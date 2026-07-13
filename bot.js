'use strict';
const path = require('path');
const { loadConfig } = require('./src/config');
const { createRateLimiter } = require('./src/rateLimiter');
const { createTorgiClient } = require('./src/torgiClient');
const { createStore } = require('./src/store');
const { escapeHtml } = require('./src/formatter');
const { createTelegram } = require('./src/telegram');
const { createNotifier } = require('./src/notifier');
const { createPoller } = require('./src/poller');
const { startHeartbeat } = require('./src/heartbeat');
const { createAlerter } = require('./src/alerts');
const { buildDigestText, msUntilNextMskHour } = require('./src/digest');

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

async function main() {
  const cfg = loadConfig();
  // один дозатор на ВСЕ запросы к torgi: фильтры не конкурируют за per-IP лимит
  const limiter = createRateLimiter({ minGapMs: cfg.torgiMinRequestGapMs, jitterMs: cfg.torgiRequestJitterMs });
  const torgi = createTorgiClient({ localAddress: cfg.torgiLocalAddress || undefined, limiter });
  const store = createStore(path.join(cfg.dataDir, 'seen.json'));
  const tg = createTelegram({
    botToken: cfg.telegramBotToken,
    chatId: cfg.telegramChatId,
    apiBase: cfg.telegramApiBase,
  });

  // Доставка одного лота: альбом фото (до maxPhotosPerLot) → одно фото → текст → plain.
  const { notifyLot } = createNotifier({ client: torgi, tg, log, maxPhotos: cfg.maxPhotosPerLot });

  // Сторож ошибок: при устойчивой ошибке шлёт понятный алерт в Telegram, при возврате — «восстановлено».
  const alerter = createAlerter({ tg, log, cooldownMs: cfg.alertCooldownMs, flushDelayMs: cfg.alertFlushMs });

  // Группируем фильтры по категории: одна категория по всем её регионам = ОДИН запрос
  // (API объединяет повторяющиеся dynSubjRF) — 3 запроса на цикл вместо 8, интервал 30с.
  const groups = new Map();
  for (const f of cfg.filters) {
    const key = String(f.catCode);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const groupList = [...groups.values()];

  // «Регион · Категория» → «Категория — Регион, Регион» для логов и алертов
  function groupLabel(members) {
    if (members.length === 1) return members[0].displayName;
    const cat = (members[0].displayName.split('·')[1] || `категория ${members[0].catCode}`).trim();
    const regions = members.map((m) => (m.displayName.split('·')[0] || m.name).trim());
    return `${cat} — ${regions.join(', ')}`;
  }

  const pollers = groupList.map((members) => {
    const label = groupLabel(members);
    return createPoller({
      members,
      groupName: label,
      client: torgi,
      store,
      notifyLot,
      log,
      lotStatuses: cfg.lotStatuses,
      pollIntervalMs: cfg.pollIntervalMs,
      pageSize: cfg.pageSize,
      catchupPageSize: cfg.catchupPageSize,
      maxCatchupPages: cfg.maxCatchupPages,
      alertThreshold: cfg.alertThreshold || 3,
      alertSustainedMs: cfg.alertSustainedMs,
      reportError: (err) => alerter.report(label, err),
      reportOk: () => alerter.resolve(label),
      // догон после простоя упёрся в потолок — часть старых лотов могла не поместиться
      onCatchupOverflow: (n) => tg.sendMessage(
        `⚠️ <b>Долгий простой</b> — ${escapeHtml(label)}\n\n` +
        `Досылаю ${n} свежих лотов, но за время простоя их могло появиться больше, чем помещается в догон. ` +
        `Часть старых могла быть пропущена — проверьте сайт вручную за период тишины.`
      ).catch(() => {}),
    });
  });

  setInterval(() => {
    groupList.forEach((members, i) => {
      const s = pollers[i].stats();
      const age = s.lastOkAt ? `${Math.round((Date.now() - s.lastOkAt) / 1000)}с назад` : 'ещё не было';
      const counts = members.map((m) => `${m.name}=${store.count(m.name)}`).join(', ');
      log(`[heartbeat] ${groupLabel(members)}: последний успешный опрос ${age}, ошибок подряд: ${s.consecutiveErrors}, лоты: ${counts}`);
    });
  }, (cfg.heartbeatMinutes || 10) * 60 * 1000).unref();

  // Суточный отчёт в Telegram: тишина перестаёт быть двусмысленной — отчёт с нулём
  // значит «на torgi пусто», отсутствие отчёта в обычное время значит «бот лежит».
  let digestPrev = { notified: 0, errors: 0, at: Date.now() };
  async function sendDigest() {
    let notified = 0;
    let errors = 0;
    for (const p of pollers) { const s = p.stats(); notified += s.totalNotified; errors += s.totalErrors; }
    const groupsInfo = groupList.map((members, i) => {
      const s = pollers[i].stats();
      return {
        label: groupLabel(members),
        ageSec: s.lastOkAt ? Math.round((Date.now() - s.lastOkAt) / 1000) : null,
        consecutiveErrors: s.consecutiveErrors,
        counts: members.map((m) => ({ name: m.name, count: store.count(m.name) })),
      };
    });
    const text = buildDigestText({
      sinceHours: Math.max(1, Math.round((Date.now() - digestPrev.at) / 3600000)),
      notified: notified - digestPrev.notified,
      errors: errors - digestPrev.errors,
      groups: groupsInfo,
    });
    digestPrev = { notified, errors, at: Date.now() };
    try { await tg.sendMessage(text); log('суточный отчёт отправлен'); }
    catch (e) { log(`суточный отчёт не отправился: ${e.message}`); }
  }
  if (Number.isInteger(cfg.digestHourMsk) && cfg.digestHourMsk >= 0 && cfg.digestHourMsk <= 23) {
    const scheduleDigest = () => {
      const t = setTimeout(async () => { await sendDigest(); scheduleDigest(); }, msUntilNextMskHour(cfg.digestHourMsk));
      if (t.unref) t.unref();
    };
    scheduleDigest();
    log(`суточный отчёт включён: ежедневно в ${cfg.digestHourMsk}:00 МСК`);
  }

  const shutdown = (sig) => {
    log(`${sig} — сохраняю состояние и выхожу`);
    store.save();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => {
    log(`unhandledRejection: ${e && e.message}`);
    Promise.resolve(alerter.report('внутренняя ошибка бота', e)).catch(() => {});
  });
  process.on('uncaughtException', (e) => {
    log(`uncaughtException: ${e && e.message}`);
    // сообщаем (flush — не ждём окна склейки) и даём systemd перезапустить (Restart=always)
    Promise.resolve(alerter.report('критическая ошибка бота (перезапуск)', e))
      .then(() => alerter.flush())
      .catch(() => {})
      .finally(() => setTimeout(() => process.exit(1), 1500));
  });

  try {
    const names = cfg.filters.map((f) => `• ${f.displayName}`).join('\n');
    await tg.sendMessage(`🟢 <b>Torgi Sentinel запущен</b>\nСлежу за фильтрами:\n${names}`);
  } catch (e) {
    log(`ВНИМАНИЕ: стартовое сообщение в Telegram не ушло: ${e.message} — проверь токен/chat_id. Продолжаю работу.`);
  }

  // старты со сдвигом, чтобы не бить в API синхронно
  pollers.forEach((p, i) => setTimeout(() => p.run(), i * Math.floor(cfg.pollIntervalMs / pollers.length)));

  // heartbeat на VPS: «я жив» каждые 2 минуты (для watchdog)
  startHeartbeat({ url: cfg.heartbeatUrl, token: cfg.telegramBotToken, log });
  if (cfg.heartbeatUrl) log(`heartbeat включён -> ${cfg.heartbeatUrl}`);

  log(`Torgi Sentinel запущен. Фильтров: ${cfg.filters.length}, интервал: ${cfg.pollIntervalMs}мс.`);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});

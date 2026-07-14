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
const { createClassifier } = require('./src/classifier');
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

  // УНИВЕРСАЛЬНАЯ ЛИНИЯ: один запрос без категории на все регионы (~15с цикл вместо
  // 7 линий × 75с — весь лимит IP работает на скорость). Раскладка по фильтрам —
  // классификатор: регион → категория-лист → город (при необходимости деталь лота).
  const unknownCategories = new Map(); // код → счётчик с прошлого отчёта (уходит в суточный отчёт)
  const { classify } = createClassifier({
    members: cfg.filters,
    client: torgi,
    log,
    onUnknownCategory: (code) => unknownCategories.set(code, (unknownCategories.get(code) || 0) + 1),
  });
  const regions = [...new Set(cfg.filters.map((f) => f.dynSubjRF))];
  const laneLabel = `Универсальная линия (${cfg.filters.length} фильтров, регионы ${regions.join('+')})`;
  const poller = createPoller({
    members: cfg.filters,
    classify,
    groupName: laneLabel,
    client: torgi,
    store,
    notifyLot,
    log,
    lotStatuses: cfg.lotStatuses,
    pollIntervalMs: cfg.pollIntervalMs,
    catchupPageSize: cfg.catchupPageSize,
    maxCatchupPages: cfg.maxCatchupPages,
    alertThreshold: cfg.alertThreshold || 3,
    alertSustainedMs: cfg.alertSustainedMs,
    reportError: (err) => alerter.report(laneLabel, err),
    reportOk: () => alerter.resolve(laneLabel),
    // догон после простоя упёрся в потолок — часть старых лотов могла не поместиться
    onCatchupOverflow: (n) => tg.sendMessage(
      `⚠️ <b>Долгий простой</b>\n\n` +
      `Досылаю ${n} свежих лотов, но за время простоя их могло появиться больше, чем помещается в догон. ` +
      `Часть старых могла быть пропущена — проверьте сайт вручную за период тишины.`
    ).catch(() => {}),
  });
  const pollers = [poller];

  setInterval(() => {
    const s = poller.stats();
    const age = s.lastOkAt ? `${Math.round((Date.now() - s.lastOkAt) / 1000)}с назад` : 'ещё не было';
    const counts = cfg.filters.map((m) => `${m.name}=${store.count(m.name)}`).join(', ');
    log(`[heartbeat] ${laneLabel}: последний успешный опрос ${age}, ошибок подряд: ${s.consecutiveErrors}, лоты: ${counts}`);
  }, (cfg.heartbeatMinutes || 10) * 60 * 1000).unref();

  // Суточный отчёт в Telegram: тишина перестаёт быть двусмысленной — отчёт с нулём
  // значит «на torgi пусто», отсутствие отчёта в обычное время значит «бот лежит».
  let digestPrev = { notified: 0, errors: 0, at: Date.now() };
  async function sendDigest() {
    const s = poller.stats();
    const groupsInfo = [{
      label: laneLabel,
      ageSec: s.lastOkAt ? Math.round((Date.now() - s.lastOkAt) / 1000) : null,
      consecutiveErrors: s.consecutiveErrors,
      counts: cfg.filters.map((m) => ({ name: m.name, count: store.count(m.name) })),
    }];
    const unknowns = [...unknownCategories.entries()].map(([code, count]) => ({ code, count }));
    unknownCategories.clear();
    const text = buildDigestText({
      sinceHours: Math.max(1, Math.round((Date.now() - digestPrev.at) / 3600000)),
      notified: s.totalNotified - digestPrev.notified,
      errors: s.totalErrors - digestPrev.errors,
      groups: groupsInfo,
      unknownCategories: unknowns,
    });
    digestPrev = { notified: s.totalNotified, errors: s.totalErrors, at: Date.now() };
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

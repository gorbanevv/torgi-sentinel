'use strict';
const path = require('path');
const { loadConfig } = require('./src/config');
const { createRateLimiter } = require('./src/rateLimiter');
const { createTorgiClient } = require('./src/torgiClient');
const { createStore } = require('./src/store');
const { formatLotMessage, stripHtml } = require('./src/formatter');
const { createTelegram } = require('./src/telegram');
const { createPoller } = require('./src/poller');
const { startHeartbeat } = require('./src/heartbeat');
const { createAlerter } = require('./src/alerts');

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

  // Доставка одного лота: фото → при любой проблеме текст → при проблеме HTML — plain.
  async function notifyLot(lot, filter) {
    const { text, imageId } = formatLotMessage(lot, filter);
    if (imageId) {
      try {
        const img = await torgi.downloadImage(imageId);
        await tg.sendPhoto(img.buffer, img.contentType, text);
        return;
      } catch (e) {
        log(`[${filter.name}] фото не приложилось (${e.message}) — отправляю текстом`);
      }
    }
    try {
      await tg.sendMessage(text);
    } catch (e) {
      log(`[${filter.name}] HTML-сообщение не прошло (${e.message}) — пробую без разметки`);
      await tg.sendMessagePlain(stripHtml(text));
    }
  }

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
      maxCatchupPages: cfg.maxCatchupPages,
      alertThreshold: cfg.alertThreshold || 3,
      alertSustainedMs: cfg.alertSustainedMs,
      reportError: (err) => alerter.report(label, err),
      reportOk: () => alerter.resolve(label),
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

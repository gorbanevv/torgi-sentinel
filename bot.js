'use strict';
const path = require('path');
const { loadConfig } = require('./src/config');
const { createTorgiClient } = require('./src/torgiClient');
const { createStore } = require('./src/store');
const { formatLotMessage, stripHtml } = require('./src/formatter');
const { createTelegram } = require('./src/telegram');
const { createPoller } = require('./src/poller');

function log(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}

async function main() {
  const cfg = loadConfig();
  const torgi = createTorgiClient();
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

  const pollers = cfg.filters.map((filter) =>
    createPoller({
      filter,
      client: torgi,
      store,
      notifyLot,
      log,
      lotStatuses: cfg.lotStatuses,
      pollIntervalMs: cfg.pollIntervalMs,
      pageSize: cfg.pageSize,
      maxCatchupPages: cfg.maxCatchupPages,
    })
  );

  setInterval(() => {
    cfg.filters.forEach((f, i) => {
      const s = pollers[i].stats();
      const age = s.lastOkAt ? `${Math.round((Date.now() - s.lastOkAt) / 1000)}с назад` : 'ещё не было';
      log(`[heartbeat] ${f.name}: последний успешный опрос ${age}, ошибок подряд: ${s.consecutiveErrors}, виденных лотов: ${store.count(f.name)}`);
    });
  }, (cfg.heartbeatMinutes || 10) * 60 * 1000).unref();

  const shutdown = (sig) => {
    log(`${sig} — сохраняю состояние и выхожу`);
    store.save();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e && e.message}`));

  try {
    const names = cfg.filters.map((f) => `• ${f.displayName}`).join('\n');
    await tg.sendMessage(`🟢 <b>Torgi Sentinel запущен</b>\nСлежу за фильтрами:\n${names}`);
  } catch (e) {
    log(`ВНИМАНИЕ: стартовое сообщение в Telegram не ушло: ${e.message} — проверь токен/chat_id. Продолжаю работу.`);
  }

  // старты со сдвигом, чтобы не бить в API синхронно
  pollers.forEach((p, i) => setTimeout(() => p.run(), i * Math.floor(cfg.pollIntervalMs / pollers.length)));
  log(`Torgi Sentinel запущен. Фильтров: ${cfg.filters.length}, интервал: ${cfg.pollIntervalMs}мс.`);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});

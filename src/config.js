'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  telegramApiBase: 'https://api.telegram.org',
  pollIntervalMs: 3000,
  pageSize: 20,
  // Догон после простоя: листаем свежие лоты до первого виденного и досылаем пропущенное.
  // Глубоко (25×100=2500 лотов/группа), чтобы пережить долгий простой без потери лотов.
  catchupPageSize: 100,
  maxCatchupPages: 25,
  heartbeatMinutes: 10,
  // «Опубликован» + «Приём заявок» — оба статуса ловим во всех фильтрах.
  lotStatuses: ['PUBLISHED', 'APPLICATIONS_SUBMISSION'],
  heartbeatUrl: '', // если задан (relay /heartbeat) — шлём «я жив» для watchdog
  // IP, с которого ходить на torgi (обход блокировки: основной IP Timeweb в блоке,
  // доп. 92.51.23.164 — проходит). Пусто = ходить с дефолтного IP.
  torgiLocalAddress: '',
  // Глобальный дозатор: минимальный зазор между ЛЮБЫМИ запросами к torgi + джиттер.
  // torgi даёт ~6 запросов/мин на IP; важно: суммарный темп всех фильтров должен быть ниже
  // (число фильтров × 60000 / pollIntervalMs < 6), иначе очередь копится.
  torgiMinRequestGapMs: 10000,
  torgiRequestJitterMs: 1000,
  // Сторож: алерт только если беда держится и порог ошибок, и это время; повторный алерт
  // того же типа — не чаще кулдауна; беды разных фильтров склеиваются в окне в одно сообщение.
  alertSustainedMs: 5 * 60 * 1000,
  alertCooldownMs: 30 * 60 * 1000,
  alertFlushMs: 45000,
  dataDir: path.join(__dirname, '..', 'data'),
};

function loadConfig(configPath) {
  const p = configPath || process.env.TORGI_CONFIG || path.join(__dirname, '..', 'config.json');
  let fileCfg = {};
  if (fs.existsSync(p)) fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cfg = { ...DEFAULTS, ...fileCfg };
  cfg.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || cfg.telegramBotToken || '';
  cfg.telegramChatId = process.env.TELEGRAM_CHAT_ID || cfg.telegramChatId || '';

  if (!Array.isArray(cfg.filters) || cfg.filters.length === 0) {
    throw new Error('config: filters[] пуст — заполни config.json по образцу config.example.json');
  }
  if (!Array.isArray(cfg.lotStatuses) || cfg.lotStatuses.length === 0) {
    throw new Error('config: lotStatuses[] пуст (ожидается напр. ["PUBLISHED","APPLICATIONS_SUBMISSION"])');
  }
  if (!cfg.telegramBotToken || cfg.telegramBotToken.startsWith('ВСТАВЬ')) {
    throw new Error('config: telegramBotToken не задан (config.json или переменная TELEGRAM_BOT_TOKEN)');
  }
  if (!cfg.telegramChatId || String(cfg.telegramChatId).startsWith('ВСТАВЬ')) {
    throw new Error('config: telegramChatId не задан (config.json или переменная TELEGRAM_CHAT_ID)');
  }
  for (const f of cfg.filters) {
    if (!f.name || !f.dynSubjRF || !f.catCode) {
      throw new Error(`config: у фильтра должны быть name, dynSubjRF, catCode: ${JSON.stringify(f)}`);
    }
    f.displayName = f.displayName || f.name;
  }
  // Групповой опрос (несколько регионов одной категории одним запросом) раскладывает лоты
  // по subjectRFCode из карточки — он обязателен, когда категория встречается более 1 раза.
  const byCat = new Map();
  for (const f of cfg.filters) {
    const k = String(f.catCode);
    if (!byCat.has(k)) byCat.set(k, []);
    byCat.get(k).push(f);
  }
  for (const [cat, members] of byCat) {
    if (members.length < 2) continue;
    for (const f of members) {
      if (!f.subjectRFCode) {
        throw new Error(
          `config: фильтру ${f.name} нужен subjectRFCode для группового опроса категории ${cat} ` +
          `(код региона в карточках лотов: Севастополь=92, Ростовская обл.=61, Краснодарский край=23)`
        );
      }
    }
  }
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };

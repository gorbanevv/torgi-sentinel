'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  telegramApiBase: 'https://api.telegram.org',
  pollIntervalMs: 3000,
  pageSize: 20,
  maxCatchupPages: 5,
  heartbeatMinutes: 10,
  // «Опубликован» + «Приём заявок» — оба статуса ловим во всех фильтрах.
  lotStatuses: ['PUBLISHED', 'APPLICATIONS_SUBMISSION'],
  heartbeatUrl: '', // если задан (relay /heartbeat) — шлём «я жив» для watchdog
  // IP, с которого ходить на torgi (обход блокировки: основной IP Timeweb в блоке,
  // доп. 92.51.23.164 — проходит). Пусто = ходить с дефолтного IP.
  torgiLocalAddress: '',
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
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };

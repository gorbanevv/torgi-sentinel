'use strict';
// Разовый показ: берём реальный свежий лот и шлём его карточку в Telegram
// теми же путями, что и боевой бот (formatter + downloadImage + sendPhoto).
// Запуск: node scripts/demo-notify.js
const { loadConfig } = require('../src/config');
const { createTorgiClient } = require('../src/torgiClient');
const { formatLotMessage, stripHtml } = require('../src/formatter');
const { createTelegram } = require('../src/telegram');

(async () => {
  const cfg = loadConfig();
  const torgi = createTorgiClient();
  const tg = createTelegram({ botToken: cfg.telegramBotToken, chatId: cfg.telegramChatId, apiBase: cfg.telegramApiBase });

  // ищем по фильтрам лот с фото (нагляднее); если нет — просто самый свежий
  let chosen = null;
  let chosenFilter = null;
  for (const f of cfg.filters) {
    const data = await torgi.searchLots({ dynSubjRF: f.dynSubjRF, catCode: f.catCode, lotStatuses: cfg.lotStatuses, size: 50, page: 0 });
    const lots = data.content || [];
    const withImg = lots.find((l) => Array.isArray(l.lotImages) && l.lotImages.length);
    if (withImg) { chosen = withImg; chosenFilter = f; break; }
    if (!chosen && lots.length) { chosen = lots[0]; chosenFilter = f; }
  }
  if (!chosen) { console.log('нет лотов для показа'); return; }

  const { text, imageIds } = formatLotMessage(chosen, chosenFilter);
  const header = 'ℹ️ <b>Демонстрация карточки</b> (существующий лот, не новый)\n\n';
  if (imageIds.length > 0) {
    try {
      const photos = [];
      for (const id of imageIds) {
        try { photos.push(await torgi.downloadImage(id)); } catch (e) { console.log('фото', id, 'пропущено:', e.message); }
      }
      if (photos.length >= 2) {
        await tg.sendMediaGroup(photos, header + text);
        console.log(`отправлен альбом из ${photos.length} фото, фильтр:`, chosenFilter.name, 'лот:', chosen.id);
        return;
      }
      if (photos.length === 1) {
        await tg.sendPhoto(photos[0].buffer, photos[0].contentType, header + text);
        console.log('отправлено с фото, фильтр:', chosenFilter.name, 'лот:', chosen.id);
        return;
      }
    } catch (e) {
      console.log('фото не приложились:', e.message, '— шлю текстом');
    }
  }
  await tg.sendMessage(header + text);
  console.log('отправлено текстом, фильтр:', chosenFilter.name, 'лот:', chosen.id);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

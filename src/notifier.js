'use strict';

const { formatLotMessage, stripHtml } = require('./formatter');

// Доставка одного лота: альбом всех фото (до 10) → одно фото → текст → текст без разметки.
//
// Фото качаем сами через общий дозатор запросов: Telegram НЕ может забрать их с torgi
// по URL (датацентры Telegram в блоклисте torgi + сертификат Минцифры — проверено,
// sendMediaGroup по URL даёт WEBPAGE_CURL_FAILED). Файлохранилище torgi сидит под тем же
// лимитом IP, что и поиск, поэтому на каждую картинку — одна попытка: не скачалась —
// пропускаем, альбом уходит с тем, что уцелело. Ни одна проблема с фото не блокирует
// доставку самого уведомления.
function createNotifier({ client, tg, log = () => {} }) {
  async function notifyLot(lot, filter) {
    const { text, imageIds } = formatLotMessage(lot, filter);

    const photos = [];
    for (const id of imageIds) {
      try {
        photos.push(await client.downloadImage(id));
      } catch (e) {
        log(`[${filter.name}] фото ${id} пропущено (${e.message})`);
      }
    }

    if (photos.length >= 2) {
      try {
        return await tg.sendMediaGroup(photos, text);
      } catch (e) {
        log(`[${filter.name}] альбом не отправился (${e.message}) — пробую одно фото`);
      }
    }
    if (photos.length >= 1) {
      try {
        return await tg.sendPhoto(photos[0].buffer, photos[0].contentType, text);
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

  return { notifyLot };
}

module.exports = { createNotifier };

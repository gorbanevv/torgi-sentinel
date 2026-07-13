'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createNotifier } = require('../src/notifier');
const { buildMediaGroup } = require('../src/telegram');

const FILTER = { name: 'f1', displayName: 'Тест · Недвижимость', realEstate: true };

function mkLot(images) {
  return { id: 'L_1', noticeNumber: 'L', lotNumber: 1, lotName: 'Лот', lotImages: images };
}

function mkFakes({ failDownload = [], failGroup = false, failPhoto = false, failMessage = false } = {}) {
  const client = {
    downloads: [],
    async downloadImage(id) {
      client.downloads.push(id);
      if (failDownload.includes(id)) throw new Error('image HTTP 503');
      return { buffer: Buffer.from('img-' + id), contentType: 'image/jpeg' };
    },
  };
  const tg = {
    calls: [],
    async sendMediaGroup(photos, caption) {
      tg.calls.push({ m: 'group', n: photos.length, caption });
      if (failGroup) throw new Error('telegram group down');
    },
    async sendPhoto(buffer, ct, caption) {
      tg.calls.push({ m: 'photo', caption });
      if (failPhoto) throw new Error('telegram photo down');
    },
    async sendMessage(text) {
      tg.calls.push({ m: 'msg', text });
      if (failMessage) throw new Error('telegram msg down');
    },
    async sendMessagePlain(text) { tg.calls.push({ m: 'plain', text }); },
  };
  return { client, tg };
}

test('потолок фото: качаем и шлём только первые maxPhotos (скорость дороже полноты)', async () => {
  const { client, tg } = mkFakes();
  const n = createNotifier({ client, tg, log: () => {}, maxPhotos: 3 });
  await n.notifyLot(mkLot(['a', 'b', 'c', 'd', 'e']), FILTER);
  assert.deepStrictEqual(client.downloads, ['a', 'b', 'c'], 'лишние фото даже не скачиваются');
  assert.strictEqual(tg.calls[0].m, 'group');
  assert.strictEqual(tg.calls[0].n, 3);
});

test('потолок фото по умолчанию = 3', async () => {
  const { client, tg } = mkFakes();
  const n = createNotifier({ client, tg, log: () => {} });
  await n.notifyLot(mkLot(['a', 'b', 'c', 'd', 'e', 'f', 'g']), FILTER);
  assert.strictEqual(client.downloads.length, 3);
});

test('несколько фото → одним альбомом, подпись на первом', async () => {
  const { client, tg } = mkFakes();
  const n = createNotifier({ client, tg, log: () => {} });
  await n.notifyLot(mkLot(['a', 'b', 'c']), FILTER);
  assert.deepStrictEqual(client.downloads, ['a', 'b', 'c'], 'скачали все');
  assert.strictEqual(tg.calls.length, 1);
  assert.strictEqual(tg.calls[0].m, 'group');
  assert.strictEqual(tg.calls[0].n, 3);
  assert.ok(tg.calls[0].caption.includes('Лот'));
});

test('фото не скачалось → пропускаем, альбом из остальных', async () => {
  const { client, tg } = mkFakes({ failDownload: ['b'] });
  const n = createNotifier({ client, tg, log: () => {} });
  await n.notifyLot(mkLot(['a', 'b', 'c']), FILTER);
  assert.deepStrictEqual(tg.calls.map((c) => c.m), ['group']);
  assert.strictEqual(tg.calls[0].n, 2, 'альбом из двух уцелевших');
});

test('альбом не отправился → откат на одно фото', async () => {
  const { client, tg } = mkFakes({ failGroup: true });
  const n = createNotifier({ client, tg, log: () => {} });
  await n.notifyLot(mkLot(['a', 'b']), FILTER);
  assert.deepStrictEqual(tg.calls.map((c) => c.m), ['group', 'photo']);
});

test('одно фото → sendPhoto без альбома', async () => {
  const { client, tg } = mkFakes();
  const n = createNotifier({ client, tg, log: () => {} });
  await n.notifyLot(mkLot(['a']), FILTER);
  assert.deepStrictEqual(tg.calls.map((c) => c.m), ['photo']);
});

test('фото нет вовсе → текстовое сообщение', async () => {
  const { client, tg } = mkFakes();
  const n = createNotifier({ client, tg, log: () => {} });
  await n.notifyLot(mkLot([]), FILTER);
  assert.deepStrictEqual(tg.calls.map((c) => c.m), ['msg']);
});

test('все скачивания упали → деградация до текста', async () => {
  const { client, tg } = mkFakes({ failDownload: ['a', 'b'] });
  const n = createNotifier({ client, tg, log: () => {} });
  await n.notifyLot(mkLot(['a', 'b']), FILTER);
  assert.deepStrictEqual(tg.calls.map((c) => c.m), ['msg']);
});

test('HTML-сообщение не прошло → plain без разметки', async () => {
  const { client, tg } = mkFakes({ failMessage: true });
  const n = createNotifier({ client, tg, log: () => {} });
  await n.notifyLot(mkLot([]), FILTER);
  assert.deepStrictEqual(tg.calls.map((c) => c.m), ['msg', 'plain']);
});

test('buildMediaGroup: подпись и parse_mode только на первом элементе, attach-ссылки по номерам', () => {
  const photos = [
    { buffer: Buffer.from('x'), contentType: 'image/jpeg' },
    { buffer: Buffer.from('y'), contentType: 'image/png' },
  ];
  const { media, files } = buildMediaGroup(photos, 'Подпись');
  assert.strictEqual(media.length, 2);
  assert.strictEqual(media[0].caption, 'Подпись');
  assert.strictEqual(media[0].parse_mode, 'HTML');
  assert.strictEqual(media[0].media, 'attach://p0');
  assert.strictEqual(media[1].caption, undefined, 'на втором подписи нет');
  assert.strictEqual(media[1].media, 'attach://p1');
  assert.deepStrictEqual(files.map((f) => f.name), ['p0', 'p1']);
  assert.strictEqual(files[1].contentType, 'image/png');
});

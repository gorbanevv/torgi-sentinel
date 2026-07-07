'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPoller } = require('../src/poller');
const { createStore } = require('../src/store');

const FILTER = { name: 'f1', displayName: 'Тест', dynSubjRF: '80', catCode: '7', realEstate: true };

function mkLot(key) {
  return { id: `${key}_1`, noticeNumber: key, lotNumber: 1, lotName: 'Лот ' + key };
}

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torgi-poller-'));
  return createStore(path.join(dir, 'seen.json'));
}

function mkClient() {
  const client = {
    calls: [],
    queue: [],
    async searchLots(params) {
      client.calls.push(params);
      const r = client.queue.shift();
      return r || { content: [], last: true, totalElements: 0 };
    },
  };
  return client;
}

function mkNotify() {
  const spy = {
    calls: [],
    fail: false,
    async notifyLot(lot) {
      if (spy.fail) throw new Error('telegram down');
      spy.calls.push(lot.id);
    },
  };
  return spy;
}

function mkPoller({ client, store, notify }) {
  return createPoller({
    filter: FILTER,
    client,
    store,
    notifyLot: notify.notifyLot,
    log: () => {},
    sleep: async () => {},
  });
}

test('первый запуск: засев без уведомлений, флаг сохраняется', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkNotify();
  const A = mkLot('A');
  const B = mkLot('B');
  client.queue.push({ content: [B, A], last: true });

  const p = mkPoller({ client, store, notify });
  const r = await p.pollOnce();

  assert.strictEqual(r.seeded, true);
  assert.strictEqual(notify.calls.length, 0, 'на засеве уведомлений нет');
  assert.ok(store.has('f1', 'A_1') && store.has('f1', 'B_1'));
  assert.ok(store.isSeeded('f1'));
});

test('новый лот → одно уведомление, повторно не шлётся', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkNotify();
  const A = mkLot('A');
  const B = mkLot('B');
  store.add('f1', 'A_1');
  store.markSeeded('f1');

  const p = mkPoller({ client, store, notify });
  client.queue.push({ content: [B, A], last: false });
  let r = await p.pollOnce();
  assert.strictEqual(r.notified, 1);
  assert.deepStrictEqual(notify.calls, ['B_1']);

  client.queue.push({ content: [B, A], last: false });
  r = await p.pollOnce();
  assert.strictEqual(r.notified, 0, 'дубликатов нет');
});

test('пачка новых уведомляется хронологично: старые → новые', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkNotify();
  store.add('f1', 'A_1');
  store.markSeeded('f1');
  // страница отсортирована новые-сверху: C новее B
  client.queue.push({ content: [mkLot('C'), mkLot('B'), mkLot('A')], last: false });

  const p = mkPoller({ client, store, notify });
  await p.pollOnce();
  assert.deepStrictEqual(notify.calls, ['B_1', 'C_1']);
});

test('вся страница новая → листаем дальше до известного лота', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkNotify();
  store.add('f1', 'A_1');
  store.markSeeded('f1');
  client.queue.push({ content: [mkLot('D'), mkLot('C')], last: false }); // page 0 — все новые
  client.queue.push({ content: [mkLot('B'), mkLot('A')], last: false }); // page 1 — упёрлись в A

  const p = mkPoller({ client, store, notify });
  await p.pollOnce();

  assert.deepStrictEqual(notify.calls, ['B_1', 'C_1', 'D_1'], 'хронологический порядок через страницы');
  assert.strictEqual(client.calls.length, 2, 'останавливаемся на известном лоте');
  assert.strictEqual(client.calls[0].page, 0);
  assert.strictEqual(client.calls[1].page, 1);
});

test('отправка упала → лот НЕ помечен и уходит в ретрай следующим циклом', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkNotify();
  store.add('f1', 'A_1');
  store.markSeeded('f1');
  const B = mkLot('B');

  const p = mkPoller({ client, store, notify });

  notify.fail = true;
  client.queue.push({ content: [B, mkLot('A')], last: false });
  await assert.rejects(() => p.pollOnce(), /telegram down/);
  assert.strictEqual(store.has('f1', 'B_1'), false, 'неотправленный лот не помечен');

  notify.fail = false;
  client.queue.push({ content: [B, mkLot('A')], last: false });
  const r = await p.pollOnce();
  assert.strictEqual(r.notified, 1);
  assert.deepStrictEqual(notify.calls, ['B_1']);
  assert.ok(store.has('f1', 'B_1'));
});

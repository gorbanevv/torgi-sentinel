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

// --- устойчивость и алерты (цикл run) ---

// Обвязка для прогона run() с виртуальным временем: клиент всегда падает,
// sleep двигает часы и останавливает цикл после maxSleeps пауз.
function runHarness({ error, pollIntervalMs = 90000, maxSleeps, pollerOpts = {} }) {
  const h = { t: 0, sleeps: [], reports: [], oks: [] };
  const store = mkStore();
  store.add('f1', 'A_1');
  store.markSeeded('f1');
  const client = {
    async searchLots() {
      if (typeof error === 'function') return error(h);
      throw new Error(error);
    },
  };
  h.poller = createPoller({
    filter: FILTER,
    client,
    store,
    notifyLot: async () => {},
    log: () => {},
    pollIntervalMs,
    now: () => h.t,
    sleep: async (ms) => {
      h.sleeps.push(ms);
      h.t += ms;
      if (h.sleeps.length >= maxSleeps) h.poller.stop();
    },
    reportError: async () => { h.reports.push(h.t); },
    reportOk: async () => { h.oks.push(h.t); },
    ...pollerOpts,
  });
  return h;
}

test('503: алерт только при устойчивой ошибке (порог И выдержка по времени)', async () => {
  const h = runHarness({
    error: 'torgi HTTP 503: <html>',
    maxSleeps: 5,
    pollerOpts: { alertThreshold: 3, alertSustainedMs: 300000 },
  });
  await h.poller.run();
  // ошибки в t=0, 90к, 180к (порог есть, но 180к < 300к выдержки — молчим),
  // 270к (мало), 405к — порог и выдержка есть → первый и единственный алерт
  assert.deepStrictEqual(h.reports, [405000], 'алерт один и только после выдержки');
});

test('503: пауза растёт мягко после нескольких повторов и упирается в потолок', async () => {
  const h = runHarness({ error: 'torgi HTTP 503: <html>', maxSleeps: 9 });
  await h.poller.run();
  assert.deepStrictEqual(
    h.sleeps,
    [90000, 90000, 90000, 135000, 202500, 303750, 455625, 600000, 600000],
    'первые повторы без раскрутки, дальше ×1.5 до потолка 10 мин'
  );
});

test('429 — мягкая ошибка: повтор через обычный интервал, без взрывного backoff', async () => {
  const h = runHarness({ error: 'torgi HTTP 429: too many', maxSleeps: 2 });
  await h.poller.run();
  assert.deepStrictEqual(h.sleeps, [90000, 90000]);
});

test('после алерта успешный цикл шлёт «восстановлено» ровно один раз', async () => {
  let fails = 3;
  const h = runHarness({
    error: (hh) => {
      if (fails-- > 0) throw new Error('torgi HTTP 503: x');
      return { content: [], last: true };
    },
    maxSleeps: 6,
    pollerOpts: { alertThreshold: 3, alertSustainedMs: 0 },
  });
  await h.poller.run();
  assert.strictEqual(h.reports.length, 1, 'алерт один');
  assert.strictEqual(h.oks.length, 1, 'восстановление один раз');
});

test('засев: прогресс страниц переживает падение на середине', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torgi-seed-'));
  const file = path.join(dir, 'seen.json');
  const store1 = createStore(file);
  const notify = mkNotify();
  let call = 0;
  const client = {
    async searchLots() {
      call++;
      if (call === 1) return { content: [mkLot('A'), mkLot('B')], last: false };
      throw new Error('torgi HTTP 503: упали на 2-й странице');
    },
  };
  const p = createPoller({
    filter: FILTER, client, store: store1,
    notifyLot: notify.notifyLot, log: () => {}, sleep: async () => {},
  });
  await assert.rejects(() => p.pollOnce(), /503/);

  const store2 = createStore(file); // перечитываем с диска, как после рестарта
  assert.ok(store2.has('f1', 'A_1') && store2.has('f1', 'B_1'), 'страница 0 сохранена на диск');
  assert.strictEqual(store2.isSeeded('f1'), false, 'засев не завершён — доедем после рестарта');
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

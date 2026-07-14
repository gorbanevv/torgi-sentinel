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

// --- наблюдаемость: текст ошибки в логе, счётчики для суточного отчёта ---

test('текст ошибки попадает в лог (не слепое «ошибка N подряд»)', async () => {
  const logs = [];
  const store = mkStore();
  store.markSeeded('f1');
  const client = { async searchLots() { throw new Error('torgi timeout 15000ms'); } };
  const p = createPoller({
    filter: FILTER, client, store, notifyLot: async () => {},
    log: (m) => logs.push(m), pollIntervalMs: 90000,
    sleep: async () => { p.stop(); },
  });
  await p.run();
  assert.ok(logs.some((l) => l.includes('timeout 15000ms')), 'в логе виден текст ошибки: ' + logs.join(' | '));
});

test('stats: суммарные счётчики ошибок/уведомлений и последняя ошибка', async () => {
  const store = mkStore();
  store.add('f1', 'A_1');
  store.markSeeded('f1');
  let n = 0;
  const client = {
    async searchLots() {
      if (n++ < 2) throw new Error('torgi HTTP 503: x');
      return { content: [mkLot('B'), mkLot('A')], last: false };
    },
  };
  let sleeps = 0;
  const p = createPoller({
    filter: FILTER, client, store, notifyLot: async () => {},
    log: () => {}, pollIntervalMs: 90000,
    sleep: async () => { if (++sleeps >= 3) p.stop(); },
  });
  await p.run();
  const s = p.stats();
  assert.strictEqual(s.totalErrors, 2, 'две ошибки посчитаны');
  assert.strictEqual(s.totalNotified, 1, 'одно уведомление посчитано');
  assert.ok(s.lastError && s.lastError.message.includes('503'), 'последняя ошибка сохранена');
});

// --- догон после простоя: досылаем всё, что появилось, пока бот молчал ---

test('догон: пропущенная за простой пачка длиннее страницы доезжает до известного лота', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkNotify();
  store.add('f1', 'OLD_1');
  store.markSeeded('f1');
  // за простой опубликовано 5 новых; страница по 2 — нужно три запроса
  client.queue.push({ content: [mkLot('E'), mkLot('D')], last: false });
  client.queue.push({ content: [mkLot('C'), mkLot('B')], last: false });
  client.queue.push({ content: [mkLot('A'), mkLot('OLD')], last: false }); // OLD известен → стоп

  const p = createPoller({
    filter: FILTER, client, store, notifyLot: notify.notifyLot,
    log: () => {}, sleep: async () => {}, catchupPageSize: 2, maxCatchupPages: 10,
  });
  const r = await p.pollOnce();

  assert.deepStrictEqual(notify.calls, ['A_1', 'B_1', 'C_1', 'D_1', 'E_1'], 'все пропущенные, хронологично');
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(client.calls.length, 3, 'остановились на первом известном');
});

test('догон глубже прежнего лимита в 5 страниц (долгий простой)', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkNotify();
  store.add('f1', 'OLD_1');
  store.markSeeded('f1');
  // 7 страниц по одному новому лоту — прежний потолок (5) обрезал бы хвост
  for (let i = 7; i >= 1; i--) client.queue.push({ content: [mkLot('N' + i)], last: false });
  client.queue.push({ content: [mkLot('OLD')], last: false }); // известен → стоп

  const p = createPoller({
    filter: FILTER, client, store, notifyLot: notify.notifyLot,
    log: () => {}, sleep: async () => {}, catchupPageSize: 1, maxCatchupPages: 25,
  });
  const r = await p.pollOnce();

  assert.deepStrictEqual(notify.calls, ['N1_1', 'N2_1', 'N3_1', 'N4_1', 'N5_1', 'N6_1', 'N7_1']);
  assert.strictEqual(r.truncated, false);
});

test('догон исчерпал бюджет, не встретив известного → truncated + сигнал переполнения', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkNotify();
  store.add('f1', 'OLD_1');
  store.markSeeded('f1');
  client.queue.push({ content: [mkLot('F'), mkLot('E')], last: false });
  client.queue.push({ content: [mkLot('D'), mkLot('C')], last: false }); // известного так и не встретили в бюджете

  let overflow = null;
  const p = createPoller({
    filter: FILTER, client, store, notifyLot: notify.notifyLot,
    log: () => {}, sleep: async () => {}, catchupPageSize: 2, maxCatchupPages: 2,
    onCatchupOverflow: (n) => { overflow = n; },
  });
  const r = await p.pollOnce();

  assert.strictEqual(r.truncated, true, 'помечаем возможную дыру');
  assert.strictEqual(overflow, 4, 'сообщили, сколько успели догнать');
  assert.deepStrictEqual(notify.calls, ['C_1', 'D_1', 'E_1', 'F_1'], 'самые свежие всё равно доставлены');
});

test('догон: конец списка (last) — не переполнение', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkNotify();
  store.markSeeded('f1'); // засеян, но пусто (крайний случай)
  client.queue.push({ content: [mkLot('B'), mkLot('A')], last: true });

  let overflow = null;
  const p = createPoller({
    filter: FILTER, client, store, notifyLot: notify.notifyLot,
    log: () => {}, sleep: async () => {}, catchupPageSize: 2, maxCatchupPages: 2,
    onCatchupOverflow: (n) => { overflow = n; },
  });
  const r = await p.pollOnce();

  assert.strictEqual(r.truncated, false, 'дошли до конца списка — дыры нет');
  assert.strictEqual(overflow, null, 'сигнал переполнения не шлётся');
  assert.deepStrictEqual(notify.calls, ['A_1', 'B_1']);
});

// --- фильтр по городу: fiasGUID члена группы уходит в запросы ---

test('город-фильтр: fiasGUID передаётся в опрос и в засев', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkNotify();
  const CITY = { name: 'sochi-realty', displayName: 'г. Сочи · Недвижимость', dynSubjRF: '26', subjectRFCode: '23', catCode: '7', fiasGUID: 'guid-sochi', realEstate: true };

  const p = createPoller({
    filter: CITY, client, store, notifyLot: notify.notifyLot,
    log: () => {}, sleep: async () => {},
  });
  client.queue.push({ content: [mkLot('S1')], last: true }); // засев
  await p.pollOnce();
  assert.strictEqual(client.calls[0].fiasGUID, 'guid-sochi', 'засев с городом');

  client.queue.push({ content: [mkLot('S1')], last: true }); // обычный цикл
  await p.pollOnce();
  assert.strictEqual(client.calls[1].fiasGUID, 'guid-sochi', 'опрос с городом');
});

// --- мердж-запрос упёрся в потолок → глубокий по-региональный догон (API режет size у мульти-региональных до 10) ---

test('группа: исчерпание мердж-бюджета включает по-региональный догон, хронология по дате публикации', async () => {
  const client = mkClient();
  const store = mkStore();
  const got = [];
  store.add('g-sev', 'KS_1'); store.markSeeded('g-sev');
  store.add('g-ros', 'KR_1'); store.markSeeded('g-ros');
  const L = (key, subj, pub) => ({ ...mkRegLot(key, subj), noticeFirstVersionPublicationDate: pub });
  // мердж: страница без единого известного → бюджет (1 страница) исчерпан
  client.queue.push({ content: [L('R1', '61', '2026-07-11T14:00:00Z'), L('S1', '92', '2026-07-11T13:00:00Z')], last: false });
  // по-региональный догон: сначала участник g-sev (80), затем g-ros (63)
  client.queue.push({ content: [L('S1', '92', '2026-07-11T13:00:00Z'), L('KS', '92', '2026-07-01T00:00:00Z')], last: false });
  client.queue.push({ content: [L('R1', '61', '2026-07-11T14:00:00Z'), L('R2', '61', '2026-07-11T12:00:00Z'), L('KR', '61', '2026-07-01T00:00:00Z')], last: false });

  const p = createPoller({
    members: MEMBERS, client, store,
    notifyLot: async (lot, m) => { got.push(`${lot.id}@${m.name}`); },
    log: () => {}, sleep: async () => {},
    catchupPageSize: 2, maxCatchupPages: 1,
  });
  const r = await p.pollOnce();

  assert.strictEqual(r.truncated, false, 'по-региональный догон дошёл до границы — дыры нет');
  assert.deepStrictEqual(got, ['R2_1@g-ros', 'S1_1@g-sev', 'R1_1@g-ros'], 'старые→новые по дате публикации, свой фильтр');
  assert.deepStrictEqual(client.calls[0].dynSubjRF, ['80', '63'], 'сначала мердж');
  assert.strictEqual(client.calls[1].dynSubjRF, '80', 'затем по-региону: сев');
  assert.strictEqual(client.calls[2].dynSubjRF, '63', 'затем ростов');
});

test('группа: и по-региональный догон упёрся → truncated (сигнал переполнения)', async () => {
  const client = mkClient();
  const store = mkStore();
  store.markSeeded('g-sev'); store.markSeeded('g-ros');
  const L = (key, subj) => mkRegLot(key, subj);
  client.queue.push({ content: [L('M1', '61'), L('M2', '92')], last: false }); // мердж: всё новое
  client.queue.push({ content: [L('M2', '92'), L('S9', '92')], last: false }); // сев: всё новое, границы нет
  client.queue.push({ content: [L('M1', '61'), L('R9', '61')], last: false }); // ростов: всё новое, границы нет

  let overflow = null;
  const p = createPoller({
    members: MEMBERS, client, store,
    notifyLot: async () => {}, log: () => {}, sleep: async () => {},
    catchupPageSize: 2, maxCatchupPages: 1,
    onCatchupOverflow: (n) => { overflow = n; },
  });
  const r = await p.pollOnce();
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(overflow, 4, 'сообщили, сколько досталось');
});

// --- групповой опрос: одна категория, несколько регионов одним запросом ---

const MEMBERS = [
  { name: 'g-sev', displayName: 'Севастополь · Тест', dynSubjRF: '80', subjectRFCode: '92', catCode: '7', realEstate: true },
  { name: 'g-ros', displayName: 'Ростовская область · Тест', dynSubjRF: '63', subjectRFCode: '61', catCode: '7', realEstate: true },
];

function mkRegLot(key, subjectRFCode) {
  return { id: `${key}_1`, noticeNumber: key, lotNumber: 1, lotName: 'Лот ' + key, subjectRFCode };
}

function mkGroupNotify() {
  const spy = { calls: [], async notifyLot(lot, member) { spy.calls.push(`${lot.id}@${member.name}`); } };
  return spy;
}

test('группа: лоты раскладываются по регионам, дедуп в корзину своего фильтра', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkGroupNotify();
  store.add('g-sev', 'A_1'); store.markSeeded('g-sev');
  store.add('g-ros', 'B_1'); store.markSeeded('g-ros');

  const p = createPoller({
    members: MEMBERS, client, store,
    notifyLot: notify.notifyLot, log: () => {}, sleep: async () => {},
  });
  // свежий ростовский C и известный севастопольский A в одной выдаче
  client.queue.push({ content: [mkRegLot('C', '61'), mkRegLot('A', '92')], last: false });
  const r = await p.pollOnce();

  assert.strictEqual(r.notified, 1);
  assert.deepStrictEqual(notify.calls, ['C_1@g-ros'], 'лот ушёл с фильтром своего региона');
  assert.ok(store.has('g-ros', 'C_1'), 'помечен в корзине своего региона');
  assert.strictEqual(store.has('g-sev', 'C_1'), false, 'в чужую корзину не попал');
  // запрос группы — оба региона одним запросом
  assert.deepStrictEqual(client.calls[0].dynSubjRF, ['80', '63']);
});

test('группа: лот неизвестного региона пропускается молча, остальные обрабатываются', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkGroupNotify();
  store.add('g-sev', 'A_1'); store.markSeeded('g-sev');
  store.markSeeded('g-ros');

  const p = createPoller({
    members: MEMBERS, client, store,
    notifyLot: notify.notifyLot, log: () => {}, sleep: async () => {},
  });
  client.queue.push({ content: [mkRegLot('X', '77'), mkRegLot('D', '61'), mkRegLot('A', '92')], last: false });
  const r = await p.pollOnce();

  assert.strictEqual(r.notified, 1);
  assert.deepStrictEqual(notify.calls, ['D_1@g-ros']);
  assert.strictEqual(store.has('g-ros', 'X_1') || store.has('g-sev', 'X_1'), false, 'чужак не помечен нигде');
});

test('группа: незасеянный участник засевается своим отдельным запросом, без уведомлений', async () => {
  const client = mkClient();
  const store = mkStore();
  const notify = mkGroupNotify();
  store.add('g-sev', 'A_1'); store.markSeeded('g-sev'); // сев уже засеян, ростов — нет

  const p = createPoller({
    members: MEMBERS, client, store,
    notifyLot: notify.notifyLot, log: () => {}, sleep: async () => {},
  });
  client.queue.push({ content: [mkRegLot('R1', '61'), mkRegLot('R2', '61')], last: true }); // ответ на засев ростова
  const r = await p.pollOnce();

  assert.strictEqual(r.seeded, true);
  assert.strictEqual(notify.calls.length, 0, 'засев без уведомлений');
  assert.strictEqual(client.calls[0].dynSubjRF, '63', 'засев строго своим регионом');
  assert.ok(store.isSeeded('g-ros') && store.has('g-ros', 'R1_1') && store.has('g-ros', 'R2_1'));
  assert.strictEqual(store.has('g-sev', 'R1_1'), false);
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

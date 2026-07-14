'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parentCatOf, createClassifier, KRD_GUID, SOCHI_GUID } = require('../src/classifier');

test('parentCatOf: листья сводятся к родителям 7/2/100, чужое — null', () => {
  assert.strictEqual(parentCatOf('11'), '7');  // нежилые
  assert.strictEqual(parentCatOf('9'), '7');   // жилые
  assert.strictEqual(parentCatOf('301'), '2'); // земли нас. пунктов
  assert.strictEqual(parentCatOf('307'), '2'); // не образованные
  assert.strictEqual(parentCatOf('100001'), '100'); // легковые
  assert.strictEqual(parentCatOf('31'), '100');     // автобусы
  assert.strictEqual(parentCatOf('7'), '7', 'родитель равен себе');
  assert.strictEqual(parentCatOf('404'), null, 'стройматериалы — не наше');
  assert.strictEqual(parentCatOf(undefined), null);
});

const MEMBERS = [
  { name: 'sev-realty', dynSubjRF: '80', subjectRFCode: '92', catCode: '7' },
  { name: 'rostov-land', dynSubjRF: '63', subjectRFCode: '61', catCode: '2' },
  { name: 'krd-realty', dynSubjRF: '26', subjectRFCode: '23', catCode: '7', fiasGUID: KRD_GUID },
  { name: 'sochi-realty', dynSubjRF: '26', subjectRFCode: '23', catCode: '7', fiasGUID: SOCHI_GUID },
  { name: 'kk-auto', dynSubjRF: '26', subjectRFCode: '23', catCode: '100' },
];

function lot(over = {}) {
  return { id: 'L_1', subjectRFCode: '61', category: { code: '301' }, lotName: 'участок', lotDescription: '', ...over };
}

test('классификация: регион + категория → региональный фильтр', async () => {
  const c = createClassifier({ members: MEMBERS, client: {}, log: () => {} });
  const r = await c.classify(lot());
  assert.deepStrictEqual(r.map((m) => m.name), ['rostov-land']);
});

test('чужая категория → пусто, с докладом о неопознанном коде', async () => {
  const unknown = [];
  const c = createClassifier({ members: MEMBERS, client: {}, log: () => {}, onUnknownCategory: (code) => unknown.push(code) });
  const r = await c.classify(lot({ category: { code: '404' } }));
  assert.deepStrictEqual(r, []);
  assert.deepStrictEqual(unknown, ['404']);
});

test('КК-недвижимость: кадастр 23:43 в карточке → г. Краснодар без детали', async () => {
  const c = createClassifier({ members: MEMBERS, client: { async getLotDetail() { throw new Error('не должен вызываться'); } }, log: () => {} });
  const r = await c.classify(lot({ subjectRFCode: '23', category: { code: '11' }, lotName: 'помещение, кадастровый номер 23:43:0302021:2670' }));
  assert.deepStrictEqual(r.map((m) => m.name), ['krd-realty']);
});

test('КК-недвижимость: «Краснодарский край» в тексте НЕ значит город', async () => {
  const calls = [];
  const client = { async getLotDetail(id) { calls.push(id); return { estateAddress: 'край Краснодарский, р-н Динской, ст. Пластуновская' }; } };
  const c = createClassifier({ members: MEMBERS, client, log: () => {} });
  const r = await c.classify(lot({ subjectRFCode: '23', category: { code: '11' }, lotName: 'помещение в Краснодарском крае' }));
  assert.deepStrictEqual(r, [], 'сельский лот отброшен');
  assert.strictEqual(calls.length, 1, 'город выяснен через деталь');
});

test('деталь: estateAddress «г.о. город Краснодар» → krd; склонение «Краснодара» тоже', async () => {
  const client = { async getLotDetail() { return { estateAddress: 'край Краснодарский, г.о. город Краснодар, г. Краснодар, ул. Мира 1' }; } };
  const c = createClassifier({ members: MEMBERS, client, log: () => {} });
  const r = await c.classify(lot({ subjectRFCode: '23', category: { code: '9' } }));
  assert.deepStrictEqual(r.map((m) => m.name), ['krd-realty']);
});

test('Сочи по тексту карточки (без детали)', async () => {
  const c = createClassifier({ members: MEMBERS, client: {}, log: () => {} });
  const r = await c.classify(lot({ subjectRFCode: '23', category: { code: '8' }, lotName: 'здание, г. Сочи, ул. Навагинская' }));
  assert.deepStrictEqual(r.map((m) => m.name), ['sochi-realty']);
});

test('КК-авто: краевой фильтр без городов — деталь не нужна', async () => {
  const c = createClassifier({ members: MEMBERS, client: { async getLotDetail() { throw new Error('лишний вызов'); } }, log: () => {} });
  const r = await c.classify(lot({ subjectRFCode: '23', category: { code: '100002' }, lotName: 'КАМАЗ' }));
  assert.deepStrictEqual(r.map((m) => m.name), ['kk-auto']);
});

test('деталь недоступна → classify бросает (лот уйдёт в ретрай следующим циклом)', async () => {
  const client = { async getLotDetail() { throw new Error('torgi HTTP 503'); } };
  const c = createClassifier({ members: MEMBERS, client, log: () => {} });
  await assert.rejects(() => c.classify(lot({ subjectRFCode: '23', category: { code: '9' } })), /503/);
});

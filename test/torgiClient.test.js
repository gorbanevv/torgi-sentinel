'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createTorgiClient, buildSearchQuery } = require('../src/torgiClient');

test('buildSearchQuery: несколько регионов → повторяющийся параметр (как lotStatus)', () => {
  const q = buildSearchQuery({ dynSubjRF: ['80', '63', '26'], catCode: '7', size: 20, page: 0 });
  assert.ok(q.includes('dynSubjRF=80&dynSubjRF=63&dynSubjRF=26'), q);
  assert.ok(q.includes('catCode=7'));
});

test('buildSearchQuery: один регион строкой — одиночный параметр', () => {
  const q = buildSearchQuery({ dynSubjRF: '63', catCode: '100', size: 20, page: 1 });
  assert.strictEqual((q.match(/dynSubjRF=/g) || []).length, 1);
  assert.ok(q.includes('page=1'));
});

test('buildSearchQuery: fiasGUID (фильтр по городу) попадает в запрос', () => {
  const q = buildSearchQuery({ dynSubjRF: '26', catCode: '7', fiasGUID: '7dfa745e-aa19-4688-b121-b655c11e482f' });
  assert.ok(q.includes('fiasGUID=7dfa745e-aa19-4688-b121-b655c11e482f'), q);
});

test('buildSearchQuery: без fiasGUID параметра нет', () => {
  const q = buildSearchQuery({ dynSubjRF: '26', catCode: '7' });
  assert.ok(!q.includes('fiasGUID'), q);
});

test('клиент: searchLots и downloadImage идут через переданный лимитер', async () => {
  const scheduled = [];
  // фейковый лимитер не зовёт fn — сеть не трогаем, проверяем только маршрутизацию
  const limiter = { schedule: async (fn) => { scheduled.push(typeof fn); return { viaLimiter: true }; } };
  const client = createTorgiClient({ limiter });

  const r1 = await client.searchLots({ dynSubjRF: '63', catCode: '7' });
  assert.deepStrictEqual(r1, { viaLimiter: true }, 'searchLots делегирован лимитеру');

  const r2 = await client.downloadImage('abc123');
  assert.deepStrictEqual(r2, { viaLimiter: true }, 'downloadImage делегирован лимитеру');

  assert.deepStrictEqual(scheduled, ['function', 'function']);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createTorgiClient } = require('../src/torgiClient');

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

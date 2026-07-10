'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../src/rateLimiter');

function fakeClock() {
  const c = { t: 0, waits: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.waits.push(ms); c.t += ms; };
  return c;
}

test('лимитер: запросы сериализуются FIFO с зазором между стартами', async () => {
  const c = fakeClock();
  const lim = createRateLimiter({ minGapMs: 10000, jitterMs: 0, now: c.now, sleep: c.sleep });
  const order = [];
  const r = await Promise.all([
    lim.schedule(async () => { order.push('a'); c.t += 300; return 'a'; }),
    lim.schedule(async () => { order.push('b'); return 'b'; }),
    lim.schedule(async () => { order.push('c'); return 'c'; }),
  ]);
  assert.deepStrictEqual(order, ['a', 'b', 'c'], 'строгий FIFO');
  assert.deepStrictEqual(r, ['a', 'b', 'c'], 'результаты проброшены');
  // 'a' стартовал в t=0 и занял 300мс; 'b' ждал до t=10000; 'c' — до t=20000
  assert.deepStrictEqual(c.waits, [9700, 10000], 'зазор считается от старта до старта');
});

test('лимитер: ошибка запроса пробрасывается, очередь живёт дальше', async () => {
  const c = fakeClock();
  const lim = createRateLimiter({ minGapMs: 10000, jitterMs: 0, now: c.now, sleep: c.sleep });
  const p1 = lim.schedule(async () => { throw new Error('boom'); });
  const p2 = lim.schedule(async () => 'ok');
  await assert.rejects(p1, /boom/);
  assert.strictEqual(await p2, 'ok', 'после падения очередь не застревает');
});

test('лимитер: без ожидания, если зазор уже прошёл', async () => {
  const c = fakeClock();
  const lim = createRateLimiter({ minGapMs: 10000, jitterMs: 0, now: c.now, sleep: c.sleep });
  await lim.schedule(async () => {});
  c.t = 50000; // прошло много времени
  await lim.schedule(async () => {});
  assert.deepStrictEqual(c.waits, [], 'спать не пришлось');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { describeError, createAlerter } = require('../src/alerts');

test('describeError: HTTP-коды torgi распознаются с понятным текстом', () => {
  assert.strictEqual(describeError(new Error('torgi HTTP 503: <html>')).code, 'HTTP503');
  assert.strictEqual(describeError(new Error('torgi HTTP 403: nope')).code, 'HTTP403');
  assert.strictEqual(describeError(new Error('torgi HTTP 404')).code, 'HTTP404');
  assert.strictEqual(describeError(new Error('torgi HTTP 429')).code, 'HTTP429');
  assert.strictEqual(describeError(new Error('torgi HTTP 500')).code, 'HTTP500');
  // у каждого есть заголовок и объяснение
  const d = describeError(new Error('torgi HTTP 503'));
  assert.ok(d.title && d.meaning);
});

test('describeError: сетевые ошибки распознаются', () => {
  assert.strictEqual(describeError(new Error('torgi timeout 15000ms')).code, 'TIMEOUT');
  assert.strictEqual(describeError(new Error('connect ETIMEDOUT 1.2.3.4:443')).code, 'TIMEOUT');
  assert.strictEqual(describeError(new Error('socket hang up ECONNRESET')).code, 'ECONNRESET');
  assert.strictEqual(describeError(new Error('getaddrinfo ENOTFOUND torgi.gov.ru')).code, 'ENOTFOUND');
  assert.strictEqual(describeError(new Error('connect ECONNREFUSED')).code, 'ECONNREFUSED');
  assert.strictEqual(describeError(new Error('EAI_AGAIN')).code, 'EAI_AGAIN');
  assert.strictEqual(describeError(new Error('ENETUNREACH')).code, 'ENETUNREACH');
});

test('describeError: не-JSON и прочее', () => {
  assert.strictEqual(describeError(new Error('torgi bad JSON: <!DOCTYPE')).code, 'BADJSON');
  assert.strictEqual(describeError(new Error('что-то странное')).code, 'OTHER');
});

test('TIMEOUT-сообщение упоминает блокировку IP (главный риск)', () => {
  const d = describeError(new Error('torgi timeout 15000ms'));
  assert.ok(/IP|блокир/i.test(d.meaning));
});

function fakeTg() {
  return { sent: [], async sendMessage(t) { this.sent.push(t); } };
}

test('alerter: первый report шлёт, повтор того же кода — молчит', async () => {
  const tg = fakeTg();
  const a = createAlerter({ tg });
  await a.report('фильтр1', new Error('torgi HTTP 503'));
  await a.report('фильтр1', new Error('torgi HTTP 503: снова'));
  assert.strictEqual(tg.sent.length, 1, 'дубликат того же кода не шлётся');
  assert.ok(tg.sent[0].includes('503'));
});

test('alerter: другой код в том же контексте — новый алерт', async () => {
  const tg = fakeTg();
  const a = createAlerter({ tg });
  await a.report('ф', new Error('torgi HTTP 503'));
  await a.report('ф', new Error('torgi timeout 15000ms'));
  assert.strictEqual(tg.sent.length, 2);
});

test('alerter: resolve после ошибки шлёт «восстановлено», без ошибки — молчит', async () => {
  const tg = fakeTg();
  const a = createAlerter({ tg });
  await a.resolve('ф'); // ошибок не было — тишина
  assert.strictEqual(tg.sent.length, 0);
  await a.report('ф', new Error('torgi HTTP 500'));
  await a.resolve('ф');
  assert.strictEqual(tg.sent.length, 2);
  assert.ok(/восстановлен/i.test(tg.sent[1]));
});

test('alerter: не падает, если tg.sendMessage бросает', async () => {
  const tg = { async sendMessage() { throw new Error('telegram down'); } };
  const a = createAlerter({ tg });
  await a.report('ф', new Error('torgi HTTP 503')); // не должно бросить
});

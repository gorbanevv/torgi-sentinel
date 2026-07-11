'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildDigestText, msUntilNextMskHour } = require('../src/digest');

test('msUntilNextMskHour: сегодня, если час ещё впереди', () => {
  // 05:00 UTC = 08:00 МСК; до 10:00 МСК — 2 часа
  const now = Date.parse('2026-07-11T05:00:00Z');
  assert.strictEqual(msUntilNextMskHour(10, now), 2 * 3600 * 1000);
});

test('msUntilNextMskHour: завтра, если час уже прошёл', () => {
  // 17:40 UTC = 20:40 МСК; до 10:00 МСК завтра — 13ч20м
  const now = Date.parse('2026-07-11T17:40:00Z');
  assert.strictEqual(msUntilNextMskHour(10, now), (13 * 60 + 20) * 60 * 1000);
});

test('msUntilNextMskHour: ровно в час — следующие сутки', () => {
  const now = Date.parse('2026-07-11T07:00:00Z'); // ровно 10:00 МСК
  assert.strictEqual(msUntilNextMskHour(10, now), 24 * 3600 * 1000);
});

test('buildDigestText: содержит суть — жив, лоты, сбои, группы, подсказку', () => {
  const text = buildDigestText({
    sinceHours: 24,
    notified: 0,
    errors: 18,
    groups: [
      { label: 'Недвижимость — Севастополь, Ростов', ageSec: 3, consecutiveErrors: 0, counts: [{ name: 'sev-realty', count: 6 }, { name: 'rostov-realty', count: 116 }] },
      { label: 'Земля', ageSec: 15, consecutiveErrors: 0, counts: [{ name: 'sev-land', count: 7 }] },
    ],
  });
  assert.ok(/бот жив/i.test(text));
  assert.ok(text.includes('24'), 'часы периода');
  assert.ok(/новых лотов:? (<b>)?0(<\/b>)?/i.test(text), 'ноль лотов явно назван');
  assert.ok(text.includes('18'), 'сбои посчитаны');
  assert.ok(text.includes('sev-realty=6') && text.includes('rostov-realty=116'));
  assert.ok(/не публиковал|не было/i.test(text), 'объяснение тишины при нуле');
  assert.ok(/нет этого отчёта|отчёта нет/i.test(text), 'подсказка про мёртвого бота');
});

test('buildDigestText: при проблемной группе кричит', () => {
  const text = buildDigestText({
    sinceHours: 24, notified: 2, errors: 40,
    groups: [{ label: 'Авто', ageSec: 7200, consecutiveErrors: 12, counts: [{ name: 'rostov-auto', count: 80 }] }],
  });
  assert.ok(/⚠|ПРОБЛЕМА/i.test(text), 'проблема помечена');
});

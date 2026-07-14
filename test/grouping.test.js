'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { groupFilters, groupLabel } = require('../src/grouping');

const F = (name, catCode, extra = {}) => ({
  name,
  displayName: name,
  dynSubjRF: '26',
  catCode,
  subjectRFCode: '23',
  ...extra,
});

test('регионы одной категории сливаются в одну группу', () => {
  const groups = groupFilters([
    F('sev-realty', '7', { dynSubjRF: '80', subjectRFCode: '92' }),
    F('rostov-realty', '7', { dynSubjRF: '63', subjectRFCode: '61' }),
    F('rostov-auto', '100', { dynSubjRF: '63', subjectRFCode: '61' }),
  ]);
  assert.strictEqual(groups.length, 2);
  assert.deepStrictEqual(groups[0].map((m) => m.name), ['sev-realty', 'rostov-realty']);
});

test('город-фильтр (fiasGUID) НЕ сливается с регионами той же категории', () => {
  const groups = groupFilters([
    F('sev-realty', '7', { dynSubjRF: '80', subjectRFCode: '92' }),
    F('krd-realty', '7', { fiasGUID: 'guid-krd' }),
    F('sochi-realty', '7', { fiasGUID: 'guid-sochi' }),
  ]);
  assert.strictEqual(groups.length, 3, 'регион + 2 города = 3 отдельные линии');
  const names = groups.map((g) => g.map((m) => m.name).join('+'));
  assert.deepStrictEqual(names, ['sev-realty', 'krd-realty', 'sochi-realty']);
});

test('два фильтра с ОДИНАКОВЫМ fiasGUID и категорией сливаются', () => {
  const groups = groupFilters([
    F('a', '2', { fiasGUID: 'g1' }),
    F('b', '2', { fiasGUID: 'g1' }),
  ]);
  assert.strictEqual(groups.length, 1);
});

test('groupLabel: одиночный фильтр — его displayName, группа — «Категория — регионы»', () => {
  const single = [{ displayName: 'г. Сочи · Недвижимость', catCode: '7' }];
  assert.strictEqual(groupLabel(single), 'г. Сочи · Недвижимость');
  const merged = [
    { displayName: 'Севастополь · Недвижимость', catCode: '7' },
    { displayName: 'Ростовская область · Недвижимость', catCode: '7' },
  ];
  assert.strictEqual(groupLabel(merged), 'Недвижимость — Севастополь, Ростовская область');
});

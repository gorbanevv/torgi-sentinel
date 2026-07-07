'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, MAX_SEEN_PER_FILTER } = require('../src/store');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'torgi-store-'));
  return path.join(dir, 'seen.json');
}

test('новый store пуст: не засеян, ничего не видел', () => {
  const s = createStore(tmpFile());
  assert.strictEqual(s.isSeeded('f'), false);
  assert.strictEqual(s.has('f', 'a_1'), false);
  assert.strictEqual(s.count('f'), 0);
});

test('add/has/count работают', () => {
  const s = createStore(tmpFile());
  s.add('f', 'a_1');
  s.add('f', 'b_1');
  assert.strictEqual(s.has('f', 'a_1'), true);
  assert.strictEqual(s.has('f', 'c_1'), false);
  assert.strictEqual(s.count('f'), 2);
  assert.strictEqual(s.count('другой'), 0);
});

test('save/reload: состояние и флаг засева переживают перезапуск', () => {
  const file = tmpFile();
  const s1 = createStore(file);
  s1.add('f', 'a_1');
  s1.markSeeded('f');
  s1.save();

  const s2 = createStore(file);
  assert.strictEqual(s2.has('f', 'a_1'), true);
  assert.strictEqual(s2.isSeeded('f'), true);
  assert.strictEqual(s2.count('f'), 1);
});

test('битый файл не роняет store — старт с чистого состояния', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{оборванный json');
  const s = createStore(file);
  assert.strictEqual(s.isSeeded('f'), false);
  s.add('f', 'x_1');
  s.save();
  assert.strictEqual(createStore(file).has('f', 'x_1'), true);
});

test('prune: не больше MAX_SEEN_PER_FILTER записей после save', () => {
  const file = tmpFile();
  const s = createStore(file);
  for (let i = 0; i < MAX_SEEN_PER_FILTER + 50; i++) s.add('f', `lot_${i}`);
  s.save();
  assert.strictEqual(createStore(file).count('f'), MAX_SEEN_PER_FILTER);
});

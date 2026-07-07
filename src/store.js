'use strict';
const fs = require('fs');
const path = require('path');

// Хранилище «виденных» лотов: JSON-файл, атомарная запись (tmp + rename).
// Структура: { filters: { [имяФильтра]: { seededAt: iso|null, seen: { [lotId]: firstSeenIso } } } }
const MAX_SEEN_PER_FILTER = 20000;

function createStore(filePath) {
  let data = { filters: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.filters) data = parsed;
  } catch {
    // файла нет или он битый — начинаем с чистого состояния
  }

  function bucket(name) {
    if (!data.filters[name]) data.filters[name] = { seededAt: null, seen: {} };
    return data.filters[name];
  }

  function isSeeded(name) { return Boolean(bucket(name).seededAt); }
  function markSeeded(name) { bucket(name).seededAt = new Date().toISOString(); }
  function has(name, lotId) { return Object.prototype.hasOwnProperty.call(bucket(name).seen, lotId); }
  function add(name, lotId) { bucket(name).seen[lotId] = new Date().toISOString(); }
  function count(name) { return Object.keys(bucket(name).seen).length; }

  function prune() {
    for (const name of Object.keys(data.filters)) {
      const seen = data.filters[name].seen;
      const ids = Object.keys(seen);
      if (ids.length <= MAX_SEEN_PER_FILTER) continue;
      ids.sort((a, b) => (seen[a] < seen[b] ? -1 : 1)); // старые в начале
      for (const id of ids.slice(0, ids.length - MAX_SEEN_PER_FILTER)) delete seen[id];
    }
  }

  function save() {
    prune();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath);
  }

  return { isSeeded, markSeeded, has, add, count, save };
}

module.exports = { createStore, MAX_SEEN_PER_FILTER };

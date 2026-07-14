'use strict';

// Раскладка логических фильтров по линиям опроса.
//
// Одна категория по нескольким регионам сливается в ОДИН запрос (API объединяет
// повторяющиеся dynSubjRF). Но фильтр по городу (fiasGUID) применяется ко всему
// запросу целиком, поэтому город-фильтры в регионные линии не вливаются — каждый
// уникальный (catCode + fiasGUID) живёт отдельной линией.
function groupFilters(filters) {
  const groups = new Map();
  for (const f of filters) {
    const key = `${f.catCode}|${f.fiasGUID || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  return [...groups.values()];
}

// «Регион · Категория» → «Категория — Регион, Регион» для логов и алертов.
function groupLabel(members) {
  if (members.length === 1) return members[0].displayName;
  const cat = (members[0].displayName.split('·')[1] || `категория ${members[0].catCode}`).trim();
  const regions = members.map((m) => (m.displayName.split('·')[0] || m.name).trim());
  return `${cat} — ${regions.join(', ')}`;
}

module.exports = { groupFilters, groupLabel };

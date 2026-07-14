'use strict';

// Суточный отчёт: тишина перестаёт быть двусмысленной.
// Отчёт пришёл с нулём — бот жив, на torgi просто не публиковали по фильтрам.
// Отчёта нет в обычное время — бот/VPS лежит, пора проверять руками.

const { escapeHtml } = require('./alerts');

const MSK_OFFSET_MS = 3 * 3600 * 1000;

// Сколько миллисекунд до ближайшего часа hourMsk:00 по Москве (строго в будущем).
function msUntilNextMskHour(hourMsk, nowMs = Date.now()) {
  const msk = nowMs + MSK_OFFSET_MS;
  const next = new Date(msk);
  next.setUTCHours(hourMsk, 0, 0, 0);
  let target = next.getTime();
  if (target <= msk) target += 24 * 3600 * 1000;
  return target - msk;
}

// Чистый строитель текста отчёта; все данные приходят снаружи — тестируем без сети/таймеров.
// groups: [{ label, ageSec|null, consecutiveErrors, counts: [{name, count}] }]
// unknownCategories: [{ code, count }] — коды категорий, не попавшие в дерево классификатора
function buildDigestText({ sinceHours, notified, errors, groups, unknownCategories = [] }) {
  const lines = [];
  const anyTrouble = groups.some((g) => g.consecutiveErrors > 0);
  lines.push(`📊 <b>Суточный отчёт — бот жив${anyTrouble ? ', но есть ⚠' : ''}</b>`);
  lines.push('');
  lines.push(
    `За ${sinceHours}ч: новых лотов: <b>${notified}</b>, тихих сбоев: ${errors}` +
    (errors > 0 ? ' (самоизлечились, вмешательство не требовалось)' : '')
  );
  lines.push('');
  for (const g of groups) {
    const ok = g.consecutiveErrors === 0;
    const age = g.ageSec === null || g.ageSec === undefined ? 'ещё не было' : `${g.ageSec}с назад`;
    const status = ok ? `ок (опрос ${age})` : `⚠ ПРОБЛЕМА: ${g.consecutiveErrors} ошибок подряд, последний успех ${age}`;
    lines.push(`• ${escapeHtml(g.label)}: ${status}`);
    lines.push(`  ${g.counts.map((c) => `${c.name}=${c.count}`).join(', ')}`);
  }
  lines.push('');
  if (unknownCategories.length > 0) {
    const items = unknownCategories.map((u) => `${escapeHtml(u.code)}×${u.count}`).join(', ');
    lines.push(`⚙️ Неопознанные категории за период: ${items} — если это не мусор (стройматериалы и т.п.), нужно расширить дерево категорий.`);
    lines.push('');
  }
  if (notified === 0) {
    lines.push('Ноль лотов = torgi не публиковал ничего нового по вашим фильтрам — бот работал штатно.');
  }
  lines.push('<i>Если этого отчёта нет в обычное время — бот лежит, проверь VPS.</i>');
  return lines.join('\n');
}

module.exports = { buildDigestText, msUntilNextMskHour };

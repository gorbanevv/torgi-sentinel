'use strict';

// Карточка лота torgi.gov.ru → сообщение для Telegram (HTML parse_mode).
// Чистые функции, без сети.

const LOT_URL_BASE = 'https://torgi.gov.ru/new/public/lots/lot/';
const CAPTION_LIMIT = 1024; // лимит Telegram на подпись к фото
const TEXT_LIMIT = 4096; // лимит Telegram на текстовое сообщение

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtml(s) {
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function truncate(s, max) {
  s = String(s);
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

function formatPrice(v) {
  const num = Number(v);
  if (!Number.isFinite(num)) return null;
  const [int, frac] = num.toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return frac === '00' ? grouped : grouped + ',' + frac;
}

function formatDateMsk(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const msk = new Date(d.getTime() + 3 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(msk.getUTCDate())}.${p(msk.getUTCMonth() + 1)}.${msk.getUTCFullYear()} ${p(msk.getUTCHours())}:${p(msk.getUTCMinutes())} МСК`;
}

// characteristics[].characteristicValue бывает числом, строкой или объектом {name,...}
function rawValue(ch) {
  let v = ch.characteristicValue !== undefined ? ch.characteristicValue : ch.value;
  if (v && typeof v === 'object') v = v.name !== undefined ? v.name : v.value;
  return v;
}

function extractArea(lot) {
  for (const ch of lot.characteristics || []) {
    const label = String(ch.name || ch.fullName || '');
    const code = String(ch.code || '');
    if (!/площад/i.test(label) && !/square|area/i.test(code)) continue;
    const v = rawValue(ch);
    if (v === undefined || v === null || v === '') continue;
    const num = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(num) || num <= 0) continue;
    let unit = 'кв. м';
    const u = ch.unit && (typeof ch.unit === 'object' ? ch.unit.name : ch.unit);
    if (typeof u === 'string' && u) unit = /квадратн/i.test(u) ? 'кв. м' : u;
    return { value: num, unit, label };
  }
  return null;
}

function extractAddress(lot) {
  const all = [...(lot.characteristics || []), ...(lot.attributes || [])];
  for (const ch of all) {
    const label = String(ch.name || ch.fullName || '');
    if (!/адрес|местополож/i.test(label)) continue;
    const v = rawValue(ch);
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function formatAreaValue(n) {
  return Number.isInteger(n) ? String(n) : String(n).replace('.', ',');
}

function buildLines(lot, filter, { withDescription = true, withAddress = true } = {}) {
  const icon = filter.realEstate ? '🏠' : '🚗';
  const lines = [];
  lines.push(`${icon} <b>Новый лот · ${escapeHtml(filter.displayName || filter.name)}</b>`);
  lines.push('');
  lines.push(`<b>${escapeHtml(truncate(lot.lotName || 'Без названия', 250))}</b>`);
  const desc = (lot.lotDescription || '').trim();
  if (withDescription && desc && desc !== (lot.lotName || '').trim()) {
    lines.push(escapeHtml(truncate(desc, 250)));
  }
  lines.push('');
  const area = extractArea(lot);
  if (area) {
    lines.push(`📐 ${escapeHtml(area.label || 'Площадь')}: <b>${formatAreaValue(area.value)} ${escapeHtml(area.unit)}</b>`);
  }
  const price = formatPrice(lot.priceMin !== undefined ? lot.priceMin : lot.priceMinExact);
  if (price) lines.push(`💰 Начальная цена: <b>${price} ₽</b>`);
  const bidd = [lot.biddType && lot.biddType.name, lot.biddForm && lot.biddForm.name].filter(Boolean).join(' · ');
  if (bidd) lines.push(`📋 ${escapeHtml(bidd)}`);
  const end = formatDateMsk(lot.biddEndTime);
  if (end) lines.push(`⏳ Приём заявок до: ${end}`);
  const addr = withAddress ? extractAddress(lot) : null;
  if (addr) lines.push(`📍 ${escapeHtml(truncate(addr, 200))}`);
  if (lot.category && lot.category.name) lines.push(`🏷 ${escapeHtml(lot.category.name)}`);
  lines.push('');
  const id = lot.id || `${lot.noticeNumber}_${lot.lotNumber}`;
  lines.push(LOT_URL_BASE + id);
  return lines.join('\n');
}

const MAX_PHOTOS = 10; // потолок альбома Telegram — больше в одно сообщение не влезает

function formatLotMessage(lot, filter) {
  const imageIds = Array.isArray(lot.lotImages) ? lot.lotImages.filter(Boolean).slice(0, MAX_PHOTOS) : [];
  const limit = imageIds.length > 0 ? CAPTION_LIMIT : TEXT_LIMIT;
  let text = buildLines(lot, filter);
  if (text.length > limit) text = buildLines(lot, filter, { withDescription: false });
  if (text.length > limit) text = buildLines(lot, filter, { withDescription: false, withAddress: false });
  if (text.length > limit) text = text.slice(0, limit - 1) + '…'; // крайний случай
  return { text, imageIds };
}

module.exports = {
  formatLotMessage,
  escapeHtml,
  stripHtml,
  truncate,
  formatPrice,
  formatDateMsk,
  extractArea,
  extractAddress,
  CAPTION_LIMIT,
  TEXT_LIMIT,
  MAX_PHOTOS,
};

'use strict';
const https = require('https');

const BASE = 'https://torgi.gov.ru';

// Параметры подтверждены вживую: lotStatus и dynSubjRF (повтор параметра = объединение
// значений — несколько статусов/регионов одним запросом), catCode (строго один),
// page (0-based), sort, fiasGUID (фильтр «Местонахождение имущества» — ФИАС-код города,
// тот же параметр шлёт сам сайт; найден в JS-бандле портала, проверен вживую:
// Краснодар 7dfa745e-…, Сочи 79da737a-…). dynSubjRF: строка или массив строк.
const DEFAULT_STATUSES = ['PUBLISHED', 'APPLICATIONS_SUBMISSION'];
function buildSearchQuery({ dynSubjRF, catCode, fiasGUID, size = 20, page = 0, lotStatuses = DEFAULT_STATUSES } = {}) {
  const q = new URLSearchParams();
  for (const st of lotStatuses.length ? lotStatuses : DEFAULT_STATUSES) q.append('lotStatus', st);
  for (const r of Array.isArray(dynSubjRF) ? dynSubjRF : [dynSubjRF]) {
    if (r !== undefined && r !== null && String(r) !== '') q.append('dynSubjRF', String(r));
  }
  if (catCode !== undefined && catCode !== null && String(catCode) !== '') q.set('catCode', String(catCode));
  for (const g of Array.isArray(fiasGUID) ? fiasGUID : [fiasGUID]) {
    if (g !== undefined && g !== null && String(g) !== '') q.append('fiasGUID', String(g));
  }
  q.set('size', String(size));
  q.set('page', String(page));
  q.set('sort', 'firstVersionPublicationDate,desc');
  return q.toString();
}

// Тёплое keep-alive соединение — ядро скорости (0.23с против 3.3с на холодном TLS).
// rejectUnauthorized:false — сертификат портала не проходит стандартную валидацию (§7 спеки).
// localAddress — привязка исходящих запросов к конкретному IP сервера (тот, что не в
// блоклисте torgi; на Timeweb основной IP блокируется, а доп. 92.51.23.164 — проходит).
// limiter — глобальный дозатор (см. rateLimiter.js): все запросы к torgi идут через
// одну очередь с зазором, иначе поллеры конкурируют за per-IP лимит и «хвостовые»
// фильтры вечно получают 503.
function createTorgiClient({ timeoutMs = 15000, localAddress, limiter } = {}) {
  const throttled = (fn) => (limiter ? limiter.schedule(fn) : fn());
  const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 4,
    rejectUnauthorized: false,
    ...(localAddress ? { localAddress } : {}),
  });

  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  };

  function getJson(pathAndQuery) {
    return new Promise((resolve, reject) => {
      const req = https.get(BASE + pathAndQuery, { agent, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`torgi HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`torgi bad JSON: ${e.message}`)); }
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`torgi timeout ${timeoutMs}ms`)));
      req.on('error', reject);
    });
  }

  function searchLots(params = {}) {
    return throttled(() => getJson('/new/api/public/lotcards/search?' + buildSearchQuery(params)));
  }

  // Деталь лота: нормализованный estateAddress и полные атрибуты (для привязки к городу).
  function getLotDetail(lotId) {
    return throttled(() => getJson('/new/api/public/lotcards/' + encodeURIComponent(lotId)));
  }

  function downloadImage(imageId, opts = {}) {
    return throttled(() => rawDownloadImage(imageId, opts));
  }

  function rawDownloadImage(imageId, { maxBytes = 9 * 1024 * 1024, imageTimeoutMs = 12000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.get(`${BASE}/new/file-store/v1/${imageId}`, { agent, headers }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`image HTTP ${res.statusCode}`)); }
        const ct = res.headers['content-type'] || '';
        if (!ct.startsWith('image/')) { res.resume(); return reject(new Error(`не картинка: ${ct}`)); }
        const chunks = [];
        let len = 0;
        res.on('data', (c) => {
          len += c.length;
          if (len > maxBytes) { req.destroy(new Error('image too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: ct }));
      });
      req.setTimeout(imageTimeoutMs, () => req.destroy(new Error('image timeout')));
      req.on('error', reject);
    });
  }

  return { searchLots, getLotDetail, downloadImage, agent };
}

module.exports = { createTorgiClient, buildSearchQuery };

'use strict';
const https = require('https');

const BASE = 'https://torgi.gov.ru';

// Тёплое keep-alive соединение — ядро скорости (0.23с против 3.3с на холодном TLS).
// rejectUnauthorized:false — сертификат портала не проходит стандартную валидацию (§7 спеки).
// localAddress — привязка исходящих запросов к конкретному IP сервера (тот, что не в
// блоклисте torgi; на Timeweb основной IP блокируется, а доп. 92.51.23.164 — проходит).
function createTorgiClient({ timeoutMs = 15000, localAddress } = {}) {
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

  // Параметры подтверждены вживую: lotStatus (повтор = объединение статусов),
  // dynSubjRF, catCode, page (0-based), sort.
  const DEFAULT_STATUSES = ['PUBLISHED', 'APPLICATIONS_SUBMISSION'];
  function searchLots({ dynSubjRF, catCode, size = 20, page = 0, lotStatuses = DEFAULT_STATUSES } = {}) {
    const q = new URLSearchParams();
    for (const st of lotStatuses.length ? lotStatuses : DEFAULT_STATUSES) q.append('lotStatus', st);
    if (dynSubjRF !== undefined && dynSubjRF !== null && String(dynSubjRF) !== '') q.set('dynSubjRF', String(dynSubjRF));
    if (catCode !== undefined && catCode !== null && String(catCode) !== '') q.set('catCode', String(catCode));
    q.set('size', String(size));
    q.set('page', String(page));
    q.set('sort', 'firstVersionPublicationDate,desc');
    return getJson('/new/api/public/lotcards/search?' + q.toString());
  }

  function downloadImage(imageId, { maxBytes = 9 * 1024 * 1024, imageTimeoutMs = 12000 } = {}) {
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

  return { searchLots, downloadImage, agent };
}

module.exports = { createTorgiClient };

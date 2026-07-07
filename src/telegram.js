'use strict';
const https = require('https');
const http = require('http');

// Telegram Bot API напрямую через https, ЛИБО через релей на VPS (apiBase = http/https://host:port).
// Релей нужен, когда оператор режет api.telegram.org (тогда телефон шлёт через VPS).
// Ретраи: сеть/5xx/429 (с учётом retry_after). 4xx кроме 429 — не ретраим, бросаем.
function createTelegram({
  botToken,
  chatId,
  apiBase = 'https://api.telegram.org',
  timeoutMs = 20000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });

  function httpPost(url, bodyBuffer, contentType) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const isHttps = u.protocol === 'https:';
      const mod = isHttps ? https : http;
      const req = mod.request(
        {
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          agent: isHttps ? httpsAgent : httpAgent,
          rejectUnauthorized: false, // релей на VPS с самоподписанным сертификатом
          headers: { 'Content-Type': contentType, 'Content-Length': bodyBuffer.length },
        },
        (res) => {
          let s = '';
          res.setEncoding('utf8');
          res.on('data', (d) => { s += d; });
          res.on('end', () => {
            try { resolve(JSON.parse(s)); } catch { reject(new Error(`telegram bad JSON (HTTP ${res.statusCode}): ${s.slice(0, 120)}`)); }
          });
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('telegram timeout')));
      req.on('error', reject);
      req.end(bodyBuffer);
    });
  }

  function apiCall(method, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    return httpPost(`${apiBase}/bot${botToken}/${method}`, body, 'application/json');
  }

  function multipart(fields, file) {
    const boundary = '----TorgiSentinel' + Math.random().toString(16).slice(2);
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
    ));
    parts.push(file.buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return { buffer: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  async function callWithRetry(fn, label, maxAttempts = 4) {
    let attempt = 0;
    for (;;) {
      attempt++;
      let result;
      let err;
      try { result = await fn(); } catch (e) { err = e; }
      if (result && result.ok) return result;
      const retryAfter = result && result.parameters && result.parameters.retry_after;
      const desc = err ? err.message : `${result.error_code}: ${result.description}`;
      const retriable = Boolean(err) || (result && (result.error_code === 429 || result.error_code >= 500));
      if (!retriable || attempt >= maxAttempts) throw new Error(`telegram ${label}: ${desc}`);
      await sleep(retryAfter ? retryAfter * 1000 : Math.min(2000 * 2 ** (attempt - 1), 30000));
    }
  }

  function sendMessage(text) {
    return callWithRetry(
      () => apiCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      'sendMessage'
    );
  }

  function sendMessagePlain(text) {
    return callWithRetry(
      () => apiCall('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }),
      'sendMessagePlain'
    );
  }

  function sendPhoto(photoBuffer, contentType, caption) {
    const { buffer, contentType: ct } = multipart(
      { chat_id: String(chatId), caption, parse_mode: 'HTML' },
      { name: 'photo', filename: 'photo.jpg', contentType: contentType || 'image/jpeg', buffer: photoBuffer }
    );
    return callWithRetry(() => httpPost(`${apiBase}/bot${botToken}/sendPhoto`, buffer, ct), 'sendPhoto');
  }

  return { sendMessage, sendMessagePlain, sendPhoto };
}

module.exports = { createTelegram };

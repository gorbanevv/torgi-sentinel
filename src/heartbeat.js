'use strict';
const https = require('https');
const http = require('http');

// Периодически стучится «я жив» на VPS (relay /heartbeat). Если url не задан — ничего не делает.
function startHeartbeat({ url, token, intervalMs = 120000, log = () => {} }) {
  if (!url) return { stop: () => {} };

  function ping() {
    try {
      const u = new URL(url);
      const isHttps = u.protocol === 'https:';
      const mod = isHttps ? https : http;
      const req = mod.request(
        {
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          rejectUnauthorized: false,
          timeout: 15000,
          headers: { 'Content-Length': 0, ...(token ? { 'X-HB': token } : {}) },
        },
        (res) => res.resume()
      );
      req.on('timeout', () => req.destroy());
      req.on('error', (e) => log(`[heartbeat] не ушёл: ${e.message}`));
      req.end();
    } catch (e) {
      log(`[heartbeat] ошибка: ${e.message}`);
    }
  }

  ping();
  const t = setInterval(ping, intervalMs);
  if (t.unref) t.unref();
  return { stop: () => clearInterval(t) };
}

module.exports = { startHeartbeat };

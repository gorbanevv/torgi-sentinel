'use strict';
// Прозрачный релей к api.telegram.org для случая, когда оператор телефона режет Bot API.
// Телефон шлёт свои Telegram-запросы сюда (на VPS), релей передаёт их в Telegram и
// возвращает ответ. Доступ ограничен путём /bot<token>/... — знать токен = уже иметь доступ
// к Telegram напрямую, так что отдельный секрет не нужен.
// Запуск: RELAY_PORT=443 node relay.js   (серт в /etc/torgi-sentinel/relay/{key,cert}.pem)
const https = require('https');
const fs = require('fs');

const PORT = Number(process.env.RELAY_PORT || 8443);
const CERT_DIR = process.env.RELAY_CERT_DIR || '/etc/torgi-sentinel/relay';
const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/etc/torgi-sentinel/heartbeat';
const HB_TOKEN = process.env.RELAY_HB || ''; // секрет heartbeat (обычно = bot token)
const TARGET = 'api.telegram.org';

const server = https.createServer(
  { key: fs.readFileSync(CERT_DIR + '/key.pem'), cert: fs.readFileSync(CERT_DIR + '/cert.pem') },
  (req, res) => {
    // телефон стучится «я жив»
    if (req.url === '/heartbeat') {
      if (HB_TOKEN && req.headers['x-hb'] !== HB_TOKEN) { res.writeHead(403); return res.end('no'); }
      try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch {}
      res.writeHead(200); return res.end('ok');
    }
    // диагностика: когда был последний heartbeat
    if (req.url === '/health') {
      let last = 0; try { last = Number(fs.readFileSync(HEARTBEAT_FILE, 'utf8')); } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ relay: 'ok', lastHeartbeatSecAgo: last ? Math.round((Date.now() - last) / 1000) : null }));
    }
    if (!req.url.startsWith('/bot')) { res.writeHead(403); return res.end('forbidden'); }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, host: TARGET };
      const preq = https.request(
        { host: TARGET, port: 443, path: req.url, method: req.method, headers },
        (pres) => { res.writeHead(pres.statusCode, pres.headers); pres.pipe(res); }
      );
      preq.setTimeout(25000, () => preq.destroy(new Error('upstream timeout')));
      preq.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end('upstream: ' + e.message); });
      preq.end(body);
    });
    req.on('error', () => { try { res.writeHead(400); res.end(); } catch {} });
  }
);
server.listen(PORT, () => console.log(new Date().toISOString() + ' relay listening on :' + PORT + ' -> ' + TARGET));

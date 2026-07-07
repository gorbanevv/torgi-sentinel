'use strict';
// Читает VPN-ключ из ФАЙЛА (путь в env KEY_FILE) и пишет конфиг Xray в OUT.
// НИКОГДА не печатает сам ключ, UUID, пароль или хост — только тип протокола и «ок».
// Поддержка: vless://, trojan://, ss://, vmess://, а также http(s) подписка (берём первый ключ).
// Запуск: KEY_FILE=/path/key OUT=/path/xray.json node keyfile-to-xray.js
const fs = require('fs');
const https = require('https');
const http = require('http');

const KEY_FILE = process.env.KEY_FILE;
const OUT = process.env.OUT || '/etc/torgi-sentinel/xray.json';
const SOCKS_PORT = Number(process.env.SOCKS_PORT || 10808);

if (!KEY_FILE || !fs.existsSync(KEY_FILE)) { console.error('нет файла ключа (env KEY_FILE)'); process.exit(1); }

function fail(msg) { console.error('ошибка разбора ключа:', msg); process.exit(2); }

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { rejectUnauthorized: false, headers: { 'User-Agent': 'torgi-sentinel' } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(s));
    }).on('error', reject);
  });
}

function maybeB64(s) {
  // строка подписки часто base64; пробуем декодировать, если это не url со схемой
  if (/^[a-z]+:\/\//i.test(s.trim())) return s;
  try {
    const dec = Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (/:\/\//.test(dec)) return dec;
  } catch {}
  return s;
}

function parseVless(u) {
  const url = new URL(u);
  const p = url.searchParams;
  const net = p.get('type') || 'tcp';
  const sec = p.get('security') || 'none';
  const stream = { network: net, security: sec === 'reality' ? 'reality' : sec === 'tls' || sec === 'xtls' ? 'tls' : 'none' };
  const sni = p.get('sni') || p.get('host') || '';
  const fp = p.get('fp') || 'chrome';
  if (stream.security === 'reality') {
    stream.realitySettings = { serverName: sni, fingerprint: fp, publicKey: p.get('pbk') || '', shortId: p.get('sid') || '', spiderX: p.get('spx') || '' };
  } else if (stream.security === 'tls') {
    stream.tlsSettings = { serverName: sni, fingerprint: fp, allowInsecure: false };
  }
  if (net === 'ws') stream.wsSettings = { path: p.get('path') || '/', headers: p.get('host') ? { Host: p.get('host') } : {} };
  if (net === 'grpc') stream.grpcSettings = { serviceName: p.get('serviceName') || '' };
  return {
    protocol: 'vless',
    settings: { vnext: [{ address: url.hostname, port: Number(url.port) || 443, users: [{ id: decodeURIComponent(url.username), encryption: 'none', flow: p.get('flow') || '' }] }] },
    streamSettings: stream,
  };
}

function parseTrojan(u) {
  const url = new URL(u);
  const p = url.searchParams;
  const net = p.get('type') || 'tcp';
  return {
    protocol: 'trojan',
    settings: { servers: [{ address: url.hostname, port: Number(url.port) || 443, password: decodeURIComponent(url.username) }] },
    streamSettings: { network: net, security: 'tls', tlsSettings: { serverName: p.get('sni') || p.get('host') || url.hostname, fingerprint: p.get('fp') || 'chrome' } },
  };
}

function parseSS(u) {
  // ss://base64(method:password)@host:port  или ss://base64(method:password@host:port)
  let rest = u.slice('ss://'.length);
  const hash = rest.indexOf('#'); if (hash >= 0) rest = rest.slice(0, hash);
  let method, password, host, port;
  if (rest.includes('@')) {
    const [userinfo, hp] = rest.split('@');
    const dec = Buffer.from(userinfo, 'base64').toString('utf8');
    [method, password] = dec.split(':');
    [host, port] = hp.split(':');
  } else {
    const dec = Buffer.from(rest, 'base64').toString('utf8');
    const at = dec.lastIndexOf('@');
    [method, password] = dec.slice(0, at).split(':');
    [host, port] = dec.slice(at + 1).split(':');
  }
  return { protocol: 'shadowsocks', settings: { servers: [{ address: host, port: Number(port), method, password }] }, streamSettings: { network: 'tcp' } };
}

function parseVmess(u) {
  const j = JSON.parse(Buffer.from(u.slice('vmess://'.length), 'base64').toString('utf8'));
  const net = j.net || 'tcp';
  const stream = { network: net, security: j.tls === 'tls' ? 'tls' : 'none' };
  if (j.tls === 'tls') stream.tlsSettings = { serverName: j.sni || j.host || j.add, allowInsecure: false };
  if (net === 'ws') stream.wsSettings = { path: j.path || '/', headers: j.host ? { Host: j.host } : {} };
  return { protocol: 'vmess', settings: { vnext: [{ address: j.add, port: Number(j.port), users: [{ id: j.id, alterId: Number(j.aid || 0), security: 'auto' }] }] }, streamSettings: stream };
}

function toOutbound(link) {
  link = link.trim();
  if (link.startsWith('vless://')) return parseVless(link);
  if (link.startsWith('trojan://')) return parseTrojan(link);
  if (link.startsWith('ss://')) return parseSS(link);
  if (link.startsWith('vmess://')) return parseVmess(link);
  fail('неизвестная схема (ожидались vless/trojan/ss/vmess)');
}

(async () => {
  let raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
  // подписка по ссылке?
  if (/^https?:\/\//i.test(raw)) raw = await fetchText(raw);
  raw = maybeB64(raw);
  // берём первую валидную строку-ключ
  const line = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => /^(vless|trojan|ss|vmess):\/\//i.test(s));
  if (!line) fail('в файле не найдено ключа vless/trojan/ss/vmess');
  const outbound = toOutbound(line);
  outbound.tag = 'proxy';

  const config = {
    log: { loglevel: 'warning' }, // важно: не 'debug', чтобы ключ не попал в логи
    inbounds: [{ tag: 'socks', listen: '127.0.0.1', port: SOCKS_PORT, protocol: 'socks', settings: { udp: true } }],
    outbounds: [outbound, { protocol: 'freedom', tag: 'direct' }],
  };
  fs.mkdirSync(require('path').dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(config, null, 2), { mode: 0o600 });
  // безопасный вывод: только протокол/транспорт/безопасность, без секретов и хоста
  console.log(`ok: протокол=${outbound.protocol} транспорт=${outbound.streamSettings.network} безопасность=${outbound.streamSettings.security} socks=127.0.0.1:${SOCKS_PORT}`);
})().catch((e) => fail(e.message));

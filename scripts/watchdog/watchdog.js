'use strict';
// Сторож на VPS: следит за heartbeat телефона (файл, куда пишет relay).
// Если телефон молчит дольше порога — шлёт алерт в Telegram (VPS достаёт Telegram напрямую).
const fs = require('fs');
const { createTelegram } = require('../../src/telegram');

const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE || '/etc/torgi-sentinel/heartbeat';
const STALE_SEC = Number(process.env.WATCHDOG_STALE_SEC || 480); // 8 минут
const CHECK_MS = Number(process.env.WATCHDOG_CHECK_MS || 60000);

const tg = createTelegram({ botToken: process.env.TG_TOKEN, chatId: process.env.TG_CHAT }); // apiBase = api.telegram.org

let haveSeen = false;
let alerted = false;
const log = (m) => console.log(new Date().toISOString(), m);
const lastTs = () => { try { return Number(fs.readFileSync(HEARTBEAT_FILE, 'utf8')) || 0; } catch { return 0; } };

async function tick() {
  const last = lastTs();
  if (!last) return; // ещё ни одного heartbeat — ждём (не спамим на старте)
  const ageSec = Math.round((Date.now() - last) / 1000);
  if (ageSec <= STALE_SEC) {
    haveSeen = true;
    if (alerted) {
      alerted = false;
      log('recovered');
      try { await tg.sendMessage('✅ <b>Бот на телефоне снова на связи</b> — мониторинг лотов возобновлён.'); } catch (e) { log('send err ' + e.message); }
    }
  } else if (haveSeen && !alerted) {
    alerted = true;
    log('STALE ' + ageSec + 's');
    try {
      await tg.sendMessage(`⚠️ <b>Бот на телефоне молчит ${Math.round(ageSec / 60)} мин.</b>\nПроверь телефон: включён? в сети? Termux не убит?\n(лоты сейчас НЕ отслеживаются)`);
    } catch (e) { log('send err ' + e.message); }
  }
}

(async () => {
  log(`watchdog старт, порог ${STALE_SEC}s, файл ${HEARTBEAT_FILE}`);
  try { await tg.sendMessage('🛡 <b>Watchdog активен</b>: слежу за телефоном и сообщу, если он замолчит.'); } catch {}
  setInterval(() => tick().catch((e) => log('tick err ' + e.message)), CHECK_MS);
  tick();
})();

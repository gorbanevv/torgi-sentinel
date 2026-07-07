#!/usr/bin/env bash
# Поднимает локальный SOCKS-прокси через Sota VPN на VPS и проверяет torgi.
# Ключ читается ИЗ ФАЙЛА и никогда не печатается. Скрипт аудируем — секретов не выводит.
# Запуск на VPS:  bash scripts/vpn/proxy-up.sh
set -uo pipefail

KEY_FILE="${KEY_FILE:-/etc/torgi-sentinel/sota.key}"
XRAY_CONF="${XRAY_CONF:-/etc/torgi-sentinel/xray.json}"
SOCKS_PORT="${SOCKS_PORT:-10808}"
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

mask() { sed -E 's/[A-Za-z0-9_+/=-]{16,}/***/g'; }  # маскируем длинные строки в любом выводе

if [ ! -s "$KEY_FILE" ]; then
  echo "❌ Ключ не найден: $KEY_FILE"
  echo "   Положи его туда САМ из своего ssh (я не увижу):"
  echo "     umask 077; mkdir -p /etc/torgi-sentinel"
  echo "     cat > $KEY_FILE      # вставь ключ, потом Enter, потом Ctrl+D"
  echo "     chmod 600 $KEY_FILE"
  exit 1
fi
echo "ключ найден: $(wc -c < "$KEY_FILE") байт (содержимое не показываю)"

# --- установка xray-core при отсутствии ---
if [ ! -x /usr/local/bin/xray ] && ! command -v xray >/dev/null 2>&1; then
  echo ">>> ставлю xray-core"
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq unzip curl >/dev/null 2>&1 || true
  tmp="$(mktemp -d)"
  if ! curl -fsSL -o "$tmp/x.zip" https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip; then
    echo "❌ не смог скачать xray"; rm -rf "$tmp"; exit 1
  fi
  unzip -o -q "$tmp/x.zip" -d "$tmp"
  install -m755 "$tmp/xray" /usr/local/bin/xray
  rm -rf "$tmp"
fi
echo "xray: $(/usr/local/bin/xray version 2>/dev/null | head -1)"

# --- конфиг из ключа (без печати ключа) ---
echo ">>> собираю конфиг xray из ключа"
if ! KEY_FILE="$KEY_FILE" OUT="$XRAY_CONF" SOCKS_PORT="$SOCKS_PORT" node "$APP_DIR/scripts/vpn/keyfile-to-xray.js"; then
  echo "❌ не удалось разобрать ключ"; exit 1
fi
chmod 600 "$XRAY_CONF"

# --- systemd-сервис для xray ---
cat > /etc/systemd/system/torgi-xray.service <<UNIT
[Unit]
Description=Xray proxy for Torgi Sentinel (Sota VPN egress)
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/bin/xray run -c ${XRAY_CONF}
Restart=always
RestartSec=3
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable torgi-xray >/dev/null 2>&1 || true
systemctl restart torgi-xray
sleep 3
if ! systemctl is-active --quiet torgi-xray; then
  echo "❌ xray не поднялся. Последние строки (замаскировано):"
  journalctl -u torgi-xray -n 8 --no-pager | mask
  exit 1
fi
echo "xray активен (SOCKS 127.0.0.1:${SOCKS_PORT})"

# --- ТЕСТ: torgi через Sota ---
echo ">>> тест torgi через Sota…"
code="$(curl -sk --socks5-hostname 127.0.0.1:${SOCKS_PORT} --max-time 20 -o /dev/null -w '%{http_code}' 'https://torgi.gov.ru/new/api/public/lotcards/search?size=1' 2>/dev/null || echo 000)"
exitip="$(curl -s --socks5-hostname 127.0.0.1:${SOCKS_PORT} --max-time 15 https://api.ipify.org 2>/dev/null || echo '?')"
echo "выходной IP Sota: ${exitip}"
echo "torgi HTTP через Sota: ${code}"
echo "======================================================"
if [ "$code" = "200" ]; then
  echo "✅ РАБОТАЕТ! torgi доступен через Sota VPN. Можно подключать бота к прокси."
else
  echo "❌ НЕ работает (код ${code}). IP Sota, похоже, тоже в бане у torgi."
  echo "   Попробуй в приложении Sota сменить локацию (лучше РФ) и обнови ключ в файле, потом повтори."
fi
echo "======================================================"

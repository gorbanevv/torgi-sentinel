#!/usr/bin/env bash
# Деплой Torgi Sentinel на VPS. Запускать из КОРНЯ репозитория:
#   ./deploy/deploy.sh root@ВАШ_VPS_IP
set -euo pipefail
HOST="${1:?Использование: ./deploy/deploy.sh user@host}"
DIR=/opt/torgi-sentinel

echo "==> Проверяю Node (нужен >=18) на $HOST"
ssh "$HOST" '
  v=$(node -v 2>/dev/null | sed "s/^v//;s/\..*//") || v=0
  if [ "${v:-0}" -lt 18 ]; then
    echo "node отсутствует или старый — ставлю Node 22 LTS (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  node -v
'

echo "==> Копирую код в $DIR"
tar cz --exclude=.git --exclude=data --exclude=config.json --exclude=node_modules . \
  | ssh "$HOST" "mkdir -p $DIR && tar xz -C $DIR"

echo "==> Ставлю systemd-юнит"
ssh "$HOST" "cp $DIR/deploy/torgi-sentinel.service /etc/systemd/system/ \
  && systemctl daemon-reload && systemctl enable torgi-sentinel"

echo "==> Код на месте. Дальше на VPS:"
echo "    1) создай $DIR/config.json (образец: $DIR/config.example.json) с токеном и chat_id"
echo "    2) systemctl restart torgi-sentinel && journalctl -u torgi-sentinel -f"

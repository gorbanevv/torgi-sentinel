#!/usr/bin/env bash
# Перебирает все серверы из сохранённой Happ-подписки (/etc/torgi-sentinel/happ.raw)
# и проверяет, какой из них пробивает до torgi.gov.ru. Подписку НЕ трогает (слоты не жрёт).
# Результат пишется в /etc/torgi-sentinel/test-results.txt
set -uo pipefail
DIR=/etc/torgi-sentinel
PORT=10809
mkdir -p "$DIR/test"

# 1) из happ.raw делаем по одному тест-конфигу xray на сервер (socks + один outbound)
node -e '
const fs=require("fs");
const configs=JSON.parse(fs.readFileSync("/etc/torgi-sentinel/happ.raw","utf8"));
const SP=new Set(["vless","vmess","trojan","shadowsocks"]);
const seen=new Set(); let n=0;
for(const cfg of (Array.isArray(configs)?configs:[configs])){
  for(const ob of (cfg.outbounds||[])){
    if(!SP.has(ob.protocol))continue;
    const vn=ob.settings&&(ob.settings.vnext||ob.settings.servers);
    const addr=vn&&vn[0]?vn[0].address:""; const port=vn&&vn[0]?vn[0].port:"";
    const key=ob.protocol+"|"+addr+"|"+port; if(seen.has(key))continue; seen.add(key);
    const o=JSON.parse(JSON.stringify(ob)); o.tag="proxy";
    const conf={log:{loglevel:"error"},
      inbounds:[{tag:"s",listen:"127.0.0.1",port:'"$PORT"',protocol:"socks",settings:{udp:true}}],
      outbounds:[o,{protocol:"freedom",tag:"direct"}]};
    fs.writeFileSync("/etc/torgi-sentinel/test/srv-"+n+".json",JSON.stringify(conf));
    n++;
  }
}
fs.writeFileSync("/etc/torgi-sentinel/test/count.txt",String(n));
'
COUNT=$(cat "$DIR/test/count.txt")

: > "$DIR/test-results.txt"
echo "серверов к тесту: $COUNT" >> "$DIR/test-results.txt"
WORKING=""
for i in $(seq 0 $((COUNT-1))); do
  /usr/local/bin/xray run -c "$DIR/test/srv-$i.json" >/dev/null 2>&1 &
  XPID=$!
  sleep 2.5
  code=$(curl -sk --socks5-hostname 127.0.0.1:$PORT --max-time 8 -o /dev/null -w '%{http_code}' 'https://torgi.gov.ru/new/api/public/lotcards/search?size=1' 2>/dev/null || echo 000)
  ip=""
  if [ "$code" = "200" ]; then
    ip=$(curl -s --socks5-hostname 127.0.0.1:$PORT --max-time 6 https://api.ipify.org 2>/dev/null || echo "?")
    WORKING="$WORKING $i"
  fi
  kill "$XPID" 2>/dev/null; wait "$XPID" 2>/dev/null
  line="srv-$i: torgi=$code${ip:+  exitIP=$ip}"
  echo "$line" >> "$DIR/test-results.txt"
done
echo "РАБОЧИЕ серверы (torgi=200):${WORKING:- нет}" >> "$DIR/test-results.txt"
echo "=== DONE ===" >> "$DIR/test-results.txt"

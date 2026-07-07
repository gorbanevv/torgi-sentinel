#!/data/data/com.termux/files/usr/bin/bash
# Авто-установщик Torgi Sentinel для Termux.
# Делает всё сам: конфиг из TG_TOKEN/TG_CHAT, автозапуск при загрузке, wake-lock, старт бота.
# Идемпотентен: можно запускать повторно (обновление/перезапуск).
#
# Обычно вызывается одной строкой (см. TERMUX.md):
#   TG_TOKEN='...' TG_CHAT='...' bash ~/torgi-sentinel/scripts/setup.sh

APP_DIR="$HOME/torgi-sentinel"
cd "$APP_DIR" 2>/dev/null || { echo "❌ нет каталога $APP_DIR (сначала git clone)"; exit 1; }

say() { echo ""; echo ">>> $*"; }

# 1) Конфиг: берём образец, вписываем токен/chat. Если config.json уже есть и env не задан — не трогаем.
if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
  say "Пишу config.json с твоим токеном и chat_id"
  node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('config.example.json','utf8'));c.telegramBotToken=process.env.TG_TOKEN;c.telegramChatId=process.env.TG_CHAT;fs.writeFileSync('config.json',JSON.stringify(c,null,2));console.log('   ok, фильтров:',c.filters.length);"
elif [ ! -f config.json ]; then
  echo "❌ Нет config.json и не передан TG_TOKEN/TG_CHAT. Запусти так:"
  echo "   TG_TOKEN='токен' TG_CHAT='chat_id' bash scripts/setup.sh"
  exit 1
else
  say "config.json уже есть — оставляю как есть"
fi

# 2) Автозапуск при загрузке телефона (нужен установленный Termux:Boot)
say "Ставлю автозапуск при загрузке телефона"
mkdir -p "$HOME/.termux/boot"
cp "$APP_DIR/scripts/run-forever.sh" "$HOME/.termux/boot/torgi-sentinel.sh"
chmod +x "$HOME/.termux/boot/torgi-sentinel.sh"
echo "   ok: ~/.termux/boot/torgi-sentinel.sh"

# 3) Останавливаем прежний экземпляр (без дублей уведомлений)
say "Останавливаю прежние экземпляры (если были)"
pkill -f "run-forever.sh" 2>/dev/null && echo "   остановлен цикл" || true
pkill -f "bot.js" 2>/dev/null && echo "   остановлен bot.js" || true
sleep 1

# 4) Держим процесс живым и запускаем в фоне прямо сейчас
say "Запускаю бота в фоне (wake-lock включён)"
termux-wake-lock 2>/dev/null || true
nohup bash "$HOME/.termux/boot/torgi-sentinel.sh" >/dev/null 2>&1 < /dev/null &
sleep 8

# 5) Показываем, что реально стартануло
say "Первые строки лога:"
tail -n 12 "$APP_DIR/bot.log" 2>/dev/null || echo "   (лог пока пуст)"

echo ""
echo "======================================================"
if grep -q "поллер запущен" "$APP_DIR/bot.log" 2>/dev/null; then
  echo "✅ ГОТОВО. Бот работает. В Telegram пришло «🟢 Torgi Sentinel запущен»."
else
  echo "⚠️  Бот запущен, но проверь лог выше. Если пусто — подожди 10с и: tail -f ~/torgi-sentinel/bot.log"
fi
echo ""
echo "ОДНО действие руками, чтобы Android не убивал бота:"
echo "  Настройки → Приложения → Termux → Батарея → «Без ограничений»."
echo "  (и установи Termux:Boot из F-Droid — тогда переживёт перезагрузку)"
echo ""
echo "Логи в любой момент:  tail -f ~/torgi-sentinel/bot.log"
echo "======================================================"

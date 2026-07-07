#!/data/data/com.termux/files/usr/bin/bash
# Автозапуск Torgi Sentinel на телефоне (Termux) с авто-перезапуском и wake-lock.
# Кладётся в ~/.termux/boot/ для старта при загрузке телефона (нужен Termux:Boot).
# Вручную можно запустить: bash ~/torgi-sentinel/scripts/run-forever.sh

# Не давать телефону усыплять процесс
termux-wake-lock 2>/dev/null || true

APP_DIR="$HOME/torgi-sentinel"
cd "$APP_DIR" || { echo "нет каталога $APP_DIR"; exit 1; }

# Бесконечный цикл: если бот упал/убит — поднимаем снова через 5с.
while true; do
  echo "$(date '+%Y-%m-%d %H:%M:%S') запуск bot.js"
  node bot.js >> "$APP_DIR/bot.log" 2>&1
  echo "$(date '+%Y-%m-%d %H:%M:%S') bot.js завершился, перезапуск через 5с" >> "$APP_DIR/bot.log"
  sleep 5
done

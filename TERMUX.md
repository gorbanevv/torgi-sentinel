# Запуск Torgi Sentinel на телефоне (Android + Termux)

Телефон даёт «жилой» мобильный IP, который torgi.gov.ru не блокирует. Бот
работает 24/7 прямо на телефоне. Ничего платного.

## 0. Что понадобится
- Старый Android-телефон, постоянно на зарядке.
- Интернет на нём (мобильный или Wi-Fi — оба дают не-датацентровый IP).
- 15 минут на первую настройку.

## 1. Установить Termux и Termux:Boot (ВАЖНО: из F-Droid, не из Play Store)
Версия из Play Store устаревшая и не годится.

1. Установи **F-Droid**: https://f-droid.org → кнопка «Download F-Droid» → установи apk.
2. В F-Droid найди и установи **Termux**.
3. Там же установи **Termux:Boot** (нужен для автозапуска после перезагрузки).

## 2. Поставить Node.js
Открой Termux и выполни по очереди:
```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git
node -v      # должно показать v20.x или новее
```

## 3. Скачать код бота
```bash
cd ~
git clone https://github.com/gorbanevv/torgi-sentinel.git
cd torgi-sentinel
```

## 4. Вписать токен и chat_id
```bash
cp config.example.json config.json
nano config.json
```
В `nano`: замени `telegramBotToken` и `telegramChatId` на свои
(как их получить — см. README.md, раздел про @BotFather). Сохрани: `Ctrl+O`,
`Enter`, выход `Ctrl+X`.

## 5. Проверить, что работает
```bash
node bot.js
```
В Telegram должно прийти «🟢 Torgi Sentinel запущен». Если пришло — всё ок,
останови (`Ctrl+C`) и переходи к автозапуску. Если ошибка — покажи мне текст.

## 6. Автозапуск 24/7 (переживает перезагрузку телефона)
```bash
mkdir -p ~/.termux/boot
cp ~/torgi-sentinel/scripts/run-forever.sh ~/.termux/boot/torgi-sentinel.sh
chmod +x ~/.termux/boot/torgi-sentinel.sh
```
Затем один раз запусти вручную, чтобы стартануть прямо сейчас (не дожидаясь ребута):
```bash
bash ~/.termux/boot/torgi-sentinel.sh &
```
Скрипт держит `termux-wake-lock` (телефон не усыпит процесс) и перезапускает
бота, если тот вдруг упал.

## 7. Чтобы Android не убивал Termux (обязательно)
- Настройки телефона → Приложения → **Termux** → Батарея →
  **«Без ограничений» / отключить оптимизацию батареи**.
- То же для **Termux:Boot**.
- Если есть «автозапуск» в настройках (Xiaomi/Huawei/Samsung) — разреши Termux.

## Полезные команды
```bash
# посмотреть логи бота
tail -f ~/torgi-sentinel/bot.log

# обновить код, когда я внесу правки
cd ~/torgi-sentinel && git pull

# остановить всё
pkill -f bot.js
```

## Проверка «а видит ли телефон torgi»
```bash
cd ~/torgi-sentinel && node scripts/smoke.js
```
Должно быть «SMOKE: всё зелёное ✓». Это подтверждает, что с телефона сайт
доступен (в отличие от VPS).

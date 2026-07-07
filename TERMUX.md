# Запуск на телефоне (Android + Termux) — минимум действий

Телефон даёт «жилой» мобильный IP, который torgi.gov.ru не блокирует. Бот работает
24/7 прямо на телефоне, бесплатно. От тебя нужно: поставить приложение и вставить
одну команду — остальное установщик сделает сам.

## Шаг 1. Поставить 2 приложения из F-Droid (НЕ из Play Store!)
Версия из Play Store устаревшая и не подойдёт.

1. Установи **F-Droid**: https://f-droid.org (кнопка «Download F-Droid», поставь apk).
2. В F-Droid найди и установи:
   - **Termux**
   - **Termux:Boot** (чтобы бот сам стартовал после перезагрузки телефона)

## Шаг 2. Открыть Termux и вставить ОДНУ команду
Скопируй команду (я дам её с уже вписанным токеном), вставь в Termux, нажми Enter.
Она сама поставит Node, скачает бота, создаст конфиг, настроит автозапуск и запустит:

```bash
pkg update -y && pkg install -y git && (pkg install -y nodejs-lts || pkg install -y nodejs) && \
git clone https://github.com/gorbanevv/torgi-sentinel.git ~/torgi-sentinel 2>/dev/null; \
cd ~/torgi-sentinel && git pull -q 2>/dev/null; \
TG_TOKEN='ВАШ_ТОКЕН' TG_CHAT='ВАШ_CHAT_ID' bash scripts/setup.sh
```

Через ~1 минуту в Telegram придёт «🟢 Torgi Sentinel запущен» — значит работает.

## Шаг 3. Одно действие руками (чтобы Android не убивал бота)
- Настройки телефона → Приложения → **Termux** → Батарея → **«Без ограничений»**
  (отключить оптимизацию батареи).
- На Xiaomi/Huawei/Samsung дополнительно разреши Termux **автозапуск**.
- Держи телефон на зарядке. **Не смахивай Termux** из недавних приложений
  (он показывает уведомление — это нормально, он так работает в фоне).

Готово. Бот ловит новые лоты и шлёт их тебе.

---

## Полезное

```bash
# смотреть логи
tail -f ~/torgi-sentinel/bot.log

# обновить бота и перезапустить (когда я внесу правки)
cd ~/torgi-sentinel && git pull && bash scripts/setup.sh

# проверить, что телефон видит torgi
cd ~/torgi-sentinel && node scripts/smoke.js

# остановить бота
pkill -f run-forever.sh; pkill -f bot.js
```

## Если что-то пошло не так
- В Telegram ничего не пришло → `tail -f ~/torgi-sentinel/bot.log` и пришли мне текст.
- «SMOKE FATAL / ETIMEDOUT» на смоук-тесте → телефон сейчас в сети, которая тоже
  режет torgi (редко). Переключи Wi-Fi ↔ мобильный интернет и повтори.

## Ручная установка (если авто-установщик не сработал)
1. `pkg update -y && pkg install -y nodejs-lts git`
2. `git clone https://github.com/gorbanevv/torgi-sentinel.git ~/torgi-sentinel && cd ~/torgi-sentinel`
3. `cp config.example.json config.json && nano config.json` — вписать `telegramBotToken` и `telegramChatId`
4. Автозапуск: `mkdir -p ~/.termux/boot && cp scripts/run-forever.sh ~/.termux/boot/torgi-sentinel.sh && chmod +x ~/.termux/boot/torgi-sentinel.sh`
5. Запуск сейчас: `bash ~/.termux/boot/torgi-sentinel.sh &`

# Torgi Sentinel

Мониторинг новых лотов на **torgi.gov.ru** (ГИС Торги) и уведомления в Telegram.

> ✅ **Рабочая архитектура (итог):** бот живёт на **Timeweb VPS**, а к torgi ходит
> через **дополнительный IP `92.51.23.164`** (основной IP Timeweb torgi блокирует, а
> этот доп. IP — нет; привязка через `config.torgiLocalAddress`). В Telegram — напрямую
> с VPS. Телефон/Termux/прокси **не нужны**.
>
> Нюансы: torgi отдаёт `503` на всплески запросов (rate-limit), поэтому интервал 30с
> (≈1 запрос/10с). IP держится через netplan `60-extra-ips.yaml` + `torgi-ipfix.service`
> (GARP при загрузке). Историю поиска решения см. в памяти проекта.
> Провалившийся вариант с телефоном — в [TERMUX.md](TERMUX.md) (оставлен для истории).

Без единой внешней зависимости: чистый Node.js (>=18), встроенный `https`,
keep-alive соединение с API портала, атомарный JSON-store для дедупликации,
systemd для автозапуска. Дизайн: `docs/superpowers/specs/2026-07-06-torgi-sentinel-design.md`.

## Фильтры (заданы в config)

Во всех фильтрах статус лота = **«Опубликован» + «Приём заявок»**
(`lotStatus=PUBLISHED` и `lotStatus=APPLICATIONS_SUBMISSION`).

| Фильтр | Параметры API |
|---|---|
| Севастополь · Недвижимость | `dynSubjRF=80`, `catCode=7` |
| Ростовская область · Автомобили и мототехника | `dynSubjRF=63`, `catCode=100` |
| Севастополь · Земельные участки (все) | `dynSubjRF=80`, `catCode=2` |

Коды проверены вживую; полный справочник — в §10 спеки.

## Создание Telegram-бота (один раз, 2 минуты)

1. В Telegram открой **@BotFather** → команда `/newbot` → придумай имя и username
   (например `torgi_sentinel_bot`). BotFather пришлёт **токен** вида
   `1234567890:AAE...xyz` — сохрани его.
2. Узнай свой **chat_id**: открой **@userinfobot** и нажми Start — он покажет `Id`.
3. **Важно:** зайди в чат со своим новым ботом и нажми **Start** — иначе бот не
   сможет писать тебе первым.

## Конфигурация

```bash
cp config.example.json config.json
# впиши telegramBotToken и telegramChatId
```

`config.json` в git не попадает. Альтернатива — переменные окружения
`TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` (перекрывают файл).

## Запуск локально

```bash
node bot.js
```

При старте бот пришлёт в Telegram «🟢 Torgi Sentinel запущен», затем молча
засеет текущие лоты (без спама старьём) и начнёт слать только новые.

## Тесты и диагностика

```bash
npm test        # юнит-тесты (без сети)
npm run smoke   # живая проверка API: доступность, сортировка, пагинация, картинки
```

## Деплой на VPS (systemd)

```bash
./deploy/deploy.sh root@ВАШ_VPS_IP
# затем на VPS: создать /opt/torgi-sentinel/config.json и
ssh root@ВАШ_VPS_IP 'systemctl restart torgi-sentinel'
```

Управление:

```bash
systemctl status torgi-sentinel          # состояние
journalctl -u torgi-sentinel -f          # живые логи (heartbeat каждые 10 мин)
systemctl restart torgi-sentinel         # перезапуск
```

## Как это работает

- **Поллер на фильтр**: каждые 3с лёгкий запрос `lotcards/search` (первая страница,
  сортировка по дате публикации). Тёплое keep-alive соединение — 0.2с на запрос.
- **Дедуп**: `data/seen.json`, атомарная запись; лот помечается «виденным» только
  после успешной доставки в Telegram (ничего не теряется при сбоях).
- **Пачки**: если новых больше страницы — листает `page=1,2…` до известного лота.
- **Сбои**: экспоненциальный backoff до 60с на ошибках API, ретраи Telegram
  (учитывает `retry_after`), фолбэк фото→текст→plain.
- **Первый запуск**: текущие лоты записываются без уведомлений.

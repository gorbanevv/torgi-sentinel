'use strict';
// Сторож ошибок: переводит любую ошибку в понятное сообщение и шлёт в Telegram.
// Дедупликация по коду ошибки + гистерезис (алерт после N ошибок подряд, «восстановлено»
// при возврате) — чтобы сообщать СРАЗУ о реальной проблеме, но не спамить на мигании.

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Разбор ошибки → { code (для дедупа), title, meaning }
function describeError(err) {
  const m = String((err && err.message) || err || '');

  // --- HTTP-код от torgi (клиент бросает "torgi HTTP 503: ...") ---
  const http = m.match(/torgi HTTP (\d{3})/);
  if (http) {
    const code = http[1];
    const table = {
      '400': ['torgi 400 — неверный запрос', 'Параметры фильтров или API сайта изменились. Скорее всего, нужно обновить бота (коды фильтров/эндпоинт).'],
      '401': ['torgi 401 — требуется авторизация', 'Эндпоинт стал закрытым. Возможно, изменилось API сайта.'],
      '403': ['torgi 403 — доступ запрещён', 'Наш IP могли забанить, либо сайт закрыл публичный доступ. Если держится — закажи новый доп. IP в панели Timeweb, я перепривяжу.'],
      '404': ['torgi 404 — эндпоинт не найден', 'API сайта изменилось (переехал адрес запроса). Нужно обновить бота.'],
      '429': ['torgi 429 — слишком много запросов', 'Явный лимит запросов с нашего IP. Надо увеличить интервал опроса. Бот сам сбавит темп и повторит.'],
      '500': ['torgi 500 — внутренняя ошибка сайта', 'Сбой на стороне torgi.gov.ru. Не наша проблема, бот повторит сам.'],
      '502': ['torgi 502 — шлюз недоступен', 'Бэкенд torgi временно лёг. На их стороне, бот повторит.'],
      '503': ['torgi 503 — перегрузка/лимит', 'torgi перегружен или лимитит частые запросы. Обычно временно — бот мягко повторяет. Если постоянно — снизим частоту.'],
      '504': ['torgi 504 — таймаут шлюза', 'torgi слишком долго отвечает (перегрузка). Временно, бот повторит.'],
    };
    const [title, meaning] = table[code] || [`torgi HTTP ${code}`, 'Необычный ответ сайта. Если повторяется — стоит разобраться.'];
    return { code: 'HTTP' + code, title, meaning };
  }

  // --- не-JSON ответ (HTML/капча вместо данных) ---
  if (/bad JSON/i.test(m)) {
    return { code: 'BADJSON', title: 'torgi вернул не данные (HTML/капча)', meaning: 'Вместо JSON пришла страница — возможно, защита от ботов или техработы. Если держится — проверим доступ.' };
  }

  // --- сетевые ошибки Node / таймаут ---
  if (/ETIMEDOUT|timeout|ESOCKETTIMEDOUT/i.test(m)) {
    return { code: 'TIMEOUT', title: 'Таймаут соединения с torgi', meaning: '⚠️ Соединение не устанавливается. ГЛАВНОЕ подозрение: наш IP 92.51.23.164 попал в блокировку torgi (как раньше основной). Если держится несколько минут — закажи новый доп. IP в панели Timeweb и напиши мне, я перепривяжу за минуту.' };
  }
  if (/ECONNRESET/i.test(m)) {
    return { code: 'ECONNRESET', title: 'Соединение с torgi сброшено', meaning: 'Сервер оборвал соединение. Часто временный сетевой сбой или защита. Обычно проходит само.' };
  }
  if (/ECONNREFUSED/i.test(m)) {
    return { code: 'ECONNREFUSED', title: 'torgi отклонил соединение', meaning: 'Порт закрыт/сервис недоступен. Возможно, техработы на torgi.' };
  }
  if (/ENOTFOUND/i.test(m)) {
    return { code: 'ENOTFOUND', title: 'DNS не находит torgi.gov.ru', meaning: 'Не резолвится домен. Проблема с DNS на сервере (VPS) или у torgi. Проверю сеть VPS.' };
  }
  if (/EAI_AGAIN/i.test(m)) {
    return { code: 'EAI_AGAIN', title: 'Временный сбой DNS', meaning: 'DNS-сервер временно не отвечает. Обычно кратковременно, бот повторит.' };
  }
  if (/ENETUNREACH/i.test(m)) {
    return { code: 'ENETUNREACH', title: 'Сеть до torgi недоступна', meaning: 'С сервера нет маршрута к torgi. Сетевой сбой на стороне Timeweb.' };
  }
  if (/EHOSTUNREACH/i.test(m)) {
    return { code: 'EHOSTUNREACH', title: 'Хост torgi недоступен', meaning: 'Нет маршрута до сервера torgi. Сетевой сбой в пути.' };
  }
  if (/EPIPE|ECONNABORTED/i.test(m)) {
    return { code: 'EPIPE', title: 'Обрыв соединения при обмене с torgi', meaning: 'Соединение прервалось на полуслове. Обычно временно.' };
  }
  if (/certificate|CERT_|SSL|TLS/i.test(m)) {
    return { code: 'TLS', title: 'Ошибка TLS/сертификата torgi', meaning: 'Проблема с шифрованием соединения. Редко — возможно, сайт сменил сертификат.' };
  }

  // --- всё прочее ---
  return { code: 'OTHER', title: 'Непредвиденная ошибка', meaning: escapeHtml(m).slice(0, 300) };
}

// Создаёт сторожа. tg — объект с sendMessage. log — функция логирования.
//
// Анти-спам (урок инцидента 2026-07-10 — десятки 🔴/✅ за вечер):
//  - flushDelayMs: беды, пришедшие в одном окне, склеиваются в ОДНО сообщение
//    (общая причина вроде rate-limit бьёт по всем фильтрам разом);
//  - cooldownMs: повторный алерт того же типа по тому же фильтру не чаще кулдауна —
//    мигание «упало-поднялось-упало» не долбит в чат; затяжная тихая беда будится
//    повторным report() после кулдауна;
//  - восстановление до отправки снимает отложенный алерт молча (мигнуло — не спамим).
function createAlerter({ tg, log = () => {}, cooldownMs = 30 * 60 * 1000, flushDelayMs = 0, now = Date.now }) {
  const active = new Map();     // контекст -> { code, silent } активной беды
  const lastLoudAt = new Map(); // `контекст|код` -> когда последний раз алертили громко
  let pendingAlerts = [];       // [{ context, d, key, prevLoudAt }] — ждут окна склейки
  let pendingResolves = [];     // [context]
  let alertTimer = null;
  let resolveTimer = null;

  async function send(text) {
    try { await tg.sendMessage(text); } catch (e) { log(`[alert] не удалось отправить алерт: ${e.message}`); }
  }

  function alertMessage(items) {
    if (items.length === 1) {
      const { context, d } = items[0];
      return (
        `🔴 <b>Ошибка мониторинга</b> — ${escapeHtml(context)}\n\n` +
        `<b>${escapeHtml(d.title)}</b>\n` +
        `${d.meaning}\n\n` +
        `<code>${escapeHtml(d.code)}</code>`
      );
    }
    // группируем по типу беды: обычно она одна на всех (rate-limit, блокировка IP)
    const byCode = new Map();
    for (const it of items) {
      if (!byCode.has(it.d.code)) byCode.set(it.d.code, { d: it.d, contexts: [] });
      byCode.get(it.d.code).contexts.push(it.context);
    }
    const parts = [`🔴 <b>Ошибка мониторинга</b> — затронуто фильтров: ${items.length}`];
    for (const { d, contexts } of byCode.values()) {
      parts.push(
        '',
        `<b>${escapeHtml(d.title)}</b>`,
        d.meaning,
        contexts.map((c) => `• ${escapeHtml(c)}`).join('\n'),
        `<code>${escapeHtml(d.code)}</code>`
      );
    }
    return parts.join('\n');
  }

  async function flushAlerts() {
    if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
    const items = pendingAlerts;
    pendingAlerts = [];
    if (items.length > 0) await send(alertMessage(items));
  }

  async function flushResolves() {
    if (resolveTimer) { clearTimeout(resolveTimer); resolveTimer = null; }
    const ctxs = pendingResolves;
    pendingResolves = [];
    if (ctxs.length > 0) {
      await send(`✅ <b>Восстановлено</b> — ${ctxs.map(escapeHtml).join(', ')}\nМониторинг снова работает штатно.`);
    }
  }

  function queueAlert(item) {
    pendingAlerts.push(item);
    if (flushDelayMs <= 0) return flushAlerts();
    if (!alertTimer) {
      alertTimer = setTimeout(() => { flushAlerts(); }, flushDelayMs);
      if (alertTimer.unref) alertTimer.unref();
    }
    return Promise.resolve();
  }

  function queueResolve(context) {
    pendingResolves.push(context);
    if (flushDelayMs <= 0) return flushResolves();
    if (!resolveTimer) {
      resolveTimer = setTimeout(() => { flushResolves(); }, flushDelayMs);
      if (resolveTimer.unref) resolveTimer.unref();
    }
    return Promise.resolve();
  }

  // Сообщить об ошибке в контексте (напр. имя фильтра).
  async function report(context, err) {
    const d = describeError(err);
    const key = `${context}|${d.code}`;
    const entry = active.get(context);
    if (entry && entry.code === d.code) {
      // та же беда уже активна: молчим; тихую после кулдауна повышаем до громкой
      const prev = lastLoudAt.get(key);
      if (entry.silent && (prev === undefined || now() - prev >= cooldownMs)) {
        entry.silent = false;
        lastLoudAt.set(key, now());
        log(`[alert] ${context}: ${d.code} — ${d.title} (беда продолжается, кулдаун истёк)`);
        return queueAlert({ context, d, key, prevLoudAt: prev });
      }
      return;
    }
    const prevLoudAt = lastLoudAt.get(key);
    const loud = prevLoudAt === undefined || now() - prevLoudAt >= cooldownMs;
    active.set(context, { code: d.code, silent: !loud });
    if (!loud) {
      log(`[alert] ${context}: ${d.code} — подавлено кулдауном`);
      return;
    }
    lastLoudAt.set(key, now());
    log(`[alert] ${context}: ${d.code} — ${d.title}`);
    return queueAlert({ context, d, key, prevLoudAt });
  }

  // Всё снова ок в контексте — если громко алертили, сообщить о восстановлении.
  async function resolve(context) {
    const entry = active.get(context);
    if (!entry) return;
    active.delete(context);
    // алерт ещё не улетел (мигнуло внутри окна склейки) — снимаем молча и возвращаем кулдаун
    const idx = pendingAlerts.findIndex((it) => it.context === context);
    if (idx !== -1) {
      const [it] = pendingAlerts.splice(idx, 1);
      if (it.prevLoudAt === undefined) lastLoudAt.delete(it.key);
      else lastLoudAt.set(it.key, it.prevLoudAt);
      log(`[alert] ${context}: мигнуло — отложенный алерт снят`);
      return;
    }
    if (entry.silent) {
      log(`[alert] ${context}: восстановлено (алерт был подавлен кулдауном — молчим)`);
      return;
    }
    log(`[alert] ${context}: восстановлено`);
    return queueResolve(context);
  }

  // Немедленно отправить всё отложенное (аварийный выход процесса).
  async function flush() {
    await flushAlerts();
    await flushResolves();
  }

  return { report, resolve, flush, describeError };
}

module.exports = { createAlerter, describeError, escapeHtml };

'use strict';

// Один опрашивающий цикл на ГРУППУ фильтров одной категории (или на одиночный фильтр).
// Все зависимости внедряются — модуль тестируем без сети.
//
// Групповой опрос: API объединяет повторяющиеся dynSubjRF (как lotStatus), поэтому одна
// категория по всем регионам — ОДИН запрос; лот раскладывается по фильтру своего региона
// через subjectRFCode из карточки (Севастополь=92, Ростовская=61, Краснодарский=23).
// Это делит нагрузку на IP: 3 запроса на цикл вместо 8 → интервал 30с без 503.
//
// Логика новизны:
//  - первый запуск фильтра: засеваем store текущими лотами БЕЗ уведомлений (seededAt);
//    незасеянный участник группы засевается отдельным запросом строго своего региона;
//  - дальше: страница 0 свежих; если ВСЯ страница новая — листаем дальше (пачка > pageSize),
//    пока не встретим известный лот (сортировка по дате публикации убывает — подтверждено);
//  - уведомляем старые→новые, лот помечается «виденным» только ПОСЛЕ успешной отправки.
function createPoller({
  filter,     // одиночный фильтр (эквивалент members: [filter])
  members,    // группа фильтров одной catCode: [{name, displayName, dynSubjRF, subjectRFCode, ...}]
  groupName,  // подпись группы в логах (по умолчанию имена участников)
  client,
  store,
  notifyLot,
  log,
  lotStatuses = ['PUBLISHED', 'APPLICATIONS_SUBMISSION'],
  pollIntervalMs = 3000,
  pageSize = 20,
  maxCatchupPages = 5,
  maxSeedPages = 100,
  maxBackoffMs = 600000,      // потолок паузы между повторами при затяжной беде (10 мин)
  alertThreshold = 3,         // алерт не раньше стольких ошибок подряд…
  alertSustainedMs = 300000,  // …И не раньше, чем беда продержится столько (не алертим мигание)
  reportError = null, // (err) => void — сторож сам решает, слать ли (кулдаун/склейка)
  reportOk = null,    // () => void — при восстановлении после алерта
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const list = (members && members.length ? members : [filter]).filter(Boolean);
  if (list.length === 0) throw new Error('poller: нужен filter или непустой members');
  const name = groupName || list.map((m) => m.name).join('+');
  const catCode = list[0].catCode;
  const multi = list.length > 1;
  const byRegion = new Map(list.map((m) => [String(m.subjectRFCode), m]));

  let consecutiveErrors = 0;
  let errorStreakStartAt = 0;
  let lastOkAt = null;
  let stopped = false;

  function lotId(lot) {
    return lot.id || `${lot.noticeNumber}_${lot.lotNumber}`;
  }

  // Чей это лот: у одиночного фильтра — всегда его; в группе — по региону из карточки.
  function memberOf(lot) {
    if (!multi) return list[0];
    return byRegion.get(String(lot.subjectRFCode)) || null;
  }

  async function seedMember(m) {
    let added = 0;
    for (let page = 0; page < maxSeedPages; page++) {
      const data = await client.searchLots({ dynSubjRF: m.dynSubjRF, catCode, lotStatuses, size: 100, page });
      const lots = data.content || [];
      for (const lot of lots) {
        if (!store.has(m.name, lotId(lot))) { store.add(m.name, lotId(lot)); added++; }
      }
      store.save(); // прогресс постранично: упавший на середине засев доедет после ретрая/рестарта
      if (data.last || lots.length === 0) break;
    }
    store.markSeeded(m.name);
    store.save();
    log(`[${m.name}] первичный засев: ${added} текущих лотов записано без уведомлений`);
  }

  async function fetchNewLots() {
    const fresh = [];
    const regionParam = multi ? list.map((m) => m.dynSubjRF) : list[0].dynSubjRF;
    for (let page = 0; page < maxCatchupPages; page++) {
      const data = await client.searchLots({ dynSubjRF: regionParam, catCode, lotStatuses, size: pageSize, page });
      const lots = data.content || [];
      let sawKnown = false;
      for (const lot of lots) {
        const m = memberOf(lot);
        if (!m) continue; // регион вне группы — по построению запроса не бывает, но страхуемся
        if (store.has(m.name, lotId(lot))) sawKnown = true;
        else fresh.push({ lot, member: m });
      }
      if (sawKnown || data.last || lots.length === 0) break;
    }
    return fresh;
  }

  async function pollOnce() {
    const unseeded = list.filter((m) => !store.isSeeded(m.name));
    if (unseeded.length > 0) {
      for (const m of unseeded) await seedMember(m);
      return { seeded: true, notified: 0 };
    }
    const fresh = await fetchNewLots();
    fresh.reverse(); // старые сначала — сообщения приходят хронологично
    let notified = 0;
    for (const { lot, member } of fresh) {
      await notifyLot(lot, member); // бросит — лот не пометится и уйдёт в ретрай следующим циклом
      store.add(member.name, lotId(lot));
      store.save();
      notified++;
    }
    return { seeded: false, notified };
  }

  async function run() {
    log(`[${name}] поллер запущен: catCode=${catCode}, регионы=${list.map((m) => m.dynSubjRF).join('+')}, интервал ${pollIntervalMs}мс`);
    let alerted = false;
    while (!stopped) {
      try {
        const r = await pollOnce();
        lastOkAt = now();
        if (alerted && reportOk) { alerted = false; try { await reportOk(); } catch {} }
        consecutiveErrors = 0;
        if (r.notified > 0) log(`[${name}] отправлено уведомлений: ${r.notified}`);
      } catch (e) {
        consecutiveErrors++;
        if (consecutiveErrors === 1) errorStreakStartAt = now();
        // 429/5xx — временный rate-limit/обслуживание torgi: первые повторы через обычный
        // интервал, при затяжной серии пауза мягко растёт ×1.5 до потолка. Сеть/иное — жёстко ×2.
        const soft = /HTTP (429|5\d\d)/.test(e.message);
        const backoff = soft
          ? Math.min(pollIntervalMs * 1.5 ** Math.max(0, consecutiveErrors - 3), maxBackoffMs)
          : Math.min(pollIntervalMs * 2 ** consecutiveErrors, maxBackoffMs);
        if (!soft || consecutiveErrors === 1 || consecutiveErrors % 20 === 0) {
          log(`[${name}] ${soft ? '503/недоступен' : 'ошибка'} (${consecutiveErrors} подряд) — пауза ${backoff}мс`);
        }
        // алерт только про устойчивую беду: порог по числу И выдержка по времени.
        // При затяжной ошибке повторяем report каждые 20 циклов — сторож сам решает,
        // будить ли снова (кулдаун), чтобы многочасовая беда не осталась незамеченной.
        const sustained = now() - errorStreakStartAt >= alertSustainedMs;
        if (consecutiveErrors >= alertThreshold && sustained && reportError && (!alerted || consecutiveErrors % 20 === 0)) {
          alerted = true;
          try { await reportError(e); } catch {}
        }
        await sleep(backoff);
        continue;
      }
      await sleep(pollIntervalMs);
    }
  }

  return {
    pollOnce,
    run,
    stop: () => { stopped = true; },
    stats: () => ({ consecutiveErrors, lastOkAt }),
  };
}

module.exports = { createPoller };

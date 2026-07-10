'use strict';

// Один опрашивающий цикл на фильтр. Все зависимости внедряются — модуль тестируем без сети.
//
// Логика новизны:
//  - первый запуск фильтра: засеваем store текущими лотами БЕЗ уведомлений (seededAt);
//  - дальше: страница 0 свежих; если ВСЯ страница новая — листаем дальше (пачка > pageSize),
//    пока не встретим известный лот (сортировка по дате публикации убывает — подтверждено);
//  - уведомляем старые→новые, лот помечается «виденным» только ПОСЛЕ успешной отправки.
function createPoller({
  filter,
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
  let consecutiveErrors = 0;
  let errorStreakStartAt = 0;
  let lastOkAt = null;
  let stopped = false;

  function lotId(lot) {
    return lot.id || `${lot.noticeNumber}_${lot.lotNumber}`;
  }

  async function seed() {
    let added = 0;
    for (let page = 0; page < maxSeedPages; page++) {
      const data = await client.searchLots({ dynSubjRF: filter.dynSubjRF, catCode: filter.catCode, lotStatuses, size: 100, page });
      const lots = data.content || [];
      for (const lot of lots) {
        if (!store.has(filter.name, lotId(lot))) { store.add(filter.name, lotId(lot)); added++; }
      }
      store.save(); // прогресс постранично: упавший на середине засев доедет после ретрая/рестарта
      if (data.last || lots.length === 0) break;
    }
    store.markSeeded(filter.name);
    store.save();
    log(`[${filter.name}] первичный засев: ${added} текущих лотов записано без уведомлений`);
  }

  async function fetchNewLots() {
    const fresh = [];
    for (let page = 0; page < maxCatchupPages; page++) {
      const data = await client.searchLots({ dynSubjRF: filter.dynSubjRF, catCode: filter.catCode, lotStatuses, size: pageSize, page });
      const lots = data.content || [];
      let sawKnown = false;
      for (const lot of lots) {
        if (store.has(filter.name, lotId(lot))) sawKnown = true;
        else fresh.push(lot);
      }
      if (sawKnown || data.last || lots.length === 0) break;
    }
    return fresh;
  }

  async function pollOnce() {
    if (!store.isSeeded(filter.name)) {
      await seed();
      return { seeded: true, notified: 0 };
    }
    const fresh = await fetchNewLots();
    fresh.reverse(); // старые сначала — сообщения приходят хронологично
    let notified = 0;
    for (const lot of fresh) {
      await notifyLot(lot, filter); // бросит — лот не пометится и уйдёт в ретрай следующим циклом
      store.add(filter.name, lotId(lot));
      store.save();
      notified++;
    }
    return { seeded: false, notified };
  }

  async function run() {
    log(`[${filter.name}] поллер запущен: dynSubjRF=${filter.dynSubjRF} catCode=${filter.catCode}, интервал ${pollIntervalMs}мс`);
    let alerted = false;
    while (!stopped) {
      try {
        const r = await pollOnce();
        lastOkAt = now();
        if (alerted && reportOk) { alerted = false; try { await reportOk(); } catch {} }
        consecutiveErrors = 0;
        if (r.notified > 0) log(`[${filter.name}] отправлено уведомлений: ${r.notified}`);
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
          log(`[${filter.name}] ${soft ? '503/недоступен' : 'ошибка'} (${consecutiveErrors} подряд) — пауза ${backoff}мс`);
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

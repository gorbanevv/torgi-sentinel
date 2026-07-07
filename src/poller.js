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
  maxBackoffMs = 60000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let consecutiveErrors = 0;
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
    while (!stopped) {
      try {
        const r = await pollOnce();
        lastOkAt = Date.now();
        consecutiveErrors = 0;
        if (r.notified > 0) log(`[${filter.name}] отправлено уведомлений: ${r.notified}`);
      } catch (e) {
        consecutiveErrors++;
        const backoff = Math.min(pollIntervalMs * 2 ** consecutiveErrors, maxBackoffMs);
        log(`[${filter.name}] ошибка (${consecutiveErrors} подряд): ${e.message} — пауза ${backoff}мс`);
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

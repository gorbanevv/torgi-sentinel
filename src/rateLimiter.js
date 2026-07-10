'use strict';

// Глобальный дозатор запросов к torgi: ВСЕ обращения (все фильтры, засев, картинки)
// сериализуются в одну FIFO-очередь с минимальным зазором между стартами запросов.
//
// Зачем: torgi лимитит запросы per-IP (~6/мин). Без общей очереди параллельные
// поллеры конкурируют за лимит и фазово блокируются: циклы с фиксированным сном
// приходят в одном и том же порядке, «хвостовые» проигрывают лимит каждый раунд
// (инцидент 2026-07-10: 5 новых фильтров получили 460 отказов 503 подряд за 7.6ч,
// пока 3 старых работали). Очередь делит лимит честно: никто не голодает.
//
// Джиттер размывает фазу относительно чужих потребителей того же лимита.
function createRateLimiter({
  minGapMs = 10000,
  jitterMs = 1000,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
} = {}) {
  let chain = Promise.resolve();
  let nextFreeAt = 0;

  function schedule(fn) {
    const run = chain.then(async () => {
      const wait = nextFreeAt - now();
      if (wait > 0) await sleep(wait);
      // зазор считаем от СТАРТА запроса: длительность самого запроса не сжимает паузу
      nextFreeAt = now() + minGapMs + Math.floor(random() * jitterMs);
      return fn();
    });
    chain = run.then(() => {}, () => {}); // очередь переживает падение любого запроса
    return run;
  }

  return { schedule };
}

module.exports = { createRateLimiter };

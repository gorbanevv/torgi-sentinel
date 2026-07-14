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
  classify,   // УНИВЕРСАЛЬНЫЙ режим: (lot) => Promise<member[]> — один запрос без категории
              // на все регионы, раскладка по фильтрам классификатором; граница — корзина _all
  groupName,  // подпись группы в логах (по умолчанию имена участников)
  client,
  store,
  notifyLot,
  log,
  lotStatuses = ['PUBLISHED', 'APPLICATIONS_SUBMISSION'],
  pollIntervalMs = 3000,
  catchupPageSize = 100,      // размер страницы догона: 100 → глубокий догон немногими запросами
  maxCatchupPages = 25,       // потолок глубины догона (25×100=2500 лотов на группу за простой)
  maxSeedPages = 100,
  maxBackoffMs = 600000,      // потолок паузы между повторами при затяжной беде (10 мин)
  alertThreshold = 3,         // алерт не раньше стольких ошибок подряд…
  alertSustainedMs = 300000,  // …И не раньше, чем беда продержится столько (не алертим мигание)
  reportError = null, // (err) => void — сторож сам решает, слать ли (кулдаун/склейка)
  reportOk = null,    // () => void — при восстановлении после алерта
  onCatchupOverflow = null, // (кол-во) => void — догон упёрся в потолок, не встретив известного лота
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const list = (members && members.length ? members : [filter]).filter(Boolean);
  if (list.length === 0) throw new Error('poller: нужен filter или непустой members');
  const universal = typeof classify === 'function';
  const ALL = '_all'; // общая корзина виденных лотов любой категории — граница универсальной линии
  const name = groupName || list.map((m) => m.name).join('+');
  const catCode = list[0].catCode;
  // город-фильтр (ФИАС): у всех участников линии он одинаков — за это отвечает groupFilters
  const fiasGUID = list[0].fiasGUID || undefined;
  const multi = list.length > 1;
  const byRegion = new Map(list.map((m) => [String(m.subjectRFCode), m]));
  const uniqueRegions = [...new Set(list.map((m) => String(m.dynSubjRF)))];

  let consecutiveErrors = 0;
  let errorStreakStartAt = 0;
  let lastOkAt = null;
  let stopped = false;
  // накопительные счётчики для суточного отчёта
  let totalErrors = 0;
  let totalNotified = 0;
  let lastError = null;

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
      const data = await client.searchLots({ dynSubjRF: m.dynSubjRF, catCode: m.catCode, fiasGUID: m.fiasGUID || undefined, lotStatuses, size: 100, page });
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

  // Листаем свежие лоты до первого УЖЕ ВИДЕННОГО (сортировка по дате убывает): всё, что новее
  // границы «виденного», — пропущено за простой и подлежит досылке. Потолок глубокий, чтобы
  // покрыть долгий простой; если он всё же исчерпан, не встретив известного лота, — возможна
  // дыра (truncated): досылаем самые свежие, а о дыре сигналим отдельно.
  //
  // ВАЖНО: мульти-региональный запрос torgi молча режет size до 10 (одиночный уважает 100),
  // поэтому при исчерпании мердж-бюджета переключаемся на глубокий по-региональный догон.
  async function fetchMemberNewLots(m) {
    const fresh = [];
    let truncated = false;
    for (let page = 0; page < maxCatchupPages; page++) {
      const data = await client.searchLots({ dynSubjRF: m.dynSubjRF, catCode: m.catCode, fiasGUID: m.fiasGUID || undefined, lotStatuses, size: catchupPageSize, page });
      const lots = data.content || [];
      let sawKnown = false;
      for (const lot of lots) {
        if (store.has(m.name, lotId(lot))) sawKnown = true;
        else fresh.push({ lot, member: m });
      }
      if (sawKnown || data.last || lots.length === 0) break;
      if (page === maxCatchupPages - 1) truncated = true;
    }
    return { fresh, truncated };
  }

  async function fetchNewLots() {
    const fresh = [];
    const regionParam = multi ? list.map((m) => m.dynSubjRF) : list[0].dynSubjRF;
    let truncated = false;
    for (let page = 0; page < maxCatchupPages; page++) {
      const data = await client.searchLots({ dynSubjRF: regionParam, catCode, fiasGUID, lotStatuses, size: catchupPageSize, page });
      const lots = data.content || [];
      let sawKnown = false;
      for (const lot of lots) {
        const m = memberOf(lot);
        if (!m) continue; // регион вне группы — по построению запроса не бывает, но страхуемся
        if (store.has(m.name, lotId(lot))) sawKnown = true;
        else fresh.push({ lot, member: m });
      }
      if (sawKnown || data.last || lots.length === 0) break;
      if (page === maxCatchupPages - 1) truncated = true; // упёрлись в потолок, известного так и нет
    }
    if (!truncated || !multi) return { fresh, truncated };

    // Мердж-бюджет кончился, границы «виденного» нет (долгий простой) — добираем по каждому
    // региону отдельно: там size=100 работает, глубины хватает на многодневный простой.
    log(`[${name}] догон мерджем упёрся в потолок — включаю глубокий по-региональный догон`);
    const deep = [];
    let deepTruncated = false;
    for (const m of list) {
      const r = await fetchMemberNewLots(m);
      deep.push(...r.fresh);
      if (r.truncated) deepTruncated = true;
    }
    const pubTs = (x) => Date.parse(x.lot.noticeFirstVersionPublicationDate || x.lot.createDate || '') || 0;
    deep.sort((a, b) => pubTs(b) - pubTs(a)); // новые сверху — вызывающий перевернёт в хронологию
    return { fresh: deep, truncated: deepTruncated };
  }

  // --- универсальная линия: один запрос без категории, граница по корзине _all ---

  // Первичный засев общей корзины: всё видимое сейчас по каждому региону (любые категории)
  // помечается виденным без уведомлений — граница для последующих циклов.
  async function seedAll() {
    let added = 0;
    for (const region of uniqueRegions) {
      for (let page = 0; page < maxSeedPages; page++) {
        const data = await client.searchLots({ dynSubjRF: region, lotStatuses, size: 100, page });
        const lots = data.content || [];
        for (const lot of lots) {
          if (!store.has(ALL, lotId(lot))) { store.add(ALL, lotId(lot)); added++; }
        }
        store.save();
        if (data.last || lots.length === 0) break;
      }
    }
    store.markSeeded(ALL);
    store.save();
    log(`[${name}] первичный засев общей корзины: ${added} лотов записано без уведомлений`);
  }

  async function fetchNewLotsUniversal() {
    const fresh = [];
    let truncated = false;
    for (let page = 0; page < maxCatchupPages; page++) {
      const data = await client.searchLots({ dynSubjRF: uniqueRegions, lotStatuses, size: catchupPageSize, page });
      const lots = data.content || [];
      let sawKnown = false;
      for (const lot of lots) {
        if (store.has(ALL, lotId(lot))) sawKnown = true;
        else fresh.push(lot);
      }
      if (sawKnown || data.last || lots.length === 0) break;
      if (page === maxCatchupPages - 1) truncated = true;
    }
    return { fresh, truncated };
  }

  async function pollOnceUniversal() {
    const unseededMembers = list.filter((m) => !store.isSeeded(m.name));
    const needSeedAll = !store.isSeeded(ALL);
    if (unseededMembers.length > 0 || needSeedAll) {
      for (const m of unseededMembers) await seedMember(m);
      if (needSeedAll) await seedAll();
      return { seeded: true, notified: 0, truncated: false };
    }

    const { fresh, truncated } = await fetchNewLotsUniversal();
    fresh.reverse(); // старые сначала — сообщения приходят хронологично
    let notified = 0;
    for (const lot of fresh) {
      // classify может сходить за деталью и бросить — тогда цикл повторится, лот не потеряется
      const targets = await classify(lot);
      for (const member of targets) {
        if (store.has(member.name, lotId(lot))) continue;
        await notifyLot(lot, member);
        store.add(member.name, lotId(lot));
        notified++;
      }
      store.add(ALL, lotId(lot)); // виденное (в т.ч. чужие категории) — граница для следующих циклов
      store.save();
    }

    let finalTruncated = false;
    if (truncated) {
      // Бюджет универсального прохода кончился без границы (долгий простой):
      // добираем каждым фильтром его точным запросом (catCode+fiasGUID, size=100 работает).
      log(`[${name}] универсальный догон упёрся в потолок — включаю по-фильтровый глубокий догон`);
      const deep = [];
      for (const m of list) {
        const r = await fetchMemberNewLots(m);
        deep.push(...r.fresh);
        if (r.truncated) finalTruncated = true;
      }
      const pubTs = (x) => Date.parse(x.lot.noticeFirstVersionPublicationDate || x.lot.createDate || '') || 0;
      deep.sort((a, b) => pubTs(a) - pubTs(b)); // старые сначала
      for (const { lot, member } of deep) {
        if (!store.has(member.name, lotId(lot))) {
          await notifyLot(lot, member);
          store.add(member.name, lotId(lot));
          notified++;
        }
        store.add(ALL, lotId(lot));
      }
      store.save();
      if (finalTruncated) {
        log(`[${name}] и глубокий догон упёрся в потолок: досылано ${notified}, часть старых могла не поместиться`);
        if (onCatchupOverflow) { try { await onCatchupOverflow(notified); } catch {} }
      }
    }
    return { seeded: false, notified, truncated: finalTruncated };
  }

  async function pollOnce() {
    if (universal) return pollOnceUniversal();
    const unseeded = list.filter((m) => !store.isSeeded(m.name));
    if (unseeded.length > 0) {
      for (const m of unseeded) await seedMember(m);
      return { seeded: true, notified: 0, truncated: false };
    }
    const { fresh, truncated } = await fetchNewLots();
    fresh.reverse(); // старые сначала — сообщения приходят хронологично
    let notified = 0;
    for (const { lot, member } of fresh) {
      await notifyLot(lot, member); // бросит — лот не пометится и уйдёт в ретрай следующим циклом
      store.add(member.name, lotId(lot));
      store.save();
      notified++;
    }
    if (truncated) {
      log(`[${name}] догон упёрся в потолок ${maxCatchupPages}×${catchupPageSize}: досылано ${notified}, часть старых могла не поместиться`);
      if (onCatchupOverflow) { try { await onCatchupOverflow(notified); } catch {} }
    }
    return { seeded: false, notified, truncated };
  }

  async function run() {
    log(`[${name}] поллер запущен: catCode=${catCode}, регионы=${list.map((m) => m.dynSubjRF).join('+')}, интервал ${pollIntervalMs}мс`);
    let alerted = false;
    while (!stopped) {
      try {
        const r = await pollOnce();
        lastOkAt = now();
        totalNotified += r.notified;
        if (alerted && reportOk) { alerted = false; try { await reportOk(); } catch {} }
        consecutiveErrors = 0;
        if (r.notified > 0) log(`[${name}] отправлено уведомлений: ${r.notified}`);
      } catch (e) {
        consecutiveErrors++;
        totalErrors++;
        const brief = String((e && e.message) || e).slice(0, 140);
        lastError = { at: now(), message: brief };
        if (consecutiveErrors === 1) errorStreakStartAt = now();
        // 429/5xx — временный rate-limit/обслуживание torgi: первые повторы через обычный
        // интервал, при затяжной серии пауза мягко растёт ×1.5 до потолка. Сеть/иное — жёстко ×2.
        const soft = /HTTP (429|5\d\d)/.test(e.message);
        const backoff = soft
          ? Math.min(pollIntervalMs * 1.5 ** Math.max(0, consecutiveErrors - 3), maxBackoffMs)
          : Math.min(pollIntervalMs * 2 ** consecutiveErrors, maxBackoffMs);
        if (!soft || consecutiveErrors === 1 || consecutiveErrors % 20 === 0) {
          log(`[${name}] ${soft ? '503/недоступен' : 'ошибка'} (${consecutiveErrors} подряд) — пауза ${backoff}мс: ${brief}`);
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
    stats: () => ({ consecutiveErrors, lastOkAt, totalErrors, totalNotified, lastError }),
  };
}

module.exports = { createPoller };

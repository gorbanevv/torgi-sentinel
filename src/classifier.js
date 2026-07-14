'use strict';

// Классификатор лота из универсальной линии: регион → категория → город.
//
// Универсальная линия спрашивает torgi ОДНИМ запросом «все свежие лоты трёх регионов
// без категории» (лимит IP ~6 запросов/мин делится на 1 линию, а не на 7 → цикл ~15с
// вместо 75с). Раскладка по логическим фильтрам — здесь, за 0 запросов в типовом случае.
//
// Категория: category.code в карточке — ЛИСТ дерева; сводим к родителю по таблице
// (листья собраны с живых фасетов 2026-07-14 по трём регионам + объединение с более
// ранними наблюдениями). Неопознанный лист — не наше (докладываем в onUnknownCategory,
// код всплывёт в суточном отчёте).
//
// Город (для фильтров с fiasGUID): быстрый путь — кадастровый квартал города или имя
// города в тексте карточки; иначе — одна деталь лота (estateAddress нормализован:
// «край Краснодарский, г.о. город Краснодар, …»). Деталь недоступна → бросаем: цикл
// повторится, лот не потеряется молча.

const PARENT_BY_LEAF = new Map();
for (const [parent, leaves] of [
  ['7', ['7', '8', '9', '10', '11', '20', '47', '202', '206', '207', '208', '220']],
  ['2', ['2', '4', '301', '302', '307', '2004']],
  ['100', ['100', '31', '100000', '100001', '100002']],
]) {
  for (const leaf of leaves) PARENT_BY_LEAF.set(leaf, parent);
}

function parentCatOf(code) {
  if (code === undefined || code === null) return null;
  return PARENT_BY_LEAF.get(String(code)) || null;
}

const KRD_GUID = '7dfa745e-aa19-4688-b121-b655c11e482f';
const SOCHI_GUID = '79da737a-603b-4c19-9b54-9114c96fb912';

// Признаки города: кадастровый квартал (23:43 — Краснодар, 23:49 — Сочи) и имя.
// «Краснодар(?!ск)» пропускает склонения (Краснодара, Краснодаре), но режет
// «Краснодарский край»; у «Сочи» склонений нет — только границы слова.
const CITY_RULES = new Map([
  [KRD_GUID, { cadastral: /(?<!\d)23:43:/, name: /(?<![а-яё])краснодар(?!ск)/i }],
  [SOCHI_GUID, { cadastral: /(?<!\d)23:49:/, name: /(?<![а-яё])сочи(?![а-яё])/i }],
]);

function rawValue(ch) {
  let v = ch.characteristicValue !== undefined ? ch.characteristicValue : ch.value;
  if (v && typeof v === 'object') v = v.name !== undefined ? v.name : v.value;
  return v;
}

// Текст карточки для поиска городских признаков: имя, описание и строковые характеристики
// (кадастровые номера, адреса). Организатора в карточке нет — ложных срабатываний
// от «администрации г. Краснодара», продающей районный лот, не будет.
function cardText(lot) {
  const parts = [lot.lotName || '', lot.lotDescription || ''];
  for (const ch of [...(lot.characteristics || []), ...(lot.attributes || [])]) {
    const v = rawValue(ch);
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join(' | ');
}

function cityMatchesText(rules, text) {
  return rules.cadastral.test(text) || rules.name.test(text);
}

function createClassifier({ members, client, log = () => {}, onUnknownCategory = null }) {
  async function classify(lot) {
    const parent = parentCatOf(lot.category && lot.category.code);
    if (!parent) {
      const code = lot.category && lot.category.code;
      if (code !== undefined && onUnknownCategory) {
        // код вне наших деревьев: почти всегда чужая категория (стройматериалы и т.п.);
        // если это новый лист под нашим родителем — увидим код в суточном отчёте
        try { onUnknownCategory(String(code)); } catch {}
      }
      return [];
    }
    const candidates = members.filter(
      (m) => String(m.subjectRFCode) === String(lot.subjectRFCode) && String(m.catCode) === parent
    );
    if (candidates.length === 0) return [];

    const regionWide = candidates.filter((m) => !m.fiasGUID);
    const cityScoped = candidates.filter((m) => m.fiasGUID);
    const result = [...regionWide];
    if (cityScoped.length === 0) return result;

    const text = cardText(lot);
    const fastHits = cityScoped.filter((m) => {
      const rules = CITY_RULES.get(m.fiasGUID);
      return rules && cityMatchesText(rules, text);
    });
    if (fastHits.length > 0) return [...result, ...fastHits];

    // Быстрых признаков нет — города выясняем по нормализованному адресу из детали.
    // Бросок при недоступности детали намеренный: пусть цикл повторится.
    const detail = await client.getLotDetail(lot.id || `${lot.noticeNumber}_${lot.lotNumber}`);
    const detailText = [detail && detail.estateAddress, detail && detail.lotName]
      .filter(Boolean)
      .join(' | ');
    const detailHits = cityScoped.filter((m) => {
      const rules = CITY_RULES.get(m.fiasGUID);
      return rules && cityMatchesText(rules, detailText);
    });
    return [...result, ...detailHits];
  }

  return { classify };
}

module.exports = { createClassifier, parentCatOf, cardText, KRD_GUID, SOCHI_GUID };

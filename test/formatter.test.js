'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  formatLotMessage,
  stripHtml,
  formatPrice,
  formatDateMsk,
  extractArea,
  CAPTION_LIMIT,
} = require('../src/formatter');

const filterRealty = { name: 'sev-realty', displayName: 'Севастополь · Недвижимость', realEstate: true };

function fixtureLot(overrides = {}) {
  return {
    id: '21000018600000001234_1',
    noticeNumber: '21000018600000001234',
    lotNumber: 1,
    lotStatus: 'PUBLISHED',
    biddType: { code: '178FZ', name: 'Продажа государственного и муниципального имущества' },
    biddForm: { code: 'EA', name: 'Электронный аукцион' },
    lotName: 'Нежилое помещение <площадь & кадастр>',
    lotDescription: 'Подвал, отдельный вход',
    priceMin: 2100892000,
    biddEndTime: '2026-07-13T14:45:00.000+00:00',
    lotImages: ['69006841e87a5339369bc20d'],
    characteristics: [
      { code: 'CadastralNumber', name: 'Кадастровый номер', characteristicValue: '91:02:001002:555' },
      { code: 'SquareZU', name: 'Площадь земельного участка', characteristicValue: 1281.0, unit: { name: 'квадратный метр' } },
    ],
    attributes: [{ code: 'DA_address', fullName: 'Адрес имущества', value: 'г. Севастополь, ул. Ленина, 1' }],
    category: { code: '11', name: 'Нежилые помещения' },
    subjectRFCode: '92',
    currencyCode: '643',
    ...overrides,
  };
}

test('полное сообщение: площадь, цена, дата МСК, адрес, ссылка, фото', () => {
  const { text, imageIds } = formatLotMessage(fixtureLot(), filterRealty);
  assert.ok(text.includes('1281 кв. м'), 'площадь с единицей');
  assert.ok(text.includes('2 100 892 000 ₽'), 'цена с разбивкой тысяч');
  assert.ok(text.includes('13.07.2026 17:45 МСК'), 'UTC 14:45 → МСК 17:45');
  assert.ok(text.includes('г. Севастополь, ул. Ленина, 1'), 'адрес');
  assert.ok(text.includes('https://torgi.gov.ru/new/public/lots/lot/21000018600000001234_1'), 'ссылка на лот');
  assert.ok(text.includes('Электронный аукцион'), 'форма торгов');
  assert.deepStrictEqual(imageIds, ['69006841e87a5339369bc20d']);
});

test('все фото лота отдаются списком, максимум 10 (лимит альбома Telegram)', () => {
  const many = Array.from({ length: 17 }, (_, i) => 'img' + i);
  const { imageIds } = formatLotMessage(fixtureLot({ lotImages: many }), filterRealty);
  assert.strictEqual(imageIds.length, 10, 'обрезано до 10');
  assert.deepStrictEqual(imageIds, many.slice(0, 10), 'первые 10, порядок сохранён');
});

test('HTML в названии лота экранируется', () => {
  const { text } = formatLotMessage(fixtureLot(), filterRealty);
  assert.ok(text.includes('&lt;площадь &amp; кадастр&gt;'));
  assert.ok(!text.includes('<площадь'));
});

test('лот без фото → imageIds пуст, лимит 4096', () => {
  const { imageIds } = formatLotMessage(fixtureLot({ lotImages: [] }), filterRealty);
  assert.deepStrictEqual(imageIds, []);
});

test('лот без цены и без характеристик не падает', () => {
  const lot = fixtureLot({ priceMin: undefined, priceMinExact: undefined, characteristics: [], attributes: [] });
  const { text } = formatLotMessage(lot, filterRealty);
  assert.ok(!text.includes('Начальная цена'));
  assert.ok(text.includes('lots/lot/'));
});

test('подпись к фото не превышает лимит Telegram 1024', () => {
  const lot = fixtureLot({
    lotName: 'Д'.repeat(600),
    lotDescription: 'О'.repeat(600),
  });
  const { text } = formatLotMessage(lot, filterRealty);
  assert.ok(text.length <= CAPTION_LIMIT, `длина ${text.length} > ${CAPTION_LIMIT}`);
});

test('formatPrice: копейки показываются только ненулевые', () => {
  assert.strictEqual(formatPrice(1500000), '1 500 000');
  assert.strictEqual(formatPrice(1234.5), '1 234,50');
  assert.strictEqual(formatPrice('мусор'), null);
});

test('formatDateMsk: null на мусоре', () => {
  assert.strictEqual(formatDateMsk('не дата'), null);
  assert.strictEqual(formatDateMsk(undefined), null);
});

test('extractArea: находит по коду Square* даже без слова «площадь»', () => {
  const area = extractArea({ characteristics: [{ code: 'totalAreaRealty', name: '', characteristicValue: '56,7' }] });
  assert.ok(area);
  assert.strictEqual(area.value, 56.7);
});

test('stripHtml убирает теги и раскрывает сущности', () => {
  assert.strictEqual(stripHtml('<b>x &amp; y</b>'), 'x & y');
});

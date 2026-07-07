'use strict';
// Живой смок-тест против torgi.gov.ru: доступность API, сортировка, пагинация,
// оба боевых фильтра, скачивание картинки, предпросмотр сообщения.
// Запуск: npm run smoke
const fs = require('fs');
const path = require('path');
const { createTorgiClient } = require('../src/torgiClient');
const { formatLotMessage, stripHtml } = require('../src/formatter');

(async () => {
  const client = createTorgiClient();
  let failures = 0;
  const check = (cond, label, extra = '') => {
    console.log((cond ? 'OK   ' : 'FAIL ') + label + (extra ? ' — ' + extra : ''));
    if (!cond) failures++;
  };

  const t0 = Date.now();
  const glob = await client.searchLots({ size: 30, page: 0 });
  const coldMs = Date.now() - t0;
  check(glob.totalElements > 0, `API доступен (холодный запрос ${coldMs}мс), PUBLISHED лотов всего: ${glob.totalElements}`);

  const t1 = Date.now();
  await client.searchLots({ size: 1, page: 0 });
  const warmMs = Date.now() - t1;
  check(warmMs < 2000, `тёплый запрос быстрый: ${warmMs}мс`);

  const dates = (glob.content || []).map((l) => l.noticeFirstVersionPublicationDate || l.createDate);
  let sorted = true;
  for (let i = 1; i < dates.length; i++) if (dates[i - 1] < dates[i]) sorted = false;
  check(sorted, 'сортировка по дате публикации убывает');

  const p0 = await client.searchLots({ catCode: '100', size: 5, page: 0 });
  const p1 = await client.searchLots({ catCode: '100', size: 5, page: 1 });
  check(
    p1.number === 1 && p0.content[0] && p1.content[0] && p1.content[0].id !== p0.content[0].id,
    'пагинация page= работает'
  );

  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  for (const f of cfg.filters) {
    const r = await client.searchLots({ dynSubjRF: f.dynSubjRF, catCode: f.catCode, size: 5, page: 0 });
    check(typeof r.totalElements === 'number', `фильтр «${f.displayName}» отвечает, лотов сейчас: ${r.totalElements}`);
  }

  let lotWithImg = null;
  for (let p = 0; p < 5 && !lotWithImg; p++) {
    const r = await client.searchLots({ catCode: '7', size: 100, page: p });
    lotWithImg = (r.content || []).find((l) => Array.isArray(l.lotImages) && l.lotImages.length > 0);
    if (r.last) break;
  }
  if (lotWithImg) {
    const img = await client.downloadImage(lotWithImg.lotImages[0]);
    const magic = img.buffer.slice(0, 2).toString('hex');
    check(magic === 'ffd8' || magic === '8950', `картинка скачана: ${img.buffer.length} байт, ${img.contentType}`);

    const { text, imageId } = formatLotMessage(lotWithImg, {
      name: 'preview',
      displayName: 'Предпросмотр (недвижимость)',
      realEstate: true,
    });
    check(text.includes('lots/lot/') && Boolean(imageId), 'форматтер собрал сообщение с фото');
    console.log('\n---------- ПРЕДПРОСМОТР СООБЩЕНИЯ ----------');
    console.log(stripHtml(text));
    console.log('--------------------------------------------\n');
  } else {
    check(false, 'не найден лот с фото для проверки картинки');
  }

  console.log(failures === 0 ? 'SMOKE: всё зелёное ✓' : `SMOKE: провалов ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE FATAL:', e.message);
  process.exit(1);
});

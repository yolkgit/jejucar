'use strict';
/** 저장된 HTML 을 cheerio 로 뜯어보며 어댑터 선택자를 확정한다. (개발용) */

const fs = require('fs');
const cheerio = require('cheerio');

const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const $ = cheerio.load(html);

console.log('.pro_title     :', $('.pro_title').length);
console.log('ul.carinfo     :', $('ul.carinfo').length);
console.log('.pro_price     :', $('.pro_price .price').length);
console.log('.tprice(주석밖):', $('.tprice').length);

// 카드 하나의 조상 사슬을 따라가며 반복 단위 컨테이너를 찾는다.
const first = $('.pro_title').first();
let node = first;
for (let i = 0; i < 5; i++) {
  node = node.parent();
  if (!node.length || !node.get(0).tagName) break;
  const el = node.get(0);
  console.log(
    `부모${i + 1}: <${el.tagName}> class="${node.attr('class') || '-'}" href="${node.attr('href') || '-'}" onclick="${(node.attr('onclick') || '-').slice(0, 90)}"`
  );
}

console.log('\n─── 카드별 파싱 결과 ───');
$('.pro_title').each((i, el) => {
  if (i >= 8) return;
  const t = $(el);
  const nameEl = t.find('.name');
  // .name 안에는 배지·연식 요소가 섞여 있으므로 자식을 지우고 남은 텍스트가 차종명이다.
  const model = nameEl.clone().children().remove().end().text().trim();
  const year = t.find('.rent_year').text().trim();
  const badges = t.find('.pro_event p').map((_, b) => $(b).text().trim()).get();
  const price = t.find('.pro_price .price strong').text().trim();
  const listPrice = t.find('.pro_price .tprice').text().trim();

  // carinfo 는 .pro_title 의 형제다.
  const info = t.nextAll('ul.carinfo').first().find('li').map((_, li) => $(li).text().trim()).get();
  const img = t.prevAll('.pro_thum').first().find('img').attr('src')
    || t.parent().find('.pro_thum img').attr('src') || '';

  console.log(
    `${i} | ${model} | ${year} | 배지:[${badges.join(',')}] | 가격:${price} | 정가:"${listPrice}" | info:[${info.join(' / ')}] | img:${img}`
  );
});

// 상세 링크가 있는지 — external_id 후보를 찾기 위해
console.log('\n─── 링크 후보 ───');
const hrefs = new Set();
$('a[href]').each((_, a) => {
  const h = $(a).attr('href');
  if (/car|rent|view|detail|product/i.test(h)) hrefs.add(h);
});
[...hrefs].slice(0, 15).forEach((h) => console.log(' ', h));

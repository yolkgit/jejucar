'use strict';
/**
 * 저장된 대용량 API 응답에서 테스트 픽스처를 잘라낸다. (개발용)
 *
 *   node scripts/make-fixture.js
 *
 * 1.5MB 전체를 저장소에 넣을 이유는 없다. 구조를 대표하는 몇 건만 남기되,
 * 등급이 서로 다른 항목을 골라 분류 로직이 실제로 검증되게 한다.
 */

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'data', 'probe', 'dolharupang-cars.json');
const dst = path.join(__dirname, '..', 'tests', 'fixtures', 'dolharupang-cars.json');

if (!fs.existsSync(src)) {
  console.error(`원본이 없습니다: ${src}\n먼저 node scripts/analyze-cars.js 를 실행하세요.`);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const items = data.data.items;

// 등급별로 하나씩 골라 분류 로직을 폭넓게 검증한다.
const wanted = ['경차', '소형∙준중형', '중형', '대형', 'RV∙SUV', '승합', '외제'];
const picked = [];
for (const type of wanted) {
  const it = items.find((i) => i.type === type && i.offers?.length);
  if (it) {
    // offer 는 최대 2개만 남긴다.
    picked.push({ ...it, offers: it.offers.slice(0, 2) });
  }
}

// 가격이 없는 offer 와 id 가 없는 offer 도 하나씩 넣어 방어 로직을 검증한다.
const base = picked[0];
picked.push({
  ...base,
  packageGroupId: 'pkg_test_broken',
  name: '테스트 결측 상품',
  offers: [
    { ...base.offers[0], productDetailId: 'prdt_no_price', pricing: {} },
    { ...base.offers[0], productDetailId: null },
  ],
});

const out = { success: true, data: { items: picked } };
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, JSON.stringify(out, null, 2), 'utf8');

const offers = picked.reduce((n, i) => n + i.offers.length, 0);
console.log(`픽스처 생성: ${dst}`);
console.log(`  차종 ${picked.length}개 / offer ${offers}개 / ${(fs.statSync(dst).size / 1024).toFixed(1)} KB`);
console.log(`  등급: ${picked.map((p) => p.type).join(', ')}`);

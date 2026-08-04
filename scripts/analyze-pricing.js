'use strict';
/** 저장된 /api/cars 응답에서 pricing 객체의 의미를 파악한다. (개발용) */

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'probe', 'dolharupang-cars.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const items = data.data.items;

const offers = [];
for (const it of items) for (const o of it.offers || []) offers.push({ it, o });

console.log(`offer 총 ${offers.length}개\n`);

// pricing 에 실제로 어떤 키들이 오는가
const keyCombos = new Map();
for (const { o } of offers) {
  const keys = Object.keys(o.pricing || {}).sort().join(',');
  keyCombos.set(keys, (keyCombos.get(keys) || 0) + 1);
}
console.log('── pricing 키 조합 ──');
for (const [k, n] of [...keyCombos].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(5)}건: {${k}}`);
}

// salePrice vs originalPrice 관계
let higher = 0, lower = 0, equal = 0, missing = 0;
const samplesHigher = [];
const samplesLower = [];
for (const { it, o } of offers) {
  const s = o.pricing?.salePrice;
  const orig = o.pricing?.originalPrice;
  if (!Number.isFinite(s) || !Number.isFinite(orig)) { missing++; continue; }
  if (s > orig) { higher++; if (samplesHigher.length < 4) samplesHigher.push({ it, o }); }
  else if (s < orig) { lower++; if (samplesLower.length < 3) samplesLower.push({ it, o }); }
  else equal++;
}
console.log(`\n── salePrice vs originalPrice ──`);
console.log(`  판매가 < 정가 (정상 할인): ${lower}`);
console.log(`  판매가 > 정가 (역전)     : ${higher}`);
console.log(`  같음                     : ${equal}`);
console.log(`  둘 중 결측               : ${missing}`);

const dump = (label, list) => {
  console.log(`\n── ${label} ──`);
  for (const { it, o } of list) {
    console.log(`  ${it.name} / ${it.type} / ${o.companyName}`);
    console.log(`    pricing: ${JSON.stringify(o.pricing)}`);
    console.log(`    insurance: ${JSON.stringify(o.insurance)}  availableQuantity: ${o.availableQuantity}`);
  }
};
dump('역전 사례 (판매가 > 정가)', samplesHigher);
dump('정상 사례 (판매가 < 정가)', samplesLower);

// 역전 비율이 등급/업체별로 쏠리는가
const byType = {};
for (const { it, o } of offers) {
  const s = o.pricing?.salePrice, orig = o.pricing?.originalPrice;
  if (!Number.isFinite(s) || !Number.isFinite(orig)) continue;
  byType[it.type] = byType[it.type] || { hi: 0, lo: 0 };
  if (s > orig) byType[it.type].hi++; else byType[it.type].lo++;
}
console.log('\n── 등급별 역전 비율 ──');
for (const [t, v] of Object.entries(byType)) {
  const tot = v.hi + v.lo;
  console.log(`  ${t.padEnd(12)} 역전 ${String(v.hi).padStart(4)}/${tot} (${((v.hi / tot) * 100).toFixed(0)}%)`);
}

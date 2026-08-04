'use strict';
/**
 * dolharupang /api/cars 응답을 받아 저장하고 가격 구조를 분석한다. (개발용)
 *
 *   node scripts/analyze-cars.js [startDate] [endDate]
 */

const fs = require('fs');
const path = require('path');
const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');

const robots = new RobotsCache();

(async () => {
  const start = process.argv[2] || '2026-09-14T10:00:00';
  const end = process.argv[3] || '2026-09-15T10:00:00';
  const url = `https://www.dolharupang.com/api/cars?startDate=${start}&endDate=${end}`;

  const v = await robots.check(url);
  console.log(`robots: ${v.allowed ? '허용' : '금지'}`);
  if (!v.allowed) process.exit(1);

  const res = await politeFetch(url, {
    timeoutMs: 40000,
    retries: 1,
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  });
  console.log(`HTTP ${res.status} · ${res.body.length} bytes`);

  const outDir = path.join(__dirname, '..', 'data', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'dolharupang-cars.json');
  fs.writeFileSync(file, res.body, 'utf8');
  console.log(`저장: ${file}\n`);

  const data = JSON.parse(res.body);
  const items = data.data?.items || [];
  console.log(`차종 ${items.length}개`);

  const offerCount = items.reduce((n, it) => n + (it.offers?.length || 0), 0);
  console.log(`offer(업체별 상품) 총 ${offerCount}개\n`);

  // offer 하나의 키 구조 (options 배열은 길어서 제외)
  const sample = items.find((it) => it.offers?.length)?.offers[0];
  console.log('── offer 키 구조 ──');
  for (const [k, val] of Object.entries(sample)) {
    if (k === 'options') {
      console.log(`  options: [${val.length}개]`);
      continue;
    }
    if (val && typeof val === 'object') {
      console.log(`  ${k}: ${Array.isArray(val) ? `[${val.length}개]` : '{'}`);
      const inner = Array.isArray(val) ? val[0] : val;
      if (inner && typeof inner === 'object') {
        for (const [k2, v2] of Object.entries(inner)) {
          const s = v2 && typeof v2 === 'object' ? JSON.stringify(v2).slice(0, 90) : String(v2);
          console.log(`      ${k2}: ${s}`);
        }
      }
    } else {
      console.log(`  ${k}: ${val}`);
    }
  }

  // 차종 등급 분포
  const types = {};
  for (const it of items) types[it.type] = (types[it.type] || 0) + 1;
  console.log('\n── 등급 분포 ──');
  Object.entries(types).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}: ${n}`));

  // 업체 수
  const companies = new Set();
  for (const it of items) for (const o of it.offers || []) companies.add(o.companyName);
  console.log(`\n── 업체 ${companies.size}곳 ──`);
  console.log('  ' + [...companies].slice(0, 25).join(', '));
})();

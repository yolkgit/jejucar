'use strict';
/** 수집한 딜의 딥링크가 실제로 상품 페이지로 연결되는지 확인한다. (개발용) */

const { db } = require('../src/db');
const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');

const robots = new RobotsCache();

(async () => {
  const rows = db
    .prepare(
      `SELECT d.external_id, d.car_model, d.vendor_name, d.valid_from, d.detail_url, s.key AS src
         FROM deals d JOIN sources s ON s.id = d.source_id
        WHERE s.key = ? LIMIT 3`
    )
    .all(process.argv[2] || 'dolharupang');

  for (const r of rows) {
    console.log(`\n■ ${r.car_model} / ${r.vendor_name}`);
    console.log(`  external_id: ${r.external_id}`);
    console.log(`  현재 detail_url: ${r.detail_url}`);

    if (r.src === 'dolharupang') {
      const start = `${r.valid_from}T10:00:00`;
      const endD = new Date(`${r.valid_from}T00:00:00`);
      endD.setDate(endD.getDate() + 1);
      const end = `${endD.toISOString().slice(0, 10)}T10:00:00`;
      const q = new URLSearchParams({
        productDetailId: r.external_id,
        optionIndex: '0',
        startDate: start,
        endDate: end,
      });
      const deep = `https://www.dolharupang.com/cars/reservation?${q}`;
      console.log(`  후보 딥링크: ${deep}`);

      const v = await robots.check(deep);
      if (!v.allowed) {
        console.log(`  robots: 금지 — ${v.reason}`);
        continue;
      }
      try {
        const res = await politeFetch(deep, { timeoutMs: 25000, retries: 0 });
        const body = res.body || '';
        // 차종명이 페이지에 나오면 올바른 상품으로 연결된 것이다.
        const modelWord = r.car_model.split(' ')[0];
        console.log(
          `  → HTTP ${res.status} · ${body.length} bytes · 차종명 포함: ${body.includes(modelWord) ? '예' : '아니오'} · 업체명 포함: ${body.includes(r.vendor_name) ? '예' : '아니오'}`
        );
      } catch (err) {
        console.log(`  → 실패: ${err.message}`);
      }
    }
  }
})();

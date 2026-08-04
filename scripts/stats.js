'use strict';
/** 수집된 딜의 분포를 요약한다. (개발용) */

const { db } = require('../src/db');
const { DISCOUNT_CAP } = require('../src/config');

const bySource = db
  .prepare(
    `SELECT s.key, s.kind, COUNT(*) AS n,
            SUM(CASE WHEN d.list_price IS NULL THEN 1 ELSE 0 END) AS no_list,
            MIN(d.sale_price) AS min_p, MAX(d.sale_price) AS max_p,
            MAX(d.discount_pct) AS max_pct,
            SUM(CASE WHEN d.discount_pct > ? THEN 1 ELSE 0 END) AS over_cap
       FROM deals d JOIN sources s ON s.id = d.source_id
      WHERE d.status = 'active'
      GROUP BY s.key ORDER BY n DESC`
  )
  .all(DISCOUNT_CAP.maxPct);

console.log('소스별 활성 딜');
console.log('key           kind      건수   정가없음  최저가     최고가     최대할인  상한초과');
console.log('─'.repeat(88));
for (const r of bySource) {
  console.log(
    `${r.key.padEnd(13)} ${r.kind.padEnd(9)} ${String(r.n).padStart(5)} ${String(r.no_list).padStart(8)} ` +
      `${r.min_p.toLocaleString().padStart(9)} ${r.max_p.toLocaleString().padStart(10)} ` +
      `${(r.max_pct === null ? '-' : r.max_pct + '%').padStart(8)} ${String(r.over_cap).padStart(8)}`
  );
}

const byClass = db
  .prepare(
    `SELECT car_class, COUNT(*) n, MIN(sale_price) lo, MAX(sale_price) hi
       FROM deals WHERE status='active' GROUP BY car_class ORDER BY n DESC`
  )
  .all();
console.log('\n등급별');
for (const r of byClass) {
  console.log(`  ${r.car_class.padEnd(8)} ${String(r.n).padStart(5)}건  ${r.lo.toLocaleString()} ~ ${r.hi.toLocaleString()}원`);
}

const vendors = db.prepare("SELECT COUNT(DISTINCT vendor_name) c FROM deals WHERE status='active'").get().c;
const total = db.prepare("SELECT COUNT(*) c FROM deals WHERE status='active'").get().c;
console.log(`\n총 ${total.toLocaleString()}건 / 업체 ${vendors}곳`);

console.log('\n최저가 상위 8건');
const cheap = db
  .prepare(
    `SELECT vendor_name, car_model, car_class, list_price, sale_price, discount_pct
       FROM deals WHERE status='active' ORDER BY sale_price LIMIT 8`
  )
  .all();
for (const r of cheap) {
  const disc = r.discount_pct === null ? '정가미표기' : `${r.discount_pct}% 할인`;
  const list = r.list_price ? `${r.list_price.toLocaleString()}원 → ` : '';
  console.log(`  ${r.car_model.slice(0, 22).padEnd(24)} ${r.vendor_name.padEnd(12)} ${list}${r.sale_price.toLocaleString()}원 (${disc})`);
}

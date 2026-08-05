'use strict';
/**
 * 딥링크 커버리지 점검. (개발용)
 * 이 앱은 원 사이트로 보내는 것이 전부이므로, 링크 없는 딜은 존재 의미가 없다.
 */

const { db } = require('../src/db');

const rows = db
  .prepare(
    `SELECT s.key,
            COUNT(*) AS total,
            SUM(CASE WHEN d.detail_url IS NULL OR d.detail_url = '' THEN 1 ELSE 0 END) AS no_link,
            SUM(CASE WHEN d.detail_url LIKE '%reservation%' OR d.detail_url LIKE '%res_form%' THEN 1 ELSE 0 END) AS deep
       FROM deals d JOIN sources s ON s.id = d.source_id
      WHERE d.status = 'active'
      GROUP BY s.key ORDER BY total DESC`
  )
  .all();

console.log('소스          활성딜   링크없음   상품딥링크');
console.log('─'.repeat(52));
for (const r of rows) {
  console.log(
    `${r.key.padEnd(13)} ${String(r.total).padStart(5)} ${String(r.no_link).padStart(9)} ${String(r.deep).padStart(11)}`
  );
}

const sample = db
  .prepare(
    `SELECT vendor_name, car_model, detail_url FROM deals
      WHERE status='active' AND detail_url IS NOT NULL
      ORDER BY discount_pct DESC LIMIT 3`
  )
  .all();
console.log('\n표본:');
for (const s of sample) {
  console.log(`  ${s.car_model} / ${s.vendor_name}`);
  console.log(`    ${s.detail_url}`);
}

const bad = db
  .prepare(
    `SELECT COUNT(*) c FROM deals
      WHERE status='active' AND detail_url IS NOT NULL AND detail_url NOT LIKE 'https://%'`
  )
  .get().c;
if (bad > 0) console.log(`\n경고: https 가 아닌 링크 ${bad}건 — /go 라우트가 거부한다`);

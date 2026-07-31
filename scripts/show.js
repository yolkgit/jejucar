'use strict';
/** 특정 소스의 딜을 표로 출력한다. (개발용) */

const { db } = require('../src/db');

const key = process.argv[2] || 'jejussok';
const rows = db
  .prepare(
    `SELECT d.external_id, d.vendor_name, d.car_model, d.car_class, d.fuel, d.seats,
            d.list_price, d.sale_price, d.discount_pct, d.insurance, d.insurance_included,
            d.first_seen_at, d.last_seen_at, d.status
       FROM deals d JOIN sources s ON s.id = d.source_id
      WHERE s.key = ? ORDER BY d.sale_price`
  )
  .all(key);

if (rows.length === 0) {
  console.log(`소스 '${key}' 에 딜이 없습니다.`);
  process.exit(0);
}

console.log(`소스 '${key}' — ${rows.length}건\n`);
console.log('id     차종                 등급     연료   인승  정가      판매가    할인율  보험');
console.log('─'.repeat(96));
for (const r of rows) {
  console.log(
    [
      r.external_id.padEnd(6),
      r.car_model.padEnd(20),
      (r.car_class || '-').padEnd(8),
      (r.fuel || '-').padEnd(6),
      String(r.seats ?? '-').padStart(3),
      (r.list_price === null ? '미표기' : r.list_price.toLocaleString()).padStart(9),
      r.sale_price.toLocaleString().padStart(9),
      (r.discount_pct === null ? '  -' : `${r.discount_pct}%`).padStart(6),
      `  ${r.insurance || '-'}${r.insurance_included ? '(포함)' : ''}`,
    ].join(' ')
  );
}

console.log(`\n최초 수집: ${rows[0].first_seen_at} / 최근 확인: ${rows[0].last_seen_at}`);

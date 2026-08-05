'use strict';
/** 예약 데이터가 남아 있는지 확인한다. (개발용) */

const { db } = require('../src/db');

const has = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bookings'")
  .get();
if (!has) {
  console.log('bookings 테이블 없음');
  process.exit(0);
}

const total = db.prepare('SELECT COUNT(*) c FROM bookings').get().c;
console.log(`bookings 총 ${total}건`);
if (total > 0) {
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM bookings GROUP BY status').all();
  for (const r of byStatus) console.log(`  ${r.status}: ${r.c}`);
  const recent = db
    .prepare('SELECT code, name, created_at, status FROM bookings ORDER BY created_at DESC LIMIT 5')
    .all();
  console.log('\n최근:');
  for (const r of recent) console.log(`  ${r.code} ${r.name} ${r.created_at} ${r.status}`);
}

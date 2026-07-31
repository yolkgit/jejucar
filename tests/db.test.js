'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// db 모듈은 로드 시점에 DB_PATH 를 읽으므로 require 전에 지정해야 한다.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeju-db-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const {
  db,
  upsertDeal,
  ensureSource,
  ensureVendor,
  discountPct,
  expireStaleDeals,
} = require('../src/db');

const source = ensureSource({ key: 'test', name: '테스트', kind: 'manual', enabled: 1 });
const vendorId = ensureVendor('제주드림렌터카', { pickup_type: 'airport_shuttle', rating: 4.6 });

const base = {
  source_id: source.id,
  vendor_id: vendorId,
  vendor_name: '제주드림렌터카',
  car_model: '아반떼 CN7',
  car_class: '준중형',
  list_price: 89000,
  sale_price: 39000,
  pickup_location: '제주공항',
  valid_from: '2026-08-01',
  valid_to: '2026-08-31',
};

test('discountPct: 내림 계산, 경계값 방어', () => {
  assert.equal(discountPct(89000, 39000), 56);
  assert.equal(discountPct(100000, 50000), 50);
  assert.equal(discountPct(3, 2), 33); // 33.33 → 내림
  assert.equal(discountPct(100, 100), 0); // 할인 없음
  assert.equal(discountPct(100, 200), 0); // 역전 시 0
  assert.equal(discountPct(0, 0), 0); // 0 나눗셈 방어
  assert.equal(discountPct(null, undefined), 0);
  assert.equal(discountPct(100000, 1), 99); // 99 상한 (CHECK 제약과 일치)
});

test('upsertDeal: 신규/갱신을 정확히 구분한다', () => {
  assert.equal(upsertDeal({ ...base, external_id: 'd1' }), 'inserted');
  assert.equal(upsertDeal({ ...base, external_id: 'd1', sale_price: 35000 }), 'updated');
  assert.equal(upsertDeal({ ...base, external_id: 'd2' }), 'inserted');
  assert.equal(upsertDeal({ ...base, external_id: 'd2' }), 'updated');

  const rows = db.prepare('SELECT external_id, sale_price, discount_pct FROM deals ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sale_price, 35000);
  assert.equal(rows[0].discount_pct, 60); // 89000 → 35000
});

test('upsertDeal: 갱신 시 first_seen_at 은 보존되고 last_seen_at 만 움직인다', () => {
  upsertDeal({ ...base, external_id: 'keep' });
  const before = db.prepare('SELECT first_seen_at FROM deals WHERE external_id = ?').get('keep');

  db.prepare("UPDATE deals SET first_seen_at = '2020-01-01 00:00:00' WHERE external_id = 'keep'").run();
  upsertDeal({ ...base, external_id: 'keep', sale_price: 30000 });

  const after = db.prepare('SELECT first_seen_at, last_seen_at FROM deals WHERE external_id = ?').get('keep');
  assert.equal(after.first_seen_at, '2020-01-01 00:00:00', 'first_seen_at 이 덮어써졌다');
  assert.ok(after.last_seen_at > after.first_seen_at);
  assert.ok(before);
});

test('deals: 할인가가 정가를 넘으면 거부한다', () => {
  assert.throws(
    () => upsertDeal({ ...base, external_id: 'bad', list_price: 10000, sale_price: 20000 }),
    /CHECK constraint failed/
  );
});

test('deals: status 는 허용된 값만 받는다', () => {
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO deals (source_id, external_id, vendor_name, car_model, car_class,
             list_price, sale_price, discount_pct, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(source.id, 'bad2', 'v', 'm', '준중형', 100, 50, 50, '이상한값'),
    /CHECK constraint failed/
  );
});

test('deals: valid_to 가 valid_from 보다 빠르면 거부한다', () => {
  assert.throws(
    () => upsertDeal({ ...base, external_id: 'bad3', valid_from: '2026-08-10', valid_to: '2026-08-01' }),
    /CHECK constraint failed/
  );
});

test('bookings: 반납이 대여보다 빠르면 거부한다', () => {
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO bookings (code, days, quoted_price, pickup_at, return_at, name, phone, snapshot_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('JJ-AAAA-BBBB', 1, 1000, '2026-08-10 10:00', '2026-08-09 10:00', '홍길동', '01011112222', '{}'),
    /CHECK constraint failed/
  );
});

test('bookings: 예약번호는 중복될 수 없다', () => {
  const ins = db.prepare(
    `INSERT INTO bookings (code, days, quoted_price, pickup_at, return_at, name, phone, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  ins.run('JJ-CCCC-DDDD', 1, 1000, '2026-08-10 10:00', '2026-08-11 10:00', '홍길동', '01011112222', '{}');
  assert.throws(
    () => ins.run('JJ-CCCC-DDDD', 1, 1000, '2026-08-10 10:00', '2026-08-11 10:00', '김철수', '01033334444', '{}'),
    /UNIQUE constraint failed/
  );
});

test('bookings: 딜이 지워져도 예약은 스냅샷과 함께 살아남는다', () => {
  const dealId = db.prepare('SELECT id FROM deals WHERE external_id = ?').get('d2').id;
  db.prepare(
    `INSERT INTO bookings (code, deal_id, days, quoted_price, pickup_at, return_at, name, phone, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('JJ-EEEE-FFFF', dealId, 2, 78000, '2026-08-10 10:00', '2026-08-12 10:00', '홍길동', '01011112222',
    JSON.stringify({ car_model: '아반떼 CN7', sale_price: 39000 }));

  db.prepare('DELETE FROM deals WHERE id = ?').run(dealId);

  const row = db.prepare('SELECT deal_id, snapshot_json FROM bookings WHERE code = ?').get('JJ-EEEE-FFFF');
  assert.equal(row.deal_id, null, 'ON DELETE SET NULL 이 동작하지 않았다');
  assert.equal(JSON.parse(row.snapshot_json).car_model, '아반떼 CN7');
});

test('expireStaleDeals: 기간 지난 딜만 expired 로 내린다', () => {
  upsertDeal({ ...base, external_id: 'old', valid_from: '2020-01-01', valid_to: '2020-01-02' });
  upsertDeal({ ...base, external_id: 'live', valid_from: '2026-01-01', valid_to: '2099-12-31' });
  upsertDeal({ ...base, external_id: 'nolimit', valid_from: null, valid_to: null });

  const changed = expireStaleDeals();
  assert.ok(changed >= 1);

  const get = (k) => db.prepare('SELECT status FROM deals WHERE external_id = ?').get(k).status;
  assert.equal(get('old'), 'expired');
  assert.equal(get('live'), 'active');
  assert.equal(get('nolimit'), 'active', '유효기간 없는 딜을 만료시키면 안 된다');
});

test('ensureVendor / ensureSource 는 멱등이다', () => {
  const a = ensureVendor('제주드림렌터카');
  const b = ensureVendor('제주드림렌터카');
  assert.equal(a, b);
  assert.equal(ensureSource({ key: 'test', name: '다른이름' }).id, source.id);
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

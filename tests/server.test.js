'use strict';
/**
 * 서버 계층 테스트.
 * Express 5 의 async 에러 자동 전파와 인증·rate limit 을 실제 HTTP 로 확인한다.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeju-srv-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.COLLECT_INTERVAL_MIN = '0';
process.env.ADMIN_PASSWORD = 'test-secret';
process.env.PORT = '0';

const express = require('express');
const { db, ensureSource, ensureVendor, upsertDeal } = require('../src/db');
const { router: dealsRouter } = require('../src/routes/deals');
const { router: bookingsRouter } = require('../src/routes/bookings');
const { router: adminRouter } = require('../src/routes/admin');

// 실제 server.js 와 같은 순서로 조립하되, listen 은 테스트가 제어한다.
const app = express();
app.use(express.json());
app.use('/api', dealsRouter);
app.use('/api', bookingsRouter);
app.use('/api', adminRouter);

// Express 5 가 async rejection 을 에러 핸들러로 넘기는지 확인하는 전용 라우트
app.get('/boom-async', async () => {
  throw new Error('async 폭발');
});
app.get('/boom-sync', () => {
  throw new Error('sync 폭발');
});

app.use((err, req, res, next) => {
  res.status(500).json({ error: '서버 오류가 발생했습니다.', caught: err.message });
});

let base;
let server;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const src = ensureSource({ key: 'seed', name: '샘플', kind: 'manual', enabled: 1 });
  const vid = ensureVendor('제주엔젤카', { rating: 4.7, review_count: 100 });
  upsertDeal({
    source_id: src.id,
    external_id: 't1',
    vendor_id: vid,
    vendor_name: '제주엔젤카',
    car_model: '아반떼 CN7',
    car_class: '준중형',
    list_price: 90000,
    sale_price: 40000,
    min_age: 21,
    min_license_years: 1,
    valid_from: '2020-01-01',
    valid_to: '2099-12-31',
  });
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function req(method, path, { body, cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

test('Express 5: async 핸들러의 rejection 이 에러 핸들러로 전파된다', async () => {
  // 전파되지 않으면 이 요청은 응답 없이 매달려 타임아웃난다.
  const r = await req('GET', '/boom-async');
  assert.equal(r.status, 500);
  assert.equal(r.json.caught, 'async 폭발');
});

test('Express 5: 동기 throw 도 에러 핸들러로 간다', async () => {
  const r = await req('GET', '/boom-sync');
  assert.equal(r.status, 500);
  assert.equal(r.json.caught, 'sync 폭발');
});

test('GET /api/deals: 목록과 필터가 동작한다', async () => {
  const all = await req('GET', '/api/deals');
  assert.equal(all.status, 200);
  assert.ok(all.json.total >= 1);

  const filtered = await req('GET', '/api/deals?carClass=준중형');
  assert.ok(filtered.json.deals.every((d) => d.carClass === '준중형'));

  const none = await req('GET', '/api/deals?carClass=승합');
  assert.equal(none.json.total, 0);

  // 화이트리스트에 없는 값은 무시되어야지, SQL 로 흘러가면 안 된다.
  const bogus = await req('GET', "/api/deals?carClass=' OR 1=1--");
  assert.equal(bogus.status, 200);
  assert.equal(bogus.json.total, all.json.total, '알 수 없는 등급 값이 필터를 우회했다');
});

test('GET /api/deals: 정렬 키가 화이트리스트로 제한된다', async () => {
  const r = await req('GET', '/api/deals?sort=;DROP TABLE deals;--');
  assert.equal(r.status, 200);
  assert.equal(r.json.sort, 'discount', '알 수 없는 정렬 키가 기본값으로 떨어지지 않았다');
  assert.ok(db.prepare('SELECT COUNT(*) c FROM deals').get().c >= 1, '테이블이 사라졌다');
});

test('POST /api/bookings: 동의 없이는 접수되지 않는다', async () => {
  const dealId = db.prepare('SELECT id FROM deals LIMIT 1').get().id;
  const r = await req('POST', '/api/bookings', {
    body: {
      dealId,
      name: '홍길동',
      phone: '01012345678',
      pickupAt: '2099-01-01 10:00',
      returnAt: '2099-01-02 10:00',
      driverAge: 30,
      licenseYears: 5,
      agreePrivacy: false,
    },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /동의/);
});

test('POST /api/bookings: 정상 접수 후 조회·취소가 된다', async () => {
  const dealId = db.prepare('SELECT id FROM deals LIMIT 1').get().id;
  const payload = {
    dealId,
    name: '홍길동',
    phone: '010-1234-5678',
    pickupAt: '2099-01-01 10:00',
    returnAt: '2099-01-03 10:00',
    driverAge: 30,
    licenseYears: 5,
    agreePrivacy: true,
  };

  const created = await req('POST', '/api/bookings', { body: payload });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.match(created.json.code, /^JJ-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(created.json.days, 2);
  assert.equal(created.json.quotedPrice, 80000);

  // 동의 시각이 기록되어야 한다.
  const stored = db.prepare('SELECT privacy_agreed_at FROM bookings WHERE code = ?').get(created.json.code);
  assert.ok(stored.privacy_agreed_at, '개인정보 동의 시각이 저장되지 않았다');

  // 같은 번호·같은 일정 재신청은 막힌다.
  const dup = await req('POST', '/api/bookings', { body: payload });
  assert.equal(dup.status, 409);

  const found = await req('POST', '/api/bookings/lookup', {
    body: { code: created.json.code, phone: '01012345678' },
  });
  assert.equal(found.status, 200);
  assert.equal(found.json.booking.status, 'pending');

  const wrongPhone = await req('POST', '/api/bookings/lookup', {
    body: { code: created.json.code, phone: '01099999999' },
  });
  assert.equal(wrongPhone.status, 404);
  assert.equal(
    wrongPhone.json.error,
    found.status === 200 ? '예약번호 또는 연락처가 일치하지 않습니다.' : wrongPhone.json.error,
    '틀린 연락처에 다른 메시지를 주면 열거 공격에 쓰인다'
  );

  const cancelled = await req('POST', '/api/bookings/cancel', {
    body: { code: created.json.code, phone: '01012345678' },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.booking.status, 'cancelled');

  const again = await req('POST', '/api/bookings/cancel', {
    body: { code: created.json.code, phone: '01012345678' },
  });
  assert.equal(again.status, 409);
});

test('POST /api/bookings: 과거 날짜는 거부한다', async () => {
  const dealId = db.prepare('SELECT id FROM deals LIMIT 1').get().id;
  const r = await req('POST', '/api/bookings', {
    body: {
      dealId,
      name: '김철수',
      phone: '01055556666',
      pickupAt: '2020-01-01 10:00',
      returnAt: '2020-01-02 10:00',
      driverAge: 30,
      licenseYears: 5,
      agreePrivacy: true,
    },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /지난 날짜/);
});

test('관리자 API 는 인증 없이 접근할 수 없다', async () => {
  for (const p of ['/api/admin/stats', '/api/admin/bookings', '/api/admin/deals', '/api/admin/sources']) {
    const r = await req('GET', p);
    assert.equal(r.status, 401, `${p} 가 인증 없이 열렸다`);
  }
});

test('관리자 로그인 후에는 접근할 수 있다', async () => {
  const bad = await req('POST', '/api/admin/login', { body: { password: 'wrong' } });
  assert.equal(bad.status, 401);

  const ok = await req('POST', '/api/admin/login', { body: { password: 'test-secret' } });
  assert.equal(ok.status, 200);
  const cookie = ok.setCookie.split(';')[0];
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Lax/);

  const stats = await req('GET', '/api/admin/stats', { cookie });
  assert.equal(stats.status, 200);
  assert.ok(stats.json.deals.total >= 1);

  // 목록에서 전화번호가 마스킹되어야 한다.
  const list = await req('GET', '/api/admin/bookings', { cookie });
  assert.equal(list.status, 200);
  for (const b of list.json.bookings) {
    assert.match(b.phoneMasked, /^\d{3}-\*{4}-\d{4}$/, '전화번호가 마스킹되지 않았다');
    assert.equal(b.phone, undefined, '목록에 전화번호 원문이 노출됐다');
  }

  const out = await req('POST', '/api/admin/logout', { cookie });
  assert.equal(out.status, 200);
  const after = await req('GET', '/api/admin/stats', { cookie });
  assert.equal(after.status, 401, '로그아웃 후에도 세션이 살아 있다');
});

test('예약 조회 rate limit 이 무차별 대입을 막는다', async () => {
  const { lookupLimiter } = require('../src/routes/bookings');
  lookupLimiter.clear();

  let blocked = 0;
  for (let i = 0; i < 14; i++) {
    const r = await req('POST', '/api/bookings/lookup', {
      body: { code: `JJ-AAAA-${String(i).padStart(4, '2')}`, phone: '01012345678' },
    });
    if (r.status === 429) blocked++;
  }
  assert.ok(blocked >= 3, `15분 10회 제한이 걸리지 않았다 (차단 ${blocked}건)`);
  lookupLimiter.clear();
});

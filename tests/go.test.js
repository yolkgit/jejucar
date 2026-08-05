'use strict';
/**
 * 송출 라우트 테스트.
 *
 * 이 앱의 핵심 기능이자, 유일하게 사용자를 외부로 내보내는 지점이다.
 * 오픈 리다이렉트가 되면 피싱에 악용되므로 목적지 검증을 특히 촘촘히 본다.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeju-go-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.COLLECT_INTERVAL_MIN = '0';

const express = require('express');
const { db, ensureSource, ensureVendor, upsertDeal } = require('../src/db');
const { router: goRouter, safeDestination } = require('../src/routes/go');

const app = express();
app.use('/', goRouter);

let base;
let server;
let dealIds = {};

test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const src = ensureSource({ key: 'dolharupang', name: '돌하루팡', kind: 'api', enabled: 1 });
  const vid = ensureVendor('조아렌트카');

  const mk = (extId, url) => {
    upsertDeal({
      source_id: src.id,
      external_id: extId,
      vendor_id: vid,
      vendor_name: '조아렌트카',
      car_model: '아반떼 CN7',
      car_class: '준중형',
      list_price: 180000,
      sale_price: 17700,
      detail_url: url,
    });
    return db.prepare('SELECT id FROM deals WHERE external_id = ?').get(extId).id;
  };

  dealIds.ok = mk('ok', 'https://www.dolharupang.com/cars/reservation?productDetailId=prdt_1&optionIndex=0');
  dealIds.evil = mk('evil', 'https://evil.example.com/phish');
  dealIds.http = mk('http', 'http://www.dolharupang.com/cars/reservation?productDetailId=prdt_2');
  dealIds.none = mk('none', null);
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function get(p) {
  const res = await fetch(base + p, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
}

test('허용된 판매처로 302 리다이렉트한다', async () => {
  const r = await get(`/go/${dealIds.ok}`);
  assert.equal(r.status, 302);
  assert.match(r.location, /^https:\/\/www\.dolharupang\.com\/cars\/reservation\?/);
});

test('클릭이 집계된다', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM outbound_clicks').get().c;
  await get(`/go/${dealIds.ok}`);
  const after = db.prepare('SELECT COUNT(*) c FROM outbound_clicks').get().c;
  assert.equal(after, before + 1);

  const row = db.prepare('SELECT * FROM outbound_clicks ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.deal_id, dealIds.ok);
  assert.equal(row.source_key, 'dolharupang');
  assert.equal(row.vendor_name, '조아렌트카');
  assert.equal(row.car_model, '아반떼 CN7');
  assert.equal(row.sale_price, 17700);
});

test('집계에 개인정보를 남기지 않는다', () => {
  // IP·User-Agent·쿠키 컬럼이 아예 없어야 한다. 있으면 언젠가 채워진다.
  const cols = db.prepare('PRAGMA table_info(outbound_clicks)').all().map((c) => c.name);
  for (const forbidden of ['ip', 'ip_address', 'user_agent', 'ua', 'cookie', 'session', 'referer']) {
    assert.ok(!cols.includes(forbidden), `개인정보 컬럼이 있다: ${forbidden}`);
  }
  assert.deepEqual(cols.sort(), [
    'car_model', 'clicked_at', 'deal_id', 'id', 'sale_price', 'source_key', 'vendor_name',
  ]);
});

test('허용 목록에 없는 호스트로는 절대 보내지 않는다 (오픈 리다이렉트 방어)', async () => {
  const r = await get(`/go/${dealIds.evil}`);
  assert.equal(r.status, 502);
  assert.equal(r.location, null, '악성 호스트로 리다이렉트했다');
});

test('https 가 아니면 보내지 않는다', async () => {
  const r = await get(`/go/${dealIds.http}`);
  assert.equal(r.status, 502);
  assert.equal(r.location, null);
});

test('링크가 없는 딜은 502 로 알린다', async () => {
  const r = await get(`/go/${dealIds.none}`);
  assert.equal(r.status, 502);
  assert.match(r.body, /링크/);
});

test('없는 딜은 404', async () => {
  const r = await get('/go/999999');
  assert.equal(r.status, 404);
});

test('잘못된 id 형식은 400', async () => {
  for (const bad of ['abc', '-1', '0', '1.5']) {
    const r = await get(`/go/${bad}`);
    assert.equal(r.status, 400, `id="${bad}" 가 통과했다`);
  }
});

test('safeDestination: 목적지 검증 단위 동작', () => {
  assert.ok(safeDestination('https://www.dolharupang.com/cars/reservation?x=1'));
  assert.ok(safeDestination('https://jejussok.com/rent/res_form.php?carno=1'));

  // 스킴
  assert.equal(safeDestination('http://www.dolharupang.com/'), null);
  assert.equal(safeDestination('javascript:alert(1)'), null);
  assert.equal(safeDestination('data:text/html,<script>'), null);
  assert.equal(safeDestination('file:///etc/passwd'), null);

  // 호스트 위장 시도
  assert.equal(safeDestination('https://www.dolharupang.com.evil.com/'), null);
  assert.equal(safeDestination('https://evil.com/?x=www.dolharupang.com'), null);
  assert.equal(safeDestination('https://evil.com#www.dolharupang.com'), null);

  // 빈 값
  assert.equal(safeDestination(null), null);
  assert.equal(safeDestination(''), null);
  assert.equal(safeDestination('not a url'), null);
});

test('집계 실패가 사용자 이동을 막지 않는다', async () => {
  // outbound_clicks 를 잠시 없애 INSERT 를 실패시킨다.
  db.exec('ALTER TABLE outbound_clicks RENAME TO outbound_clicks_tmp');
  try {
    const r = await get(`/go/${dealIds.ok}`);
    assert.equal(r.status, 302, '집계가 깨지자 리다이렉트까지 막혔다');
  } finally {
    db.exec('ALTER TABLE outbound_clicks_tmp RENAME TO outbound_clicks');
  }
});

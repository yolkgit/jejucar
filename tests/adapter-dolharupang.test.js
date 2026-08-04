'use strict';
/**
 * 돌하루팡 어댑터 테스트.
 * 픽스처는 2026-07-31 에 /api/cars 로 실제 받은 응답에서 등급별로 잘라낸 것이다.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../src/collector/adapters/dolharupang');
const { normalizeDeal } = require('../src/lib/normalize');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'dolharupang-cars.json'), 'utf8');

function makeCtx({ body = FIXTURE, status = 200, notModified = false } = {}) {
  const warnings = [];
  const infos = [];
  const calls = [];
  return {
    ctx: {
      etag: null,
      lastModified: null,
      async get(url, opts) {
        calls.push({ url, opts });
        return { ok: status === 200, status, body: notModified ? null : body, notModified, etag: '"v1"', lastModified: null };
      },
      warn: (m) => warnings.push(m),
      info: (m) => infos.push(m),
    },
    warnings,
    infos,
    calls,
  };
}

test('API 응답에서 업체별 상품을 추출한다', async () => {
  const { ctx, calls } = makeCtx();
  const out = await adapter.collect(ctx);

  // 픽스처는 offer 15개 중 2개가 의도적으로 불량이다.
  assert.equal(out.deals.length, 13, `추출 건수가 예상과 다르다: ${out.deals.length}`);

  const d = out.deals[0];
  assert.ok(d.vendor_name, '업체명이 비었다');
  assert.ok(d.car_model, '차종명이 비었다');
  assert.ok(Number.isFinite(d.sale_price) && d.sale_price > 0);
  assert.match(d.external_id, /^prdt_/, 'external_id 가 productDetailId 가 아니다');

  // 호출 URL 형식 확인
  assert.equal(calls.length, 1, 'API 를 한 번만 불러야 한다');
  assert.match(calls[0].url, /\/api\/cars\?startDate=.*&endDate=/);
  assert.match(decodeURIComponent(calls[0].url), /\d{4}-\d{2}-\d{2}T\d{2}:00:00/, '날짜 형식이 API 규격과 다르다');
  assert.equal(calls[0].opts.headers.Accept, 'application/json');
});

test('정가(originalPrice)와 판매가를 모두 싣는다', async () => {
  const { ctx } = makeCtx();
  const out = await adapter.collect(ctx);

  const withList = out.deals.filter((d) => d.list_price !== null);
  assert.ok(withList.length > 0, '정가가 하나도 실리지 않았다');
  for (const d of withList) {
    assert.ok(d.list_price >= d.sale_price, `${d.car_model}: 정가 < 판매가`);
  }
});

test('할인율 60% 초과 상품이 실제로 존재하고 그대로 보존된다', async () => {
  // 신고 요금 대비 90% 할인이 흔한 것이 이 업계의 실제 구조다.
  // 임의로 깎거나 숨기지 않고 그대로 싣되, 앱이 상한 초과 배지를 붙인다.
  const { ctx } = makeCtx();
  const out = await adapter.collect(ctx);

  const results = out.deals.map((raw) => normalizeDeal(raw, { sourceId: 1 })).filter((r) => r.ok);
  const pcts = results
    .filter((r) => r.deal.list_price)
    .map((r) => Math.floor(((r.deal.list_price - r.deal.sale_price) / r.deal.list_price) * 100));

  assert.ok(pcts.some((p) => p > 60), `60% 초과 할인이 없다: ${pcts.join(', ')}`);
});

test('묶음 등급 표기를 앱 등급으로 정규화한다', async () => {
  const { ctx } = makeCtx();
  const out = await adapter.collect(ctx);

  const results = out.deals.map((raw) => normalizeDeal(raw, { sourceId: 1 }));
  const rejected = results.filter((r) => !r.ok);
  assert.equal(rejected.length, 0, `정규화 거부: ${rejected.map((r) => r.reason).join(' | ')}`);

  const ALLOWED = ['경차', '소형', '준중형', '중형', '대형', 'SUV', '승합', '전기', '수입'];
  for (const r of results) {
    assert.ok(ALLOWED.includes(r.deal.car_class), `알 수 없는 등급: ${r.deal.car_class} (${r.deal.car_model})`);
  }

  // 'RV∙SUV' → SUV, '외제' → 수입 이 실제로 일어나는지
  const classes = new Set(results.map((r) => r.deal.car_class));
  assert.ok(classes.has('SUV'), `SUV 로 분류된 항목이 없다: ${[...classes].join(', ')}`);
  assert.ok(classes.has('수입'), `수입으로 분류된 항목이 없다: ${[...classes].join(', ')}`);
});

test('연령·면허 조건을 그대로 옮긴다', async () => {
  const { ctx } = makeCtx();
  const out = await adapter.collect(ctx);

  const withAge = out.deals.filter((d) => d.min_age !== null);
  assert.ok(withAge.length > 0, 'minimumAge 가 하나도 안 실렸다');
  for (const d of withAge) {
    assert.ok(d.min_age >= 18 && d.min_age <= 40, `이상한 최소 연령: ${d.min_age}`);
  }
});

test('가격·ID 가 없는 상품은 버리고 경고를 남긴다', async () => {
  const { ctx, warnings } = makeCtx();
  await adapter.collect(ctx);

  assert.ok(warnings.some((w) => /가격이 없어/.test(w)), `가격 결측 경고 없음: ${warnings.join(' | ')}`);
  assert.ok(warnings.some((w) => /productDetailId/.test(w)), `ID 결측 경고 없음: ${warnings.join(' | ')}`);
});

test('기준일을 notes 에 남긴다', async () => {
  const { ctx } = makeCtx();
  const out = await adapter.collect(ctx);

  // 성수기·비수기 가격차가 10배까지 나므로 어느 날짜 기준인지 반드시 보여야 한다.
  for (const d of out.deals) {
    assert.match(d.notes, /\d{4}-\d{2}-\d{2} 기준/, `기준일이 없다: ${d.notes}`);
  }
  assert.match(out.deals[0].valid_from, /^\d{4}-\d{2}-\d{2}$/);
});

test('구조가 바뀌면 조용히 넘어가지 않고 경고한다', async () => {
  const { ctx, warnings } = makeCtx({ body: JSON.stringify({ success: true, data: {} }) });
  const out = await adapter.collect(ctx);
  assert.equal(out.deals.length, 0);
  assert.ok(warnings.some((w) => /items/.test(w)), warnings.join(' | '));
});

test('빈 목록도 경고한다', async () => {
  const { ctx, warnings } = makeCtx({ body: JSON.stringify({ success: true, data: { items: [] } }) });
  const out = await adapter.collect(ctx);
  assert.equal(out.deals.length, 0);
  assert.ok(warnings.some((w) => /0건/.test(w)), warnings.join(' | '));
});

test('JSON 이 아니면 예외를 던진다', async () => {
  const { ctx } = makeCtx({ body: '<html>점검 중</html>' });
  await assert.rejects(() => adapter.collect(ctx), /JSON 파싱 실패/);
});

test('304 면 파싱하지 않는다', async () => {
  const { ctx } = makeCtx({ notModified: true });
  const out = await adapter.collect(ctx);
  assert.equal(out.unchanged, true);
});

test('HTTP 오류는 예외로 올린다', async () => {
  const { ctx } = makeCtx({ status: 502 });
  await assert.rejects(() => adapter.collect(ctx), /502/);
});

test('어댑터는 기본 비활성이다', () => {
  assert.equal(adapter.enabled, false);
  assert.equal(adapter.kind, 'api');
});

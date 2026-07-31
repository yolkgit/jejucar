'use strict';
/**
 * 제주속으로 어댑터 테스트.
 *
 * 픽스처는 2026-07-31 에 실제로 받은 홈페이지 HTML 이다.
 * 네트워크를 타지 않으므로 상대 서버에 부담을 주지 않고,
 * 사이트 구조가 바뀌어 선택자가 깨지면 여기서 먼저 드러난다.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const adapter = require('../src/collector/adapters/jejussok');
const { normalizeDeal } = require('../src/lib/normalize');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'jejussok-home.html'), 'utf8');

/** ctx.get 을 픽스처로 대체한 실행 컨텍스트 */
function makeCtx({ body = FIXTURE, status = 200, notModified = false } = {}) {
  const warnings = [];
  const infos = [];
  return {
    ctx: {
      etag: null,
      lastModified: null,
      async get() {
        return { ok: status === 200, status, body: notModified ? null : body, notModified, etag: '"x"', lastModified: null };
      },
      warn: (m) => warnings.push(m),
      info: (m) => infos.push(m),
    },
    warnings,
    infos,
  };
}

test('실제 HTML 에서 차량을 추출한다', async () => {
  const { ctx, warnings } = makeCtx();
  const out = await adapter.collect(ctx);

  assert.ok(out.deals.length >= 5, `추출된 딜이 너무 적다: ${out.deals.length}`);
  assert.equal(warnings.length, 0, `경고 발생: ${warnings.join(' | ')}`);

  const avante = out.deals.find((d) => d.car_model.includes('아반떼'));
  assert.ok(avante, '아반떼를 찾지 못했다');
  assert.equal(avante.vendor_name, '제주속으로');
  assert.equal(avante.sale_price, '22,300');
  assert.equal(avante.car_class, '준중형');
  assert.equal(avante.fuel, '휘발유');
  assert.equal(avante.seats, 5);
  assert.equal(avante.insurance_included, true, '자차포함 배지를 못 읽었다');
  assert.match(avante.external_id, /^\d+$/, 'external_id 가 carno 숫자가 아니다');
});

test('정가는 의도적으로 수집하지 않는다', async () => {
  const { ctx } = await Promise.resolve(makeCtx());
  const out = await adapter.collect(ctx);

  // 페이지에는 <!-- <div class="tprice"><s>185,000원</s></div> --> 이 주석으로 들어 있다.
  // 이걸 끌어다 쓰면 22,300원이 88% 할인으로 표시된다 — 사이트가 감춘 값이다.
  assert.ok(FIXTURE.includes('185,000'), '픽스처에 주석 정가가 없다 (테스트 전제 확인)');
  for (const d of out.deals) {
    assert.equal(d.list_price, null, `${d.car_model} 에 정가가 붙었다: ${d.list_price}`);
  }
});

test('external_id 가 차량마다 고유하고 안정적이다', async () => {
  const { ctx } = makeCtx();
  const a = await adapter.collect(ctx);
  const b = await adapter.collect(makeCtx().ctx);

  const idsA = a.deals.map((d) => d.external_id);
  assert.equal(new Set(idsA).size, idsA.length, 'external_id 가 중복된다');
  // 같은 입력이면 같은 ID 여야 한다. 아니면 매 수집마다 딜이 새로 쌓인다.
  assert.deepEqual(idsA, b.deals.map((d) => d.external_id));
});

test('정규화를 통과해 저장 가능한 형태가 된다', async () => {
  const { ctx } = makeCtx();
  const out = await adapter.collect(ctx);

  const results = out.deals.map((raw) => normalizeDeal(raw, { sourceId: 1 }));
  const rejected = results.filter((r) => !r.ok);
  assert.equal(rejected.length, 0, `정규화 거부: ${rejected.map((r) => r.reason).join(' | ')}`);

  const classes = new Set(results.map((r) => r.deal.car_class));
  for (const c of classes) {
    assert.ok(['경차', '소형', '준중형', '중형', '대형', 'SUV', '승합', '전기', '수입'].includes(c), `알 수 없는 등급: ${c}`);
  }

  // 정가가 없으니 할인율도 없어야 한다.
  for (const r of results) {
    assert.equal(r.deal.list_price, null);
  }

  // 이 사이트는 경차를 '경형'으로 쓴다. 레이가 경차로 잡히는지 확인.
  const ray = results.find((r) => r.deal.car_model.includes('레이'));
  if (ray) assert.equal(ray.deal.car_class, '경차');

  // 휘발유 → 가솔린 정규화
  const gasoline = results.filter((r) => r.deal.fuel === '가솔린');
  assert.ok(gasoline.length >= 1, '휘발유가 가솔린으로 정규화되지 않았다');
});

test('304 응답이면 파싱하지 않는다', async () => {
  const { ctx } = makeCtx({ notModified: true });
  const out = await adapter.collect(ctx);
  assert.equal(out.unchanged, true);
  assert.equal(out.deals.length, 0);
});

test('구조가 바뀌어 카드를 못 찾으면 조용히 넘어가지 않고 경고한다', async () => {
  const { ctx, warnings } = makeCtx({ body: '<html><body><p>개편 중</p></body></html>' });
  const out = await adapter.collect(ctx);

  assert.equal(out.deals.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pro_box|구조/);
});

test('HTTP 오류는 예외로 올린다', async () => {
  const { ctx } = makeCtx({ status: 503 });
  await assert.rejects(() => adapter.collect(ctx), /503/);
});

test('어댑터는 기본 비활성이다', () => {
  // 이용약관을 사람이 확인하기 전에 자동으로 돌면 안 된다.
  assert.equal(adapter.enabled, false);
  assert.equal(adapter.kind, 'crawler');
});

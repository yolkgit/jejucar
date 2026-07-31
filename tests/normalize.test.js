'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeDeal,
  normalizeCarClass,
  normalizeFuel,
  normalizeInsurance,
  normalizeDealType,
  parsePrice,
  parseDate,
} = require('../src/lib/normalize');

test('normalizeCarClass: 차종명으로 등급을 잡는다', () => {
  assert.equal(normalizeCarClass('아반떼 CN7').car_class, '준중형');
  assert.equal(normalizeCarClass('레이').car_class, '경차');
  assert.equal(normalizeCarClass('캐스퍼').car_class, '경차');
  assert.equal(normalizeCarClass('K5').car_class, '중형');
  assert.equal(normalizeCarClass('카니발 9인승').car_class, '승합');
  assert.equal(normalizeCarClass('쏘렌토').car_class, 'SUV');
  assert.equal(normalizeCarClass('셀토스').car_class, 'SUV');
  assert.equal(normalizeCarClass('아이오닉5').car_class, '전기');
  assert.equal(normalizeCarClass('그랜저').car_class, '대형');
  assert.equal(normalizeCarClass('벤츠 C200').car_class, '수입');
  assert.equal(normalizeCarClass('AVANTE').car_class, '준중형', '영문 표기도 잡아야 한다');
});

test('normalizeCarClass: 긴 이름이 짧은 이름보다 먼저 매칭된다', () => {
  // '코나EV'(전기)가 '코나'(SUV)로 떨어지면 안 된다
  assert.equal(normalizeCarClass('코나EV').car_class, '전기');
  assert.equal(normalizeCarClass('코나').car_class, 'SUV');
  assert.equal(normalizeCarClass('니로EV').car_class, '전기');
  assert.equal(normalizeCarClass('니로').car_class, 'SUV');
});

test('normalizeCarClass: 업계 관행대로 베뉴·코나·니로는 SUV/RV 로 분류한다', () => {
  // 소형 세단 등급으로 넣으면 필터 결과가 사용자 기대와 어긋난다
  assert.equal(normalizeCarClass('베뉴').car_class, 'SUV');
  assert.equal(normalizeCarClass('셀토스').car_class, 'SUV');
  assert.equal(normalizeCarClass('토레스').car_class, 'SUV');
});

test('normalizeCarClass: 단종 차량도 재고 운용되므로 계속 분류해야 한다', () => {
  // 스파크(2022), K3(2024), 말리부(2023) 단종. 매물에는 여전히 등장한다.
  assert.equal(normalizeCarClass('스파크').car_class, '경차');
  assert.equal(normalizeCarClass('K3').car_class, '준중형');
  assert.equal(normalizeCarClass('말리부').car_class, '중형');
});

test('normalizeCarClass: 등급 표기만 있어도 잡는다', () => {
  assert.equal(normalizeCarClass('알 수 없는 차', '중형 세단').car_class, '중형');
  assert.equal(normalizeCarClass('미정', '소형 SUV').car_class, 'SUV');
  assert.equal(normalizeCarClass('미정', '9인승 승합차').car_class, '승합');
});

test('normalizeCarClass: 분류 실패 시 추측하지 않고 null 을 준다', () => {
  const r = normalizeCarClass('듣도보도못한차종ZZZ');
  assert.equal(r.car_class, null);
  assert.equal(r.matched, null);
});

test('parsePrice: 다양한 표기를 원 단위 정수로', () => {
  assert.equal(parsePrice('89,000원'), 89000);
  assert.equal(parsePrice('89000'), 89000);
  assert.equal(parsePrice(39000), 39000);
  assert.equal(parsePrice('  1,234,500 원 '), 1234500);
  assert.equal(parsePrice('8만9천원'), 89000);
  assert.equal(parsePrice('5만원'), 50000);
});

test('parsePrice: 쓰레기 입력을 조용히 통과시키지 않는다', () => {
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice(undefined), null);
  assert.equal(parsePrice('가격문의'), null);
  assert.equal(parsePrice('0원'), null);
  assert.equal(parsePrice('-56%'), null, '할인율을 가격으로 오인하면 안 된다');
  assert.equal(parsePrice('50'), null, '100원 미만은 파싱 오류로 본다');
});

test('parseDate: 여러 구분자를 YYYY-MM-DD 로 통일', () => {
  assert.equal(parseDate('2026-08-01'), '2026-08-01');
  assert.equal(parseDate('2026.8.1'), '2026-08-01');
  assert.equal(parseDate('2026/08/01'), '2026-08-01');
  assert.equal(parseDate('2026년 8월 1일'), '2026-08-01');
  assert.equal(parseDate('20260801'), '2026-08-01');
  assert.equal(parseDate('아무때나'), null);
  assert.equal(parseDate(''), null);
});

test('normalizeFuel / normalizeInsurance / normalizeDealType', () => {
  assert.equal(normalizeFuel('가솔린 2.0'), '가솔린');
  assert.equal(normalizeFuel('디젤'), '디젤');
  assert.equal(normalizeFuel('아이오닉5 전기'), '전기');
  assert.equal(normalizeFuel('알 수 없음'), null);

  // '완전자차' 가 '자차'(일반자차)로 떨어지면 보장 범위를 잘못 표기하게 된다
  assert.equal(normalizeInsurance('완전자차 포함'), '완전자차');
  assert.equal(normalizeInsurance('슈퍼커버'), '완전자차');
  assert.equal(normalizeInsurance('일반자차'), '일반자차');
  assert.equal(normalizeInsurance('자차 별도'), '일반자차');
  assert.equal(normalizeInsurance('책임보험만'), '책임보험');

  // '초특가' 가 '특가' 보다 먼저 매칭되어야 한다
  assert.equal(normalizeDealType('여름 초특가'), '초특가');
  assert.equal(normalizeDealType('얼리버드 할인'), '얼리버드');
  assert.equal(normalizeDealType('타임세일'), '타임세일');
  assert.equal(normalizeDealType('마감임박!'), '마감임박');
});

test('normalizeDeal: 정상 입력을 스키마 형태로 변환', () => {
  const r = normalizeDeal(
    {
      external_id: 'abc-1',
      vendor_name: '  제주드림렌터카 ',
      car_model: '아반떼 CN7',
      list_price: '89,000원',
      sale_price: '39,000원',
      title: '여름 초특가',
      insurance: '완전자차 포함',
      insurance_included: true,
      pickup_location: '제주공항',
      valid_from: '2026.08.01',
      valid_to: '2026.08.31',
      stock: '3',
    },
    { sourceId: 7 }
  );

  assert.equal(r.ok, true, r.reason);
  const d = r.deal;
  assert.equal(d.source_id, 7);
  assert.equal(d.vendor_name, '제주드림렌터카', '앞뒤 공백이 남았다');
  assert.equal(d.car_class, '준중형');
  assert.equal(d.list_price, 89000);
  assert.equal(d.sale_price, 39000);
  assert.equal(d.deal_type, '초특가');
  assert.equal(d.insurance, '완전자차');
  assert.equal(d.insurance_included, true);
  assert.equal(d.valid_from, '2026-08-01');
  assert.equal(d.valid_to, '2026-08-31');
  assert.equal(d.stock, 3);
  assert.equal(d.transmission, '자동');
  assert.equal(d.status, 'active');
});

test('normalizeDeal: 불량 입력을 이유와 함께 버린다', () => {
  const cases = [
    // 각 케이스는 검사하려는 항목 하나만 비운다. 여러 개를 비우면
    // 검증 순서상 앞선 항목이 먼저 걸려 의도한 분기를 못 본다.
    [{ vendor_name: 'v', car_model: '레이', list_price: '90000', sale_price: '40000' }, /external_id/],
    [{ external_id: 'a', car_model: '레이' }, /업체명/],
    [{ external_id: 'a', vendor_name: 'v' }, /차종명/],
    [{ external_id: 'a', vendor_name: 'v', car_model: '레이', sale_price: '가격문의' }, /판매가 파싱 실패/],
    // 정가를 "줬는데 못 읽은" 경우는 선택자 파손 신호이므로 버린다.
    [
      { external_id: 'a', vendor_name: 'v', car_model: '레이', list_price: '가격문의', sale_price: '30000' },
      /정가 파싱 실패/,
    ],
    [
      { external_id: 'a', vendor_name: 'v', car_model: '레이', list_price: '10000', sale_price: '20000' },
      /판매가.*정가.*큼/,
    ],
    [
      { external_id: 'a', vendor_name: 'v', car_model: '외계차XYZ', list_price: '90000', sale_price: '40000' },
      /등급 분류 실패/,
    ],
  ];

  for (const [input, pattern] of cases) {
    const r = normalizeDeal(input, { sourceId: 1 });
    assert.equal(r.ok, false, `통과되면 안 되는 입력: ${JSON.stringify(input)}`);
    assert.match(r.reason, pattern);
  }
});

test('normalizeDeal: 정가를 아예 주지 않으면 통과하고 list_price 는 null 이다', () => {
  // 정가를 공개하지 않는 소스가 있다. 지어내면 허위 할인율이 된다.
  for (const missing of [{}, { list_price: null }, { list_price: '' }, { list_price: '  ' }]) {
    const r = normalizeDeal(
      { external_id: 'a', vendor_name: '제주속으로', car_model: '더뉴아반떼', sale_price: '22,300', ...missing },
      { sourceId: 1 }
    );
    assert.equal(r.ok, true, `거부됨: ${r.reason}`);
    assert.equal(r.deal.list_price, null);
    assert.equal(r.deal.sale_price, 22300);
  }
});

test('normalizeDeal: 정가와 할인가가 같으면 통과하되 할인율 0 이다', () => {
  const r = normalizeDeal(
    { external_id: 'a', vendor_name: 'v', car_model: '레이', list_price: '50000', sale_price: '50000' },
    { sourceId: 1 }
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.deal.list_price, r.deal.sale_price);
});

test('normalizeDeal: 수동 변속 표기를 반영한다', () => {
  const r = normalizeDeal(
    {
      external_id: 'a',
      vendor_name: 'v',
      car_model: '모닝',
      list_price: '40000',
      sale_price: '20000',
      notes: '수동 변속',
    },
    { sourceId: 1 }
  );
  assert.equal(r.deal.transmission, '수동');
});

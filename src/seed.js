'use strict';
/**
 * 데모용 시드 데이터 생성기.
 *
 *   npm run seed          기존 시드를 지우고 새로 생성
 *   npm run seed -- keep  기존 시드를 두고 추가
 *
 * ── 데이터 출처 ──────────────────────────────────────────────
 * 업체명은 실재하는 제주 렌터카 업체다. 다만 **가격·재고·평점은 실제
 * 매물이 아니라 조사된 시장 가격대 안에서 만든 예시**다. 실제 예약에
 * 쓰려면 관리자 화면에서 실제 값으로 바꾸거나 수집기를 붙여야 한다.
 *
 * 가격 근거 (2025~2026 언론·업체 공식 사이트 조사):
 *   비수기 24시간 — 경차 2~4만, 준중형 4~6만, 중형 4~7만, SUV 5~9만, 승합 3~5만
 *   보험 일일 — 일반자차 8,000원(면책금 10만), 완전자차 14,000원 (제주OK렌터카 경차 기준)
 *
 * 제외한 것:
 *   레드캡렌터카 — 2024-12-31 제주 단기렌터카 사업 종료
 *   스파크(2022)·K3(2024)·말리부(2023) — 단종. 파서는 인식하되 신규 딜로는 만들지 않는다.
 */

const { db, ensureSource, ensureVendor, upsertDeal, today } = require('./db');
const { DISCOUNT_CAP } = require('./config');

/** 재현 가능한 시드 데이터를 위해 고정 시드 LCG 를 쓴다. Math.random 은 실행마다 달라진다. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    // Numerical Recipes LCG
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rng = makeRng(20260730);

const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
/** 원 단위 가격을 1,000원 단위로 떨어지게 반올림한다. 실제 렌터카 요금 표기 관행. */
const round1k = (n) => Math.round(n / 1000) * 1000;

// 실재 확인된 제주 렌터카 업체. pickup 은 조사된 운영 방식.
const VENDORS = [
  { name: '롯데렌터카',     pickup_type: 'office',          rating: 4.5, reviews: 3120, tier: '대기업' },
  { name: 'SK렌터카',       pickup_type: 'office',          rating: 4.4, reviews: 2480, tier: '대기업' },
  { name: '빌리카',         pickup_type: 'airport_shuttle', rating: 4.2, reviews: 1640, tier: '대기업' },
  { name: '제주렌트카',     pickup_type: 'airport_shuttle', rating: 4.3, reviews: 2010, tier: '로컬대형' },
  { name: '제주공항렌트카', pickup_type: 'airport_shuttle', rating: 4.1, reviews: 1180, tier: '로컬' },
  { name: '제주로렌트카',   pickup_type: 'airport_shuttle', rating: 4.6, reviews: 1890, tier: '로컬대형' },
  { name: '제주OK렌터카',   pickup_type: 'airport_shuttle', rating: 4.2, reviews:  970, tier: '로컬' },
  { name: '제주엔젤카',     pickup_type: 'airport_shuttle', rating: 4.7, reviews: 1420, tier: '로컬' },
  { name: '제주유레카',     pickup_type: 'airport_shuttle', rating: 4.3, reviews:  760, tier: '로컬' },
  { name: '해피렌트카',     pickup_type: 'airport_shuttle', rating: 4.0, reviews:  540, tier: '로컬' },
  { name: '제주원렌터카',   pickup_type: 'airport_shuttle', rating: 4.1, reviews:  610, tier: '로컬' },
  { name: '무지개렌트카',   pickup_type: 'airport_shuttle', rating: 4.2, reviews:  430, tier: '로컬' },
  { name: '제주에코렌트카', pickup_type: 'airport_shuttle', rating: 4.4, reviews:  380, tier: '로컬' },
  { name: '제주속으로',     pickup_type: 'airport_shuttle', rating: 4.0, reviews:  290, tier: '로컬' },
];

// [차종, 등급, 연료, 인승, 비수기 정가 하한, 상한]
const CARS = [
  ['레이',          '경차',   'LPG',       4,  45000,  60000],
  ['캐스퍼',        '경차',   '가솔린',    4,  45000,  62000],
  ['모닝',          '경차',   '가솔린',    4,  42000,  58000],
  ['아반떼 CN7',    '준중형', '가솔린',    5,  70000,  92000],
  ['K5',            '중형',   '가솔린',    5,  82000, 105000],
  ['쏘나타 DN8',    '중형',   '가솔린',    5,  84000, 108000],
  ['그랜저 GN7',    '대형',   '가솔린',    5, 130000, 165000],
  ['K8',            '대형',   '가솔린',    5, 128000, 160000],
  ['셀토스',        'SUV',    '가솔린',    5,  88000, 115000],
  ['투싼',          'SUV',    '디젤',      5,  95000, 125000],
  ['쏘렌토',        'SUV',    '디젤',      7, 115000, 150000],
  ['싼타페',        'SUV',    '가솔린',    7, 118000, 152000],
  ['토레스',        'SUV',    '가솔린',    5,  98000, 128000],
  ['카니발 9인승',  '승합',   '디젤',      9, 125000, 165000],
  ['스타리아 9인승','승합',   '디젤',      9, 120000, 158000],
  ['아이오닉5',     '전기',   '전기',      5,  98000, 130000],
  ['EV6',           '전기',   '전기',      5, 100000, 132000],
  ['코나EV',        '전기',   '전기',      5,  88000, 115000],
  ['벤츠 C200',     '수입',   '가솔린',    5, 260000, 340000],
  ['BMW 320i',      '수입',   '가솔린',    5, 250000, 330000],
];

const PICKUPS = ['제주공항 셔틀', '제주공항 렌터카하우스', '제주시내 지점', '서귀포 지점', '중문 지점'];
const DEAL_TYPES = ['얼리버드', '타임세일', '초특가', '마감임박', '장기할인'];

/** 등급별 최소 연령·면허 경과. 조사된 제주OK렌터카 기준을 따랐다. */
function ageRule(carClass) {
  if (['대형', 'SUV', '승합', '수입'].includes(carClass)) return { min_age: 26, min_license_years: 1 };
  return { min_age: 21, min_license_years: 1 };
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function buildDeals(count) {
  const start = today();
  const deals = [];

  for (let i = 0; i < count; i++) {
    const vendor = pick(VENDORS);
    const [model, carClass, fuel, seats, lo, hi] = pick(CARS);

    const listPrice = round1k(between(lo, hi));

    // 할인율 분포: 대부분 25~60%.
    // 상한(60%)을 넘는 건도 2건만 섞어 경고 UI 가 실제로 동작하는지 보이게 한다.
    const overCap = i === 3 || i === 17;
    const pct = overCap ? between(68, 82) : between(25, DISCOUNT_CAP.maxPct);
    const salePrice = round1k(listPrice * (1 - pct / 100));

    const dealType = pick(DEAL_TYPES);
    const longTerm = dealType === '장기할인';
    const minDays = longTerm ? between(3, 5) : 1;

    // 완전자차 포함 여부. 포함이면 할인 매력이 크므로 배지로 강조된다.
    const insurance = rng() < 0.35 ? '완전자차' : rng() < 0.6 ? '일반자차' : '책임보험';
    const insuranceIncluded = insurance !== '책임보험' && rng() < 0.55;

    const validFrom = addDays(start, between(0, 20));
    const validTo = addDays(validFrom, between(10, 70));

    deals.push({
      external_id: `seed-${String(i + 1).padStart(3, '0')}`,
      vendor,
      vendor_name: vendor.name,
      car_model: model,
      car_class: carClass,
      fuel,
      seats,
      transmission: '자동',
      list_price: listPrice,
      sale_price: salePrice,
      deal_type: dealType,
      insurance,
      insurance_included: insuranceIncluded,
      // 마감임박 딜은 무료취소가 안 되는 경우가 많다.
      free_cancel: dealType !== '마감임박',
      pickup_location: pick(PICKUPS),
      min_days: minDays,
      ...ageRule(carClass),
      valid_from: validFrom,
      valid_to: validTo,
      stock: rng() < 0.4 ? between(1, 6) : null,
      notes: buildNotes({ insurance, insuranceIncluded, dealType, minDays, vendor }),
      status: 'active',
    });
  }
  return deals;
}

function buildNotes({ insurance, insuranceIncluded, dealType, minDays, vendor }) {
  const parts = [];
  if (insuranceIncluded) parts.push(`${insurance} 요금 포함`);
  else if (insurance !== '책임보험') parts.push(`${insurance} 현장 선택 가능`);
  if (minDays > 1) parts.push(`${minDays}일 이상 대여 시 적용`);
  if (dealType === '마감임박') parts.push('잔여 차량 소진 시 조기 마감');
  if (vendor.pickup_type === 'airport_shuttle') parts.push('제주공항 5번 게이트 → 렌터카하우스 셔틀 탑승');
  else parts.push('공항 인근 지점 방문 수령');
  return parts.join(' · ');
}

function main() {
  const keep = process.argv[2] === 'keep';
  const source = ensureSource({
    key: 'seed',
    name: '샘플 데이터',
    kind: 'manual',
    base_url: null,
    enabled: 1,
    note: 'npm run seed 로 생성. 실제 매물이 아니다.',
  });

  if (!keep) {
    const removed = db.prepare('DELETE FROM deals WHERE source_id = ?').run(source.id).changes;
    if (removed) console.log(`기존 시드 딜 ${removed}건 삭제`);
  }

  const deals = buildDeals(48);

  const write = db.transaction((rows) => {
    let ins = 0;
    let upd = 0;
    for (const d of rows) {
      const vendorId = ensureVendor(d.vendor_name, {
        pickup_type: d.vendor.pickup_type,
        rating: d.vendor.rating,
        review_count: d.vendor.reviews,
      });
      const { vendor, ...rest } = d;
      const r = upsertDeal({ ...rest, source_id: source.id, vendor_id: vendorId });
      if (r === 'inserted') ins++;
      else upd++;
    }
    return { ins, upd };
  });

  const { ins, upd } = write(deals);

  const stats = db
    .prepare(
      `SELECT COUNT(*) AS n,
              MIN(sale_price) AS min_price,
              MAX(sale_price) AS max_price,
              MAX(discount_pct) AS max_pct,
              SUM(CASE WHEN discount_pct > ? THEN 1 ELSE 0 END) AS over_cap
         FROM deals WHERE source_id = ? AND status = 'active'`
    )
    .get(DISCOUNT_CAP.maxPct, source.id);

  console.log(`\n시드 완료 — 신규 ${ins}건, 갱신 ${upd}건`);
  console.log(`활성 딜 ${stats.n}건 / 최저 ${stats.min_price.toLocaleString()}원 ~ 최고 ${stats.max_price.toLocaleString()}원`);
  console.log(`최대 할인율 ${stats.max_pct}%`);
  if (stats.over_cap > 0) {
    console.log(
      `\n⚠ 할인율 ${DISCOUNT_CAP.maxPct}% 초과 딜 ${stats.over_cap}건 — ` +
        `${DISCOUNT_CAP.effectiveFrom} 시행 '${DISCOUNT_CAP.ruleName}' 상한 초과.\n` +
        `  경고 배지 동작 확인용으로 일부러 넣은 값이다. 실제 운영 데이터에는 없어야 한다.`
    );
  }
  console.log(`\n업체 ${db.prepare('SELECT COUNT(*) c FROM vendors').get().c}개 등록됨`);
}

if (require.main === module) main();

module.exports = { buildDeals, VENDORS, CARS, makeRng };

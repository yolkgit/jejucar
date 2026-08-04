'use strict';
/**
 * 수집한 원문 텍스트를 DB 스키마에 맞는 값으로 정규화한다.
 *
 * 소스마다 표기가 다르다("아반떼", "AVANTE CN7", "아반떼(가솔린/5인)").
 * 어댑터는 원문만 넘기고, 등급·연료·인승 판정은 전부 여기서 한다.
 * 그래야 소스가 늘어도 분류 규칙이 한 곳에 남는다.
 */

// 차종 → 등급 사전. 긴 이름이 먼저 매칭되도록 아래 MODEL_INDEX 에서 길이순 정렬한다.
//
// 분류 근거: 국내 렌터카 등급은 법정 표준이 아니라 업체별 관행이다.
// 여기서는 제주 주요 업체(제주렌트카·제주OK렌터카·돌하루팡)의 카테고리를 따랐다.
// 단종 차량(스파크 2022, K3 2024, 말리부 2023)도 남겨 둔다 —
// 렌터카는 재고 차량을 계속 운용하므로 매물에 실제로 등장한다.
const MODEL_TABLE = [
  // 경차 (현행 주력: 레이·캐스퍼·모닝)
  { class: '경차', seats: 4, models: ['모닝', '레이', '캐스퍼', '스파크', 'ray', 'morning', 'casper', 'spark'] },
  // 소형 세단/해치백. 베뉴·코나·니로는 업계에서 SUV/RV 로 분류하므로 여기 두지 않는다.
  { class: '소형', seats: 5, models: ['프라이드', '엑센트', '리오', 'accent'] },
  // 준중형 (현행 주력: 아반떼 CN7. K3 는 2024 단종이나 재고 운용)
  { class: '준중형', seats: 5, models: ['아반떼', 'k3', '크루즈', 'avante', 'elantra'] },
  // 중형 (말리부는 2023 한국 단종이나 재고 운용)
  { class: '중형', seats: 5, models: ['소나타', '쏘나타', 'sonata', 'k5', 'sm6', '말리부', 'malibu'] },
  // 대형/고급
  { class: '대형', seats: 5, models: ['그랜저', 'grandeur', 'k8', 'k9', 'g80', 'g90', '제네시스', 'genesis'] },
  // SUV / RV
  { class: 'SUV', seats: 5, models: ['셀토스', '코나', '투싼', '스포티지', '베뉴', '니로', 'seltos', 'kona', 'tucson', 'sportage', 'venue', 'niro'] },
  { class: 'SUV', seats: 5, models: ['쏘렌토', '싼타페', '산타페', 'sorento', 'santafe', 'qm6', '토레스', 'torres', 'gv70', 'gv80'] },
  { class: 'SUV', seats: 7, models: ['팰리세이드', 'palisade', '모하비', 'mohave'] },
  // 승합 (스타리아는 11인승까지. 12인승은 구형 그랜드스타렉스)
  { class: '승합', seats: 9, models: ['카니발', 'carnival', '스타리아', 'staria', '스타렉스', 'starex', '솔라티', 'solati'] },
  // 전기
  { class: '전기', seats: 5, models: ['아이오닉', 'ioniq', 'ev6', 'ev9', '테슬라', 'tesla', '모델3', '모델y', '코나ev', 'konaev', '니로ev', '볼트', 'bolt', '아토3', 'atto3'] },
  // 수입
  { class: '수입', seats: 5, models: ['벤츠', 'benz', 'bmw', '아우디', 'audi', '폭스바겐', '미니쿠퍼', 'minicooper', '볼보', 'volvo'] },
];

const VALID_CLASSES = new Set(['경차', '소형', '준중형', '중형', '대형', 'SUV', '승합', '수입', '전기']);

// 등급명이 텍스트에 직접 쓰여 있는 경우를 위한 별칭
const CLASS_ALIASES = {
  경차: '경차',
  경형: '경차',
  소형: '소형',
  준중형: '준중형',
  중형: '중형',
  준대형: '대형',
  대형: '대형',
  고급: '대형',
  suv: 'SUV',
  '소형suv': 'SUV',
  '중형suv': 'SUV',
  '대형suv': 'SUV',
  // 돌하루팡은 'RV∙SUV', '소형∙준중형', '외제' 같은 묶음 표기를 쓴다.
  rvsuv: 'SUV',
  rv: 'SUV',
  '소형준중형': '준중형',
  승합: '승합',
  승합차: '승합',
  '9인승': '승합',
  '11인승': '승합',
  수입: '수입',
  수입차: '수입',
  외제: '수입',
  외제차: '수입',
  전기: '전기',
  전기차: '전기',
  ev: '전기',
};

const MODEL_INDEX = (() => {
  const entries = [];
  for (const row of MODEL_TABLE) {
    for (const m of row.models) {
      entries.push({ needle: m.toLowerCase(), class: row.class, seats: row.seats });
    }
  }
  // "니로suv" 가 "니로" 보다 먼저 매칭되어야 한다.
  entries.sort((a, b) => b.needle.length - a.needle.length);
  return entries;
})();

/**
 * 공백·특수문자를 정리한 비교용 키.
 * 소스마다 'RV∙SUV'(U+2219), '소형·준중형'(U+00B7) 처럼 다른 구분 기호를 쓰므로
 * 가운뎃점 계열을 모두 제거해 하나로 모은다.
 */
function compactKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\-_.·∙•・/()[\]]+/g, '');
}

function cleanText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 차종명(+부가 텍스트)에서 등급을 추론한다.
 * @returns {{car_class:string, seats:number|null, matched:string|null}}
 */
function normalizeCarClass(modelText, extraText = '') {
  const hay = compactKey(`${modelText} ${extraText}`);

  // 1) 차종명 직접 매칭이 가장 신뢰도 높다.
  for (const e of MODEL_INDEX) {
    if (hay.includes(e.needle)) {
      return { car_class: e.class, seats: e.seats, matched: e.needle };
    }
  }

  // 2) 등급 표기가 텍스트에 있는지
  const aliasKeys = Object.keys(CLASS_ALIASES).sort((a, b) => b.length - a.length);
  for (const k of aliasKeys) {
    if (hay.includes(compactKey(k))) {
      return { car_class: CLASS_ALIASES[k], seats: null, matched: k };
    }
  }

  // 3) 인승 표기로 승합 추정
  const seatMatch = hay.match(/(\d{1,2})인승/);
  if (seatMatch) {
    const n = Number(seatMatch[1]);
    if (n >= 9) return { car_class: '승합', seats: n, matched: `${n}인승` };
    if (n >= 7) return { car_class: 'SUV', seats: n, matched: `${n}인승` };
  }

  // 분류 실패를 '중형' 같은 그럴듯한 값으로 덮으면 필터 결과가 조용히 오염된다.
  return { car_class: null, seats: null, matched: null };
}

/**
 * "89,000원", "8만9천원", "89000" → 89000
 * 여러 금액이 섞인 텍스트에서는 첫 번째를 취한다.
 * @returns {number|null}
 */
function parsePrice(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? Math.round(text) : null;
  const s = String(text ?? '');
  if (!s) return null;

  // "8만9천원" 형태
  const man = s.match(/(\d+)\s*만\s*(\d+)?\s*천?/);
  if (man && /만/.test(s) && !/[,\d]{4,}/.test(s.replace(/[^\d,]/g, ''))) {
    const base = Number(man[1]) * 10000;
    const extra = man[2] ? Number(man[2]) * 1000 : 0;
    const v = base + extra;
    return v > 0 ? v : null;
  }

  // 쉼표 포함 숫자
  const m = s.replace(/[^\d,]/g, ' ').match(/\d[\d,]*/);
  if (!m) return null;
  const v = Number(m[0].replace(/,/g, ''));
  if (!Number.isFinite(v) || v <= 0) return null;
  // 원 단위 가격이 100원 미만이면 파싱 오류로 본다 (예: 할인율을 가격으로 오인)
  return v < 100 ? null : Math.round(v);
}

const FUEL_MAP = [
  { needle: '하이브리드', value: '하이브리드' },
  { needle: 'hybrid', value: '하이브리드' },
  { needle: '전기', value: '전기' },
  { needle: 'ev', value: '전기' },
  { needle: '디젤', value: '디젤' },
  { needle: 'diesel', value: '디젤' },
  { needle: 'lpg', value: 'LPG' },
  { needle: '가솔린', value: '가솔린' },
  { needle: '휘발유', value: '가솔린' },
  { needle: 'gasoline', value: '가솔린' },
];

function normalizeFuel(text) {
  const hay = compactKey(text);
  for (const f of FUEL_MAP) if (hay.includes(f.needle)) return f.value;
  return null;
}

const INSURANCE_MAP = [
  { needle: '완전자차', value: '완전자차' },
  { needle: '슈퍼커버', value: '완전자차' },
  { needle: 'fullcover', value: '완전자차' },
  { needle: '풀커버', value: '완전자차' },
  { needle: '일반자차', value: '일반자차' },
  { needle: '자차', value: '일반자차' },
  { needle: '책임보험', value: '책임보험' },
];

function normalizeInsurance(text) {
  const hay = compactKey(text);
  // 긴 것부터 검사해야 '완전자차' 가 '자차' 로 떨어지지 않는다.
  for (const i of INSURANCE_MAP) if (hay.includes(i.needle)) return i.value;
  return null;
}

const DEAL_TYPE_MAP = [
  { needle: '얼리버드', value: '얼리버드' },
  { needle: '조기예약', value: '얼리버드' },
  { needle: '타임세일', value: '타임세일' },
  { needle: '타임특가', value: '타임세일' },
  { needle: '초특가', value: '초특가' },
  { needle: '특가', value: '초특가' },
  { needle: '마감임박', value: '마감임박' },
  { needle: '임박', value: '마감임박' },
  { needle: '장기', value: '장기할인' },
];

function normalizeDealType(text) {
  const hay = compactKey(text);
  for (const d of DEAL_TYPE_MAP) if (hay.includes(d.needle)) return d.value;
  return null;
}

/** 'YYYY-MM-DD' 로 통일. '2026.08.01', '2026/8/1', '20260801' 허용. */
function parseDate(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;

  let m = s.match(/(\d{4})\s*[-.\/년]\s*(\d{1,2})\s*[-.\/월]\s*(\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * 어댑터가 만든 원시 딜을 검증·정규화한다.
 * 필수값이 비었거나 분류에 실패하면 이유와 함께 버린다.
 * 조용히 기본값으로 채우면 잘못된 데이터가 사용자에게 노출된다.
 *
 * @returns {{ok:true, deal:object} | {ok:false, reason:string}}
 */
function normalizeDeal(raw, { sourceId }) {
  const vendorName = cleanText(raw.vendor_name);
  const carModel = cleanText(raw.car_model);
  if (!vendorName) return { ok: false, reason: '업체명 없음' };
  if (!carModel) return { ok: false, reason: '차종명 없음' };
  if (!raw.external_id) return { ok: false, reason: 'external_id 없음' };

  const salePrice = parsePrice(raw.sale_price);
  if (!salePrice) return { ok: false, reason: `판매가 파싱 실패: ${raw.sale_price}` };

  // 정가는 선택 항목이다. 아예 공개하지 않는 소스가 있고, 그런 경우
  // 정가를 지어내면 실제보다 큰 할인율이 표시된다.
  // 단, 정가가 "주어졌는데 못 읽은" 경우는 파싱 오류이므로 버린다.
  // 둘을 구분하지 않으면 선택자가 깨졌을 때 조용히 할인율만 사라진다.
  const listGiven =
    raw.list_price !== null && raw.list_price !== undefined && String(raw.list_price).trim() !== '';
  const listPrice = listGiven ? parsePrice(raw.list_price) : null;
  if (listGiven && !listPrice) return { ok: false, reason: `정가 파싱 실패: ${raw.list_price}` };
  if (listPrice !== null && salePrice > listPrice) {
    return { ok: false, reason: `판매가(${salePrice})가 정가(${listPrice})보다 큼` };
  }

  const extra = [raw.car_class, raw.notes, raw.title, raw.fuel].filter(Boolean).join(' ');
  const { car_class, seats } = normalizeCarClass(carModel, extra);
  if (!car_class || !VALID_CLASSES.has(car_class)) {
    return { ok: false, reason: `차종 등급 분류 실패: "${carModel}"` };
  }

  return {
    ok: true,
    deal: {
      source_id: sourceId,
      external_id: String(raw.external_id),
      vendor_name: vendorName,
      car_model: carModel,
      car_class,
      fuel: normalizeFuel(`${carModel} ${extra}`),
      seats: raw.seats ?? seats,
      transmission: /수동|manual/i.test(extra) ? '수동' : '자동',
      list_price: listPrice,
      sale_price: salePrice,
      deal_type: normalizeDealType(`${raw.deal_type ?? ''} ${raw.title ?? ''} ${raw.notes ?? ''}`),
      insurance: normalizeInsurance(`${raw.insurance ?? ''} ${extra}`),
      insurance_included: Boolean(raw.insurance_included),
      free_cancel: raw.free_cancel !== false,
      pickup_location: cleanText(raw.pickup_location) || null,
      min_days: Number(raw.min_days) >= 1 ? Number(raw.min_days) : 1,
      min_age: raw.min_age ?? null,
      min_license_years: raw.min_license_years ?? null,
      valid_from: parseDate(raw.valid_from),
      valid_to: parseDate(raw.valid_to),
      stock: Number.isFinite(Number(raw.stock)) ? Number(raw.stock) : null,
      detail_url: raw.detail_url ?? null,
      image_url: raw.image_url ?? null,
      notes: cleanText(raw.notes) || null,
      status: 'active',
    },
  };
}

module.exports = {
  normalizeDeal,
  normalizeCarClass,
  normalizeFuel,
  normalizeInsurance,
  normalizeDealType,
  parsePrice,
  parseDate,
  cleanText,
  compactKey,
  VALID_CLASSES,
};

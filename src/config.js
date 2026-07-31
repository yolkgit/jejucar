'use strict';
/**
 * 앱 전역 설정 및 규제 상수.
 *
 * 제주도 '자동차 대여약관 기재 등에 관한 규칙'
 *   공포 2026-07-15 / 시행 2026-09-16
 *   업체 신고 1일 대여요금의 60%를 초과하는 할인 금지 (대여 10일 초과 시 예외)
 *
 * 이 앱은 '할인 정보'를 전면에 내세우므로 위 상한과 직결된다.
 * 시행일과 상한율을 하드코딩된 매직넘버로 흩뿌리지 않고 여기 모아 둔다.
 * 규칙이 바뀌면 이 파일만 고치면 된다.
 */

const DISCOUNT_CAP = {
  // 시행일 (Asia/Seoul 기준 날짜)
  effectiveFrom: '2026-09-16',
  // 신고 요금 대비 최대 할인율(%)
  maxPct: 60,
  // 대여 기간이 이 일수를 초과하면 상한 적용 예외
  exemptOverDays: 10,
  ruleName: '제주특별자치도 자동차 대여약관 기재 등에 관한 규칙',
  promulgated: '2026-07-15',
};

/**
 * 해당 딜이 할인율 상한을 넘는지 판단한다.
 * 시행일 전에는 위반이 아니지만 '시행 후 조정 대상'으로 표시해 준다.
 *
 * @param {{discount_pct:number, min_days?:number}} deal
 * @param {string} [todayStr] 'YYYY-MM-DD'
 * @returns {{overCap:boolean, enforced:boolean, exempt:boolean, cap:number}}
 */
function checkDiscountCap(deal, todayStr) {
  const today = todayStr || new Date().toISOString().slice(0, 10);
  const pct = Number(deal?.discount_pct) || 0;
  const days = Number(deal?.min_days) || 1;

  const exempt = days > DISCOUNT_CAP.exemptOverDays;
  const overCap = !exempt && pct > DISCOUNT_CAP.maxPct;
  const enforced = today >= DISCOUNT_CAP.effectiveFrom;

  return { overCap, enforced, exempt, cap: DISCOUNT_CAP.maxPct };
}

const PICKUP_PLACES = [
  '제주공항 셔틀',
  '제주공항 렌터카하우스',
  '제주시내 지점',
  '서귀포 지점',
  '중문 지점',
  '성산 지점',
];

const CAR_CLASSES = ['경차', '소형', '준중형', '중형', '대형', 'SUV', '승합', '전기', '수입'];

const DEAL_TYPES = ['얼리버드', '타임세일', '초특가', '마감임박', '장기할인'];

const INSURANCE_LEVELS = ['책임보험', '일반자차', '완전자차'];

/**
 * 성수기 판정 — 요금이 크게 뛰는 구간.
 * 7월 중순~8월 중순, 설·추석 연휴, 5월 초 황금연휴.
 * 연도별 명절은 매년 달라지므로 월/일 범위로만 근사한다.
 */
function isPeakSeason(dateStr) {
  if (!dateStr) return false;
  const md = dateStr.slice(5); // 'MM-DD'
  return (md >= '07-15' && md <= '08-20') || (md >= '05-01' && md <= '05-06');
}

module.exports = {
  DISCOUNT_CAP,
  checkDiscountCap,
  PICKUP_PLACES,
  CAR_CLASSES,
  DEAL_TYPES,
  INSURANCE_LEVELS,
  isPeakSeason,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'jeju2026',
  PORT: Number(process.env.PORT) || 3000,
};

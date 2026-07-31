'use strict';
/**
 * 관리자 수동 등록 소스.
 *
 * 크롤링이 막히거나 선택자가 깨져도 앱이 빈 껍데기가 되지 않게 하는 최후 보루다.
 * 수집 로직이 없고(kind='manual'), 관리자 화면에서 직접 등록한 딜이 여기 달린다.
 * 수집기는 이 소스를 항상 건너뛴다 — 수동 등록 딜을 덮어쓰면 안 되기 때문이다.
 */

module.exports = {
  key: 'manual',
  name: '관리자 직접 등록',
  kind: 'manual',
  baseUrl: null,
  enabled: true,
  note: '관리자 화면에서 등록한 딜. 수집기가 건드리지 않는다.',
};

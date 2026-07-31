'use strict';
/**
 * 샘플(시드) 데이터 소스.
 *
 * 수집이 0건이어도 앱을 둘러볼 수 있게 하는 데모용 딜이 여기 달린다.
 * kind='manual' 이라 수집기가 건드리지 않는다.
 * 운영에 들어가면 관리자 화면에서 이 소스를 통째로 비우면 된다.
 */

module.exports = {
  key: 'seed',
  name: '샘플 데이터',
  kind: 'manual',
  baseUrl: null,
  enabled: true,
  note: 'npm run seed 로 생성되는 데모용 딜. 실제 매물이 아니다.',
};

'use strict';
/**
 * 관리자 인증 유틸.
 *
 * 이 앱은 예약을 받지 않으므로 개인정보를 저장하지 않는다.
 * (예약번호 생성·전화번호 정규화·마스킹 함수가 있었으나 예약 기능과 함께 제거했다)
 */

const crypto = require('crypto');

/** 타이밍 공격에 안전한 문자열 비교 (관리자 비밀번호 검증용). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  // 길이가 다르면 timingSafeEqual 이 던지므로 해시로 길이를 맞춘다.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

module.exports = { safeEqual, sessionToken };

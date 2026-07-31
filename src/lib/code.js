'use strict';
/**
 * 예약번호 생성 및 개인정보 취급 유틸.
 *
 * 비회원 예약은 예약번호가 사실상 인증 수단이므로 순번(1,2,3...)이면 안 된다.
 * 암호학적 난수 + 혼동되는 글자 제거(Crockford Base32 변형)로 만든다.
 */

const crypto = require('crypto');

// 0/O, 1/I/L, U(욕설 회피) 제외 → 사람이 전화로 불러주기 쉬움
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 편향 없는 난수 문자열. rejection sampling 으로 모듈로 편향 제거. */
function randomCode(len) {
  const out = [];
  const max = 256 - (256 % ALPHABET.length);
  while (out.length < len) {
    const buf = crypto.randomBytes(len * 2);
    for (const b of buf) {
      if (b >= max) continue; // 편향 구간 버림
      out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === len) break;
    }
  }
  return out.join('');
}

/**
 * 예약번호. 예: JJ-K7M2-9XQP
 * 30^8 ≈ 6.5×10^11 조합 — 조회 rate limit 과 함께 쓰면 무차별 대입이 비현실적.
 */
function bookingCode() {
  return `JJ-${randomCode(4)}-${randomCode(4)}`;
}

/** 사용자가 대시 없이/소문자로 입력해도 받아준다. */
function normalizeBookingCode(input) {
  if (typeof input !== 'string') return null;
  const raw = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (raw.length !== 10 || !raw.startsWith('JJ')) return null;
  const body = raw.slice(2);
  if (![...body].every((c) => ALPHABET.includes(c))) return null;
  return `JJ-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** 전화번호를 숫자만 남겨 비교용으로 정규화. */
function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/\D/g, '');
  // 국내 휴대폰/유선 길이 범위
  if (digits.length < 9 || digits.length > 11) return null;
  return digits;
}

/** 관리자 목록 화면에서 원문 전화번호를 그대로 흘리지 않기 위한 마스킹. */
function maskPhone(digits) {
  if (!digits || digits.length < 7) return '***';
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

function maskName(name) {
  if (!name) return '';
  if (name.length <= 1) return name;
  if (name.length === 2) return `${name[0]}*`;
  return `${name[0]}${'*'.repeat(name.length - 2)}${name[name.length - 1]}`;
}

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

module.exports = {
  bookingCode,
  normalizeBookingCode,
  normalizePhone,
  maskPhone,
  maskName,
  safeEqual,
  sessionToken,
  randomCode,
  ALPHABET,
};

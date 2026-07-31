'use strict';
/**
 * 예약 신청 · 조회 · 취소 API.
 *
 * 결제는 없다. 신청을 접수해 DB 에 남기고 관리자가 확정/취소한다.
 *
 * 개인정보 방침:
 * - 면허번호는 받지 않는다. 운전면허번호는 '개인정보의 안전성 확보조치 기준'상
 *   암호화 의무 대상이라, 현장 인수 시 면허증 확인으로 대체하는 편이 안전하다.
 * - 주민등록번호도 받지 않는다.
 * - 나이·면허 경과 연수는 차종별 대여 자격 확인에 필요한 최소 항목만 받는다.
 */

const express = require('express');
const { db, now, today } = require('../db');
const { bookingCode, normalizeBookingCode, normalizePhone } = require('../lib/code');
const { RateLimiter, middleware } = require('../lib/ratelimit');
const { toDeal, SELECT_BASE } = require('./deals');

const router = express.Router();

// 예약번호 무차별 대입 방어. 30^8 조합이라 15분에 10회면 사실상 불가능해진다.
const lookupLimiter = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 10, name: 'lookup' });
// 신청 스팸 방어.
const createLimiter = new RateLimiter({ windowMs: 60 * 60 * 1000, max: 20, name: 'create' });

const MAX_DAYS = 60;

function isDateTime(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(v);
}

/** 'YYYY-MM-DDTHH:MM' 과 'YYYY-MM-DD HH:MM' 을 모두 받아 후자로 통일한다. */
function normalizeDateTime(v) {
  return isDateTime(v) ? v.replace('T', ' ') : null;
}

function dayDiff(pickupAt, returnAt) {
  const a = new Date(pickupAt.replace(' ', 'T'));
  const b = new Date(returnAt.replace(' ', 'T'));
  const hours = (b - a) / 3600000;
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  // 렌터카 관행: 24시간 단위로 올림. 25시간이면 2일치.
  return Math.max(1, Math.ceil(hours / 24));
}

function trimStr(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * 신청 내용을 검증한다.
 * @returns {{ok:true, value:object} | {ok:false, error:string, field?:string}}
 */
function validateBooking(body, deal) {
  const name = trimStr(body.name, 40);
  if (!name) return { ok: false, error: '이름을 입력해 주세요.', field: 'name' };
  if (name.length < 2) return { ok: false, error: '이름을 정확히 입력해 주세요.', field: 'name' };

  const phone = normalizePhone(body.phone);
  if (!phone) return { ok: false, error: '연락처를 정확히 입력해 주세요. (숫자 9~11자리)', field: 'phone' };

  const email = trimStr(body.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { ok: false, error: '이메일 형식이 올바르지 않습니다.', field: 'email' };
  }

  const pickupAt = normalizeDateTime(body.pickupAt);
  const returnAt = normalizeDateTime(body.returnAt);
  if (!pickupAt) return { ok: false, error: '대여 일시를 선택해 주세요.', field: 'pickupAt' };
  if (!returnAt) return { ok: false, error: '반납 일시를 선택해 주세요.', field: 'returnAt' };
  if (returnAt <= pickupAt) {
    return { ok: false, error: '반납 일시는 대여 일시보다 뒤여야 합니다.', field: 'returnAt' };
  }

  // 과거 날짜 예약 차단. 날짜 문자열 비교로 충분하다 (동일 포맷).
  if (pickupAt.slice(0, 10) < today()) {
    return { ok: false, error: '지난 날짜는 예약할 수 없습니다.', field: 'pickupAt' };
  }

  const days = dayDiff(pickupAt, returnAt);
  if (days > MAX_DAYS) {
    return { ok: false, error: `최대 ${MAX_DAYS}일까지 신청할 수 있습니다.`, field: 'returnAt' };
  }
  if (days < deal.min_days) {
    return { ok: false, error: `이 특가는 최소 ${deal.min_days}일 이상 대여해야 합니다.`, field: 'returnAt' };
  }

  // 딜 유효기간 밖이면 이 가격이 적용되지 않는다.
  const pickupDate = pickupAt.slice(0, 10);
  if (deal.valid_from && pickupDate < deal.valid_from) {
    return { ok: false, error: `이 특가는 ${deal.valid_from}부터 이용할 수 있습니다.`, field: 'pickupAt' };
  }
  if (deal.valid_to && pickupDate > deal.valid_to) {
    return { ok: false, error: `이 특가는 ${deal.valid_to}까지만 이용할 수 있습니다.`, field: 'pickupAt' };
  }

  const driverAge = body.driverAge === '' || body.driverAge == null ? null : Number(body.driverAge);
  if (driverAge !== null) {
    if (!Number.isInteger(driverAge) || driverAge < 18 || driverAge > 100) {
      return { ok: false, error: '운전자 나이를 정확히 입력해 주세요.', field: 'driverAge' };
    }
    if (deal.min_age && driverAge < deal.min_age) {
      return {
        ok: false,
        error: `이 차종은 만 ${deal.min_age}세 이상만 대여할 수 있습니다.`,
        field: 'driverAge',
      };
    }
  } else if (deal.min_age) {
    return { ok: false, error: '운전자 나이를 입력해 주세요. 차종별 연령 제한이 있습니다.', field: 'driverAge' };
  }

  const licenseYears =
    body.licenseYears === '' || body.licenseYears == null ? null : Number(body.licenseYears);
  if (licenseYears !== null) {
    if (!Number.isInteger(licenseYears) || licenseYears < 0 || licenseYears > 80) {
      return { ok: false, error: '면허 취득 후 경과 연수를 정확히 입력해 주세요.', field: 'licenseYears' };
    }
    if (deal.min_license_years && licenseYears < deal.min_license_years) {
      return {
        ok: false,
        error: `이 차종은 면허 취득 후 ${deal.min_license_years}년 이상이어야 대여할 수 있습니다.`,
        field: 'licenseYears',
      };
    }
  } else if (deal.min_license_years) {
    return { ok: false, error: '면허 취득 후 경과 연수를 입력해 주세요.', field: 'licenseYears' };
  }

  // 개인정보 수집·이용 동의 없이는 접수하지 않는다.
  if (body.agreePrivacy !== true && body.agreePrivacy !== 'true' && body.agreePrivacy !== '1') {
    return { ok: false, error: '개인정보 수집·이용에 동의해야 신청할 수 있습니다.', field: 'agreePrivacy' };
  }

  return {
    ok: true,
    value: {
      name,
      phone,
      email,
      pickupAt,
      returnAt,
      days,
      driverAge,
      licenseYears,
      memo: trimStr(body.memo, 500),
      pickupPlace: trimStr(body.pickupPlace, 100) || deal.pickup_location,
    },
  };
}

const insertBooking = db.prepare(`
  INSERT INTO bookings (
    code, deal_id, snapshot_json, days, quoted_price,
    pickup_at, return_at, pickup_place,
    name, phone, email, driver_age, license_years, memo,
    privacy_agreed_at, status, created_at, updated_at
  ) VALUES (
    @code, @deal_id, @snapshot_json, @days, @quoted_price,
    @pickup_at, @return_at, @pickup_place,
    @name, @phone, @email, @driver_age, @license_years, @memo,
    @privacy_agreed_at, 'pending', @now, @now
  )
`);

router.post('/bookings', middleware(createLimiter, { message: '신청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' }), (req, res) => {
  const body = req.body || {};
  const dealId = Number(body.dealId);
  if (!Number.isInteger(dealId)) {
    return res.status(400).json({ error: '딜 번호가 올바르지 않습니다.' });
  }

  const dealRow = db.prepare(`${SELECT_BASE} WHERE d.id = @id`).get({ id: dealId });
  if (!dealRow) return res.status(404).json({ error: '딜을 찾을 수 없습니다.' });
  if (dealRow.status !== 'active') {
    return res.status(409).json({ error: '종료된 특가입니다. 다른 상품을 선택해 주세요.' });
  }

  const v = validateBooking(body, dealRow);
  if (!v.ok) return res.status(400).json({ error: v.error, field: v.field });

  // 재고가 표시된 딜은 남은 수량 안에서만 접수한다.
  if (dealRow.stock !== null) {
    const taken = db
      .prepare("SELECT COUNT(*) AS c FROM bookings WHERE deal_id = ? AND status IN ('pending', 'confirmed')")
      .get(dealId).c;
    if (taken >= dealRow.stock) {
      return res.status(409).json({ error: '이 특가는 신청이 마감되었습니다.' });
    }
  }

  // 같은 번호로 같은 딜·같은 일정을 중복 신청하는 것을 막는다.
  const dup = db
    .prepare(
      `SELECT code FROM bookings
        WHERE deal_id = ? AND phone = ? AND pickup_at = ? AND status IN ('pending', 'confirmed')`
    )
    .get(dealId, v.value.phone, v.value.pickupAt);
  if (dup) {
    return res.status(409).json({ error: '같은 일정으로 이미 신청하셨습니다.', code: dup.code });
  }

  const quoted = dealRow.sale_price * v.value.days;
  const snapshot = {
    ...toDeal(dealRow),
    snapshotAt: now(),
    // 스냅샷에는 조회용 파생값이 아니라 계약 조건에 해당하는 값만 남긴다.
    quotedFor: { days: v.value.days, unitPrice: dealRow.sale_price },
  };

  // 예약번호 충돌은 사실상 없지만, 만에 하나 겹치면 재시도한다.
  let code = null;
  for (let attempt = 0; attempt < 5 && !code; attempt++) {
    const candidate = bookingCode();
    try {
      insertBooking.run({
        code: candidate,
        deal_id: dealId,
        snapshot_json: JSON.stringify(snapshot),
        days: v.value.days,
        quoted_price: quoted,
        pickup_at: v.value.pickupAt,
        return_at: v.value.returnAt,
        pickup_place: v.value.pickupPlace,
        name: v.value.name,
        phone: v.value.phone,
        email: v.value.email,
        driver_age: v.value.driverAge,
        license_years: v.value.licenseYears,
        memo: v.value.memo,
        privacy_agreed_at: now(),
        now: now(),
      });
      code = candidate;
    } catch (err) {
      if (!String(err.message).includes('UNIQUE constraint failed: bookings.code')) throw err;
    }
  }
  if (!code) return res.status(500).json({ error: '예약번호 생성에 실패했습니다. 다시 시도해 주세요.' });

  res.status(201).json({
    code,
    status: 'pending',
    quotedPrice: quoted,
    days: v.value.days,
    pickupAt: v.value.pickupAt,
    returnAt: v.value.returnAt,
    message: '신청이 접수되었습니다. 업체 확인 후 확정 안내를 드립니다.',
  });
});

/** 조회·취소 공통 인증: 예약번호 + 연락처. */
function findBooking(body) {
  const code = normalizeBookingCode(body?.code);
  const phone = normalizePhone(body?.phone);
  // 어느 쪽이 틀렸는지 알려주지 않는다. 열거 공격을 막기 위해서다.
  if (!code || !phone) return null;
  return db.prepare('SELECT * FROM bookings WHERE code = ? AND phone = ?').get(code, phone) || null;
}

function toBookingView(row) {
  let snapshot = null;
  try {
    snapshot = JSON.parse(row.snapshot_json);
  } catch {
    snapshot = null;
  }
  return {
    code: row.code,
    status: row.status,
    days: row.days,
    quotedPrice: row.quoted_price,
    pickupAt: row.pickup_at,
    returnAt: row.return_at,
    pickupPlace: row.pickup_place,
    name: row.name,
    email: row.email,
    memo: row.memo,
    adminMemo: row.admin_memo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledBy: row.cancelled_by,
    deal: snapshot,
  };
}

router.post(
  '/bookings/lookup',
  middleware(lookupLimiter, { message: '조회 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.' }),
  (req, res) => {
    const row = findBooking(req.body);
    if (!row) {
      return res.status(404).json({ error: '예약번호 또는 연락처가 일치하지 않습니다.' });
    }
    res.json({ booking: toBookingView(row) });
  }
);

router.post(
  '/bookings/cancel',
  middleware(lookupLimiter, { message: '요청이 너무 많습니다. 15분 후 다시 시도해 주세요.' }),
  (req, res) => {
    const row = findBooking(req.body);
    if (!row) {
      return res.status(404).json({ error: '예약번호 또는 연락처가 일치하지 않습니다.' });
    }
    if (row.status === 'cancelled') {
      return res.status(409).json({ error: '이미 취소된 신청입니다.' });
    }
    if (row.status === 'rejected') {
      return res.status(409).json({ error: '업체에서 반려한 신청입니다.' });
    }
    // 대여 시작 후에는 앱에서 취소할 수 없다. 업체와 직접 처리해야 한다.
    if (row.pickup_at <= now()) {
      return res.status(409).json({
        error: '대여 시작 시각이 지나 온라인 취소가 불가합니다. 업체로 문의해 주세요.',
      });
    }

    db.prepare(
      "UPDATE bookings SET status = 'cancelled', cancelled_by = 'user', updated_at = ? WHERE id = ?"
    ).run(now(), row.id);

    const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(row.id);
    res.json({ booking: toBookingView(updated), message: '신청이 취소되었습니다.' });
  }
);

module.exports = { router, validateBooking, dayDiff, lookupLimiter, createLimiter };

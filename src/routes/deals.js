'use strict';
/**
 * 딜 조회 API.
 * 모든 필터는 파라미터 바인딩으로만 조립한다. 문자열 보간 금지.
 */

const express = require('express');
const { db } = require('../db');
const { checkDiscountCap, CAR_CLASSES } = require('../config');

const router = express.Router();

const MAX_LIMIT = 60;

const SORTS = {
  // 기본: 할인율 높은 순. 같으면 싼 것 먼저.
  discount: 'd.discount_pct DESC, d.sale_price ASC',
  price: 'd.sale_price ASC, d.discount_pct DESC',
  priceDesc: 'd.sale_price DESC',
  rating: 'COALESCE(v.rating, 0) DESC, d.discount_pct DESC',
  latest: 'd.first_seen_at DESC, d.id DESC',
};

/** 'YYYY-MM-DD' 형태인지 확인. 아니면 null. */
function asDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 쉼표로 넘어온 다중 선택 값을 화이트리스트로 거른다. */
function asEnumList(v, allowed) {
  if (typeof v !== 'string' || !v) return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => allowed.includes(s));
}

function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  const diff = Math.round((b - a) / 86400000);
  return diff;
}

/** 요청 쿼리에서 WHERE 절과 바인딩을 만든다. */
function buildFilter(q) {
  const where = ["d.status = 'active'"];
  const params = {};

  const text = typeof q.q === 'string' ? q.q.trim() : '';
  if (text) {
    // LIKE 만으로 처리한다. FTS5 는 한국어 토크나이징이 약해 부분일치가 오히려 낫다.
    where.push('(d.vendor_name LIKE @q OR d.car_model LIKE @q)');
    params.q = `%${text.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  }

  const classes = asEnumList(q.carClass, CAR_CLASSES);
  if (classes.length) {
    const keys = classes.map((c, i) => {
      params[`cls${i}`] = c;
      return `@cls${i}`;
    });
    where.push(`d.car_class IN (${keys.join(', ')})`);
  }

  const minPrice = asInt(q.minPrice);
  if (minPrice !== null && minPrice > 0) {
    where.push('d.sale_price >= @minPrice');
    params.minPrice = minPrice;
  }
  const maxPrice = asInt(q.maxPrice);
  if (maxPrice !== null && maxPrice > 0) {
    where.push('d.sale_price <= @maxPrice');
    params.maxPrice = maxPrice;
  }

  const minDiscount = asInt(q.minDiscount);
  if (minDiscount !== null && minDiscount > 0) {
    where.push('d.discount_pct >= @minDiscount');
    params.minDiscount = minDiscount;
  }

  if (typeof q.dealType === 'string' && q.dealType.trim()) {
    where.push('d.deal_type = @dealType');
    params.dealType = q.dealType.trim();
  }
  if (typeof q.insurance === 'string' && q.insurance.trim()) {
    where.push('d.insurance = @insurance');
    params.insurance = q.insurance.trim();
  }
  if (typeof q.vendor === 'string' && q.vendor.trim()) {
    where.push('d.vendor_name = @vendor');
    params.vendor = q.vendor.trim();
  }
  if (typeof q.pickup === 'string' && q.pickup.trim()) {
    where.push('d.pickup_location = @pickup');
    params.pickup = q.pickup.trim();
  }

  if (q.freeCancel === '1' || q.freeCancel === 'true') where.push('d.free_cancel = 1');
  if (q.insuranceIncluded === '1' || q.insuranceIncluded === 'true') where.push('d.insurance_included = 1');

  // 대여 기간이 주어지면 그 기간에 실제로 쓸 수 있는 딜만 남긴다.
  const from = asDate(q.pickupDate);
  const to = asDate(q.returnDate);
  if (from) {
    where.push('(d.valid_to IS NULL OR d.valid_to >= @from)');
    params.from = from;
  }
  if (to) {
    where.push('(d.valid_from IS NULL OR d.valid_from <= @to)');
    params.to = to;
  }
  if (from && to) {
    const days = daysBetween(from, to);
    if (days >= 1) {
      // 최소 대여일 조건을 못 채우는 딜은 보여줘도 예약이 안 된다.
      where.push('d.min_days <= @days');
      params.days = days;
    }
  }

  return { where: where.join(' AND '), params };
}

/** DB 행을 API 응답 형태로. 할인율 상한 경고를 여기서 붙인다. */
function toDeal(row) {
  const cap = checkDiscountCap(row);
  return {
    id: row.id,
    vendor: row.vendor_name,
    vendorRating: row.rating,
    vendorReviews: row.review_count,
    pickupType: row.pickup_type,
    carModel: row.car_model,
    carClass: row.car_class,
    fuel: row.fuel,
    seats: row.seats,
    transmission: row.transmission,
    listPrice: row.list_price,
    salePrice: row.sale_price,
    discountPct: row.discount_pct,
    dealType: row.deal_type,
    insurance: row.insurance,
    insuranceIncluded: Boolean(row.insurance_included),
    freeCancel: Boolean(row.free_cancel),
    pickupLocation: row.pickup_location,
    minDays: row.min_days,
    minAge: row.min_age,
    minLicenseYears: row.min_license_years,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    stock: row.stock,
    detailUrl: row.detail_url,
    notes: row.notes,
    sourceKey: row.source_key,
    sourceName: row.source_name,
    // 2026-09-16 시행 할인율 상한 초과 여부
    capWarning: cap.overCap ? { cap: cap.cap, enforced: cap.enforced, exempt: cap.exempt } : null,
  };
}

const SELECT_BASE = `
  SELECT d.*, v.rating, v.review_count, v.pickup_type,
         s.key AS source_key, s.name AS source_name
    FROM deals d
    LEFT JOIN vendors v ON v.id = d.vendor_id
    LEFT JOIN sources s ON s.id = d.source_id
`;

router.get('/deals', (req, res) => {
  const { where, params } = buildFilter(req.query);

  const sortKey = typeof req.query.sort === 'string' && SORTS[req.query.sort] ? req.query.sort : 'discount';
  const limit = Math.min(MAX_LIMIT, Math.max(1, asInt(req.query.limit) ?? 24));
  const page = Math.max(1, asInt(req.query.page) ?? 1);
  const offset = (page - 1) * limit;

  const total = db.prepare(`SELECT COUNT(*) AS c FROM deals d WHERE ${where}`).get(params).c;

  const rows = db
    .prepare(`${SELECT_BASE} WHERE ${where} ORDER BY ${SORTS[sortKey]} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit, offset });

  res.json({
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
    sort: sortKey,
    deals: rows.map(toDeal),
  });
});

router.get('/deals/:id', (req, res) => {
  const id = asInt(req.params.id);
  if (id === null) return res.status(400).json({ error: '잘못된 딜 번호입니다.' });

  const row = db.prepare(`${SELECT_BASE} WHERE d.id = @id`).get({ id });
  if (!row) return res.status(404).json({ error: '딜을 찾을 수 없습니다.' });
  if (row.status !== 'active') {
    // 만료된 딜도 내용은 보여주되 예약은 막는다.
    return res.json({ deal: toDeal(row), available: false, reason: '종료된 특가입니다.' });
  }
  res.json({ deal: toDeal(row), available: true });
});

/** 필터 UI 를 채우기 위한 선택지와 현재 데이터 분포. */
router.get('/meta', (req, res) => {
  const active = "status = 'active'";

  const classes = db
    .prepare(`SELECT car_class AS name, COUNT(*) AS count FROM deals WHERE ${active} GROUP BY car_class`)
    .all();
  // 화면 순서를 데이터 순서에 맡기지 않는다.
  classes.sort((a, b) => CAR_CLASSES.indexOf(a.name) - CAR_CLASSES.indexOf(b.name));

  const vendors = db
    .prepare(
      `SELECT d.vendor_name AS name, COUNT(*) AS count, MAX(v.rating) AS rating
         FROM deals d LEFT JOIN vendors v ON v.id = d.vendor_id
        WHERE d.status = 'active'
        GROUP BY d.vendor_name ORDER BY count DESC`
    )
    .all();

  const dealTypes = db
    .prepare(`SELECT deal_type AS name, COUNT(*) AS count FROM deals WHERE ${active} AND deal_type IS NOT NULL GROUP BY deal_type ORDER BY count DESC`)
    .all();

  const pickups = db
    .prepare(`SELECT pickup_location AS name, COUNT(*) AS count FROM deals WHERE ${active} AND pickup_location IS NOT NULL GROUP BY pickup_location ORDER BY count DESC`)
    .all();

  const range = db
    .prepare(`SELECT MIN(sale_price) AS min, MAX(sale_price) AS max, MAX(discount_pct) AS maxDiscount, COUNT(*) AS total FROM deals WHERE ${active}`)
    .get();

  const updatedAt = db.prepare(`SELECT MAX(last_seen_at) AS at FROM deals WHERE ${active}`).get().at;

  res.json({
    classes,
    vendors,
    dealTypes,
    pickups,
    priceRange: { min: range.min ?? 0, max: range.max ?? 0 },
    maxDiscount: range.maxDiscount ?? 0,
    total: range.total ?? 0,
    updatedAt,
  });
});

module.exports = { router, toDeal, buildFilter, SELECT_BASE };

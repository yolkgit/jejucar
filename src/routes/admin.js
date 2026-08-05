'use strict';
/**
 * 관리자 API.
 *
 * 인증은 비밀번호 1개 + 서버 저장 세션 토큰이다.
 * 사용자 계정 체계를 두지 않은 이유: 운영자가 1~2명인 소규모 도구이고,
 * 계정 관리를 붙이면 오히려 관리 부담과 공격면이 커진다.
 * 대신 토큰을 DB 에 저장해 즉시 무효화할 수 있게 했다.
 */

const express = require('express');
const { db, now, ensureVendor, upsertDeal, discountPct } = require('../db');
const { safeEqual, sessionToken } = require('../lib/code');
const { RateLimiter, middleware, clientKey } = require('../lib/ratelimit');
const { ADMIN_PASSWORD, CAR_CLASSES } = require('../config');
const { toDeal, SELECT_BASE } = require('./deals');

const router = express.Router();

const SESSION_HOURS = 12;
const COOKIE = 'jjadmin';

// 비밀번호가 하나뿐이므로 무차별 대입 방어가 특히 중요하다.
const loginLimiter = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 8, name: 'admin-login' });

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function addHours(h) {
  const d = new Date(Date.now() + h * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 만료된 세션은 조회 시점에 걷어낸다. 별도 스케줄러를 두지 않는다. */
function currentSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(now());
  return db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token) || null;
}

function requireAdmin(req, res, next) {
  if (!currentSession(req)) {
    return res.status(401).json({ error: '관리자 로그인이 필요합니다.' });
  }
  next();
}

router.post('/admin/login', middleware(loginLimiter, { message: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.' }), (req, res) => {
  const password = req.body?.password;
  if (!safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
  }

  // 성공하면 이 IP 의 실패 카운트를 지운다.
  loginLimiter.reset(clientKey(req));

  const token = sessionToken();
  db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)').run(
    token,
    now(),
    addHours(SESSION_HOURS)
  );

  // HTTPS 종단이 리버스 프록시인 배포를 고려해 Secure 는 환경변수로 켠다.
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`
  );
  res.json({ ok: true, expiresIn: SESSION_HOURS * 3600 });
});

router.post('/admin/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

router.get('/admin/me', (req, res) => {
  res.json({ authenticated: Boolean(currentSession(req)) });
});

router.use('/admin', requireAdmin);

// ── 통계 ────────────────────────────────────────────────────
router.get('/admin/stats', (req, res) => {
  const deals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active'  THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
              SUM(CASE WHEN status = 'hidden'  THEN 1 ELSE 0 END) AS hidden
         FROM deals`
    )
    .get();

  const clicks = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN clicked_at >= datetime('now','localtime','-1 day')  THEN 1 ELSE 0 END) AS d1,
              SUM(CASE WHEN clicked_at >= datetime('now','localtime','-7 days') THEN 1 ELSE 0 END) AS d7
         FROM outbound_clicks`
    )
    .get();

  // 링크가 없는 딜은 이 앱에서 아무 쓸모가 없다. 눈에 띄게 보여준다.
  const noLink = db
    .prepare("SELECT COUNT(*) AS c FROM deals WHERE status='active' AND (detail_url IS NULL OR detail_url='')")
    .get().c;

  res.json({ deals, clicks, noLink });
});

// ── 송출 클릭 ───────────────────────────────────────────────
router.get('/admin/clicks', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

  const top = db
    .prepare(
      `SELECT vendor_name, car_model, source_key, COUNT(*) AS clicks, MAX(clicked_at) AS last_at
         FROM outbound_clicks
        WHERE clicked_at >= datetime('now','localtime','-30 days')
        GROUP BY vendor_name, car_model, source_key
        ORDER BY clicks DESC, last_at DESC
        LIMIT ?`
    )
    .all(limit);

  const bySource = db
    .prepare(
      `SELECT source_key, COUNT(*) AS clicks
         FROM outbound_clicks
        WHERE clicked_at >= datetime('now','localtime','-30 days')
        GROUP BY source_key ORDER BY clicks DESC`
    )
    .all();

  const daily = db
    .prepare(
      `SELECT substr(clicked_at, 1, 10) AS day, COUNT(*) AS clicks
         FROM outbound_clicks
        WHERE clicked_at >= datetime('now','localtime','-14 days')
        GROUP BY day ORDER BY day DESC`
    )
    .all();

  res.json({ top, bySource, daily });
});

// ── 딜 관리 ─────────────────────────────────────────────────
router.get('/admin/deals', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const status = ['active', 'expired', 'hidden'].includes(req.query.status) ? req.query.status : null;
  const rows = status
    ? db.prepare(`${SELECT_BASE} WHERE d.status = ? ORDER BY d.discount_pct DESC LIMIT ?`).all(status, limit)
    : db.prepare(`${SELECT_BASE} ORDER BY d.status, d.discount_pct DESC LIMIT ?`).all(limit);
  res.json({ deals: rows.map((r) => ({ ...toDeal(r), status: r.status })) });
});

/** 수동 등록·수정은 'manual' 소스에만 허용한다. 수집 소스 딜을 손대면 다음 수집에 덮어써진다. */
function manualSourceId() {
  const row = db.prepare("SELECT id FROM sources WHERE key = 'manual'").get();
  if (row) return row.id;
  db.prepare("INSERT INTO sources (key, name, kind, enabled) VALUES ('manual', '관리자 직접 등록', 'manual', 1)").run();
  return db.prepare("SELECT id FROM sources WHERE key = 'manual'").get().id;
}

router.post('/admin/deals', (req, res) => {
  const b = req.body || {};
  const listPrice = Number(b.listPrice);
  const salePrice = Number(b.salePrice);

  if (!b.vendorName || !b.carModel) {
    return res.status(400).json({ error: '업체명과 차종은 필수입니다.' });
  }
  if (!Number.isFinite(listPrice) || !Number.isFinite(salePrice) || listPrice <= 0 || salePrice <= 0) {
    return res.status(400).json({ error: '정가와 할인가를 올바르게 입력해 주세요.' });
  }
  if (salePrice > listPrice) {
    return res.status(400).json({ error: '할인가가 정가보다 클 수 없습니다.' });
  }
  if (!CAR_CLASSES.includes(b.carClass)) {
    return res.status(400).json({ error: `차종 등급은 ${CAR_CLASSES.join(', ')} 중 하나여야 합니다.` });
  }

  const sourceId = manualSourceId();
  const externalId = `admin-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const vendorId = ensureVendor(String(b.vendorName).trim());

  upsertDeal({
    source_id: sourceId,
    external_id: externalId,
    vendor_id: vendorId,
    vendor_name: String(b.vendorName).trim(),
    car_model: String(b.carModel).trim(),
    car_class: b.carClass,
    fuel: b.fuel || null,
    seats: Number(b.seats) || null,
    list_price: listPrice,
    sale_price: salePrice,
    deal_type: b.dealType || null,
    insurance: b.insurance || null,
    insurance_included: Boolean(b.insuranceIncluded),
    free_cancel: b.freeCancel !== false,
    pickup_location: b.pickupLocation || null,
    min_days: Number(b.minDays) || 1,
    min_age: Number(b.minAge) || null,
    min_license_years: Number(b.minLicenseYears) || null,
    valid_from: b.validFrom || null,
    valid_to: b.validTo || null,
    stock: b.stock === '' || b.stock == null ? null : Number(b.stock),
    detail_url: b.detailUrl || null,
    notes: b.notes || null,
    status: 'active',
  });

  const created = db.prepare(`${SELECT_BASE} WHERE d.source_id = ? AND d.external_id = ?`).get(sourceId, externalId);
  res.status(201).json({ deal: toDeal(created) });
});

router.patch('/admin/deals/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM deals WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '딜을 찾을 수 없습니다.' });

  const b = req.body || {};
  const listPrice = b.listPrice === undefined ? row.list_price : Number(b.listPrice);
  const salePrice = b.salePrice === undefined ? row.sale_price : Number(b.salePrice);
  if (!Number.isFinite(listPrice) || !Number.isFinite(salePrice) || salePrice > listPrice) {
    return res.status(400).json({ error: '가격이 올바르지 않습니다.' });
  }
  if (b.status !== undefined && !['active', 'expired', 'hidden'].includes(b.status)) {
    return res.status(400).json({ error: '허용되지 않는 상태값입니다.' });
  }

  db.prepare(
    `UPDATE deals
        SET list_price = ?, sale_price = ?, discount_pct = ?,
            stock = COALESCE(?, stock),
            notes = COALESCE(?, notes),
            status = COALESCE(?, status),
            last_seen_at = ?
      WHERE id = ?`
  ).run(
    listPrice,
    salePrice,
    discountPct(listPrice, salePrice),
    b.stock === undefined ? null : b.stock === '' || b.stock === null ? null : Number(b.stock),
    b.notes ?? null,
    b.status ?? null,
    now(),
    id
  );

  res.json({ deal: toDeal(db.prepare(`${SELECT_BASE} WHERE d.id = ?`).get(id)) });
});

router.delete('/admin/deals/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM deals WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '딜을 찾을 수 없습니다.' });

  // 삭제하면 이 딜의 클릭 집계가 deal_id NULL 로 끊긴다.
  // (비정규화 컬럼 덕에 업체·차종별 집계는 남는다)
  const clicks = db.prepare('SELECT COUNT(*) AS c FROM outbound_clicks WHERE deal_id = ?').get(id).c;
  if (clicks > 0 && req.query.force !== '1') {
    return res.status(409).json({
      error: `송출 클릭 ${clicks}건이 연결돼 있습니다. 삭제 대신 '숨김'을 권합니다. 그래도 지우려면 force=1.`,
    });
  }

  db.prepare('DELETE FROM deals WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ── 수집 소스 관리 ──────────────────────────────────────────
router.get('/admin/sources', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM deals d WHERE d.source_id = s.id AND d.status = 'active') AS active_deals
         FROM sources s ORDER BY s.kind, s.key`
    )
    .all();
  res.json({ sources: rows });
});

router.patch('/admin/sources/:key', (req, res) => {
  const row = db.prepare('SELECT * FROM sources WHERE key = ?').get(req.params.key);
  if (!row) return res.status(404).json({ error: '소스를 찾을 수 없습니다.' });
  if (row.kind === 'manual') {
    return res.status(400).json({ error: '수동 등록 소스는 수집 대상이 아닙니다.' });
  }
  const enabled = req.body?.enabled ? 1 : 0;
  db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(enabled, row.id);
  res.json({ ok: true, enabled: Boolean(enabled) });
});

router.post('/admin/collect', async (req, res) => {
  // 수집은 오래 걸릴 수 있다. 요청은 즉시 받고 결과를 기다린다 (소스 수가 적어 감당 가능).
  const { collectAll } = require('../collector');
  const key = typeof req.body?.key === 'string' ? req.body.key : null;
  const result = await collectAll({ onlyKey: key });
  res.json(result);
});

router.get('/admin/logs', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({
    logs: db.prepare('SELECT * FROM crawl_logs ORDER BY id DESC LIMIT ?').all(limit),
  });
});

module.exports = { router, requireAdmin, loginLimiter, COOKIE };

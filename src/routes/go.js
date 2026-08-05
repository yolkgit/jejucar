'use strict';
/**
 * 송출(아웃바운드) 라우트.
 *
 * 이 앱의 존재 이유다. 사용자가 특가를 고르면 원 사이트의 **그 상품 페이지**로 보낸다.
 * 예약·결제는 전부 원 사이트에서 이루어진다.
 *
 *   GET /go/:id  →  클릭 1건 기록 후 302 로 detail_url 이동
 *
 * 보안: 오픈 리다이렉트가 되지 않도록 **DB 에 저장된 딜의 detail_url 로만** 보낸다.
 * 사용자가 넘긴 URL 은 절대 따라가지 않으며, 스킴과 호스트를 다시 검증한다.
 */

const express = require('express');
const { db, now } = require('../db');

const router = express.Router();

// 어댑터가 넣은 링크만 허용한다. 새 소스를 붙이면 여기에 호스트를 추가해야 한다.
// 화이트리스트를 두는 이유: DB 가 오염돼도 임의 사이트로 사용자를 보내지 않기 위해서다.
const ALLOWED_HOSTS = new Set([
  'www.dolharupang.com',
  'dolharupang.com',
  'jejussok.com',
  'www.jejussok.com',
]);

const recordClick = db.prepare(`
  INSERT INTO outbound_clicks (deal_id, source_key, vendor_name, car_model, sale_price, clicked_at)
  VALUES (@deal_id, @source_key, @vendor_name, @car_model, @sale_price, @clicked_at)
`);

const findDeal = db.prepare(`
  SELECT d.id, d.detail_url, d.vendor_name, d.car_model, d.sale_price, d.status, s.key AS source_key
    FROM deals d LEFT JOIN sources s ON s.id = d.source_id
   WHERE d.id = ?
`);

/** 저장된 URL 이 실제로 보내도 되는 주소인지 다시 확인한다. */
function safeDestination(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.has(u.host)) return null;
  return u.href;
}

router.get('/go/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).send('잘못된 요청입니다.');
  }

  const deal = findDeal.get(id);
  if (!deal) return res.status(404).send('상품을 찾을 수 없습니다.');

  const dest = safeDestination(deal.detail_url);
  if (!dest) {
    // 링크가 없으면 이 앱은 할 일이 없다. 조용히 목록으로 돌려보내지 않고 알린다.
    return res.status(502).send('이 상품의 판매처 링크가 확인되지 않습니다.');
  }

  try {
    recordClick.run({
      deal_id: deal.id,
      source_key: deal.source_key,
      vendor_name: deal.vendor_name,
      car_model: deal.car_model,
      sale_price: deal.sale_price,
      clicked_at: now(),
    });
  } catch (err) {
    // 집계 실패가 사용자 이동을 막아서는 안 된다.
    console.error('[송출] 클릭 기록 실패:', err.message);
  }

  // 302: 링크는 영구적이지 않다. 딜이 만료되면 목적지가 바뀔 수 있다.
  res.redirect(302, dest);
});

module.exports = { router, safeDestination, ALLOWED_HOSTS };

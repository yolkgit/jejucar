'use strict';
/**
 * 제주속으로 (jejussok.com) 어댑터.
 *
 * ── 이 소스를 고른 이유 ──────────────────────────────────────
 * 조사한 제주 렌터카 사이트 중 **가격이 정적 HTML 에 들어 있는 유일한 곳**이다.
 * 나머지(카모아·돌하루팡·제주패스·JARent 등)는 전부 CSR 이라 날짜를 고른 뒤
 * 내부 API 를 호출해야 가격이 나오고, 정적 파서로는 값을 얻을 수 없다.
 *
 * robots.txt (2026-07 확인): `User-agent: * / Allow: /` — 전체 허용, Crawl-delay 없음.
 * 그래도 수집기가 매 요청마다 robots 를 다시 확인하고 호스트당 2초 간격을 지킨다.
 *
 * ── 한계 (알고 쓸 것) ────────────────────────────────────────
 * 1. 홈페이지에 노출되는 **6대 남짓**만 정적으로 얻을 수 있다.
 *    /rent/list.php 는 날짜 파라미터를 붙여도 CSR 이라 카드가 비어 온다.
 * 2. **정가(tprice)가 HTML 주석으로 가려져 있다.**
 *    `<!-- <div class="tprice"><s>185,000원</s></div> -->`
 *    주석에서 끌어다 쓰면 22,300원이 "88% 할인"으로 표시되는데, 그건 이 사이트가
 *    표시하지 않기로 한 값이다. 제주도 할인율 상한 규칙·표시광고법이 문제 삼는
 *    바로 그 형태이므로 **의도적으로 읽지 않는다.** 정가 없이 판매가만 싣는다.
 * 3. 유효기간이 표기되지 않는다. valid_from/valid_to 를 비워 둔다.
 */

const cheerio = require('cheerio');

const BASE = 'https://jejussok.com';

/** 예약 링크에서 carno 를 뽑는다. 소스 내에서 안정적인 차량 식별자다. */
function carNoFrom(href) {
  if (!href) return null;
  // href 는 ./index_link.php?link=1&url=<인코딩된 예약 URL> 형태다.
  let s = href;
  try {
    s = decodeURIComponent(href);
  } catch {
    /* 인코딩이 깨져 있으면 원문에서 그대로 찾는다 */
  }
  const m = s.match(/[?&]carno=(\d+)/);
  return m ? m[1] : null;
}

module.exports = {
  key: 'jejussok',
  name: '제주속으로',
  kind: 'crawler',
  baseUrl: BASE,
  // 기본 비활성. 이용약관을 직접 확인한 뒤 관리자 화면에서 켠다.
  enabled: false,
  note: 'robots.txt 전체 허용(2026-07 확인). 홈 노출 차량만 수집되며 정가는 제공되지 않는다.',

  async collect(ctx) {
    const res = await ctx.get(`${BASE}/`, {
      etag: ctx.etag,
      lastModified: ctx.lastModified,
    });

    if (res.notModified) return { deals: [], unchanged: true };
    if (!res.ok || !res.body) throw new Error(`홈 응답 이상: HTTP ${res.status}`);

    const $ = cheerio.load(res.body);
    const cards = $('li.pro_box');

    if (cards.length === 0) {
      ctx.warn('li.pro_box 를 찾지 못했습니다 — 사이트 구조가 바뀌었을 수 있습니다');
      return { deals: [], etag: res.etag, lastModified: res.lastModified };
    }

    const deals = [];
    const seen = new Set();

    cards.each((i, el) => {
      const $card = $(el);
      const title = $card.find('.pro_title');
      if (title.length === 0) return;

      const href = $card.find('a[href]').first().attr('href');
      const carNo = carNoFrom(href);
      if (!carNo) {
        ctx.warn(`${i}번째 카드에서 carno 를 찾지 못해 건너뜁니다`);
        return;
      }
      // 같은 차가 여러 번 노출될 수 있다. 먼저 나온 것만 쓴다.
      if (seen.has(carNo)) return;
      seen.add(carNo);

      // .name 안에는 배지(.pro_event)와 연식(.rent_year) 요소가 섞여 있다.
      // 자식 요소를 걷어내고 남은 텍스트가 차종명이다.
      const nameEl = title.find('.name');
      const carModel = nameEl.clone().children().remove().end().text().trim();
      if (!carModel) {
        ctx.warn(`carno=${carNo} 차종명이 비어 건너뜁니다`);
        return;
      }

      const price = title.find('.pro_price .price strong').first().text().trim();
      if (!price) {
        ctx.warn(`carno=${carNo} (${carModel}) 가격을 찾지 못해 건너뜁니다`);
        return;
      }

      // ul.carinfo → [등급, 인승, 연료, 대여단위]
      const info = $card
        .find('ul.carinfo li')
        .map((_, li) => $(li).text().trim())
        .get()
        .filter(Boolean);

      const badges = title
        .find('.pro_event p')
        .map((_, p) => $(p).text().trim())
        .get();

      const year = title.find('.rent_year').text().trim();
      const seatText = info.find((t) => /인승/.test(t));
      const seats = seatText ? Number(seatText.replace(/\D/g, '')) : null;

      // '자차포함' 배지는 보험이 요금에 포함된다는 뜻이다.
      const insuranceIncluded = badges.some((b) => /자차\s*포함|보험\s*포함/.test(b));

      const img = $card.find('.pro_thum img').attr('src');

      deals.push({
        external_id: carNo,
        vendor_name: '제주속으로',
        car_model: carModel,
        // 등급·연료 판정은 normalize.js 에 맡긴다. 원문을 그대로 넘긴다.
        // 이 사이트는 경차를 '경형'으로 쓴다 — CLASS_ALIASES 가 처리한다.
        car_class: info[0] || null,
        fuel: info.find((t) => /휘발유|가솔린|디젤|경유|LPG|전기|하이브리드/i.test(t)) || null,
        seats: Number.isFinite(seats) ? seats : null,
        // 정가는 의도적으로 넘기지 않는다. 위 주석 참고.
        list_price: null,
        sale_price: price,
        insurance: insuranceIncluded ? '자차' : null,
        insurance_included: insuranceIncluded,
        title: badges.join(' '),
        pickup_location: '제주공항 셔틀',
        detail_url: href ? new URL(href, `${BASE}/`).href : null,
        image_url: img ? new URL(img, `${BASE}/`).href : null,
        notes: [year, ...badges, info[3]].filter(Boolean).join(' · '),
      });
    });

    ctx.info(`카드 ${cards.length}개 중 ${deals.length}건 추출`);
    return { deals, etag: res.etag, lastModified: res.lastModified };
  },
};

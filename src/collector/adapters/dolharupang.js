'use strict';
/**
 * 돌하루팡 (dolharupang.com) 어댑터 — 내부 JSON API 사용.
 *
 * ── 어떻게 찾았나 ────────────────────────────────────────────
 * 이 사이트는 Next.js CSR 이라 HTML 에는 가격이 없다. 하지만 화면을 그리기 위해
 * 내부 REST API 를 부르고, 그 엔드포인트는 브라우저 없이도 호출된다.
 * `scripts/scan-chunks.js` 로 같은 호스트 JS 번들을 전부 받아 /api/ 경로를 모으고,
 * `scripts/grep-chunks.js` 로 호출부 맥락을 읽어 파라미터와 날짜 형식을 확정했다.
 *
 *   GET /api/cars?startDate=YYYY-MM-DDTHH:mm:ss&endDate=...
 *   → { success, data: { items: [ { name, type, fuelType, capacity, offers: [...] } ] } }
 *
 * robots.txt (2026-07 확인): `User-Agent: * / Allow: /`.
 * ClaudeBot·GPTBot 등 AI 크롤러도 개별 Allow 로 명시돼 있다. /api 경로에 Disallow 없음.
 *
 * ── 주의 ────────────────────────────────────────────────────
 * 1. 응답이 1.5MB 가량이고 차종 485개 · offer 1400여 개가 온다.
 *    요청 1회로 전부 받으므로 자주 부를 이유가 없다. 기본 수집 주기(3시간)면 충분하다.
 * 2. **가격은 조회 날짜에 종속된다.** 성수기·비수기 차이가 10배까지 나므로
 *    수집 시점의 기준일을 notes 에 명시하고, 그 날짜를 valid_from 으로 남긴다.
 * 3. originalPrice(신고 요금) 대비 salePrice 가 90% 할인으로 나오는 경우가 흔하다.
 *    이건 조작이 아니라 이 업계의 실제 요금 신고 구조다.
 *    2026-09-16 시행 제주도 규칙의 60% 상한을 넘으므로 앱이 경고 배지를 붙인다.
 */

const BASE = 'https://www.dolharupang.com';

/** 'YYYY-MM-DDTHH:mm:ss' — 타임존 없는 로컬 표기. API 가 이 형식만 받는다. */
function apiDate(d, hour = 10) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hour)}:00:00`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** 옵션 배열에서 실제로 있는 항목만 뽑는다. */
function presentOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.filter((o) => o && o.isExist !== false && o.value).map((o) => String(o.value));
}

module.exports = {
  key: 'dolharupang',
  name: '돌하루팡',
  kind: 'api',
  baseUrl: BASE,
  // 기본 비활성. 이용약관을 직접 확인한 뒤 관리자 화면에서 켠다.
  enabled: false,
  note: 'robots.txt 전체 허용(2026-07 확인). 내부 JSON API /api/cars 사용. 요청 1회로 1400여 상품 수집.',

  // 수집 기준일: 오늘로부터 며칠 뒤 / 몇 박. 조회 날짜에 따라 가격이 달라진다.
  leadDays: 14,
  nights: 1,

  async collect(ctx) {
    const start = addDays(new Date(), this.leadDays);
    const end = addDays(start, this.nights);
    const startStr = apiDate(start);
    const endStr = apiDate(end);
    const refDate = startStr.slice(0, 10);

    const url = `${BASE}/api/cars?startDate=${encodeURIComponent(startStr)}&endDate=${encodeURIComponent(endStr)}`;
    ctx.info(`기준일 ${refDate} (${this.nights}박) 조회`);

    const res = await ctx.get(url, {
      etag: ctx.etag,
      lastModified: ctx.lastModified,
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });

    if (res.notModified) return { deals: [], unchanged: true };
    if (!res.ok || !res.body) throw new Error(`API 응답 이상: HTTP ${res.status}`);

    let payload;
    try {
      payload = JSON.parse(res.body);
    } catch (err) {
      throw new Error(`JSON 파싱 실패: ${err.message}`);
    }

    const items = payload?.data?.items;
    if (!Array.isArray(items)) {
      ctx.warn('data.items 가 배열이 아닙니다 — API 응답 구조가 바뀌었을 수 있습니다');
      return { deals: [], etag: res.etag, lastModified: res.lastModified };
    }
    if (items.length === 0) {
      ctx.warn(`기준일 ${refDate} 에 조회된 차량이 0건입니다`);
      return { deals: [], etag: res.etag, lastModified: res.lastModified };
    }

    const deals = [];
    let noPrice = 0;
    let noId = 0;

    for (const item of items) {
      const offers = Array.isArray(item.offers) ? item.offers : [];
      for (const offer of offers) {
        // productDetailId 는 업체×차량 조합의 고유 키다. 중복 제거 기준으로 쓴다.
        const id = offer.productDetailId;
        if (!id) {
          noId++;
          continue;
        }

        const sale = offer.pricing?.salePrice;
        const original = offer.pricing?.originalPrice;
        if (!Number.isFinite(sale) || sale <= 0) {
          noPrice++;
          continue;
        }

        // originalPrice 는 업체가 신고한 1일 요금이다.
        // 판매가가 그보다 **높은** 경우가 전체의 35% 나 된다 (성수기 할증).
        // 예: 같은 K5 가 조아렌트카 17,700원(신고가 180,000 대비 -90%),
        //     SEEU렌트카 207,400원(신고가 200,000 대비 +3.7%).
        // 할증을 정가로 세워 두면 "할인"으로 오인되므로, 실제로 싼 경우에만
        // 정가로 인정하고 나머지는 정가 없음으로 둔다. 대신 할증 사실은 notes 에 남긴다.
        const hasRealDiscount = Number.isFinite(original) && original > sale;
        const surcharge =
          Number.isFinite(original) && original > 0 && sale > original
            ? Math.round(((sale - original) / original) * 1000) / 10
            : null;

        const opts = presentOptions(offer.options);
        const insuranceRaw = offer.insurance && offer.insurance !== 'none' ? String(offer.insurance) : null;

        deals.push({
          external_id: id,
          vendor_name: offer.companyName || offer.companyId || '업체 미상',
          car_model: item.name || '',
          // 'RV∙SUV', '소형∙준중형', '외제' 같은 묶음 표기가 온다. normalize 가 처리한다.
          car_class: item.type || null,
          fuel: item.fuelType || null,
          seats: Number.isFinite(item.capacity) ? item.capacity : null,
          list_price: hasRealDiscount ? original : null,
          sale_price: sale,
          insurance: insuranceRaw,
          insurance_included: Boolean(insuranceRaw),
          min_age: Number.isFinite(offer.eligibility?.minimumAge) ? offer.eligibility.minimumAge : null,
          min_license_years: Number.isFinite(offer.eligibility?.minimumCareer)
            ? offer.eligibility.minimumCareer
            : null,
          stock: Number.isFinite(offer.availableQuantity) ? offer.availableQuantity : null,
          pickup_location: '제주공항 셔틀',
          image_url: item.imageUrl || null,
          detail_url: `${BASE}/cars`,
          // 가격이 어느 날짜 기준인지 반드시 남긴다. 성수기/비수기 차이가 10배까지 난다.
          notes: [
            `${refDate} 기준 ${this.nights}일 요금`,
            // 신고 요금을 넘는 할증은 소비자가 알아야 할 정보다. 숨기지 않는다.
            surcharge !== null ? `업체 신고 요금(${original.toLocaleString()}원) 대비 +${surcharge}%` : null,
            offer.modelYear ? `${offer.modelYear}년식` : null,
            opts.length ? opts.slice(0, 6).join(' · ') : null,
          ]
            .filter(Boolean)
            .join(' / '),
          valid_from: refDate,
          valid_to: null,
        });
      }
    }

    if (noPrice) ctx.warn(`가격이 없어 건너뛴 상품 ${noPrice}건`);
    if (noId) ctx.warn(`productDetailId 가 없어 건너뛴 상품 ${noId}건`);
    ctx.info(`차종 ${items.length}개 → 상품 ${deals.length}건 추출`);

    return { deals, etag: res.etag, lastModified: res.lastModified };
  },
};

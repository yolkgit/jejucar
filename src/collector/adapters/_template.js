'use strict';
/**
 * 어댑터 템플릿 — 이 파일은 '_' 로 시작하므로 레지스트리가 건너뛴다.
 * 새 소스를 추가할 때 이 파일을 복사해 이름을 바꿔라 (예: dolharupang.js).
 *
 * ── 어댑터가 지켜야 할 것 ────────────────────────────────────
 * 1. collect(ctx) 안에서 직접 fetch 하지 말고 반드시 ctx.get(url) 을 써라.
 *    ctx.get 이 robots.txt 판정 · 호스트별 rate limit · ETag 조건부 요청 ·
 *    재시도를 전부 처리한다. 직접 fetch 하면 이 보호막을 우회한다.
 * 2. 반환하는 딜은 "원문 그대로" 넘겨라. 등급 분류·가격 파싱은 하지 마라.
 *    src/lib/normalize.js 가 일괄 처리한다. 그래야 규칙이 한 곳에 모인다.
 * 3. external_id 는 그 소스 안에서 안정적으로 고유해야 한다.
 *    (source_id, external_id) 가 중복 제거 키이므로, 매번 바뀌는 값
 *    (예: 타임스탬프, 배열 인덱스)을 쓰면 같은 딜이 계속 새로 쌓인다.
 * 4. 파싱에 실패한 항목은 조용히 버리지 말고 ctx.warn() 으로 남겨라.
 */

const cheerio = require('cheerio');

module.exports = {
  // DB sources.key 와 1:1 대응. 바꾸면 기존 딜과의 연결이 끊긴다.
  key: 'example',
  name: '예시 소스',
  // 'crawler' HTML 크롤링 | 'api' 공개 API | 'manual' 수동 등록(수집 없음)
  kind: 'crawler',
  baseUrl: 'https://example.com',
  // 기본 비활성. robots.txt 와 약관을 직접 확인한 뒤에만 켜라.
  enabled: false,
  note: '템플릿. 실제 사용 전 robots.txt 와 이용약관을 확인할 것.',

  /**
   * @param {object} ctx
   * @param {(url:string, opts?:object)=>Promise<{ok:boolean,status:number,body:string|null,notModified:boolean}>} ctx.get
   * @param {(msg:string)=>void} ctx.warn
   * @param {(msg:string)=>void} ctx.info
   * @param {string|null} ctx.etag         이전 실행에서 받은 ETag
   * @param {string|null} ctx.lastModified
   * @returns {Promise<{deals:Array<object>, etag?:string|null, lastModified?:string|null, unchanged?:boolean}>}
   */
  async collect(ctx) {
    const listUrl = `${this.baseUrl}/deals`;

    const res = await ctx.get(listUrl, {
      etag: ctx.etag,
      lastModified: ctx.lastModified,
    });

    // 304 = 지난번과 동일. 파싱할 필요가 없다.
    if (res.notModified) return { deals: [], unchanged: true };
    if (!res.ok || !res.body) {
      throw new Error(`목록 페이지 응답 이상: HTTP ${res.status}`);
    }

    const $ = cheerio.load(res.body);
    const deals = [];

    $('.deal-card').each((i, el) => {
      const $el = $(el);

      // 소스가 안정적인 ID 를 노출하면 그것을 쓴다.
      const externalId = $el.attr('data-deal-id') || $el.find('a').attr('href');
      if (!externalId) {
        ctx.warn(`external_id 를 찾을 수 없는 카드 (${i}번째) — 건너뜀`);
        return;
      }

      deals.push({
        external_id: externalId,
        vendor_name: $el.find('.vendor').text(),
        car_model: $el.find('.model').text(),
        // 가격은 문자열 원문으로 넘긴다. "89,000원" 같은 형태여도 된다.
        list_price: $el.find('.price-original').text(),
        sale_price: $el.find('.price-sale').text(),
        title: $el.find('.badge').text(),
        insurance: $el.find('.insurance').text(),
        pickup_location: $el.find('.pickup').text(),
        detail_url: new URL($el.find('a').attr('href'), this.baseUrl).href,
        notes: $el.find('.note').text(),
      });
    });

    if (deals.length === 0) {
      // 0건은 "특가가 없다" 일 수도, "선택자가 깨졌다" 일 수도 있다.
      // 구분이 안 되므로 경고를 남겨 사람이 확인하게 한다.
      ctx.warn('파싱 결과 0건 — 사이트 구조가 바뀌었을 수 있음');
    }

    return { deals, etag: res.etag, lastModified: res.lastModified };
  },
};

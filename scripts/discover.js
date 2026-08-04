'use strict';
/**
 * 한 사이트가 수집 가능한지 한 번에 진단한다. (개발용)
 *
 *   node scripts/discover.js https://example.com/
 *   node scripts/discover.js --all
 *
 * 진단 항목:
 *   1. robots.txt 판정
 *   2. 정적 HTML 에 가격이 있는가 (SSR 이면 바로 파싱 가능)
 *   3. 같은 호스트 JS 번들에서 /api/ 경로 수집 (CSR 이면 내부 API 후보)
 *   4. 프레임워크 추정 (Next.js 등)
 */

const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');
const { HostLimiter, mapLimit } = require('../src/lib/limiter');

const robots = new RobotsCache();
const limiter = new HostLimiter({ minIntervalMs: 1200 });

const CANDIDATES = [
  'https://carmore.kr/',
  'https://www.jejupass.com/',
  'https://rentcar.jejupass.com/',
  'https://jarrent.com/',
  'https://www.jejuonecar.net/',
  'https://www.jejurorentcar.com/',
  'https://jejuangeltour.com/',
  'https://www.jrcoop.co.kr/',
  'https://www.happyrent.co.kr/',
  'https://www.jejurentcar.co.kr/',
  'https://www.jejuokrent.co.kr/',
];

async function get(url, opts = {}) {
  const v = await robots.check(url);
  if (!v.allowed) return { blocked: true, reason: v.reason };
  try {
    const res = await limiter.run(url, () => politeFetch(url, { timeoutMs: 20000, retries: 1, ...opts }));
    return { ok: res.ok, status: res.status, body: res.body, contentType: res.contentType };
  } catch (err) {
    return { error: err.message };
  }
}

function priceHits(html) {
  const hits = [...html.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+)\s*원/g)].map((m) => m[1]);
  return [...new Set(hits)];
}

const CAR_WORDS = ['아반떼', '레이', '캐스퍼', '모닝', 'K5', '쏘나타', '카니발', '셀토스', '쏘렌토', '스타리아', '투싼', '그랜저'];

function extractApiPaths(code) {
  const out = new Set();
  for (const m of code.matchAll(/["'`](\/api\/[a-zA-Z0-9_\-./{}$]{2,110}?)["'`]/g)) out.add(m[1]);
  for (const m of code.matchAll(/`(\/api\/[^`]{2,110})`/g)) out.add(m[1]);
  // /api 가 아닌 ajax 엔드포인트도 흔하다
  for (const m of code.matchAll(/["'`](\/[a-zA-Z0-9_\-./]*(?:ajax|json|list|search)[a-zA-Z0-9_\-./]*\.(?:php|asp|jsp|do))["'`]/gi)) {
    out.add(m[1]);
  }
  return [...out];
}

async function diagnose(target) {
  const line = (s) => console.log(s);
  line(`\n${'═'.repeat(72)}`);
  line(`■ ${target}`);

  const v = await robots.check(target);
  line(`  robots : ${v.allowed ? '허용' : '금지'} — ${v.reason}${v.crawlDelayMs ? ` (Crawl-delay ${v.crawlDelayMs}ms)` : ''}`);
  if (!v.allowed) return { target, robots: 'blocked' };

  const home = await get(target);
  if (home.blocked) return { target, robots: 'blocked' };
  if (home.error || !home.body) {
    line(`  홈     : 실패 — ${home.error || `HTTP ${home.status}`}`);
    return { target, error: home.error || home.status };
  }
  line(`  홈     : HTTP ${home.status} · ${home.body.length} bytes`);

  const prices = priceHits(home.body);
  const cars = CAR_WORDS.filter((w) => home.body.includes(w));
  const ssr = prices.length >= 3 && cars.length >= 2;
  line(`  가격   : "n,nnn원" ${prices.length}종${prices.length ? ` (${prices.slice(0, 5).join(', ')})` : ''}`);
  line(`  차종명 : ${cars.length ? cars.slice(0, 6).join(', ') : '없음'}`);
  line(`  판정   : ${ssr ? '★ SSR — 정적 파싱 가능' : 'CSR 의심 — 내부 API 탐색 필요'}`);

  const fw = [];
  if (/_next\/static/.test(home.body)) fw.push('Next.js');
  if (/__NUXT__/.test(home.body)) fw.push('Nuxt');
  if (/ng-version/.test(home.body)) fw.push('Angular');
  if (fw.length) line(`  프레임 : ${fw.join(', ')}`);

  // JS 번들 스캔
  const base = new URL(target);
  const srcs = [
    ...new Set(
      [...home.body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
        .map((m) => {
          try {
            return new URL(m[1], base).href;
          } catch {
            return null;
          }
        })
        .filter((u) => u && new URL(u).host === base.host)
    ),
  ];
  line(`  번들   : 같은 호스트 ${srcs.length}개`);

  const apis = new Set();
  if (srcs.length) {
    const got = await mapLimit(srcs.slice(0, 25), 3, async (u) => (await get(u)).body);
    for (const r of got) {
      if (!r.ok || !r.value) continue;
      for (const p of extractApiPaths(r.value)) apis.add(p);
    }
  }
  // 인라인 스크립트도 본다
  for (const p of extractApiPaths(home.body)) apis.add(p);

  const interesting = [...apis].filter((p) =>
    /car|rent|price|product|search|list|item|goods|prod|reserv/i.test(p)
  );
  if (interesting.length) {
    line(`  ★ 관심 엔드포인트 ${interesting.length}개:`);
    interesting.slice(0, 20).forEach((p) => line(`      ${p}`));
  } else if (apis.size) {
    line(`  엔드포인트 ${apis.size}개 (관심 키워드 불일치)`);
    [...apis].slice(0, 8).forEach((p) => line(`      ${p}`));
  } else {
    line('  엔드포인트: 없음');
  }

  return { target, ssr, prices: prices.length, apis: interesting };
}

(async () => {
  const arg = process.argv[2];
  const targets = arg === '--all' || !arg ? CANDIDATES : [arg];

  const results = [];
  for (const t of targets) {
    try {
      results.push(await diagnose(t));
    } catch (err) {
      console.log(`\n■ ${t}\n  예외: ${err.message}`);
    }
  }

  console.log(`\n${'═'.repeat(72)}\n요약`);
  for (const r of results) {
    if (!r) continue;
    const tag = r.robots === 'blocked' ? 'robots 금지'
      : r.error ? `실패(${r.error})`
      : r.ssr ? 'SSR 파싱 가능'
      : r.apis?.length ? `내부 API 후보 ${r.apis.length}개`
      : '단서 없음';
    console.log(`  ${r.target.padEnd(38)} ${tag}`);
  }
})();

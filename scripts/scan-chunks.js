'use strict';
/**
 * 같은 호스트의 모든 JS 번들을 받아 /api/ 경로와 API base URL 을 모은다. (개발용)
 *
 *   node scripts/scan-chunks.js https://www.dolharupang.com/ car,rent,price,search
 *
 * 두 번째 인자는 관심 키워드(쉼표 구분). 주면 해당 경로를 따로 강조한다.
 */

const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');
const { HostLimiter } = require('../src/lib/limiter');
const { mapLimit } = require('../src/lib/limiter');

const robots = new RobotsCache();
const limiter = new HostLimiter({ minIntervalMs: 400 });

async function get(url) {
  const v = await robots.check(url);
  if (!v.allowed) return null;
  try {
    const res = await limiter.run(url, () => politeFetch(url, { timeoutMs: 25000, retries: 1 }));
    return res.ok ? res.body : null;
  } catch {
    return null;
  }
}

(async () => {
  const target = process.argv[2];
  const keywords = (process.argv[3] || 'car,rent,price,search,product,item,list')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const html = await get(target);
  if (!html) {
    console.log('HTML 실패');
    process.exit(1);
  }

  const base = new URL(target);
  const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map((m) => {
      try {
        return new URL(m[1], base).href;
      } catch {
        return null;
      }
    })
    .filter((u) => u && new URL(u).host === base.host);

  const uniq = [...new Set(srcs)];
  console.log(`같은 호스트 번들 ${uniq.length}개 수집 중...\n`);

  const apiPaths = new Set();
  const baseUrls = new Set();
  const swagger = new Set();

  const results = await mapLimit(uniq, 4, async (u) => ({ u, code: await get(u) }));

  let okCount = 0;
  for (const r of results) {
    if (!r.ok || !r.value.code) continue;
    okCount++;
    const code = r.value.code;

    for (const m of code.matchAll(/["'`](\/api\/[a-zA-Z0-9_\-./{}$]{2,120}?)["'`]/g)) {
      apiPaths.add(m[1]);
    }
    // 템플릿 리터럴로 조립되는 경로: `/api/cars/${id}` 형태
    for (const m of code.matchAll(/`(\/api\/[^`]{2,120})`/g)) apiPaths.add(m[1]);

    // API base URL 후보
    for (const m of code.matchAll(/["'`](https?:\/\/[a-zA-Z0-9_\-.]+(?::\d+)?(?:\/api)?)["'`]/g)) {
      const h = m[1];
      if (/localhost|127\.0\.0\.1|w3\.org|schema\.org|github|npmjs|nextjs\.org|google|facebook|kakao|naver\.com\/v/i.test(h)) continue;
      baseUrls.add(h);
    }
    for (const m of code.matchAll(/["'`]([^"'`]*(?:swagger|openapi|api-docs)[^"'`]*)["'`]/gi)) {
      swagger.add(m[1]);
    }
  }

  console.log(`번들 ${okCount}/${uniq.length} 수신\n`);

  const all = [...apiPaths].sort();
  const hot = all.filter((p) => keywords.some((k) => p.toLowerCase().includes(k)));
  const rest = all.filter((p) => !hot.includes(p));

  console.log(`═══ 관심 키워드 일치 경로 (${hot.length})`);
  hot.forEach((p) => console.log('  ★ ' + p));

  console.log(`\n═══ 기타 /api 경로 (${rest.length})`);
  rest.slice(0, 60).forEach((p) => console.log('    ' + p));

  if (baseUrls.size) {
    console.log(`\n═══ 호스트 후보 (${baseUrls.size})`);
    [...baseUrls].sort().slice(0, 25).forEach((u) => console.log('    ' + u));
  }
  if (swagger.size) {
    console.log('\n═══ API 문서 후보');
    [...swagger].slice(0, 10).forEach((u) => console.log('    ' + u));
  }
})();

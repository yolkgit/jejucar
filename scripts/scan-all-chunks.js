'use strict';
/**
 * Next.js 빌드 매니페스트에서 **모든** 청크를 뽑아 엔드포인트를 훑는다. (개발용)
 *
 *   node scripts/scan-all-chunks.js https://carmore.kr cB8cFXF86W-H89hCu4FWI
 *
 * urls-in-chunks.js 는 초기 HTML 의 <script src> 만 본다. Next.js 는 라우트별 청크를
 * 이동 시점에 동적으로 불러오므로, 그 방식으로는 다른 페이지의 코드를 놓친다.
 * 매니페스트에는 모든 라우트의 청크 목록이 들어 있다.
 */

const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');
const { HostLimiter, mapLimit } = require('../src/lib/limiter');

const robots = new RobotsCache();
const limiter = new HostLimiter({ minIntervalMs: 300 });

async function get(url) {
  const v = await robots.check(url);
  if (!v.allowed) return null;
  try {
    const res = await limiter.run(url, () => politeFetch(url, { timeoutMs: 30000, retries: 1 }));
    return res.ok ? res.body : null;
  } catch {
    return null;
  }
}

(async () => {
  const origin = (process.argv[2] || '').replace(/\/$/, '');
  const buildId = process.argv[3];
  if (!origin || !buildId) {
    console.log('사용법: node scripts/scan-all-chunks.js <origin> <buildId>');
    process.exit(1);
  }

  const manifest = await get(`${origin}/_next/static/${buildId}/_buildManifest.js`);
  if (!manifest) {
    console.log('빌드 매니페스트를 받지 못했습니다.');
    process.exit(1);
  }

  // 매니페스트는 난독화된 함수라 파싱 대신 "static/chunks/..." 문자열을 전부 긁는다.
  const chunkPaths = [
    ...new Set([...manifest.matchAll(/["']((?:static\/chunks|static\/css)\/[^"']+\.js)["']/g)].map((m) => m[1])),
  ];
  // 매니페스트 상단의 축약 변수(s,c,t...)에 담긴 공용 청크도 같은 패턴으로 잡힌다.
  console.log(`매니페스트에서 청크 ${chunkPaths.length}개 발견`);

  const urls = chunkPaths.map((p) => `${origin}/_next/${p}`);
  const found = new Map();
  let ok = 0;

  const results = await mapLimit(urls, 5, async (u) => ({ u, code: await get(u) }));

  for (const r of results) {
    if (!r.ok || !r.value.code) continue;
    ok++;
    const { u, code } = r.value;
    const name = u.split('/').pop();

    for (const m of code.matchAll(/url:\s*["'`](\/[^"'`]{1,120})["'`]/g)) {
      const p = m[1];
      if (!found.has(p)) found.set(p, new Set());
      found.get(p).add(name);
    }
    for (const m of code.matchAll(/url:\s*["'`](\/[^"'`]{0,80})["'`]\s*\.concat\(/g)) {
      const p = `${m[1]}{...}`;
      if (!found.has(p)) found.set(p, new Set());
      found.get(p).add(name);
    }
    for (const m of code.matchAll(/["'`](\/api\/[a-zA-Z0-9_\-./{}$]{2,110})["'`]/g)) {
      const p = m[1];
      if (!found.has(p)) found.set(p, new Set());
      found.get(p).add(name);
    }
  }

  console.log(`청크 ${ok}/${urls.length} 수신, 엔드포인트 ${found.size}개\n`);

  const filter = (process.argv[4] || '').toLowerCase();
  const entries = [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const shown = filter ? entries.filter(([p]) => p.toLowerCase().includes(filter)) : entries;

  for (const [p, bundles] of shown) {
    console.log(`  ${p}`);
    console.log(`      ← ${[...bundles].slice(0, 2).join(', ')}`);
  }
})();

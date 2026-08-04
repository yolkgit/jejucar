'use strict';
/**
 * 번들에서 `url:"..."` 형태의 엔드포인트를 전부 뽑는다. (개발용)
 *
 *   node scripts/urls-in-chunks.js https://carmore.kr/home/carlist.html
 *
 * scan-chunks.js 는 /api/ 접두사만 봐서 carmore 처럼 접두사 없는 경로를 놓친다.
 * 이쪽은 HTTP 클라이언트에 넘기는 url 속성을 직접 찾는다.
 */

const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');
const { HostLimiter, mapLimit } = require('../src/lib/limiter');

const robots = new RobotsCache();
const limiter = new HostLimiter({ minIntervalMs: 350 });

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
  const target = process.argv[2];
  const filter = (process.argv[3] || '').toLowerCase();

  const html = await get(target);
  if (!html) {
    console.log('HTML 실패');
    process.exit(1);
  }
  const base = new URL(target);

  const srcs = [
    ...new Set(
      [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
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
  console.log(`번들 ${srcs.length}개 수집...\n`);

  const found = new Map(); // path -> Set(bundle)
  const results = await mapLimit(srcs, 4, async (u) => ({ u, code: await get(u) }));

  for (const r of results) {
    if (!r.ok || !r.value.code) continue;
    const { u, code } = r.value;
    const name = u.split('/').pop();

    // url:"/path"  /  url:"/path".concat(  /  url:`/path${
    for (const m of code.matchAll(/url:\s*["'`](\/[^"'`]{1,120})["'`]/g)) {
      const p = m[1];
      if (!found.has(p)) found.set(p, new Set());
      found.get(p).add(name);
    }
    for (const m of code.matchAll(/url:\s*["'`](\/[^"'`]{0,80})["'`]\s*\.concat\(/g)) {
      const p = m[1] + '{...}';
      if (!found.has(p)) found.set(p, new Set());
      found.get(p).add(name);
    }
    // fetch("/path") 형태도
    for (const m of code.matchAll(/fetch\(\s*["'`](\/[^"'`]{1,120})["'`]/g)) {
      const p = m[1];
      if (!found.has(p)) found.set(p, new Set());
      found.get(p).add(name);
    }
  }

  const entries = [...found.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const shown = filter ? entries.filter(([p]) => p.toLowerCase().includes(filter)) : entries;

  console.log(`엔드포인트 ${entries.length}개${filter ? ` (필터 "${filter}" → ${shown.length}개)` : ''}\n`);
  for (const [p, bundles] of shown) {
    console.log(`  ${p}`);
    console.log(`      ← ${[...bundles].slice(0, 3).join(', ')}`);
  }
})();

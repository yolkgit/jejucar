'use strict';
/**
 * 같은 호스트 JS 번들에서 특정 문자열의 주변 맥락을 뽑는다. (개발용)
 *
 *   node scripts/grep-chunks.js https://www.dolharupang.com/ "/api/cars" 400
 */

const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');
const { HostLimiter, mapLimit } = require('../src/lib/limiter');

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
  const [target, needle, ctxLenRaw] = process.argv.slice(2);
  const ctxLen = Number(ctxLenRaw) || 320;
  if (!target || !needle) {
    console.log('사용법: node scripts/grep-chunks.js <url> <검색어> [맥락길이]');
    process.exit(1);
  }

  const html = await get(target);
  if (!html) process.exit(1);
  const base = new URL(target);

  const srcs = [...new Set(
    [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map((m) => {
        try { return new URL(m[1], base).href; } catch { return null; }
      })
      .filter((u) => u && new URL(u).host === base.host)
  )];

  const results = await mapLimit(srcs, 4, async (u) => ({ u, code: await get(u) }));

  let found = 0;
  for (const r of results) {
    if (!r.ok || !r.value.code) continue;
    const { u, code } = r.value;
    let from = 0;
    while (found < 12) {
      const i = code.indexOf(needle, from);
      if (i < 0) break;
      const s = Math.max(0, i - ctxLen);
      const e = Math.min(code.length, i + ctxLen);
      console.log(`\n─── ${u.split('/').pop()} @${i} ───`);
      console.log(code.slice(s, e));
      from = i + needle.length;
      found++;
    }
  }
  if (found === 0) console.log(`"${needle}" 를 찾지 못했습니다.`);
})();

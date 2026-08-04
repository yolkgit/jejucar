'use strict';
/**
 * CSR 사이트의 내부 API 엔드포인트를 찾는다. (개발용)
 *
 *   node scripts/find-api.js https://example.com/
 *
 * HTML 을 받아 <script src> 를 모으고, 각 번들에서 URL 처럼 보이는 문자열과
 * fetch/axios/ajax 호출부를 뽑아낸다. 브라우저를 띄우지 않고
 * "이 사이트가 어떤 엔드포인트를 부르는가"를 추정하기 위한 것이다.
 */

const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');
const { HostLimiter } = require('../src/lib/limiter');

const robots = new RobotsCache();
const limiter = new HostLimiter({ minIntervalMs: 1500 });

async function get(url) {
  const v = await robots.check(url);
  if (!v.allowed) {
    console.log(`  [robots 금지] ${url} — ${v.reason}`);
    return null;
  }
  try {
    const res = await limiter.run(url, () => politeFetch(url, { timeoutMs: 20000, retries: 1 }));
    return res.ok ? res.body : null;
  } catch (err) {
    console.log(`  [실패] ${url} — ${err.message}`);
    return null;
  }
}

/** 코드 문자열에서 API 로 보이는 경로를 뽑는다. */
function extractEndpoints(code) {
  const hits = new Set();

  // 따옴표로 감싼 경로 리터럴
  const strRe = /["'`](\/[a-zA-Z0-9_\-./]{3,120}?)["'`]/g;
  for (const m of code.matchAll(strRe)) {
    const p = m[1];
    if (/\.(png|jpe?g|gif|svg|webp|css|woff2?|ttf|ico|mp4)$/i.test(p)) continue;
    if (/^\/(images?|img|assets?|static|fonts?|css|js\/vendor)\//i.test(p)) continue;
    if (/api|ajax|json|list|search|car|rent|price|product|reserv|booking|item|goods|prod/i.test(p)) {
      hits.add(p);
    }
  }

  // 절대 URL
  const urlRe = /["'`](https?:\/\/[a-zA-Z0-9_\-./:]{6,140}?)["'`]/g;
  for (const m of code.matchAll(urlRe)) {
    if (/api|ajax|json/i.test(m[1])) hits.add(m[1]);
  }

  return [...hits];
}

/** fetch/axios/$.ajax 호출 주변 맥락 */
function extractCalls(code) {
  const out = [];
  const re = /(fetch\s*\(|axios\s*\.\s*(get|post)\s*\(|\$\.(ajax|get|post)\s*\(|XMLHttpRequest)/g;
  for (const m of code.matchAll(re)) {
    const s = Math.max(0, m.index - 60);
    const e = Math.min(code.length, m.index + 220);
    const snippet = code.slice(s, e).replace(/\s+/g, ' ').trim();
    if (/\/[a-z0-9_\-./]{3,}/i.test(snippet)) out.push(snippet);
    if (out.length >= 12) break;
  }
  return out;
}

(async () => {
  const target = process.argv[2];
  if (!target) {
    console.log('사용법: node scripts/find-api.js <url>');
    process.exit(1);
  }

  console.log(`═══ ${target}\n`);
  const html = await get(target);
  if (!html) {
    console.log('HTML 을 받지 못했습니다.');
    process.exit(1);
  }
  console.log(`HTML ${html.length} bytes`);

  // 인라인 스크립트에서 먼저 찾는다.
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .join('\n');
  console.log(`인라인 스크립트 ${inline.length} bytes`);

  const inlineEps = extractEndpoints(inline + html);
  if (inlineEps.length) {
    console.log('\n── HTML/인라인에서 발견한 경로 ──');
    inlineEps.slice(0, 40).forEach((e) => console.log('  ' + e));
  }

  const inlineCalls = extractCalls(inline);
  if (inlineCalls.length) {
    console.log('\n── 인라인 호출부 ──');
    inlineCalls.forEach((c) => console.log('  ' + c.slice(0, 200)));
  }

  // 외부 번들
  const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((s) => !/googletagmanager|google-analytics|gtag|facebook|kakao\.com\/v1|hotjar|clarity|wcs\.naver/i.test(s));

  console.log(`\n외부 스크립트 ${srcs.length}개`);

  const base = new URL(target);
  const allEps = new Set(inlineEps);

  for (const src of srcs.slice(0, 12)) {
    let abs;
    try {
      abs = new URL(src, base).href;
    } catch {
      continue;
    }
    // 같은 호스트 번들만 본다. 서드파티는 관심 없다.
    if (new URL(abs).host !== base.host) continue;

    const code = await get(abs);
    if (!code) continue;
    const eps = extractEndpoints(code);
    const calls = extractCalls(code);
    if (eps.length || calls.length) {
      console.log(`\n── ${abs} (${code.length} bytes) ──`);
      eps.slice(0, 25).forEach((e) => {
        console.log('  경로: ' + e);
        allEps.add(e);
      });
      calls.slice(0, 6).forEach((c) => console.log('  호출: ' + c.slice(0, 190)));
    }
  }

  console.log(`\n═══ 후보 경로 ${allEps.size}개`);
})();

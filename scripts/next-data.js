'use strict';
/**
 * Next.js 페이지의 __NEXT_DATA__ 를 꺼내 구조를 본다. (개발용)
 * SSR/SSG 페이지면 여기에 화면 데이터가 통째로 들어 있는 경우가 있다.
 *
 *   node scripts/next-data.js https://carmore.kr/home/carlist.html
 */

const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');

const robots = new RobotsCache();

function summarize(v, depth = 0, key = '', out = []) {
  const pad = '  '.repeat(depth);
  if (depth > 4) return out;
  if (Array.isArray(v)) {
    out.push(`${pad}${key}[] (${v.length})`);
    if (v.length && depth < 4) summarize(v[0], depth + 1, '', out);
    return out;
  }
  if (v && typeof v === 'object') {
    if (key) out.push(`${pad}${key}{}`);
    for (const [k, val] of Object.entries(v).slice(0, 30)) {
      if (val && typeof val === 'object') summarize(val, depth + 1, k, out);
      else {
        const s = typeof val === 'string' ? `"${val.slice(0, 60)}"` : String(val);
        out.push(`${pad}  ${k}: ${s}`);
      }
    }
    return out;
  }
  out.push(`${pad}${key}: ${v}`);
  return out;
}

(async () => {
  const url = process.argv[2];
  const v = await robots.check(url);
  console.log(`robots: ${v.allowed ? '허용' : '금지'}`);
  if (!v.allowed) process.exit(1);

  const res = await politeFetch(url, { timeoutMs: 25000, retries: 1 });
  console.log(`HTTP ${res.status} · ${res.body?.length ?? 0} bytes\n`);
  if (!res.body) process.exit(1);

  const m = res.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    console.log('__NEXT_DATA__ 없음');
    // application/json 스크립트라도 있는지
    const others = [...res.body.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]{0,400})/g)];
    console.log(`application/json 스크립트 ${others.length}개`);
    others.slice(0, 3).forEach((o, i) => console.log(`  [${i}] ${o[1].slice(0, 300)}`));
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (err) {
    console.log(`파싱 실패: ${err.message}`);
    console.log(m[1].slice(0, 500));
    process.exit(1);
  }

  console.log(`__NEXT_DATA__ ${m[1].length} bytes`);
  console.log(`buildId: ${data.buildId}`);
  console.log(`page: ${data.page}`);
  console.log(`\n── pageProps 구조 ──`);
  const lines = summarize(data.props?.pageProps ?? data.props, 0, '');
  lines.slice(0, 60).forEach((l) => console.log(l));

  // 가격처럼 보이는 숫자가 들어 있는지
  const raw = JSON.stringify(data);
  const priceKeys = [...new Set([...raw.matchAll(/"([a-zA-Z]*[Pp]rice[a-zA-Z]*)":/g)].map((x) => x[1]))];
  if (priceKeys.length) console.log(`\n가격 관련 키: ${priceKeys.join(', ')}`);

  // API base 후보
  const apiHints = [...new Set([...raw.matchAll(/"(https?:\/\/[^"]*(?:api|svc|service)[^"]*)"/gi)].map((x) => x[1]))];
  if (apiHints.length) {
    console.log('\nAPI 후보 URL:');
    apiHints.slice(0, 10).forEach((u) => console.log('  ' + u));
  }
})();

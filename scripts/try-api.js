'use strict';
/**
 * API 엔드포인트를 robots 준수 fetch 로 호출하고 응답 구조를 보여준다. (개발용)
 *
 *   node scripts/try-api.js "https://www.dolharupang.com/api/cars?startDate=2026-09-14&endDate=2026-09-15"
 */

const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');

const robots = new RobotsCache();

/** 중첩 객체의 키 구조를 요약한다. */
function shape(v, depth = 0, path = '') {
  const pad = '  '.repeat(depth);
  if (Array.isArray(v)) {
    console.log(`${pad}${path}[] (${v.length}개)`);
    if (v.length) shape(v[0], depth + 1, '');
    return;
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (val && typeof val === 'object') {
        if (depth < 3) shape(val, depth + 1, k);
        else console.log(`${pad}  ${k}: {…}`);
      } else {
        const s = typeof val === 'string' ? `"${val.slice(0, 48)}"` : String(val);
        console.log(`${pad}  ${k}: ${s}`);
      }
    }
    return;
  }
  console.log(`${pad}${path}: ${v}`);
}

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.log('사용법: node scripts/try-api.js <url>');
    process.exit(1);
  }

  const v = await robots.check(url);
  console.log(`robots: ${v.allowed ? '허용' : '금지'} — ${v.reason}`);
  if (!v.allowed) process.exit(1);

  const res = await politeFetch(url, {
    timeoutMs: 30000,
    retries: 1,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  console.log(`HTTP ${res.status} · ${res.contentType} · ${res.body ? res.body.length : 0} bytes\n`);
  if (!res.body) process.exit(1);

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    console.log('JSON 아님. 앞부분:');
    console.log(res.body.slice(0, 600));
    process.exit(1);
  }

  console.log('── 응답 구조 ──');
  shape(data);

  // 배열이 어디 있든 첫 원소를 통째로 보여준다.
  const findArray = (o, p = '') => {
    if (Array.isArray(o) && o.length) return { path: p, arr: o };
    if (o && typeof o === 'object') {
      for (const [k, val] of Object.entries(o)) {
        const r = findArray(val, p ? `${p}.${k}` : k);
        if (r) return r;
      }
    }
    return null;
  };
  const found = findArray(data);
  if (found) {
    console.log(`\n── ${found.path} 첫 항목 전문 ──`);
    console.log(JSON.stringify(found.arr[0], null, 2).slice(0, 2500));
    console.log(`\n(총 ${found.arr.length}건)`);
  }
})();

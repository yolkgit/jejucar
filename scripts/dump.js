'use strict';
/** 페이지를 받아 파일로 저장하고, 지정 문자열 주변 맥락을 보여준다. (개발용) */

const fs = require('fs');
const path = require('path');
const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');

const robots = new RobotsCache();

(async () => {
  const url = process.argv[2];
  const needles = process.argv.slice(3);
  if (!url) {
    console.log('사용법: node scripts/dump.js <url> [검색어...]');
    process.exit(1);
  }

  const verdict = await robots.check(url);
  console.log(`robots: ${verdict.allowed ? '허용' : '금지'} — ${verdict.reason}`);
  if (!verdict.allowed) process.exit(1);

  const res = await politeFetch(url, { timeoutMs: 20000, retries: 1 });
  console.log(`HTTP ${res.status} · ${res.body?.length ?? 0} bytes`);
  if (!res.body) process.exit(1);

  const outDir = path.join(__dirname, '..', 'data', 'probe');
  fs.mkdirSync(outDir, { recursive: true });
  const name = url.replace(/[^a-z0-9]+/gi, '_').slice(0, 80) + '.html';
  const file = path.join(outDir, name);
  fs.writeFileSync(file, res.body, 'utf8');
  console.log(`저장: ${file}`);

  for (const needle of needles) {
    console.log(`\n─── "${needle}" 주변 ───`);
    let from = 0;
    let n = 0;
    while (n < 3) {
      const i = res.body.indexOf(needle, from);
      if (i < 0) break;
      const s = Math.max(0, i - 320);
      const e = Math.min(res.body.length, i + 320);
      console.log(res.body.slice(s, e).replace(/\s+/g, ' ').trim());
      console.log('  ---');
      from = i + needle.length;
      n++;
    }
    if (n === 0) console.log('(없음)');
  }
})();

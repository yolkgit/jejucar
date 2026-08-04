'use strict';
/** 페이지의 내부 링크와 Next 라우트를 나열한다. (개발용) */

const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');

const robots = new RobotsCache();

(async () => {
  const url = process.argv[2];
  const v = await robots.check(url);
  console.log(`robots: ${v.allowed ? '허용' : '금지'}`);
  if (!v.allowed) process.exit(1);

  const res = await politeFetch(url, { timeoutMs: 25000, retries: 1 });
  console.log(`HTTP ${res.status} · ${res.body?.length ?? 0} bytes\n`);
  if (!res.body) process.exit(1);

  const hrefs = [
    ...new Set(
      [...res.body.matchAll(/href=["']([^"']+)["']/g)]
        .map((m) => m[1])
        .filter((h) => h.startsWith('/') && !h.startsWith('//') && !/\.(css|js|png|jpg|svg|ico|webp)$/i.test(h))
    ),
  ];
  console.log(`내부 링크 ${hrefs.length}개:`);
  hrefs.slice(0, 40).forEach((h) => console.log('  ' + h));

  const m = res.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const d = JSON.parse(m[1]);
      console.log(`\nNext page: ${d.page}  buildId: ${d.buildId}`);
    } catch {}
  }

  // Next.js 라우트 매니페스트에서 페이지 목록을 얻을 수 있다.
  const routes = [
    ...new Set([...res.body.matchAll(/\/_next\/static\/chunks\/pages([^"']*?)\.js/g)].map((x) => x[1])),
  ];
  if (routes.length) {
    console.log('\n페이지 청크:');
    routes.slice(0, 30).forEach((r) => console.log('  ' + r));
  }
})();

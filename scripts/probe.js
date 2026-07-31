'use strict';
/**
 * 소스 탐색 도구 (개발용).
 *
 *   node scripts/probe.js https://example.com/path
 *
 * 앱의 실제 수집 경로(robots 판정 → politeFetch)를 그대로 써서 페이지를 받고,
 * 가격처럼 보이는 문자열이 HTML 안에 있는지 보여준다.
 * 어댑터 선택자를 추측으로 쓰지 않기 위한 것이다.
 */

const cheerio = require('cheerio');
const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');
const { HostLimiter } = require('../src/lib/limiter');

const robots = new RobotsCache();
const limiter = new HostLimiter({ minIntervalMs: 2000 });

async function probe(url) {
  console.log(`\n═══ ${url}`);

  const verdict = await robots.check(url);
  console.log(`robots: ${verdict.allowed ? '허용' : '금지'} — ${verdict.reason}`);
  if (verdict.crawlDelayMs) console.log(`Crawl-delay: ${verdict.crawlDelayMs}ms`);
  if (!verdict.allowed) return null;

  const res = await limiter.run(url, () => politeFetch(url, { timeoutMs: 20000, retries: 1 }));
  console.log(`HTTP ${res.status} · ${res.contentType || '?'} · ${res.body ? res.body.length : 0} bytes`);
  if (!res.ok || !res.body) return null;

  const html = res.body;

  // 원화 금액처럼 보이는 문자열
  const priceHits = [...html.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+)\s*원/g)].map((m) => m[1]);
  const uniq = [...new Set(priceHits)];
  console.log(`\n"n,nnn원" 패턴: ${priceHits.length}개 (고유 ${uniq.length}개)`);
  if (uniq.length) console.log(`  예: ${uniq.slice(0, 12).join(', ')}`);

  // 차종명이 HTML 에 있는지
  const models = ['아반떼', '레이', '캐스퍼', '모닝', 'K5', '쏘나타', '카니발', '셀토스', '쏘렌토', '스타리아', '아이오닉', 'EV6'];
  const found = models.filter((m) => html.includes(m));
  console.log(`차종명: ${found.length ? found.join(', ') : '없음'}`);

  // JS 안에 박힌 JSON 데이터(__NUXT__, __NEXT_DATA__ 등)
  const jsonBlobs = ['__NEXT_DATA__', '__NUXT__', 'window.__INITIAL_STATE__', 'application/json'];
  const blobs = jsonBlobs.filter((k) => html.includes(k));
  if (blobs.length) console.log(`내장 JSON 후보: ${blobs.join(', ')}`);

  const $ = cheerio.load(html);

  // 가격 텍스트를 담은 가장 안쪽 요소의 선택자 경로를 뽑는다.
  if (uniq.length) {
    console.log('\n가격을 담은 요소들:');
    const seen = new Set();
    $('*').each((_, el) => {
      const $el = $(el);
      if ($el.children().length > 0) return; // 잎 노드만
      const t = $el.text().trim();
      if (!/[0-9]{1,3}(,[0-9]{3})+\s*원/.test(t)) return;
      const path = [];
      let cur = el;
      for (let i = 0; i < 4 && cur && cur.tagName; i++) {
        const c = ($(cur).attr('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        path.unshift(cur.tagName + (c ? `.${c}` : ''));
        cur = cur.parent;
      }
      const key = path.join(' > ');
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size <= 10) console.log(`  ${key}\n    → "${t.slice(0, 60)}"`);
    });
  }

  return { html, $ };
}

(async () => {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.log('사용법: node scripts/probe.js <url> [url...]');
    process.exit(1);
  }
  for (const t of targets) {
    try {
      await probe(t);
    } catch (err) {
      console.log(`실패: ${err.message}`);
    }
  }
})();

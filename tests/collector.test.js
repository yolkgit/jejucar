'use strict';
/**
 * 수집 오케스트레이터 통합 테스트.
 * 실제 로컬 HTTP 서버를 띄워 robots.txt 판정·조건부 요청·만료 정책을 검증한다.
 * 네트워크를 모킹하지 않는 이유: robots 판정과 politeFetch 의 상호작용이
 * 바로 이 층의 핵심이므로, 모킹하면 정작 검증하려는 부분이 빠진다.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeju-collect-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.COLLECT_INTERVAL_MIN = '0';

const { db, ensureSource } = require('../src/db');
const { collectSource } = require('../src/collector');

const silentLog = { info() {}, warn() {}, error() {} };

/** 요청 경로별 응답을 지정해 서버를 띄운다. 포트는 OS 가 배정한다. */
async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

function dealCard({ id, vendor, model, list, sale }) {
  return `<div class="deal-card" data-deal-id="${id}">
    <span class="vendor">${vendor}</span>
    <span class="model">${model}</span>
    <span class="price-original">${list}</span>
    <span class="price-sale">${sale}</span>
  </div>`;
}

/** 템플릿과 같은 구조를 파싱하는 최소 어댑터를 만든다. */
function makeAdapter(origin, key) {
  const cheerio = require('cheerio');
  return {
    key,
    name: `테스트 ${key}`,
    kind: 'crawler',
    baseUrl: origin,
    enabled: true,
    async collect(ctx) {
      const res = await ctx.get(`${origin}/deals`, {
        etag: ctx.etag,
        lastModified: ctx.lastModified,
      });
      if (res.notModified) return { deals: [], unchanged: true };
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const $ = cheerio.load(res.body);
      const deals = [];
      $('.deal-card').each((i, el) => {
        const $el = $(el);
        deals.push({
          external_id: $el.attr('data-deal-id'),
          vendor_name: $el.find('.vendor').text(),
          car_model: $el.find('.model').text(),
          list_price: $el.find('.price-original').text(),
          sale_price: $el.find('.price-sale').text(),
        });
      });
      if (deals.length === 0) ctx.warn('파싱 0건');
      return { deals, etag: res.etag, lastModified: res.lastModified };
    },
  };
}

function sourceRowFor(key, origin) {
  return ensureSource({ key, name: `테스트 ${key}`, kind: 'crawler', base_url: origin, enabled: 1 });
}

const ROBOTS_ALLOW = 'User-agent: *\nAllow: /\n';

test('robots.txt 가 허용하면 딜을 수집·정규화·저장한다', async () => {
  const srv = await startServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(200, { 'Content-Type': 'text/plain' }).end(ROBOTS_ALLOW);
    if (req.url === '/deals') {
      return res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        `<html><body>
          ${dealCard({ id: 'a1', vendor: '제주드림렌터카', model: '아반떼 CN7', list: '89,000원', sale: '39,000원' })}
          ${dealCard({ id: 'a2', vendor: '제주OK렌터카', model: '레이', list: '45,000원', sale: '19,000원' })}
        </body></html>`
      );
    }
    res.writeHead(404).end();
  });

  const key = 'allow-ok';
  const row = sourceRowFor(key, srv.origin);
  const r = await collectSource(makeAdapter(srv.origin, key), row, silentLog);

  assert.equal(r.status, 'ok', r.message);
  assert.equal(r.fetched, 2);
  assert.equal(r.inserted, 2);
  assert.equal(r.rejected, 0);

  const rows = db
    .prepare('SELECT external_id, vendor_name, car_class, list_price, sale_price, discount_pct FROM deals WHERE source_id = ? ORDER BY external_id')
    .all(row.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].car_class, '준중형');
  assert.equal(rows[0].sale_price, 39000);
  assert.equal(rows[0].discount_pct, 56);
  assert.equal(rows[1].car_class, '경차');

  await srv.close();
});

test('robots.txt 가 금지하면 status=blocked, 아무것도 저장하지 않는다', async () => {
  const srv = await startServer((req, res) => {
    if (req.url === '/robots.txt') {
      return res.writeHead(200, { 'Content-Type': 'text/plain' }).end('User-agent: *\nDisallow: /deals\n');
    }
    if (req.url === '/deals') {
      return res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(dealCard({ id: 'z1', vendor: 'v', model: '레이', list: '40,000원', sale: '10,000원' }));
    }
    res.writeHead(404).end();
  });

  const key = 'blocked';
  const row = sourceRowFor(key, srv.origin);
  const r = await collectSource(makeAdapter(srv.origin, key), row, silentLog);

  assert.equal(r.status, 'blocked');
  assert.match(r.message, /robots\.txt/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM deals WHERE source_id = ?').get(row.id).c, 0);

  const src = db.prepare('SELECT robots_status FROM sources WHERE id = ?').get(row.id);
  assert.equal(src.robots_status, 'blocked');

  await srv.close();
});

test('robots.txt 조회가 5xx 로 실패하면 보수적으로 금지한다', async () => {
  const srv = await startServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(500).end('boom');
    if (req.url === '/deals') {
      return res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(dealCard({ id: 'y1', vendor: 'v', model: '레이', list: '40,000원', sale: '10,000원' }));
    }
    res.writeHead(404).end();
  });

  const key = 'robots-5xx';
  const row = sourceRowFor(key, srv.origin);
  const r = await collectSource(makeAdapter(srv.origin, key), row, silentLog);

  assert.equal(r.status, 'blocked', 'robots 를 못 읽었는데 수집을 진행했다');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM deals WHERE source_id = ?').get(row.id).c, 0);

  await srv.close();
});

test('robots.txt 가 404 면 규칙 없음 = 허용으로 본다', async () => {
  const srv = await startServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(404).end();
    if (req.url === '/deals') {
      return res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(dealCard({ id: 'n1', vendor: '제주해피렌트카', model: '카니발', list: '120,000원', sale: '80,000원' }));
    }
    res.writeHead(404).end();
  });

  const key = 'robots-404';
  const row = sourceRowFor(key, srv.origin);
  const r = await collectSource(makeAdapter(srv.origin, key), row, silentLog);

  assert.equal(r.status, 'ok', r.message);
  assert.equal(r.inserted, 1);
  assert.equal(
    db.prepare('SELECT car_class FROM deals WHERE source_id = ?').get(row.id).car_class,
    '승합'
  );

  await srv.close();
});

test('ETag 가 같으면 304 를 받아 status=unchanged 로 끝낸다', async () => {
  let dealsHits = 0;
  const ETAG = '"v1"';
  const srv = await startServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(200).end(ROBOTS_ALLOW);
    if (req.url === '/deals') {
      dealsHits++;
      if (req.headers['if-none-match'] === ETAG) return res.writeHead(304, { ETag: ETAG }).end();
      return res
        .writeHead(200, { ETag: ETAG, 'Content-Type': 'text/html' })
        .end(dealCard({ id: 'e1', vendor: '제주엔젤카', model: '쏘렌토', list: '150,000원', sale: '90,000원' }));
    }
    res.writeHead(404).end();
  });

  const key = 'etag';
  const first = sourceRowFor(key, srv.origin);
  const r1 = await collectSource(makeAdapter(srv.origin, key), first, silentLog);
  assert.equal(r1.status, 'ok', r1.message);
  assert.equal(r1.inserted, 1);

  // 두 번째 실행은 저장된 ETag 를 보내 304 를 받아야 한다.
  const second = db.prepare('SELECT * FROM sources WHERE key = ?').get(key);
  assert.equal(second.etag, ETAG, 'ETag 가 소스에 저장되지 않았다');
  const r2 = await collectSource(makeAdapter(srv.origin, key), second, silentLog);
  assert.equal(r2.status, 'unchanged');
  assert.equal(r2.inserted, 0);
  assert.equal(dealsHits, 2);

  await srv.close();
});

test('수집 0건일 때 기존 딜을 만료시키지 않는다 (선택자 파손 방어)', async () => {
  let serveEmpty = false;
  const srv = await startServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(200).end(ROBOTS_ALLOW);
    if (req.url === '/deals') {
      const body = serveEmpty
        ? '<html><body><!-- 구조 변경됨 --></body></html>'
        : `<html><body>${dealCard({ id: 'k1', vendor: '제주로렌트카', model: '셀토스', list: '90,000원', sale: '45,000원' })}</body></html>`;
      return res.writeHead(200, { 'Content-Type': 'text/html' }).end(body);
    }
    res.writeHead(404).end();
  });

  const key = 'empty-guard';
  const row = sourceRowFor(key, srv.origin);
  await collectSource(makeAdapter(srv.origin, key), row, silentLog);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM deals WHERE source_id = ? AND status = 'active'").get(row.id).c, 1);

  // 사이트 구조가 깨져 0건이 됐다고 해서 멀쩡한 딜을 전멸시키면 안 된다.
  serveEmpty = true;
  const fresh = db.prepare('SELECT * FROM sources WHERE key = ?').get(key);
  const r = await collectSource(makeAdapter(srv.origin, key), fresh, silentLog);

  assert.equal(r.fetched, 0);
  assert.equal(r.expired, 0, '0건 수집인데 기존 딜을 만료시켰다');
  assert.equal(
    db.prepare("SELECT COUNT(*) c FROM deals WHERE source_id = ? AND status = 'active'").get(row.id).c,
    1,
    '기존 활성 딜이 사라졌다'
  );
  assert.match(r.message, /보존/);

  await srv.close();
});

test('딜이 목록에서 빠지면 만료 처리한다 (정상 수집일 때만)', async () => {
  let dropSecond = false;
  const srv = await startServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(200).end(ROBOTS_ALLOW);
    if (req.url === '/deals') {
      const cards = [dealCard({ id: 'g1', vendor: '제주원렌터카', model: '아반떼', list: '80,000원', sale: '40,000원' })];
      if (!dropSecond) {
        cards.push(dealCard({ id: 'g2', vendor: '제주원렌터카', model: '모닝', list: '40,000원', sale: '18,000원' }));
      }
      return res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<html><body>${cards.join('')}</body></html>`);
    }
    res.writeHead(404).end();
  });

  const key = 'expire-unseen';
  const row = sourceRowFor(key, srv.origin);
  const r1 = await collectSource(makeAdapter(srv.origin, key), row, silentLog);
  assert.equal(r1.inserted, 2);

  // last_seen_at 비교가 초 단위이므로 확실히 시간차를 만든다.
  await new Promise((r) => setTimeout(r, 1100));

  dropSecond = true;
  const fresh = db.prepare('SELECT * FROM sources WHERE key = ?').get(key);
  const r2 = await collectSource(makeAdapter(srv.origin, key), fresh, silentLog);

  assert.equal(r2.fetched, 1);
  assert.equal(r2.expired, 1, '목록에서 빠진 딜이 만료되지 않았다');
  const g2 = db.prepare('SELECT status FROM deals WHERE source_id = ? AND external_id = ?').get(row.id, 'g2');
  assert.equal(g2.status, 'expired');
  const g1 = db.prepare('SELECT status FROM deals WHERE source_id = ? AND external_id = ?').get(row.id, 'g1');
  assert.equal(g1.status, 'active', '아직 있는 딜을 만료시켰다');

  await srv.close();
});

test('불량 딜은 버리고 정상 딜만 저장한다', async () => {
  const srv = await startServer((req, res) => {
    if (req.url === '/robots.txt') return res.writeHead(200).end(ROBOTS_ALLOW);
    if (req.url === '/deals') {
      return res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        `<html><body>
          ${dealCard({ id: 'ok1', vendor: '제주유레카', model: '아반떼', list: '80,000원', sale: '40,000원' })}
          ${dealCard({ id: 'bad1', vendor: '', model: '레이', list: '40,000원', sale: '20,000원' })}
          ${dealCard({ id: 'bad2', vendor: 'v', model: '외계차ZZZ', list: '40,000원', sale: '20,000원' })}
          ${dealCard({ id: 'bad3', vendor: 'v', model: '레이', list: '가격문의', sale: '가격문의' })}
          ${dealCard({ id: 'bad4', vendor: 'v', model: '레이', list: '10,000원', sale: '20,000원' })}
        </body></html>`
      );
    }
    res.writeHead(404).end();
  });

  const key = 'reject';
  const row = sourceRowFor(key, srv.origin);
  const r = await collectSource(makeAdapter(srv.origin, key), row, silentLog);

  assert.equal(r.status, 'ok', r.message);
  assert.equal(r.fetched, 5);
  assert.equal(r.inserted, 1, '정상 딜 1건만 들어가야 한다');
  assert.equal(r.rejected, 4);
  assert.match(r.message, /버림 4건/);

  const kept = db.prepare('SELECT external_id FROM deals WHERE source_id = ?').all(row.id);
  assert.deepEqual(kept.map((k) => k.external_id), ['ok1']);

  await srv.close();
});

test('수집 실패·거부가 crawl_logs 에 모두 남는다', () => {
  const logs = db.prepare('SELECT source_key, status FROM crawl_logs ORDER BY id').all();
  const byStatus = logs.reduce((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1;
    return acc;
  }, {});
  assert.ok(byStatus.ok >= 4, `ok 로그 부족: ${JSON.stringify(byStatus)}`);
  assert.ok(byStatus.blocked >= 2, `blocked 로그 부족: ${JSON.stringify(byStatus)}`);
  assert.ok(byStatus.unchanged >= 1, `unchanged 로그 부족: ${JSON.stringify(byStatus)}`);
  // running 이 남아 있으면 finishLog 가 호출되지 않은 경로가 있다는 뜻이다.
  assert.equal(byStatus.running, undefined, '완료 처리되지 않은 수집 로그가 있다');
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

'use strict';

const path = require('path');
const express = require('express');

const { PORT } = require('./src/config');
const { db, expireStaleDeals } = require('./src/db');
const { router: dealsRouter } = require('./src/routes/deals');
const { router: bookingsRouter } = require('./src/routes/bookings');
const { router: adminRouter } = require('./src/routes/admin');
const { startScheduler, loadAdapters } = require('./src/collector');
const { ensureSource } = require('./src/db');

const app = express();

// 리버스 프록시(nginx 등) 뒤에서 req.ip 가 실제 클라이언트를 가리키게 한다.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '256kb' }));

// 기본 보안 헤더. 외부 CDN 을 쓰지 않으므로 CSP 를 좁게 잡을 수 있다.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  next();
});

app.use('/api', dealsRouter);
app.use('/api', bookingsRouter);
app.use('/api', adminRouter);

app.get('/api/health', (req, res) => {
  const deals = db.prepare("SELECT COUNT(*) AS c FROM deals WHERE status = 'active'").get().c;
  res.json({ ok: true, activeDeals: deals, time: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// 정의되지 않은 API 경로는 HTML 을 돌려주지 말고 JSON 404 로 끝낸다.
app.use('/api', (req, res) => {
  res.status(404).json({ error: '없는 API 경로입니다.' });
});

// Express 5 는 async 핸들러의 rejection 도 여기로 보낸다.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[오류]', err);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? '서버 오류가 발생했습니다.' : err.message,
  });
});

// 어댑터를 DB 소스로 등록해 둔다. 수집을 한 번도 안 돌렸어도
// 관리자 화면에서 어떤 소스가 있는지 바로 보이게 하기 위해서다.
{
  const { adapters, problems } = loadAdapters();
  for (const a of adapters.values()) {
    ensureSource({
      key: a.key,
      name: a.name,
      kind: a.kind,
      base_url: a.baseUrl,
      enabled: a.enabled,
      note: a.note,
    });
  }
  for (const p of problems) console.warn(`[시작] 어댑터 문제: ${p}`);
  console.log(`[시작] 수집 어댑터 ${adapters.size}개 등록`);
}

// 시작 시 한 번 만료 정리를 돌린다. 컨테이너가 며칠 꺼져 있었을 수 있다.
const expired = expireStaleDeals();
if (expired) console.log(`[시작] 유효기간 지난 딜 ${expired}건 정리`);

const server = app.listen(PORT, () => {
  console.log(`제주 렌터카 특가 — http://localhost:${PORT}`);
});

startScheduler();

function shutdown(signal) {
  console.log(`\n${signal} 수신 — 종료합니다.`);
  server.close(() => {
    // WAL 체크포인트를 남기고 닫아야 -wal 파일에 데이터가 남지 않는다.
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (err) {
      console.error('DB 종료 중 오류:', err.message);
    }
    process.exit(0);
  });
  // 열린 연결이 남아 있어도 10초 뒤에는 강제 종료한다.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;

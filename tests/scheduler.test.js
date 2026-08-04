'use strict';
/**
 * 스케줄러 시작 동작 테스트.
 * 컨테이너를 새로 띄웠을 때 한 주기(기본 3시간)를 기다리지 않고 바로 채우는지,
 * 그러면서도 재시작을 반복할 때 상대 서버를 반복해 때리지 않는지 확인한다.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jeju-sched-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { db, ensureSource, now } = require('../src/db');

function setLastOk(key, minutesAgo) {
  const d = new Date(Date.now() - minutesAgo * 60000);
  const p = (n) => String(n).padStart(2, '0');
  const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  db.prepare('UPDATE sources SET last_ok_at = ?, enabled = 1 WHERE key = ?').run(s, key);
}

const silent = { info() {}, warn() {}, error() {} };

test('COLLECT_INTERVAL_MIN=0 이면 스케줄러를 걸지 않는다', () => {
  process.env.COLLECT_INTERVAL_MIN = '0';
  delete require.cache[require.resolve('../src/collector')];
  const { startScheduler } = require('../src/collector');
  assert.equal(startScheduler({ log: silent }), null);
});

test('한 번도 수집한 적 없으면 시작 직후에 수집한다', async () => {
  process.env.COLLECT_INTERVAL_MIN = '180';
  delete require.cache[require.resolve('../src/collector')];
  const collector = require('../src/collector');

  ensureSource({ key: 'jejussok', name: '제주속으로', kind: 'crawler', enabled: 1 });
  db.prepare("UPDATE sources SET last_ok_at = NULL WHERE key = 'jejussok'").run();

  const logs = [];
  const timer = collector.startScheduler({
    log: { info: (m) => logs.push(m), warn() {}, error() {} },
    startupDelayMs: 30,
  });

  await new Promise((r) => setTimeout(r, 260));
  clearInterval(timer);

  assert.ok(
    logs.some((l) => /시작 직후 보충/.test(l)),
    `시작 수집이 안 돌았다: ${logs.join(' | ')}`
  );
});

test('직전 수집이 한 주기 안이면 시작 시 수집을 건너뛴다', async () => {
  process.env.COLLECT_INTERVAL_MIN = '180';
  delete require.cache[require.resolve('../src/collector')];
  const collector = require('../src/collector');

  ensureSource({ key: 'jejussok', name: '제주속으로', kind: 'crawler', enabled: 1 });
  setLastOk('jejussok', 30); // 30분 전 성공

  const logs = [];
  const timer = collector.startScheduler({
    log: { info: (m) => logs.push(m), warn() {}, error() {} },
    startupDelayMs: 30,
  });

  await new Promise((r) => setTimeout(r, 200));
  clearInterval(timer);

  assert.ok(
    logs.some((l) => /건너뜀/.test(l)),
    `재시작마다 수집하면 상대 서버에 부담이다: ${logs.join(' | ')}`
  );
  assert.ok(!logs.some((l) => /시작 직후 보충/.test(l)));
});

test('직전 수집이 한 주기보다 오래됐으면 시작 시 수집한다', async () => {
  process.env.COLLECT_INTERVAL_MIN = '180';
  delete require.cache[require.resolve('../src/collector')];
  const collector = require('../src/collector');

  ensureSource({ key: 'jejussok', name: '제주속으로', kind: 'crawler', enabled: 1 });
  setLastOk('jejussok', 400); // 400분 전 = 한 주기(180분) 초과

  const logs = [];
  const timer = collector.startScheduler({
    log: { info: (m) => logs.push(m), warn() {}, error() {} },
    startupDelayMs: 30,
  });

  await new Promise((r) => setTimeout(r, 260));
  clearInterval(timer);

  assert.ok(
    logs.some((l) => /시작 직후 보충/.test(l)),
    `오래됐는데도 안 돌았다: ${logs.join(' | ')}`
  );
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

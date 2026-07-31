'use strict';
/**
 * 수집 소스 켜기/끄기 (CLI).
 *
 *   node scripts/source.js              현재 목록
 *   node scripts/source.js jejussok on  켜기
 *   node scripts/source.js jejussok off 끄기
 */

const { db } = require('../src/db');

const [key, action] = process.argv.slice(2);

if (!key) {
  const rows = db
    .prepare(
      `SELECT s.key, s.name, s.kind, s.enabled, s.robots_status, s.last_run_at,
              (SELECT COUNT(*) FROM deals d WHERE d.source_id = s.id AND d.status='active') AS deals
         FROM sources s ORDER BY s.kind, s.key`
    )
    .all();
  console.log('key          kind     상태   딜   robots     최근 실행');
  console.log('─'.repeat(72));
  for (const r of rows) {
    console.log(
      `${r.key.padEnd(12)} ${r.kind.padEnd(8)} ${(r.kind === 'manual' ? '수동' : r.enabled ? '켜짐' : '꺼짐').padEnd(5)} ${String(r.deals).padStart(3)}   ${(r.robots_status || '-').padEnd(9)} ${r.last_run_at || '-'}`
    );
  }
  process.exit(0);
}

const row = db.prepare('SELECT * FROM sources WHERE key = ?').get(key);
if (!row) {
  console.error(`소스 '${key}' 를 찾을 수 없습니다.`);
  process.exit(1);
}
if (row.kind === 'manual') {
  console.error(`'${key}' 는 수동 등록 소스라 수집 대상이 아닙니다.`);
  process.exit(1);
}

const enabled = action === 'on' ? 1 : action === 'off' ? 0 : null;
if (enabled === null) {
  console.error('두 번째 인자는 on 또는 off 여야 합니다.');
  process.exit(1);
}

db.prepare('UPDATE sources SET enabled = ? WHERE id = ?').run(enabled, row.id);
console.log(`${key}: ${enabled ? '켜짐' : '꺼짐'}`);

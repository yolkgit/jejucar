'use strict';
/**
 * 수집기 1회 실행 (CLI).
 *
 *   npm run collect              모든 활성 소스
 *   npm run collect -- dolharupang   특정 소스만
 */

const { collectAll } = require('./index');

const onlyKey = process.argv[2] || null;

collectAll({ onlyKey })
  .then(({ summary, expiredByDate, adapterProblems }) => {
    console.log('\n── 수집 결과 ──────────────────────────');
    if (summary.length === 0) {
      console.log('실행된 소스가 없습니다. 활성화된 crawler/api 소스가 있는지 확인하세요.');
    }
    for (const s of summary) {
      const line =
        s.status === 'skipped'
          ? `${s.key.padEnd(16)} 건너뜀 (${s.message})`
          : `${s.key.padEnd(16)} ${String(s.status).padEnd(10)} 수집 ${s.fetched ?? 0} / 신규 ${s.inserted ?? 0} / 갱신 ${s.updated ?? 0} / 만료 ${s.expired ?? 0} / 버림 ${s.rejected ?? 0}`;
      console.log(line);
      if (s.message && s.status !== 'skipped') console.log(`${' '.repeat(17)}└ ${s.message}`);
    }
    if (expiredByDate) console.log(`\n유효기간 만료: ${expiredByDate}건`);
    if (adapterProblems.length) {
      console.log('\n어댑터 문제:');
      for (const p of adapterProblems) console.log(`  - ${p}`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('수집 실패:', err);
    process.exit(1);
  });

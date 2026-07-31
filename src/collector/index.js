'use strict';
/**
 * 수집 오케스트레이터.
 *
 * 소스 하나당 흐름:
 *   robots.txt 판정 → 조건부 요청 → 어댑터 파싱 → 정규화 → upsert → 로그
 *
 * 설계 원칙:
 * - 어댑터는 네트워크를 직접 만지지 않는다. ctx.get 만 쓴다.
 * - 한 소스의 실패가 다른 소스를 막지 않는다.
 * - 실패·거부·0건을 전부 crawl_logs 에 남긴다. 조용한 실패가 최악이다.
 */

const { db, upsertDeal, ensureVendor, ensureSource, now, expireStaleDeals } = require('../db');
const { politeFetch } = require('../lib/http');
const { RobotsCache } = require('../lib/robots');
const { HostLimiter } = require('../lib/limiter');
const { normalizeDeal } = require('../lib/normalize');
const { loadAdapters } = require('./registry');

const robots = new RobotsCache();
const limiter = new HostLimiter({ minIntervalMs: 2000 });

const startLog = db.prepare(`
  INSERT INTO crawl_logs (source_id, source_key, started_at, status)
  VALUES (?, ?, ?, 'running')
`);
const finishLog = db.prepare(`
  UPDATE crawl_logs
     SET finished_at = ?, status = ?, fetched = ?, inserted = ?, updated = ?, expired = ?, message = ?
   WHERE id = ?
`);
const touchSource = db.prepare(`
  UPDATE sources
     SET last_run_at = ?, last_ok_at = COALESCE(?, last_ok_at), last_error = ?,
         etag = ?, last_modified = ?,
         robots_status = ?, robots_reason = ?, robots_checked_at = ?
   WHERE id = ?
`);

/** 이번 실행에서 다시 보이지 않은 딜을 만료 처리한다. */
const expireUnseen = db.prepare(`
  UPDATE deals SET status = 'expired'
   WHERE source_id = ? AND status = 'active' AND last_seen_at < ?
`);

/**
 * 어댑터에게 넘기는 실행 컨텍스트.
 * ctx.get 이 robots 판정과 rate limit 을 강제한다.
 */
function makeContext(adapter, sourceRow, log) {
  const warnings = [];
  let robotsVerdict = null;

  return {
    ctx: {
      etag: sourceRow.etag || null,
      lastModified: sourceRow.last_modified || null,
      baseUrl: adapter.baseUrl,

      async get(url, opts = {}) {
        // api 종류도 robots 를 확인한다. 공개 API 라도 경로가 막혀 있을 수 있다.
        const verdict = await robots.check(url);
        if (!robotsVerdict) robotsVerdict = verdict;
        if (!verdict.allowed) {
          const err = new Error(`robots.txt 가 허용하지 않음: ${url} (${verdict.reason})`);
          err.code = 'ROBOTS_BLOCKED';
          throw err;
        }
        // 사이트가 Crawl-delay 를 명시하면 그 간격을 따른다.
        if (verdict.crawlDelayMs) {
          limiter.setInterval(new URL(url).host, verdict.crawlDelayMs);
        }
        return limiter.run(url, () =>
          politeFetch(url, {
            ...opts,
            onRetry: (ms, attempt, reason) =>
              log.info(`재시도 ${attempt}회 (${Math.round(ms / 1000)}초 후): ${reason}`),
          })
        );
      },

      warn(msg) {
        warnings.push(msg);
        log.warn(`[${adapter.key}] ${msg}`);
      },
      info(msg) {
        log.info(`[${adapter.key}] ${msg}`);
      },
    },
    warnings,
    getRobotsVerdict: () => robotsVerdict,
  };
}

const consoleLog = {
  info: (m) => console.log(`[수집] ${m}`),
  warn: (m) => console.warn(`[수집] ⚠ ${m}`),
  error: (m) => console.error(`[수집] ✖ ${m}`),
};

/**
 * 소스 하나를 수집한다.
 * @returns {Promise<{status:string, fetched:number, inserted:number, updated:number, expired:number, rejected:number, message:string}>}
 */
async function collectSource(adapter, sourceRow, log = consoleLog) {
  const runStartedAt = now();
  const logId = Number(startLog.run(sourceRow.id, adapter.key, runStartedAt).lastInsertRowid);

  const result = {
    status: 'error',
    fetched: 0,
    inserted: 0,
    updated: 0,
    expired: 0,
    rejected: 0,
    message: '',
  };

  const { ctx, warnings, getRobotsVerdict } = makeContext(adapter, sourceRow, log);
  let etag = sourceRow.etag || null;
  let lastModified = sourceRow.last_modified || null;

  try {
    const out = await adapter.collect(ctx);
    const rawDeals = Array.isArray(out?.deals) ? out.deals : [];
    if (out?.etag !== undefined) etag = out.etag;
    if (out?.lastModified !== undefined) lastModified = out.lastModified;

    if (out?.unchanged) {
      result.status = 'unchanged';
      result.message = '변경 없음 (HTTP 304)';
    } else {
      result.fetched = rawDeals.length;

      // 정규화는 DB 쓰기 전에 전부 끝낸다. 트랜잭션을 짧게 유지한다.
      const accepted = [];
      const rejectReasons = [];
      for (const raw of rawDeals) {
        const norm = normalizeDeal(raw, { sourceId: sourceRow.id });
        if (norm.ok) accepted.push(norm.deal);
        else rejectReasons.push(norm.reason);
      }
      result.rejected = rejectReasons.length;

      // 쓰기는 한 트랜잭션으로. 중간에 터지면 전부 롤백된다.
      const write = db.transaction((deals) => {
        let ins = 0;
        let upd = 0;
        for (const d of deals) {
          d.vendor_id = ensureVendor(d.vendor_name);
          if (upsertDeal(d) === 'inserted') ins++;
          else upd++;
        }
        return { ins, upd };
      });
      const { ins, upd } = write(accepted);
      result.inserted = ins;
      result.updated = upd;

      // 이번 실행에서 안 보인 딜은 내린다.
      // 단, 0건 수집일 때는 하지 않는다 — 선택자가 깨진 것과
      // 정말 특가가 사라진 것을 구분할 수 없어서, 멀쩡한 딜을 전멸시킬 수 있다.
      if (accepted.length > 0) {
        result.expired = expireUnseen.run(sourceRow.id, runStartedAt).changes;
      } else if (rawDeals.length === 0) {
        warnings.push('수집 0건 — 기존 딜을 만료시키지 않고 보존했다');
      }

      const parts = [];
      if (rejectReasons.length) {
        // 같은 이유가 반복되므로 요약해서 남긴다.
        const counts = new Map();
        for (const r of rejectReasons) {
          const key = r.split(':')[0];
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        parts.push(
          `버림 ${rejectReasons.length}건 (${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')})`
        );
      }
      if (warnings.length) parts.push(`경고 ${warnings.length}건: ${warnings.slice(0, 3).join(' | ')}`);
      result.status = 'ok';
      result.message = parts.join(' / ') || '정상';
    }
  } catch (err) {
    result.status = err.code === 'ROBOTS_BLOCKED' ? 'blocked' : 'error';
    result.message = err.message;
    log.error(`[${adapter.key}] ${err.message}`);
  }

  const verdict = getRobotsVerdict();
  const okNow = result.status === 'ok' || result.status === 'unchanged' ? now() : null;

  finishLog.run(
    now(),
    result.status,
    result.fetched,
    result.inserted,
    result.updated,
    result.expired,
    result.message.slice(0, 2000),
    logId
  );

  touchSource.run(
    now(),
    okNow,
    result.status === 'ok' || result.status === 'unchanged' ? null : result.message.slice(0, 500),
    etag,
    lastModified,
    verdict ? (verdict.allowed ? 'allowed' : 'blocked') : adapter.kind === 'manual' ? 'n/a' : 'unknown',
    verdict ? verdict.reason : null,
    verdict ? now() : null,
    sourceRow.id
  );

  return result;
}

/**
 * 활성화된 모든 소스를 수집한다.
 * 소스별로 순차 실행한다 — 서로 다른 호스트라도 한꺼번에 때리지 않는다.
 */
async function collectAll({ log = consoleLog, onlyKey = null } = {}) {
  const { adapters, problems } = loadAdapters();
  for (const p of problems) log.warn(`어댑터 문제: ${p}`);

  // 어댑터 정의를 DB 에 반영한다 (없으면 생성).
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

  const rows = db.prepare('SELECT * FROM sources').all();
  const summary = [];

  for (const row of rows) {
    const adapter = adapters.get(row.key);
    if (!adapter) {
      log.warn(`소스 '${row.key}' 에 대응하는 어댑터가 없음 — 건너뜀`);
      continue;
    }
    if (onlyKey && row.key !== onlyKey) continue;
    if (adapter.kind === 'manual') continue; // 수동 등록 딜은 건드리지 않는다
    if (!row.enabled) {
      log.info(`소스 '${row.key}' 비활성 — 건너뜀`);
      summary.push({ key: row.key, status: 'skipped', message: '비활성' });
      continue;
    }

    log.info(`소스 '${row.key}' 수집 시작`);
    const r = await collectSource(adapter, row, log);
    log.info(
      `소스 '${row.key}' 완료: ${r.status} (수집 ${r.fetched}, 신규 ${r.inserted}, 갱신 ${r.updated}, 만료 ${r.expired}, 버림 ${r.rejected})`
    );
    summary.push({ key: row.key, ...r });
  }

  const expiredByDate = expireStaleDeals();
  if (expiredByDate) log.info(`유효기간 만료로 ${expiredByDate}건 내림`);

  return { summary, expiredByDate, adapterProblems: problems };
}

/** 주기 실행. COLLECT_INTERVAL_MIN=0 이면 끈다. */
function startScheduler({ log = consoleLog } = {}) {
  const minutes = Number(process.env.COLLECT_INTERVAL_MIN ?? 180);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    log.info('자동 수집 비활성 (COLLECT_INTERVAL_MIN=0)');
    return null;
  }

  let running = false;
  const tick = async () => {
    // 이전 실행이 아직 안 끝났으면 건너뛴다. 겹쳐 돌면 상대 서버를 두 배로 때린다.
    if (running) {
      log.warn('이전 수집이 진행 중 — 이번 주기 건너뜀');
      return;
    }
    running = true;
    try {
      await collectAll({ log });
    } catch (err) {
      log.error(`수집 주기 실패: ${err.message}`);
    } finally {
      running = false;
    }
  };

  log.info(`자동 수집 ${minutes}분 주기로 예약`);
  const timer = setInterval(tick, minutes * 60 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = { collectAll, collectSource, startScheduler, loadAdapters };

'use strict';
/**
 * robots.txt 조회 · 캐시 · 판정.
 *
 * 원칙: robots.txt 를 가져오지 못하면 "허용"으로 넘어가지 않는다.
 * - 404/410 → 규칙 없음 = 허용 (RFC 9309)
 * - 401/403 → 전면 금지로 해석 (RFC 9309)
 * - 5xx/네트워크 오류 → 금지로 해석 (보수적. 상대 서버가 아플 때 더 긁지 않는다)
 */

const robotsParser = require('robots-parser');
const { politeFetch, userAgent } = require('./http');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간

class RobotsCache {
  constructor({ ttlMs = CACHE_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    /** @type {Map<string, {at:number, robots:any|null, reason:string, allowAll:boolean, denyAll:boolean}>} */
    this.cache = new Map();
  }

  async #load(origin) {
    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached;

    const robotsUrl = `${origin}/robots.txt`;
    let entry;
    try {
      const res = await politeFetch(robotsUrl, { timeoutMs: 10000, retries: 1 });
      if (res.status === 404 || res.status === 410) {
        entry = { robots: null, allowAll: true, denyAll: false, reason: 'robots.txt 없음 (허용)' };
      } else if (res.status === 401 || res.status === 403) {
        entry = { robots: null, allowAll: false, denyAll: true, reason: `robots.txt 접근 거부 (HTTP ${res.status}) — 전면 금지로 해석` };
      } else if (res.ok && typeof res.body === 'string') {
        entry = {
          robots: robotsParser(robotsUrl, res.body),
          allowAll: false,
          denyAll: false,
          reason: 'robots.txt 파싱됨',
        };
      } else {
        entry = { robots: null, allowAll: false, denyAll: true, reason: `robots.txt 응답 이상 (HTTP ${res.status}) — 보수적으로 금지` };
      }
    } catch (err) {
      entry = { robots: null, allowAll: false, denyAll: true, reason: `robots.txt 조회 실패: ${err.message} — 보수적으로 금지` };
    }

    entry.at = Date.now();
    this.cache.set(origin, entry);
    return entry;
  }

  /**
   * @returns {Promise<{allowed:boolean, reason:string, crawlDelayMs:number|null}>}
   */
  async check(url, ua = userAgent()) {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      return { allowed: false, reason: `잘못된 URL: ${url}`, crawlDelayMs: null };
    }

    const entry = await this.#load(origin);

    if (entry.allowAll) return { allowed: true, reason: entry.reason, crawlDelayMs: null };
    if (entry.denyAll) return { allowed: false, reason: entry.reason, crawlDelayMs: null };

    const allowed = entry.robots.isAllowed(url, ua);
    const delaySec = entry.robots.getCrawlDelay(ua);
    return {
      // isAllowed 는 규칙이 없으면 undefined 를 줄 수 있다 → 허용으로 본다.
      allowed: allowed !== false,
      reason: allowed === false ? 'robots.txt 가 이 경로를 금지함' : entry.reason,
      crawlDelayMs: Number.isFinite(delaySec) ? delaySec * 1000 : null,
    };
  }

  clear() {
    this.cache.clear();
  }
}

module.exports = { RobotsCache, CACHE_TTL_MS };

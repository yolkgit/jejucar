'use strict';
/**
 * 인메모리 rate limiter.
 *
 * 외부 의존성을 쓰지 않는 이유: 단일 컨테이너 · 단일 프로세스라
 * 프로세스 메모리로 충분하고, 의존성 하나를 줄이는 편이 낫다.
 * 수평 확장하면 이 구현은 인스턴스별로 따로 세므로 공유 저장소가 필요하다.
 *
 * 슬라이딩 윈도우가 아니라 고정 윈도우다. 경계에서 최대 2배까지 통과할 수 있으나
 * 예약번호 무차별 대입(30^8 조합)을 막는 목적에는 충분하다.
 */

class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.windowMs  윈도우 길이(ms)
   * @param {number} opts.max       윈도우당 허용 횟수
   * @param {string} [opts.name]    로그·오류 메시지용
   */
  constructor({ windowMs, max, name = 'limiter' }) {
    this.windowMs = windowMs;
    this.max = max;
    this.name = name;
    /** @type {Map<string, {count:number, resetAt:number}>} */
    this.hits = new Map();
    this.lastSweep = Date.now();
  }

  /** 만료된 항목을 걷어낸다. 매 요청마다 전체를 훑으면 비싸므로 가끔만 돈다. */
  #sweep(now) {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [k, v] of this.hits) {
      if (v.resetAt <= now) this.hits.delete(k);
    }
  }

  /**
   * @returns {{allowed:boolean, remaining:number, retryAfterSec:number}}
   */
  check(key, now = Date.now()) {
    this.#sweep(now);

    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }

    entry.count++;
    const allowed = entry.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - entry.count),
      retryAfterSec: Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  reset(key) {
    this.hits.delete(key);
  }

  clear() {
    this.hits.clear();
  }
}

/**
 * 프록시 뒤에서도 대체로 맞는 클라이언트 식별자.
 * 신뢰할 수 없는 헤더이므로 보안 경계로 쓰면 안 되고, 남용 억제 용도로만 쓴다.
 */
function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** Express 미들웨어로 감싼다. */
function middleware(limiter, { message } = {}) {
  return (req, res, next) => {
    const { allowed, retryAfterSec } = limiter.check(clientKey(req));
    if (allowed) return next();
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json({
      error: message || '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.',
      retryAfterSec,
    });
  };
}

module.exports = { RateLimiter, clientKey, middleware };

'use strict';
/**
 * 예의 있는(polite) HTTP 클라이언트.
 *
 * - 신원을 밝히는 User-Agent (연락처 포함)
 * - AbortSignal.timeout 기반 타임아웃
 * - 429 / 5xx 에 대해 지수 백오프 재시도, Retry-After 헤더 존중
 * - ETag / Last-Modified 조건부 요청으로 상대 서버 부하 감소
 * - 응답 본문 크기 상한 (메모리 폭주 방지)
 */

const PKG_URL = 'https://github.com/yolkgit/jeju-rentcar';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 3;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB

function userAgent() {
  const contact = (process.env.CRAWLER_CONTACT || '').trim();
  // 크롤러는 자기 정체를 밝혀야 한다. 연락처가 있으면 함께 노출한다.
  return contact
    ? `JejuRentcarBot/1.0 (+${PKG_URL}; ${contact})`
    : `JejuRentcarBot/1.0 (+${PKG_URL})`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry-After 는 초 단위 정수 또는 HTTP-date 두 가지 형식이 있다.
 * 파싱 불가하면 null 을 돌려 호출부가 백오프로 넘어가게 한다.
 */
function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, Math.min(at - nowMs, 60000));
  return null;
}

async function readBodyCapped(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return await res.text();

  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error(`응답 본문이 상한(${MAX_BODY_BYTES} bytes)을 초과했습니다`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(Buffer.from)).toString('utf8');
}

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries]
 * @param {string|null} [opts.etag]           이전에 받은 ETag
 * @param {string|null} [opts.lastModified]   이전에 받은 Last-Modified
 * @param {object} [opts.headers]             추가 헤더
 * @param {(ms:number, attempt:number, reason:string)=>void} [opts.onRetry]
 * @param {number} [opts.nowMs]               테스트 주입용 현재 시각
 * @returns {Promise<{ok:boolean, status:number, notModified:boolean, body:string|null,
 *                    etag:string|null, lastModified:string|null, contentType:string|null,
 *                    url:string, attempts:number}>}
 */
async function politeFetch(url, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    etag = null,
    lastModified = null,
    headers = {},
    onRetry = null,
    nowMs = null,
  } = opts;

  const baseHeaders = {
    'User-Agent': userAgent(),
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9',
    ...headers,
  };
  if (etag) baseHeaders['If-None-Match'] = etag;
  if (lastModified) baseHeaders['If-Modified-Since'] = lastModified;

  let lastErr = null;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const res = await fetch(url, {
        headers: baseHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });

      // 304: 내용이 안 바뀜. 본문 없음. 재시도 대상 아님.
      if (res.status === 304) {
        return {
          ok: true,
          status: 304,
          notModified: true,
          body: null,
          etag,
          lastModified,
          contentType: null,
          url: res.url || url,
          attempts: attempt,
        };
      }

      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      if (retryable && attempt <= retries) {
        const now = nowMs ?? Date.now();
        const hinted = parseRetryAfter(res.headers.get('retry-after'), now);
        // 지수 백오프. 서버가 Retry-After 를 주면 그쪽을 우선한다.
        const backoff = hinted ?? Math.min(1000 * 2 ** (attempt - 1), 30000);
        if (onRetry) onRetry(backoff, attempt, `HTTP ${res.status}`);
        await sleep(backoff);
        continue;
      }

      const body = res.ok ? await readBodyCapped(res) : null;
      return {
        ok: res.ok,
        status: res.status,
        notModified: false,
        body,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        contentType: res.headers.get('content-type'),
        url: res.url || url,
        attempts: attempt,
      };
    } catch (err) {
      lastErr = err;
      if (attempt > retries) break;
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 30000);
      if (onRetry) onRetry(backoff, attempt, err.message);
      await sleep(backoff);
    }
  }

  throw new Error(`요청 실패 (${retries + 1}회 시도): ${url} — ${lastErr?.message || '알 수 없는 오류'}`);
}

module.exports = { politeFetch, userAgent, parseRetryAfter, MAX_BODY_BYTES };

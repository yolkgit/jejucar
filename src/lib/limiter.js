'use strict';
/**
 * 호스트별 요청 간격 제한기.
 *
 * 같은 호스트에 대해 동시 요청 1건 + 최소 간격(기본 2초)을 강제한다.
 * robots.txt 의 Crawl-delay 를 읽어 호스트별로 간격을 올릴 수 있다.
 * 서로 다른 호스트는 서로 막지 않는다.
 */

const DEFAULT_MIN_INTERVAL_MS = 2000;

class HostLimiter {
  constructor({ minIntervalMs = DEFAULT_MIN_INTERVAL_MS } = {}) {
    this.defaultInterval = minIntervalMs;
    /** @type {Map<string, {interval:number, chain:Promise<void>, lastAt:number}>} */
    this.hosts = new Map();
  }

  /** 해당 호스트의 최소 간격을 설정한다 (robots.txt Crawl-delay 반영용). */
  setInterval(host, ms) {
    const slot = this.#slot(host);
    // 이미 더 보수적인 값이 잡혀 있으면 낮추지 않는다.
    slot.interval = Math.max(slot.interval, ms);
  }

  #slot(host) {
    let slot = this.hosts.get(host);
    if (!slot) {
      slot = { interval: this.defaultInterval, chain: Promise.resolve(), lastAt: 0 };
      this.hosts.set(host, slot);
    }
    return slot;
  }

  /**
   * 호스트 순번을 기다렸다가 fn 을 실행한다.
   * 같은 호스트의 호출들은 직렬화되고, 각 호출 사이에 최소 간격이 보장된다.
   *
   * 대기 계산·fn 실행·lastAt 갱신이 모두 한 체인 안에 들어가야 한다.
   * 대기 구간만 체인에 넣으면 뒤따르는 호출이 갱신 전 lastAt 을 읽고 그냥 통과한다.
   */
  run(urlOrHost, fn) {
    const host = urlOrHost.includes('://') ? new URL(urlOrHost).host : urlOrHost;
    const slot = this.#slot(host);

    const task = slot.chain.then(async () => {
      // 간격은 직전 요청이 "끝난" 시점 기준으로 잰다 (보수적).
      const wait = slot.lastAt + slot.interval - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        slot.lastAt = Date.now();
      }
    });

    // 다음 호출자는 이 작업이 완전히 끝난 뒤 줄을 선다.
    // 실패를 삼켜서 한 건의 오류가 뒤따르는 호출을 막지 않게 한다.
    slot.chain = task.then(
      () => {},
      () => {}
    );

    return task;
  }
}

/** 동시 실행 개수를 n 개로 제한하며 작업 목록을 처리한다. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

module.exports = { HostLimiter, mapLimit, DEFAULT_MIN_INTERVAL_MS };

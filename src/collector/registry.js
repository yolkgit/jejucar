'use strict';
/**
 * 어댑터 레지스트리.
 *
 * adapters/ 안의 .js 파일을 읽어 어댑터로 등록한다.
 * '_' 로 시작하는 파일은 템플릿·헬퍼로 보고 건너뛴다.
 */

const fs = require('fs');
const path = require('path');

const ADAPTER_DIR = path.join(__dirname, 'adapters');

const REQUIRED = ['key', 'name', 'kind'];

function loadAdapters() {
  const adapters = new Map();
  const problems = [];

  const files = fs
    .readdirSync(ADAPTER_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'));

  for (const file of files) {
    const full = path.join(ADAPTER_DIR, file);
    let mod;
    try {
      mod = require(full);
    } catch (err) {
      problems.push(`${file}: 로드 실패 — ${err.message}`);
      continue;
    }

    const missing = REQUIRED.filter((k) => !mod[k]);
    if (missing.length) {
      problems.push(`${file}: 필수 필드 누락 — ${missing.join(', ')}`);
      continue;
    }
    if (!['manual', 'api', 'crawler'].includes(mod.kind)) {
      problems.push(`${file}: kind 가 manual|api|crawler 중 하나여야 함 (현재: ${mod.kind})`);
      continue;
    }
    // manual 이 아니면 수집 로직이 반드시 있어야 한다.
    if (mod.kind !== 'manual' && typeof mod.collect !== 'function') {
      problems.push(`${file}: kind=${mod.kind} 인데 collect() 가 없음`);
      continue;
    }
    if (adapters.has(mod.key)) {
      problems.push(`${file}: key 중복 — '${mod.key}'`);
      continue;
    }

    adapters.set(mod.key, mod);
  }

  return { adapters, problems };
}

module.exports = { loadAdapters, ADAPTER_DIR };

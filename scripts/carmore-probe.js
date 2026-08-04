'use strict';
/**
 * 카모아 rentcar-api 의 /cars 파라미터를 알아낸다. (개발용)
 * /affiliates 에서 제주 지점을 추린 뒤 파라미터 조합을 바꿔가며 시도한다.
 */

const { politeFetch } = require('../src/lib/http');
const { RobotsCache } = require('../src/lib/robots');
const { HostLimiter } = require('../src/lib/limiter');

const robots = new RobotsCache();
const limiter = new HostLimiter({ minIntervalMs: 1500 });
const BASE = 'https://rentcar-api.carmore.kr';

async function call(path) {
  const url = `${BASE}${path}`;
  const v = await robots.check(url);
  if (!v.allowed) return { blocked: true };
  const res = await limiter.run(url, () =>
    politeFetch(url, { timeoutMs: 30000, retries: 1, headers: { Accept: 'application/json' } })
  );
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {}
  return { status: res.status, size: res.body?.length ?? 0, json };
}

function fmt(d, h = 10) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

(async () => {
  console.log('── 제주 지점 추리기 ──');
  const aff = await call('/affiliates');
  const all = aff.json?.result?.affiliates || [];
  const jeju = all.filter(
    (a) =>
      a.jejuShuttle ||
      /제주/.test(a.name) ||
      /제주/.test(a.location?.address || '') ||
      a.location?.iataAirportCode === 'CJU'
  );
  console.log(`전체 ${all.length} → 제주 관련 ${jeju.length}`);
  jeju.slice(0, 6).forEach((a) =>
    console.log(`  ${a.id.padStart(4)} ${a.name.padEnd(24)} locationCode=${a.location?.locationCode} shuttle=${a.jejuShuttle ? 'Y' : 'N'}`)
  );

  const codes = [...new Set(jeju.map((a) => a.location?.locationCode).filter(Boolean))];
  console.log(`\n제주 locationCode: ${codes.slice(0, 10).join(', ')}`);

  const start = new Date();
  start.setDate(start.getDate() + 14);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const s = fmt(start);
  const e = fmt(end);
  const code = codes[0] || 'R_1';
  const affId = jeju[0]?.id || '1';

  const attempts = [
    `/cars?locationCode=${code}&startDate=${s}&endDate=${e}`,
    `/cars?locationCode=${code}&startDateTime=${s}T10:00:00&endDateTime=${e}T10:00:00`,
    `/cars?locationCode=${code}&pickupDate=${s}T10:00:00&returnDate=${e}T10:00:00`,
    `/cars?areaCode=CJU&startDate=${s}T10:00:00&endDate=${e}T10:00:00`,
    `/cars?affiliateId=${affId}&startDate=${s}T10:00:00&endDate=${e}T10:00:00`,
    `/cars?locationCode=${code}&startDate=${s}T10:00:00&endDate=${e}T10:00:00`,
    `/cars?locationCode=${code}&startDate=${s}T10:00:00&endDate=${e}T10:00:00&page=1&size=20`,
  ];

  console.log('\n── /cars 파라미터 시도 ──');
  for (const path of attempts) {
    const r = await call(path);
    const msg = r.json?.message ?? '';
    const res = r.json?.result;
    const counts = res
      ? `cars=${res.cars?.length ?? '-'} vehicles=${res.vehicles?.length ?? '-'} inventory=${res.inventory?.length ?? '-'} carModels=${res.carModels?.length ?? '-'}`
      : '';
    console.log(`  ${r.status} ${String(r.size).padStart(7)}B ${msg.padEnd(16)} ${counts}`);
    console.log(`      ${path}`);
    if (res && (res.cars?.length || res.vehicles?.length || res.inventory?.length)) {
      console.log('\n★ 데이터 확보! 첫 항목:');
      const first = res.cars?.[0] || res.vehicles?.[0] || res.inventory?.[0];
      console.log(JSON.stringify(first, null, 2).slice(0, 1500));
      break;
    }
  }
})();

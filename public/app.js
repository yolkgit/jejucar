'use strict';
/* 제주 렌터카 특가 — 프론트엔드
   빌드 스텝 없이 동작한다. 외부 라이브러리를 쓰지 않는다. */

// ── 유틸 ──────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * 딜 데이터는 외부 사이트에서 수집될 수 있으므로 신뢰할 수 없다.
 * 화면에 넣는 모든 문자열은 반드시 이 함수를 거친다.
 */
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const wonFmt = new Intl.NumberFormat('ko-KR');
const won = (n) => wonFmt.format(Number(n) || 0);

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayCount(from, to) {
  if (!from || !to) return 0;
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  return Math.round((b - a) / 86400000);
}

function fmtDateTime(s) {
  if (!s) return '-';
  return s.replace('T', ' ').slice(0, 16);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(data?.error || `요청에 실패했습니다. (${res.status})`);
    err.status = res.status;
    err.field = data?.field;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const host = $('#toastHost');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// ── 상태 ──────────────────────────────────────────────────
const state = {
  meta: null,
  filters: { carClass: [], sort: 'discount', page: 1 },
  lastQuery: null,
};

// ── 모달 ──────────────────────────────────────────────────
let closeModalFn = null;

function openModal({ title, body, foot }) {
  closeModal();

  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head">
        <div class="sheet-title">${esc(title)}</div>
        <button class="sheet-close" aria-label="닫기">&times;</button>
      </div>
      <div class="sheet-body"></div>
      ${foot ? '<div class="sheet-foot"></div>' : ''}
    </div>`;

  const bodyEl = $('.sheet-body', scrim);
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else bodyEl.appendChild(body);

  if (foot) {
    const footEl = $('.sheet-foot', scrim);
    if (typeof foot === 'string') footEl.innerHTML = foot;
    else footEl.appendChild(foot);
  }

  // 배경 스크롤 잠금
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  const onKey = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) closeModal();
  });
  $('.sheet-close', scrim).addEventListener('click', closeModal);
  document.addEventListener('keydown', onKey);

  $('#modalHost').appendChild(scrim);
  // 첫 포커스 가능한 요소로 이동시켜 키보드 사용자를 배려한다.
  const focusable = $('input, select, textarea, button:not(.sheet-close)', scrim);
  (focusable || $('.sheet-close', scrim)).focus();

  closeModalFn = () => {
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = prevOverflow;
    scrim.remove();
    closeModalFn = null;
  };
  return scrim;
}

function closeModal() {
  if (closeModalFn) closeModalFn();
}

// ── 메타 / 필터 칩 ────────────────────────────────────────
async function loadMeta() {
  state.meta = await api('/api/meta');
  renderClassChips();
  renderQuickChips();
  renderFooterNote();
  renderCapNotice();
}

function renderClassChips() {
  const host = $('#classChips');
  const { classes } = state.meta;
  const all = state.filters.carClass.length === 0;

  host.innerHTML =
    `<button class="chip" data-class="" aria-pressed="${all}">전체 <span class="count">${state.meta.total}</span></button>` +
    classes
      .map(
        (c) =>
          `<button class="chip" data-class="${esc(c.name)}" aria-pressed="${state.filters.carClass.includes(c.name)}">${esc(c.name)} <span class="count">${c.count}</span></button>`
      )
      .join('');

  $$('.chip', host).forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.class;
      if (!val) state.filters.carClass = [];
      else {
        const i = state.filters.carClass.indexOf(val);
        if (i >= 0) state.filters.carClass.splice(i, 1);
        else state.filters.carClass.push(val);
      }
      state.filters.page = 1;
      renderClassChips();
      loadDeals();
    });
  });
}

const QUICK_FILTERS = [
  { key: 'freeCancel', label: '무료취소' },
  { key: 'insuranceIncluded', label: '보험 포함' },
  { key: 'minDiscount', label: '50% 이상', value: 50 },
];

function renderQuickChips() {
  const host = $('#quickChips');
  const types = state.meta.dealTypes || [];

  host.innerHTML =
    QUICK_FILTERS.map(
      (f) =>
        `<button class="chip" data-quick="${f.key}" aria-pressed="${Boolean(state.filters[f.key])}">${esc(f.label)}</button>`
    ).join('') +
    types
      .map(
        (t) =>
          `<button class="chip" data-dealtype="${esc(t.name)}" aria-pressed="${state.filters.dealType === t.name}">${esc(t.name)} <span class="count">${t.count}</span></button>`
      )
      .join('');

  $$('[data-quick]', host).forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = QUICK_FILTERS.find((x) => x.key === btn.dataset.quick);
      if (state.filters[f.key]) delete state.filters[f.key];
      else state.filters[f.key] = f.value ?? true;
      state.filters.page = 1;
      renderQuickChips();
      loadDeals();
    });
  });

  $$('[data-dealtype]', host).forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.dealtype;
      state.filters.dealType = state.filters.dealType === v ? undefined : v;
      state.filters.page = 1;
      renderQuickChips();
      loadDeals();
    });
  });
}

function renderFooterNote() {
  const m = state.meta;
  $('#footerNote').textContent = m.updatedAt
    ? `현재 특가 ${m.total}건 · 업체 ${m.vendors.length}곳 · 최종 갱신 ${m.updatedAt}`
    : `현재 특가 ${m.total}건`;
}

/** 할인율 상한 규칙을 사용자에게 알린다. 앱 컨셉과 직결되는 정보다. */
function renderCapNotice() {
  const host = $('#noticeHost');
  const over = (state.meta.maxDiscount ?? 0) > 60;
  if (!over) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = `
    <div class="notice warn">
      <span class="icon" aria-hidden="true">!</span>
      <span><strong>할인율 60% 초과 상품 안내</strong> —
      2026년 9월 16일 시행 「제주특별자치도 자동차 대여약관 기재 등에 관한 규칙」에 따라
      제주 렌터카는 신고 요금의 60%를 초과해 할인할 수 없습니다(10일 초과 대여는 예외).
      해당 상품에는 <b>상한 초과</b> 표시가 붙습니다.</span>
    </div>`;
}

// ── 딜 목록 ───────────────────────────────────────────────
function buildQuery() {
  const p = new URLSearchParams();
  const f = state.filters;

  const q = $('#q').value.trim();
  if (q) p.set('q', q);
  if (f.carClass.length) p.set('carClass', f.carClass.join(','));
  if (f.dealType) p.set('dealType', f.dealType);
  if (f.freeCancel) p.set('freeCancel', '1');
  if (f.insuranceIncluded) p.set('insuranceIncluded', '1');
  if (f.minDiscount) p.set('minDiscount', String(f.minDiscount));

  const from = $('#pickupDate').value;
  const to = $('#returnDate').value;
  if (from) p.set('pickupDate', from);
  if (to) p.set('returnDate', to);

  p.set('sort', f.sort);
  p.set('page', String(f.page));
  p.set('limit', '12');
  return p.toString();
}

function dealCardHtml(d) {
  const badges = [];
  // 정가를 공개하지 않는 소스가 있다. 그때는 할인율 배지를 아예 달지 않는다.
  // 임의의 기준가로 할인율을 만들어 붙이면 허위 표기가 된다.
  if (d.discountPct !== null && d.discountPct !== undefined) {
    badges.push(`<span class="badge-item discount">${d.discountPct}% 할인</span>`);
  }
  if (d.dealType) badges.push(`<span class="badge-item deal-type">${esc(d.dealType)}</span>`);
  if (d.insurance) {
    badges.push(
      `<span class="badge-item insurance">${esc(d.insurance)}${d.insuranceIncluded ? ' 포함' : ''}</span>`
    );
  }
  if (d.freeCancel) badges.push('<span class="badge-item cancel">무료취소</span>');
  if (d.stock !== null && d.stock !== undefined) {
    badges.push(`<span class="badge-item stock">${d.stock}대 남음</span>`);
  }
  if (d.capWarning) badges.push('<span class="badge-item cap">할인율 상한 초과</span>');

  const rating = d.vendorRating
    ? `<span class="deal-rating">★ ${Number(d.vendorRating).toFixed(1)}<span class="n"> (${won(d.vendorReviews)})</span></span>`
    : '';

  const spec = [d.carClass, d.fuel, d.seats ? `${d.seats}인승` : null, d.pickupLocation]
    .filter(Boolean)
    .map(esc)
    .join(' · ');

  return `
    <button class="deal-card" data-id="${d.id}">
      <div class="deal-top">
        <div class="deal-head">
          <div class="deal-vendor">${esc(d.vendor)} ${rating}</div>
          <div class="deal-model">${esc(d.carModel)}</div>
          <div class="deal-spec">${spec}</div>
        </div>
        <div class="deal-price">
          ${d.listPrice ? `<div class="deal-list-price">${won(d.listPrice)}원</div>` : '<div class="deal-list-price no-list">정가 미표기</div>'}
          <div class="deal-sale-price">${won(d.salePrice)}<span class="unit">원</span></div>
          <div class="deal-per">1일 기준${d.minDays > 1 ? ` · ${d.minDays}일~` : ''}</div>
        </div>
      </div>
      <div class="badges">${badges.join('')}</div>
    </button>`;
}

async function loadDeals() {
  const list = $('#dealList');
  const qs = buildQuery();
  state.lastQuery = qs;

  list.innerHTML = Array.from({ length: 3 }, () => '<div class="skeleton"></div>').join('');
  $('#pager').hidden = true;

  let data;
  try {
    data = await api(`/api/deals?${qs}`);
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="big">!</div><div class="msg">목록을 불러오지 못했습니다</div><div class="sub">${esc(err.message)}</div></div>`;
    $('#resultCount').textContent = '';
    return;
  }

  // 사용자가 그 사이 필터를 바꿨으면 이 응답은 버린다.
  if (state.lastQuery !== qs) return;

  $('#resultCount').innerHTML = `총 <strong>${won(data.total)}</strong>건`;

  if (data.deals.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="big">🚗</div>
        <div class="msg">조건에 맞는 특가가 없습니다</div>
        <div class="sub">날짜나 차종 조건을 넓혀 보세요.</div>
      </div>`;
    return;
  }

  list.innerHTML = data.deals.map(dealCardHtml).join('');
  $$('.deal-card', list).forEach((card) => {
    card.addEventListener('click', () => openDealDetail(Number(card.dataset.id)));
  });

  renderPager(data);
}

function renderPager(data) {
  const pager = $('#pager');
  if (data.pages <= 1) {
    pager.hidden = true;
    return;
  }
  pager.hidden = false;
  pager.innerHTML = `
    <button id="prevPage" ${data.page <= 1 ? 'disabled' : ''}>이전</button>
    <span class="info">${data.page} / ${data.pages}</span>
    <button id="nextPage" ${data.page >= data.pages ? 'disabled' : ''}>다음</button>`;

  $('#prevPage').addEventListener('click', () => {
    state.filters.page = Math.max(1, state.filters.page - 1);
    loadDeals();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#nextPage').addEventListener('click', () => {
    state.filters.page = Math.min(data.pages, state.filters.page + 1);
    loadDeals();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// ── 딜 상세 ───────────────────────────────────────────────
async function openDealDetail(id) {
  let data;
  try {
    data = await api(`/api/deals/${id}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const d = data.deal;
  const rows = [
    ['업체', `${esc(d.vendor)}${d.vendorRating ? ` (★ ${Number(d.vendorRating).toFixed(1)})` : ''}`],
    ['차종', `${esc(d.carModel)} · ${esc(d.carClass)}`],
    ['연료 / 인승', [d.fuel, d.seats ? `${d.seats}인승` : null].filter(Boolean).map(esc).join(' · ') || '-'],
    ['변속', esc(d.transmission)],
    ['보험', d.insurance ? `${esc(d.insurance)}${d.insuranceIncluded ? ' (요금 포함)' : ' (현장 선택)'}` : '-'],
    ['취소', d.freeCancel ? '무료취소 가능' : '무료취소 불가'],
    ['픽업', esc(d.pickupLocation) || '-'],
    ['최소 대여', `${d.minDays}일`],
    ['이용 가능 기간', d.validFrom || d.validTo ? `${esc(d.validFrom) || '제한 없음'} ~ ${esc(d.validTo) || '제한 없음'}` : '제한 없음'],
    ['대여 조건', [
      d.minAge ? `만 ${d.minAge}세 이상` : null,
      d.minLicenseYears ? `면허 취득 ${d.minLicenseYears}년 이상` : null,
    ].filter(Boolean).join(' · ') || '업체 문의'],
    ['잔여', d.stock === null || d.stock === undefined ? '문의' : `${d.stock}대`],
    ['정보 출처', esc(d.sourceName) || '-'],
  ];

  const capHtml = d.capWarning
    ? `<div class="notice warn"><span class="icon" aria-hidden="true">!</span>
        <span>이 상품의 할인율(${d.discountPct}%)은 2026-09-16 시행 제주도 규칙의 상한 60%를 넘습니다.
        시행 이후에는 요금이 조정될 수 있습니다.</span></div>`
    : '';

  const unavailable = data.available === false
    ? `<div class="notice error"><span class="icon" aria-hidden="true">!</span><span>${esc(data.reason || '예약할 수 없는 상품입니다.')}</span></div>`
    : '';

  const body = `
    ${unavailable}
    ${capHtml}
    <div class="detail-hero">
      <div class="model">${esc(d.carModel)}</div>
      <div class="vendor">${esc(d.vendor)}</div>
      <div class="prices">
        <span class="sale">${won(d.salePrice)}원</span>
        ${d.listPrice ? `<span class="list">${won(d.listPrice)}원</span>` : ''}
        ${d.discountPct !== null && d.discountPct !== undefined ? `<span class="pct">${d.discountPct}%</span>` : ''}
      </div>
      <div class="deal-per" style="margin-top:4px">
        1일 기준 요금${d.listPrice ? '' : ' · 업체가 정가를 공개하지 않아 할인율을 표시하지 않습니다'}
      </div>
    </div>

    <table class="spec-table">
      ${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}
    </table>

    ${d.notes ? `<div class="section-title">안내</div><div style="font-size:13px;color:var(--text-2);line-height:1.65">${esc(d.notes)}</div>` : ''}
  `;

  // 이 앱은 예약을 받지 않는다. 판매처 상품 페이지로 보내는 것이 전부다.
  // 목적지 호스트를 미리 보여줘서 어디로 가는지 알고 누르게 한다.
  const host = destHost(d.detailUrl);
  const canGo = data.available !== false && Boolean(host);

  const foot = canGo
    ? `<div class="price-sum">
         <div class="label">${esc(host)} 에서 예약</div>
         <div class="value">${won(d.salePrice)}원</div>
       </div>
       <a class="primary-btn" id="toSource" href="/go/${d.id}" target="_blank" rel="noopener noreferrer nofollow">예약하러 가기</a>`
    : `<button class="secondary-btn" id="closeDetail">닫기</button>`;

  openModal({ title: '특가 상세', body, foot });

  if ($('#closeDetail')) $('#closeDetail').addEventListener('click', closeModal);
}

/** 링크의 도메인만 뽑는다. 어디로 나가는지 사용자에게 밝히기 위해서다. */
function destHost(url) {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// ── 초기화 ────────────────────────────────────────────────
function initDates() {
  const pick = $('#pickupDate');
  const ret = $('#returnDate');
  pick.min = todayStr();
  ret.min = todayStr();

  const sync = () => {
    if (pick.value) ret.min = pick.value;
    if (pick.value && ret.value && ret.value < pick.value) ret.value = addDays(pick.value, 1);
    const days = dayCount(pick.value, ret.value);
    $('#rangeHint').textContent =
      days >= 1
        ? `${days}일 대여 · 이 기간에 이용 가능한 특가만 표시합니다.`
        : '날짜를 고르면 그 기간에 쓸 수 있는 특가만 보여줍니다.';
    state.filters.page = 1;
    loadDeals();
  };

  pick.addEventListener('change', sync);
  ret.addEventListener('change', sync);
}

function init() {
  $('#q').addEventListener(
    'input',
    debounce(() => {
      state.filters.page = 1;
      loadDeals();
    }, 280)
  );

  $('#sort').addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    state.filters.page = 1;
    loadDeals();
  });

  $('#logo').addEventListener('click', () => {
    state.filters = { carClass: [], sort: 'discount', page: 1 };
    $('#q').value = '';
    $('#pickupDate').value = '';
    $('#returnDate').value = '';
    $('#sort').value = 'discount';
    renderClassChips();
    renderQuickChips();
    loadDeals();
  });

  initDates();

  loadMeta()
    .then(loadDeals)
    .catch((err) => {
      $('#dealList').innerHTML = `<div class="empty"><div class="big">!</div><div class="msg">초기화에 실패했습니다</div><div class="sub">${esc(err.message)}</div></div>`;
    });
}

document.addEventListener('DOMContentLoaded', init);

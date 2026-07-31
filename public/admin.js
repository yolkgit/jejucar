'use strict';
/* 관리자 화면 — 예약 확정/취소, 딜 관리, 수집 소스 제어 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const nf = new Intl.NumberFormat('ko-KR');
const won = (n) => nf.format(Number(n) || 0);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `요청 실패 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toastHost').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

const STATUS_LABEL = { pending: '확인 대기', confirmed: '확정', cancelled: '취소', rejected: '반려' };

let currentTab = 'bookings';

// ── 인증 ──────────────────────────────────────────────────
async function boot() {
  const me = await api('/api/admin/me').catch(() => ({ authenticated: false }));
  if (me.authenticated) showApp();
  else showLogin();
}

function showLogin() {
  $('#loginView').hidden = false;
  $('#appView').hidden = true;
  $('#logoutBtn').hidden = true;
  $('#pw').focus();
}

async function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  $('#logoutBtn').hidden = false;
  await loadStats();
  await renderTab();
}

$('#loginBtn').addEventListener('click', doLogin);
$('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const btn = $('#loginBtn');
  btn.disabled = true;
  $('#loginErr').innerHTML = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } });
    $('#pw').value = '';
    await showApp();
  } catch (err) {
    $('#loginErr').innerHTML = `<div class="notice error"><span class="icon">!</span><span>${esc(err.message)}</span></div>`;
  } finally {
    btn.disabled = false;
  }
}

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ── 통계 ──────────────────────────────────────────────────
async function loadStats() {
  const s = await api('/api/admin/stats');
  $('#stats').innerHTML = `
    <div class="stat"><div class="label">활성 딜</div><div class="value">${won(s.deals.active)}</div></div>
    <div class="stat ${s.bookings.pending ? 'warn' : ''}"><div class="label">확인 대기</div><div class="value">${won(s.bookings.pending)}</div></div>
    <div class="stat"><div class="label">확정</div><div class="value">${won(s.bookings.confirmed)}</div></div>
    <div class="stat"><div class="label">최근 7일 신청</div><div class="value">${won(s.recentBookings7d)}</div></div>`;
}

// ── 탭 ────────────────────────────────────────────────────
$$('[role=tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    $$('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
    renderTab();
  });
});

async function renderTab() {
  const host = $('#tabBody');
  host.innerHTML = '<div class="skeleton"></div>';
  try {
    if (currentTab === 'bookings') await renderBookings(host);
    else if (currentTab === 'deals') await renderDeals(host);
    else await renderSources(host);
  } catch (err) {
    host.innerHTML = `<div class="notice error"><span class="icon">!</span><span>${esc(err.message)}</span></div>`;
  }
}

// ── 예약 ──────────────────────────────────────────────────
let bookingFilter = '';

async function renderBookings(host) {
  const qs = bookingFilter ? `?status=${bookingFilter}` : '';
  const { bookings } = await api(`/api/admin/bookings${qs}`);

  const filters = ['', 'pending', 'confirmed', 'cancelled', 'rejected'];
  const chips = filters
    .map((f) => `<button class="chip" data-f="${f}" aria-pressed="${bookingFilter === f}">${f ? STATUS_LABEL[f] : '전체'}</button>`)
    .join('');

  host.innerHTML = `
    <nav class="chips">${chips}</nav>
    ${bookings.length === 0 ? '<div class="empty"><div class="msg">해당 예약이 없습니다</div></div>' : ''}
    ${bookings.map(bookingCard).join('')}`;

  $$('[data-f]', host).forEach((b) =>
    b.addEventListener('click', () => {
      bookingFilter = b.dataset.f;
      renderTab();
    })
  );

  $$('[data-act]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      const { code, act } = b.dataset;
      if (act === 'cancelled' && !confirm('이 예약을 취소 처리할까요?')) return;
      if (act === 'rejected' && !confirm('이 예약을 반려할까요?')) return;
      b.disabled = true;
      try {
        await api(`/api/admin/bookings/${encodeURIComponent(code)}`, { method: 'PATCH', body: { status: act } });
        toast('상태를 변경했습니다.');
        await loadStats();
        await renderTab();
      } catch (err) {
        toast(err.message, 'error');
        b.disabled = false;
      }
    })
  );

  $$('[data-memo]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      const code = b.dataset.memo;
      const cur = b.dataset.cur || '';
      const memo = prompt('신청자에게 보일 안내 메모', cur);
      if (memo === null) return;
      try {
        await api(`/api/admin/bookings/${encodeURIComponent(code)}`, { method: 'PATCH', body: { adminMemo: memo } });
        toast('메모를 저장했습니다.');
        await renderTab();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  $$('[data-detail]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        const { booking } = await api(`/api/admin/bookings/${encodeURIComponent(b.dataset.detail)}`);
        alert(
          `예약번호: ${booking.code}\n` +
          `신청자: ${booking.name}\n` +
          `연락처: ${booking.phone}\n` +
          `이메일: ${booking.email || '-'}\n` +
          `나이/면허: ${booking.driver_age ?? '-'}세 / ${booking.license_years ?? '-'}년\n` +
          `요청사항: ${booking.memo || '-'}\n` +
          `동의 시각: ${booking.privacy_agreed_at || '-'}`
        );
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

function bookingCard(b) {
  const acts = [];
  if (b.status === 'pending') {
    acts.push(`<button class="mini-btn good" data-act="confirmed" data-code="${esc(b.code)}">확정</button>`);
    acts.push(`<button class="mini-btn bad" data-act="rejected" data-code="${esc(b.code)}">반려</button>`);
  }
  if (b.status === 'pending' || b.status === 'confirmed') {
    acts.push(`<button class="mini-btn" data-act="cancelled" data-code="${esc(b.code)}">취소</button>`);
  }
  acts.push(`<button class="mini-btn" data-detail="${esc(b.code)}">연락처 보기</button>`);
  acts.push(`<button class="mini-btn" data-memo="${esc(b.code)}" data-cur="${esc(b.adminMemo || '')}">메모</button>`);

  return `
    <div class="row-card">
      <div class="row-head">
        <div class="grow">
          <div class="row-title">${esc(b.car || '차량 정보 없음')}</div>
          <div class="row-sub">
            <span class="mono">${esc(b.code)}</span> · ${esc(b.name)} · ${esc(b.phoneMasked)}<br>
            ${esc(b.pickupAt)} → ${esc(b.returnAt)} (${b.days}일) · ${won(b.quotedPrice)}원<br>
            ${esc(b.pickupPlace) || '-'} · 신청 ${esc(b.createdAt)}
            ${b.memo ? `<br>요청: ${esc(b.memo)}` : ''}
            ${b.adminMemo ? `<br>메모: ${esc(b.adminMemo)}` : ''}
          </div>
        </div>
        <span class="status-pill ${esc(b.status)}">${esc(STATUS_LABEL[b.status] || b.status)}</span>
      </div>
      <div class="row-actions">${acts.join('')}</div>
    </div>`;
}

// ── 딜 ────────────────────────────────────────────────────
async function renderDeals(host) {
  const { deals } = await api('/api/admin/deals?limit=200');

  host.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <button class="mini-btn on" id="addDeal">+ 딜 직접 등록</button>
    </div>
    ${deals.map(dealCard).join('')}`;

  $('#addDeal').addEventListener('click', openDealForm);

  $$('[data-edit]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.edit;
      const sale = prompt('새 할인가 (원)', b.dataset.sale);
      if (sale === null) return;
      try {
        await api(`/api/admin/deals/${id}`, { method: 'PATCH', body: { salePrice: Number(sale) } });
        toast('가격을 수정했습니다.');
        await renderTab();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  $$('[data-hide]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      const next = b.dataset.status === 'hidden' ? 'active' : 'hidden';
      try {
        await api(`/api/admin/deals/${b.dataset.hide}`, { method: 'PATCH', body: { status: next } });
        toast(next === 'hidden' ? '숨김 처리했습니다.' : '다시 노출합니다.');
        await loadStats();
        await renderTab();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  $$('[data-del]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('이 딜을 삭제할까요?')) return;
      try {
        await api(`/api/admin/deals/${b.dataset.del}`, { method: 'DELETE' });
        toast('삭제했습니다.');
        await loadStats();
        await renderTab();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

function dealCard(d) {
  return `
    <div class="row-card">
      <div class="row-head">
        <div class="grow">
          <div class="row-title">${esc(d.carModel)} <span style="font-weight:600;color:var(--text-3);font-size:12px">${esc(d.carClass)}</span></div>
          <div class="row-sub">
            ${esc(d.vendor)} · ${d.listPrice ? `<s>${won(d.listPrice)}</s> ` : ''}<b>${won(d.salePrice)}원</b>${
              d.discountPct !== null && d.discountPct !== undefined
                ? ` (${d.discountPct}%)`
                : ' <span style="color:var(--text-3)">정가 미표기</span>'
            }
            ${d.capWarning ? ' · <b style="color:var(--amber)">상한 초과</b>' : ''}<br>
            ${esc(d.validFrom) || '-'} ~ ${esc(d.validTo) || '-'} · ${esc(d.sourceName)}
          </div>
        </div>
        <span class="status-pill ${d.status === 'active' ? 'confirmed' : 'cancelled'}">${d.status === 'active' ? '노출' : d.status === 'hidden' ? '숨김' : '만료'}</span>
      </div>
      <div class="row-actions">
        <button class="mini-btn" data-edit="${d.id}" data-sale="${d.salePrice}">가격 수정</button>
        <button class="mini-btn" data-hide="${d.id}" data-status="${esc(d.status)}">${d.status === 'hidden' ? '노출' : '숨김'}</button>
        <button class="mini-btn bad" data-del="${d.id}">삭제</button>
      </div>
    </div>`;
}

const CAR_CLASSES = ['경차', '소형', '준중형', '중형', '대형', 'SUV', '승합', '전기', '수입'];

function openDealForm() {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-label="딜 등록">
      <div class="sheet-head"><div class="sheet-title">딜 직접 등록</div><button class="sheet-close">&times;</button></div>
      <div class="sheet-body">
        <div class="search-grid">
          <div class="field"><label for="dVendor">업체명 *</label><input id="dVendor" placeholder="제주엔젤카"></div>
          <div class="field"><label for="dModel">차종 *</label><input id="dModel" placeholder="아반떼 CN7"></div>
          <div class="field"><label for="dClass">등급 *</label>
            <select id="dClass">${CAR_CLASSES.map((c) => `<option>${c}</option>`).join('')}</select></div>
          <div class="field"><label for="dFuel">연료</label>
            <select id="dFuel"><option value="">선택</option>${['가솔린','디젤','LPG','하이브리드','전기'].map((f)=>`<option>${f}</option>`).join('')}</select></div>
          <div class="field"><label for="dList">정가(원) *</label><input id="dList" type="number" inputmode="numeric"></div>
          <div class="field"><label for="dSale">할인가(원) *</label><input id="dSale" type="number" inputmode="numeric"></div>
          <div class="field"><label for="dFrom">시작일</label><input id="dFrom" type="date"></div>
          <div class="field"><label for="dTo">종료일</label><input id="dTo" type="date"></div>
          <div class="field"><label for="dPickup">픽업 장소</label><input id="dPickup" placeholder="제주공항 셔틀"></div>
          <div class="field"><label for="dStock">잔여 수량</label><input id="dStock" type="number" inputmode="numeric" placeholder="미입력=문의"></div>
          <div class="field"><label for="dIns">보험</label>
            <select id="dIns"><option value="">선택</option>${['책임보험','일반자차','완전자차'].map((i)=>`<option>${i}</option>`).join('')}</select></div>
          <div class="field"><label for="dMinDays">최소 대여일</label><input id="dMinDays" type="number" value="1" min="1"></div>
          <div class="field full"><label for="dNotes">안내</label><textarea id="dNotes" rows="2"></textarea></div>
          <div class="field full">
            <label class="check-row"><input type="checkbox" id="dInsInc"><span>보험 요금 포함</span></label>
          </div>
        </div>
        <div id="dErr" style="margin-top:10px"></div>
      </div>
      <div class="sheet-foot"><button class="primary-btn" id="dSave" style="width:100%">등록</button></div>
    </div>`;

  const close = () => scrim.remove();
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  $('.sheet-close', scrim).addEventListener('click', close);
  $('#modalHost').appendChild(scrim);

  $('#dSave', scrim).addEventListener('click', async () => {
    const btn = $('#dSave', scrim);
    btn.disabled = true;
    $('#dErr', scrim).innerHTML = '';
    try {
      await api('/api/admin/deals', {
        method: 'POST',
        body: {
          vendorName: $('#dVendor', scrim).value,
          carModel: $('#dModel', scrim).value,
          carClass: $('#dClass', scrim).value,
          fuel: $('#dFuel', scrim).value || null,
          listPrice: $('#dList', scrim).value,
          salePrice: $('#dSale', scrim).value,
          validFrom: $('#dFrom', scrim).value || null,
          validTo: $('#dTo', scrim).value || null,
          pickupLocation: $('#dPickup', scrim).value || null,
          stock: $('#dStock', scrim).value,
          insurance: $('#dIns', scrim).value || null,
          insuranceIncluded: $('#dInsInc', scrim).checked,
          minDays: $('#dMinDays', scrim).value,
          notes: $('#dNotes', scrim).value || null,
        },
      });
      toast('딜을 등록했습니다.');
      close();
      await loadStats();
      await renderTab();
    } catch (err) {
      $('#dErr', scrim).innerHTML = `<div class="notice error"><span class="icon">!</span><span>${esc(err.message)}</span></div>`;
      btn.disabled = false;
    }
  });
}

// ── 수집 소스 ─────────────────────────────────────────────
async function renderSources(host) {
  const [{ sources }, { logs }] = await Promise.all([
    api('/api/admin/sources'),
    api('/api/admin/logs?limit=25'),
  ]);

  host.innerHTML = `
    <div class="notice info" style="margin-bottom:12px">
      <span class="icon">i</span>
      <span>수집기는 <strong>robots.txt를 먼저 확인</strong>하고, 금지된 경로는 요청하지 않습니다.
      소스를 켜기 전에 해당 사이트의 이용약관을 직접 확인하세요.</span>
    </div>
    ${sources.map(sourceCard).join('')}
    <div class="section-title">최근 수집 로그</div>
    ${logs.length === 0 ? '<div class="row-sub">아직 수집 기록이 없습니다.</div>' : ''}
    ${logs.map(logLine).join('')}`;

  $$('[data-toggle]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/api/admin/sources/${encodeURIComponent(b.dataset.toggle)}`, {
          method: 'PATCH',
          body: { enabled: b.dataset.enabled !== '1' },
        });
        await renderTab();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );

  $$('[data-run]', host).forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = '수집 중…';
      try {
        const r = await api('/api/admin/collect', { method: 'POST', body: { key: b.dataset.run } });
        const s = r.summary?.[0];
        toast(s ? `${s.key}: ${s.status} (신규 ${s.inserted ?? 0}, 갱신 ${s.updated ?? 0})` : '수집 완료');
        await loadStats();
        await renderTab();
      } catch (err) {
        toast(err.message, 'error');
        b.disabled = false;
        b.textContent = '지금 수집';
      }
    })
  );
}

function sourceCard(s) {
  const manual = s.kind === 'manual';
  return `
    <div class="row-card">
      <div class="row-head">
        <div class="grow">
          <div class="row-title">${esc(s.name)} <span style="font-weight:600;color:var(--text-3);font-size:12px">${esc(s.kind)}</span></div>
          <div class="row-sub">
            <span class="mono">${esc(s.key)}</span>${s.base_url ? ` · ${esc(s.base_url)}` : ''}<br>
            활성 딜 ${won(s.active_deals)}건
            ${s.robots_status && s.robots_status !== 'n/a' ? ` · robots: <b>${esc(s.robots_status)}</b>` : ''}
            ${s.last_run_at ? `<br>최근 실행 ${esc(s.last_run_at)}` : ''}
            ${s.last_error ? `<br><span style="color:var(--red)">오류: ${esc(s.last_error)}</span>` : ''}
            ${s.note ? `<br><span style="color:var(--text-3)">${esc(s.note)}</span>` : ''}
          </div>
        </div>
        <span class="status-pill ${manual ? 'cancelled' : s.enabled ? 'confirmed' : 'pending'}">
          ${manual ? '수동' : s.enabled ? '켜짐' : '꺼짐'}
        </span>
      </div>
      ${manual ? '' : `
      <div class="row-actions">
        <button class="mini-btn ${s.enabled ? 'on' : ''}" data-toggle="${esc(s.key)}" data-enabled="${s.enabled ? 1 : 0}">
          ${s.enabled ? '끄기' : '켜기'}
        </button>
        ${s.enabled ? `<button class="mini-btn" data-run="${esc(s.key)}">지금 수집</button>` : ''}
      </div>`}
    </div>`;
}

function logLine(l) {
  return `<div class="log-line">
    <span class="st ${esc(l.status)}">${esc(l.status)}</span>
    · ${esc(l.source_key)} · ${esc(l.started_at)}
    · 수집 ${l.fetched} / 신규 ${l.inserted} / 갱신 ${l.updated} / 만료 ${l.expired}
    ${l.message ? `<br><span style="color:var(--text-3)">${esc(l.message)}</span>` : ''}
  </div>`;
}

boot();

/* ──────────────────────────────────────────
   공용: 세션·서버 호출·포맷 도우미
   - 세션 토큰은 워크스페이스 auth 함수가 서명한 것. 모든 함수 호출에 x-auth-token으로 붙이고 서버가 매번 검증한다.
   - 워크스페이스에서 넘어올 때는 주소 해시 #sso=<60초 일회용 코드>를 받아 auth sso_redeem으로 토큰과 바꾼다 (해시는 즉시 지움).
────────────────────────────────────────── */
const CFG = window.DNRB_CONFIG;
const SESSION_KEY = 'dnrb_agents_session';
let SESSION = null;

const $ = id => document.getElementById(id);
const isAdmin = () => SESSION?.role === 'admin';
const ROLE_LABEL = { admin: '관리자', staff: 'MD', marketer: '마케터', cs: 'CS팀', logistics: '물류팀' };

async function loadSession() {
  // 워크스페이스에서 넘어온 60초 일회용 코드(#sso=코드) → auth sso_redeem으로 정식 토큰과 교환.
  // 7일 토큰을 주소에 싣지 않는 이유: 공용 PC 브라우저 기록에 남아도 소진된 코드는 쓸모없다 (2026-09-10 보안 검토 반영).
  const m = location.hash.match(/[#&]sso=([A-Za-z0-9_-]+)/);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search + '#home');
    try {
      const d = await callFn('auth', null, { method: 'POST', body: JSON.stringify({ action: 'sso_redeem', code: m[1] }) });
      if (d.token) saveSession({ token: d.token, id: d.id, name: d.name, role: d.role, exp: d.exp });
    } catch (e) { console.warn('SSO 교환 실패:', e.message); }
  }
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (s && s.token && s.exp > Date.now()) SESSION = s;
  } catch { /* 없음 */ }
}
function saveSession(s) { SESSION = s; localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function logout() { localStorage.removeItem(SESSION_KEY); SESSION = null; location.hash = ''; location.reload(); }

function sbHeaders() {
  const h = { apikey: CFG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  if (SESSION?.token) h['x-auth-token'] = SESSION.token;
  return h;
}
function fnUrl(name, params) {
  const qs = params ? new URLSearchParams(params).toString() : '';
  return `${CFG.SUPABASE_URL}/functions/v1/${name}${qs ? '?' + qs : ''}`;
}
async function callFn(name, params, init = {}) {
  const res = await fetch(fnUrl(name, params), { ...init, headers: sbHeaders() });
  const text = await res.text();
  let d = {};
  try { d = text ? JSON.parse(text) : {}; } catch { d = { error: text.slice(0, 120) }; }
  if (!res.ok || d.error) {
    const err = new Error(d.error || d.message || String(res.status));
    err.status = res.status;
    throw err;
  }
  return d;
}
// 워크스페이스의 db 프록시 함수 — 테이블·역할 화이트리스트를 서버가 강제 (agent_reports = admin)
async function dbProxy(path, init = {}) {
  return await callFn('db', null, {
    method: 'POST',
    body: JSON.stringify({ path, method: init.method || 'GET', body: init.body, prefer: init.prefer }),
  });
}
async function authLogin(id, password) {
  const d = await callFn('auth', null, { method: 'POST', body: JSON.stringify({ action: 'login', id, password }) });
  if (!d.token) throw new Error('로그인 실패');
  saveSession({ token: d.token, id: d.id, name: d.name, role: d.role, exp: d.exp });
}

/* ── 포맷 ── */
const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');
const fmtMan = n => {
  if (n == null || !isFinite(n)) return '—';
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(1) + '억 원';
  return Math.round(n / 1e4).toLocaleString('ko-KR') + '만 원';
};
const fmtDelta = p => p == null ? '<span class="muted">비교 불가</span>'
  : `<b class="${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '+' : ''}${Number(p).toFixed(1)}%</b>`;
const DOW = '일월화수목금토';
const dateLabel = d => d ? `${d.slice(0, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)} (${DOW[new Date(d + 'T12:00:00Z').getUTCDay()]})` : '';
const dateShort = d => d ? `${d.slice(5, 7)}.${d.slice(8, 10)} (${DOW[new Date(d + 'T12:00:00Z').getUTCDay()]})` : '';
const timeLabel = iso => new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const relTime = iso => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return '방금'; if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60); if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
};

let __toastT;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(__toastT); __toastT = setTimeout(() => el.classList.remove('show'), 3200);
}
// 버튼 진행 표시 (경과 초)
const __btnT = new Map();
function btnBusy(btn, label) {
  if (!btn) return;
  clearInterval(__btnT.get(btn));
  const t0 = Date.now(); btn.disabled = true;
  const tick = () => { btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label} <span class="muted">${Math.round((Date.now() - t0) / 1000)}초</span>`; };
  tick(); __btnT.set(btn, setInterval(tick, 1000));
}
function btnIdle(btn, html) {
  if (!btn) return;
  clearInterval(__btnT.get(btn)); __btnT.delete(btn);
  btn.disabled = false; btn.innerHTML = html;
}

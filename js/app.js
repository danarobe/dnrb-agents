/* ──────────────────────────────────────────
   앱 뼈대: 로그인 화면 ↔ 본문, 해시 라우터
   #decide | #board | #home | #reports | #reports/<id>   (2026-11-07: '오늘 할 일'을 첫 화면으로 → 2026-11-11 대표 결정함·팀 작업보드로 나눔, 옛 #todo는 첫 화면으로)
────────────────────────────────────────── */
const ROUTES = {
  decide: { label: '대표 결정함', short: '결정함', icon: 'fa-stamp' },
  board: { label: '팀 작업보드', short: '작업보드', icon: 'fa-table-columns' },
  home: { label: '담당자', icon: 'fa-users' },
  reports: { label: '보고서', icon: 'fa-file-lines' },
};

function route() {
  const h = location.hash.replace(/^#/, '');
  const [key, id] = h.split('/');
  const home0 = typeof isCeo === 'function' && isCeo() ? 'decide' : 'board';   // 첫 화면: 대표 = 결정함, 직원 = 팀 작업보드
  const k = ROUTES[key] ? key : home0;
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.key === k));
  if (k === 'decide' || k === 'board') renderTasks(k);
  if (k === 'home') renderHome();
  if (k === 'reports') renderReports(id);
  if (typeof notifLoad === 'function') notifLoad();   // 60초 스로틀
  window.scrollTo(0, 0);
}

function renderShell() {
  $('login').style.display = SESSION ? 'none' : 'flex';
  $('app').style.display = SESSION ? '' : 'none';
  if (!SESSION) return;
  $('nav').innerHTML = Object.entries(ROUTES).map(([k, v]) => `<a href="#${k}" data-key="${k}"><i class="fa-solid ${v.icon}"></i> ${v.short ? `<span class="nl">${v.label}</span><span class="ns">${v.short}</span>` : v.label}</a>`).join('');
  $('user-info').textContent = `${SESSION.name} (${ROLE_LABEL[SESSION.role] || SESSION.role})`;
  route();
}

async function submitLogin(ev) {
  ev.preventDefault();
  const btn = $('login-btn'), msg = $('login-msg');
  msg.textContent = '';
  btnBusy(btn, '로그인 중');
  try {
    await authLogin($('login-id').value.trim(), $('login-pw').value);
    await loadAccess();
    renderShell();
  } catch (e) { msg.textContent = e.message; }
  finally { btnIdle(btn, '로그인'); }
}

window.addEventListener('hashchange', () => { if (SESSION) route(); });
document.addEventListener('DOMContentLoaded', async () => {
  await loadSession();   // #sso= 코드 교환이 있으면 서버 왕복 1회
  await loadAccess();    // 관리자가 아니면 허용 목록 확인
  if (!location.hash) history.replaceState(null, '', SESSION?.role === 'admin' ? '#decide' : '#board');
  renderShell();
});

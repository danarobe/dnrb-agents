/* ──────────────────────────────────────────
   앱 뼈대: 로그인 화면 ↔ 본문, 해시 라우터
   #home | #reports | #reports/<id>
────────────────────────────────────────── */
const ROUTES = {
  home: { label: '담당자', icon: 'fa-users' },
  reports: { label: '보고서', icon: 'fa-file-lines' },
};

function route() {
  const h = location.hash.replace(/^#/, '');
  const [key, id] = h.split('/');
  const k = ROUTES[key] ? key : 'home';
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.key === k));
  if (k === 'home') renderHome();
  if (k === 'reports') renderReports(id);
  window.scrollTo(0, 0);
}

function renderShell() {
  $('login').style.display = SESSION ? 'none' : 'flex';
  $('app').style.display = SESSION ? '' : 'none';
  if (!SESSION) return;
  $('nav').innerHTML = Object.entries(ROUTES).map(([k, v]) => `<a href="#${k}" data-key="${k}"><i class="fa-solid ${v.icon}"></i> ${v.label}</a>`).join('');
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
    renderShell();
  } catch (e) { msg.textContent = e.message; }
  finally { btnIdle(btn, '로그인'); }
}

window.addEventListener('hashchange', () => { if (SESSION) route(); });
document.addEventListener('DOMContentLoaded', () => {
  loadSession();
  if (!location.hash) history.replaceState(null, '', '#home');
  renderShell();
});

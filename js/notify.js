/* ──────────────────────────────────────────
   알림 (2026-09-15, 사용자 요청 "보고서가 나오면 관리자 모두에게 알림")
   - 담당자 함수가 보고서를 저장하면 관리자 전원의 notifications 행 + 구독 기기 웹 푸시를 이미 보낸다(agent.ts notifyAdmins).
   - 여기는 그 알림을 이 앱에서도 보고(종 아이콘), **이 기기의 휴대폰 알림을 켜는** 곳. 푸시는 기기(브라우저)마다 따로 켜야 한다.
   - 워크스페이스 종 알림과 같은 notifications / push_subscriptions 테이블(db 프록시), 같은 VAPID 공개키.
   - 아이폰은 Safari '홈 화면에 추가' 후 그 앱에서만 푸시를 켤 수 있다(iOS 정책).
────────────────────────────────────────── */
const PUSH_PUBKEY = 'BOwOXWnEz151B3IpLEh9qTKqHhfMPZomqbYAcLgRtmyFRZDKxrQLaedVut5Ui4DYpBoWfpx3xhlj46CMF9NrhJI';
const notifState = { rows: [], lastFetch: 0, open: false };

async function notifLoad(force) {
  if (!SESSION) return;
  if (!force && Date.now() - notifState.lastFetch < 60000) return;
  notifState.lastFetch = Date.now();
  try {
    notifState.rows = await dbProxy(`notifications?user_id=eq.${encodeURIComponent(SESSION.id)}&order=created_at.desc&limit=30`) || [];
  } catch { return; }
  notifBadge();
}
function notifBadge() {
  const b = $('notif-badge'); if (!b) return;
  const unread = (notifState.rows || []).filter(r => !r.read).length;
  b.style.display = unread ? '' : 'none';
  b.textContent = unread > 9 ? '9+' : unread;
}
function notifToggle(ev) {
  if (ev) ev.stopPropagation();
  const d = $('notif-drop');
  notifState.open = d.style.display === 'none';
  d.style.display = notifState.open ? 'block' : 'none';
  if (notifState.open) { notifRender(); notifLoad(true).then(notifRender); }
}
document.addEventListener('click', e => {
  const d = $('notif-drop'), w = $('notif-wrap');
  if (d && d.style.display !== 'none' && !d.contains(e.target) && !(w && w.contains(e.target))) { d.style.display = 'none'; notifState.open = false; }
});
function notifRender() {
  const rows = notifState.rows || [];
  const unread = rows.filter(r => !r.read), read = rows.filter(r => r.read);
  const item = r => `<div class="ntf ${r.read ? '' : 'unread'}" onclick="notifOpen('${escHtml(r.id)}')">
      <div class="ntf-top"><b>${escHtml(r.actor_name)}</b> · ${String(r.created_at || '').slice(5, 16).replace('T', ' ')}</div>
      <div class="ntf-msg">${escHtml(r.message)}</div></div>`;
  $('notif-drop').innerHTML = `<div class="ntf-head"><b>알림</b>${unread.length ? `<button onclick="notifReadAll(event)">모두 읽음</button>` : ''}</div>
    ${unread.length ? unread.map(item).join('') : '<div class="muted small pad">새 알림이 없어요</div>'}
    ${read.length ? `<details class="ntf-read"><summary>읽은 알림 ${read.length}</summary>${read.slice(0, 15).map(item).join('')}</details>` : ''}
    <div class="ntf-push"><i class="fa-solid fa-mobile-screen"></i><span id="push-label">휴대폰 알림 확인 중…</span><button id="push-btn" class="btn ghost sm" style="display:none;"></button></div>`;
  notifPushRow();
}
async function notifOpen(id) {
  const r = (notifState.rows || []).find(x => x.id === id); if (!r) return;
  if (!r.read) { r.read = true; notifBadge(); dbProxy(`notifications?id=eq.${id}`, { method: 'PATCH', prefer: 'return=minimal', body: { read: true } }).catch(() => {}); }
  $('notif-drop').style.display = 'none'; notifState.open = false;
  // 담당자 보고서 알림 → 그 담당자의 최신 보고서로
  const m = String(r.message || '').match(/\] (.*)$/);
  const rows = await reportsLoad(true).catch(() => []);
  const hit = rows.find(x => x.report?.headline && m && m[1] && String(m[1]).startsWith(String(x.report.headline).slice(0, 12))) || rows[0];
  location.hash = hit ? '#reports/' + hit.id : '#reports';
}
async function notifReadAll(ev) {
  if (ev) ev.stopPropagation();
  try {
    await dbProxy(`notifications?user_id=eq.${encodeURIComponent(SESSION.id)}&read=eq.false`, { method: 'PATCH', prefer: 'return=minimal', body: { read: true } });
    (notifState.rows || []).forEach(r => { r.read = true; });
    notifBadge(); notifRender();
  } catch (e) { toast('' + e.message); }
}

/* ── 휴대폰 알림(웹 푸시) — 기기마다 따로 ── */
function pushB64ToU8(base64) {
  const pad = '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function notifPushRow() {
  const label = $('push-label'), btn = $('push-btn'); if (!label || !btn) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    label.innerHTML = '이 브라우저는 휴대폰 알림 미지원<br><span class="muted">아이폰: Safari 공유 → 홈 화면에 추가 후 그 앱에서 켜세요</span>';
    btn.style.display = 'none'; return;
  }
  let sub = null;
  try { const reg = await navigator.serviceWorker.getRegistration('./'); sub = reg && await reg.pushManager.getSubscription(); } catch {}
  label.textContent = sub ? '이 기기의 휴대폰 알림: 켜짐' : '이 기기의 휴대폰 알림: 꺼짐 — 켜면 보고서가 나올 때 휴대폰으로 와요';
  btn.style.display = '';
  btn.textContent = sub ? '끄기' : '켜기';
  btn.onclick = ev => { ev.stopPropagation(); sub ? pushDisable() : pushEnable(); };
}
async function pushEnable() {
  try {
    const reg = await navigator.serviceWorker.register('./sw.js');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('알림 권한이 허용되지 않았어요'); notifPushRow(); return; }
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushB64ToU8(PUSH_PUBKEY) });
    const j = sub.toJSON();
    await dbProxy('push_subscriptions', { method: 'POST', prefer: 'return=minimal,resolution=merge-duplicates', body: { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_id: SESSION.id } });
    toast('이 기기에서 휴대폰 알림을 켰어요. 보고서가 나오면 알림이 와요');
  } catch (e) { toast('알림 켜기 실패: ' + e.message); }
  notifPushRow();
}
async function pushDisable() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('./');
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
      await dbProxy(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}&user_id=eq.${encodeURIComponent(SESSION.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
      await sub.unsubscribe();
    }
    toast('이 기기의 휴대폰 알림을 껐어요');
  } catch (e) { toast('' + e.message); }
  notifPushRow();
}

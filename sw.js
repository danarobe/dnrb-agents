/* DNRB 에이전트 — 웹 푸시 서비스 워커 (2026-09-15)
   담당자 보고서 알림을 휴대폰·데스크톱 시스템 알림으로 표시한다. 워크스페이스 sw.js와 같은 구조. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'DNRB 에이전트', {
    body: d.body || '',
    data: { url: d.url || './' },
    tag: 'dnrb-agent-report',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.includes('dnrb-agents') && 'focus' in c) { c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});

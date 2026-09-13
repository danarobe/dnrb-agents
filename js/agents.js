/* ──────────────────────────────────────────
   담당자(에이전트) 등록부
   - key = agent_reports.agent 값. 새 담당자를 만들면 여기 한 줄 + Supabase 함수 하나.
   - status: active(돌아가는 중) / planned(준비 중) — 준비 중은 카드만 보이고 실행 버튼이 없다.
   - fn: 실행 함수 이름 (action=run/status 규약을 따른다)
────────────────────────────────────────── */
const AGENTS = [
  {
    key: 'sales', name: '매출 분석 담당', icon: 'fa-chart-line', color: '#4f46e5', status: 'active', fn: 'sales-agent',
    schedule: '매일 아침 8시',
    desc: '어제 매출·주문율·취소반품·광고 효율을 모아 아침 보고서를 씁니다. 오늘 할 일 3가지를 담당별로 제안합니다.',
    sources: ['카페24 매출·상품', '카페24 취소반품', 'Meta 광고'],
  },
  {
    key: 'returns', name: '취소·반품 감시 담당', icon: 'fa-rotate-left', color: '#b91c1c', status: 'active', fn: 'returns-agent',
    schedule: '매일 아침 8시 15분',
    desc: '취소·반품이 지난주보다 늘었는지, 잘 팔리는데 반품 많은 상품과 옵션·사유를 찾아 상세페이지·검수·출고 대응을 제안합니다. 관리 상품은 나아졌는지 판정합니다.',
    sources: ['카페24 취소반품', '순반품률(7/14/30일)', '반품 사유', '반품 관리 목록'],
  },
  {
    key: 'strategy', name: '상품 전략 담당', icon: 'fa-chess', color: '#0891b2', status: 'active', fn: 'strategy-agent',
    schedule: '매일 아침 8시 30분',
    desc: '신상품을 조회수×주문율 4분면으로 나눠 어디에 힘을 실을지 정하고, 급상승·TOP10 상품은 광고 소재를 분석해 추가 소재 컨셉·릴스 훅 멘트·상세 강조점을 제안합니다. 마진과 1+1·할인 행사를 함께 봅니다.',
    sources: ['카페24 NEW ARRIVALS', '조회수·주문율', '혜택(1+1·할인)', 'Meta 광고 소재'],
  },
  {
    key: 'marketing', name: '마케팅 담당', icon: 'fa-bullhorn', color: '#b45309', status: 'planned',
    schedule: '매주 월요일', desc: '광고 성과와 재고를 보고 이번 주 밀어줄 상품과 광고 문구를 제안합니다.', sources: ['Meta 광고', '안정재고'],
  },
  {
    key: 'cs', name: '고객 응대 담당', icon: 'fa-headset', color: '#15803d', status: 'planned',
    schedule: '수시', desc: '문의와 리뷰를 분류하고 답변 초안을 씁니다. 발송은 사람이 확인한 뒤에만.', sources: ['카페24 게시판'],
  },
];
const agentOf = key => AGENTS.find(a => a.key === key);

/* 홈: 담당자 카드 + 최신 보고서 요약 */
async function renderHome() {
  const main = $('main');
  main.innerHTML = `
    <div class="page-head">
      <div><h1>담당자</h1><p class="sub">쇼핑몰 매출을 키우기 위한 AI 담당자들입니다. 각자 정해진 시간에 데이터를 보고 보고서를 씁니다.</p></div>
    </div>
    <div id="setup-notice"></div>
    <div class="cards" id="agent-cards">${AGENTS.map(agentCardSkeleton).join('')}</div>`;
  renderSetupNotice();
  // 최신 보고서 1건씩 (현재는 sales만 데이터가 있음)
  if (!isAdmin()) {
    AGENTS.forEach(a => { const el = $('card-last-' + a.key); if (el) el.innerHTML = '<span class="muted">보고서는 관리자만 볼 수 있어요</span>'; });
    return;
  }
  try {
    const [rows] = await Promise.all([reportsLoad(), actionsLoad()]);
    AGENTS.forEach(a => {
      const el = $('card-last-' + a.key); if (!el) return;
      const r = rows.find(x => x.agent === a.key);
      if (!r) { el.innerHTML = `<span class="muted">${a.status === 'active' ? '아직 보고서가 없어요' : '준비 중'}</span>`; return; }
      if (r.status === 'error') {
        el.innerHTML = `<div class="last-err"><i class="fa-solid fa-triangle-exclamation"></i> ${dateShort(r.report_date)} 보고서 실패 · <a href="#reports/${r.id}">원인 보기</a></div>`;
        return;
      }
      const wa = Array.isArray(r.report?.week_actions) ? r.report.week_actions : [];
      const doneN = wa.filter(x => { const st = (actionsState.map || new Map()).get(r.agent + '|' + actionKey(x)); return st && st.done; }).length;
      el.innerHTML = `<a class="last-report mood-${r.report?.mood || 'neutral'}" href="#reports/${r.id}">
          <span class="when">${dateShort(r.report_date)} 기준 · ${relTime(r.created_at)}</span>
          <b>${escHtml(r.report?.headline || '')}</b>
          ${wa.length ? `<span class="progress"><i class="fa-solid fa-list-check"></i> 이번 주 할 일 ${doneN}/${wa.length} 완료</span>` : ''}
        </a>`;
    });
  } catch (e) {
    AGENTS.forEach(a => { const el = $('card-last-' + a.key); if (el) el.innerHTML = `<span class="muted">불러오기 실패: ${escHtml(e.message)}</span>`; });
  }
}

function agentCardSkeleton(a) {
  const active = a.status === 'active';
  return `<div class="card agent ${active ? '' : 'planned'}" id="card-${a.key}">
    <div class="agent-head">
      <span class="agent-icon" style="background:${a.color}1a;color:${a.color};"><i class="fa-solid ${a.icon}"></i></span>
      <div class="agent-title">
        <b>${a.name}</b>
        <span class="pill ${active ? 'on' : 'off'}">${active ? '활동 중' : '준비 중'}</span>
      </div>
    </div>
    <p class="agent-desc">${a.desc}</p>
    <div class="agent-meta"><i class="fa-regular fa-clock"></i> ${a.schedule} · <i class="fa-solid fa-database"></i> ${a.sources.join(', ')}</div>
    <div class="agent-last" id="card-last-${a.key}"><span class="muted"><i class="fa-solid fa-spinner fa-spin"></i></span></div>
    ${active && isAdmin() ? `<div class="agent-actions">
      <a class="btn ghost" href="#reports">보고서 보기</a>
      <button class="btn primary" id="run-${a.key}" onclick="agentRun('${a.key}')"><i class="fa-solid fa-wand-magic-sparkles"></i> 지금 실행</button>
    </div>` : ''}
  </div>`;
}

/* API 키 미설정 안내 — sales-agent status */
let __statusCache = null;
async function agentStatus(force) {
  if (__statusCache && !force) return __statusCache;
  try { __statusCache = await callFn('sales-agent', { action: 'status' }); } catch { __statusCache = null; }
  return __statusCache;
}
async function renderSetupNotice() {
  const el = $('setup-notice'); if (!el || !isAdmin()) return;
  const st = await agentStatus();
  if (!st || st.configured) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="notice warn">
    <b><i class="fa-solid fa-key"></i> Claude API 키가 아직 없어요.</b> 데이터 수집은 되지만 보고서 본문을 쓰지 못합니다.
    <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>에서 키를 만든 뒤 터미널에서 아래 두 줄을 실행하세요.
    <pre>supabase secrets set ANTHROPIC_API_KEY=키값 --project-ref eeffmbusaqaadeojjlnc
supabase functions deploy sales-agent --project-ref eeffmbusaqaadeojjlnc</pre>
  </div>`;
}

/* 지금 실행 */
async function agentRun(key) {
  const a = agentOf(key); if (!a || !a.fn || !isAdmin()) return;
  const btn = $('run-' + key);
  btnBusy(btn, '분석 중');
  try {
    const startedAt = Date.now();
    const d = await callFn(a.fn, { action: 'run' }, { method: 'POST', body: '{}' });
    if (d.id) { toast('보고서가 도착했어요'); __reportsCache = null; location.hash = '#reports/' + d.id; return; }
    // 2단계 실행(수집 끝 → 별도 함수가 작성 중) — 새 보고서 행이 생길 때까지 10초마다 확인 (최대 4분)
    toast('수집 완료, 보고서 작성 중이에요 (1~2분)');
    btnBusy(btn, '작성 중');
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const rows = await reportsLoad(true).catch(() => []);
      const fresh = rows.find(r => r.agent === key && new Date(r.created_at).getTime() > startedAt - 60000);
      if (fresh) {
        if (fresh.status === 'error') { toast('보고서 작성 실패: ' + (fresh.error || '')); actionsState.map = null; if (location.hash.startsWith('#reports')) renderReports(fresh.id); else renderHome(); return; }
        toast('보고서가 도착했어요'); location.hash = '#reports/' + fresh.id; return;
      }
    }
    toast('아직 작성 중이에요. 잠시 후 보고서 목록을 새로고침해 주세요');
  } catch (e) {
    toast('실패: ' + e.message);
    __reportsCache = null;
    if (location.hash.startsWith('#reports')) renderReports(); else renderHome();
  } finally { btnIdle(btn, '<i class="fa-solid fa-wand-magic-sparkles"></i> 지금 실행'); }
}

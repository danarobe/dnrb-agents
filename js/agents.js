/* ──────────────────────────────────────────
   담당자(에이전트) 등록부
   - key = agent_reports.agent 값. 새 담당자를 만들면 여기 한 줄 + Supabase 함수 하나.
   - status: active(돌아가는 중) / planned(준비 중) — 준비 중은 카드만 보이고 실행 버튼이 없다.
   - fn: 실행 함수 이름 (action=run/status 규약을 따른다)
────────────────────────────────────────── */
const AGENTS = [
  {
    key: 'sales', name: '오늘의 요약', icon: 'fa-newspaper', color: '#4f46e5', status: 'active', fn: 'sales-agent',
    schedule: '매일 아침 8시 45분 (숫자판은 8시)',
    desc: '대표가 아침에 이 한 장만 봐도 되게 씁니다. 8시에 어제 매출 숫자판을 모아 두고, 반품·전략 담당이 그걸 보고 일한 뒤, 8시 45분에 숫자 흐름 + 팀 결론(출처) + 팀 통합 할 일 + 대표 결정 필요만 정리합니다. 상품별 분석은 하지 않습니다.',
    sources: ['매출 숫자판', '오늘 반품·전략 보고서', '광고 소재·상세 점검 보고서'],
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
    desc: '오늘의 결론 칩(밀기·보류·점검·시즌·소싱)과 판매량 급증 TOP10(광고 수·7일 광고비·ROAS·주문율)으로 시작해, 신상품을 조회수×주문율 4분면 격자로 나누고, 급상승·TOP10 집중 상품은 숫자(조회·주문율·판매·마진·ON 광고·14일 광고비·ROAS·이벤트)로 현재 상태와 판매 확대 액션을 씁니다. 잘 팔리는 상품의 코디 상품은 주문 동반 비율로 가려냅니다. 소재 분석은 광고 소재 담당 몫.',
    sources: ['카페24 NEW ARRIVALS', '조회수·주문율', '혜택(1+1·할인)', 'Meta 광고 소재'],
  },
  {
    key: 'ads', name: '광고 운영 담당', icon: 'fa-sliders', color: '#ea580c', status: 'active', fn: 'ads-agent',
    schedule: '매일 아침 8시 35분 (오늘의 요약 바로 앞)',
    desc: 'Meta 소재별 일별 성과와 카페24 매출로 어제 광고 보고서를 직접 씁니다: 요약 카드 7 → 14일 흐름(광고비·ROAS·자연 매출 비율) → 신규 테스트(상품별 3일차까지) → 치고 올라오는 소재 → 하락 소재 → 주의 → 상품별 힘주기 / 증액 보류 / 다시 켜기 / 줄이기 / 유지. 예산을 바꾸지는 않습니다.',
    sources: ['Meta 소재별 일별 성과 14일', '카페24 일별 매출·어제 판매', '오늘 상품 전략·반품 보고서', 'Meta ON·꺼진 광고'],
  },
  {
    key: 'detail', name: '상세페이지 점검 담당', icon: 'fa-file-image', color: '#7c3aed', status: 'active', fn: 'detail-agent', onDemand: true,
    schedule: '요청할 때만 (자동 실행 없음)',
    desc: '상품을 고르면 상세페이지 이미지를 조각내 읽고(Gemini) 실측표·사이즈 가이드·소재·색상별 컷이 빠졌는지, 첫 화면에 무엇을 내세울지, 붙여 넣을 문장까지 제안합니다. 상품 하나에 약 40원, 같은 상세는 다시 읽지 않습니다.',
    sources: ['카페24 상세 이미지', '상품 전략·반품 보고서'],
  },
  {
    key: 'creative', name: '광고 소재 담당', icon: 'fa-bullhorn', color: '#b45309', status: 'active', fn: 'creative-agent', onDemand: true, batch: true,
    schedule: '매주 월요일 아침 9시 + 요청할 때',
    desc: '판매 급상승 5개와 베스트 5개 상품의 상세페이지·리뷰·기존 광고 성과를 읽고, 어떤 후킹 포인트로 소재를 만들지(첫 3초 문구·첫 장면·본문·형식·피할 소구·테스트 순서) 제작안을 씁니다. 상품 하나만 골라 요청할 수도 있어요.',
    sources: ['카페24 상세 이미지', '상품 후기', 'Meta 소재 성과', '반품 사유·검색 트렌드'],
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
    <div id="credit-strip"></div>
    ${orgChartHtml()}
    <div class="cards" id="agent-cards">${AGENTS.map(agentCardSkeleton).join('')}</div>`;
  renderSetupNotice();
  if (SESSION?.role === 'admin') creditLoad();
  // 최신 보고서 1건씩 (현재는 sales만 데이터가 있음)
  if (!isAdmin()) {
    AGENTS.forEach(a => { const el = $('card-last-' + a.key); if (el) el.innerHTML = '<span class="muted">보고서는 관리자만 볼 수 있어요</span>'; });
    return;
  }
  try {
    const [rows] = await Promise.all([reportsLoad(), actionsLoad()]);
    orgChartStatus(rows);
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

/* ── 사무실 조직도 (2026-10-17 사용자 요청 "사무실 부서처럼 한눈에" → 같은 날 "글이 너무 많아 복잡하다" 지적으로 단순화) ──
   그림에는 아이콘·이름·시간·한 줄 질문·화살표만. 설명은 접힌 '이 그림 읽는 법' 안에.
   아침 줄: 매출(08:00) → 반품(08:15) → 전략(08:30). 전략·반품 아래로 상세 점검·광고 소재(요청형)에 '부탁' 화살표.
   상태는 orgChartStatus가 실제 최신 보고서로 채운다(오늘 보고 완료 ✓, 넘긴 요청 수). */
const ORG_DESKS = {
  returns:  { time: '08:15', q: '반품은 괜찮나?' },
  strategy: { time: '08:30', q: '어떤 상품을 밀까?' },
  sales:    { time: '08:45', q: '오늘, 한 장으로?' },
  ads:      { time: '08:35', q: '어떤 광고에 힘을 줄까?' },
  detail:   { time: '요청하면', q: '상세 어디를 고칠까?' },
  creative: { time: '월요일 · 요청하면', q: '어떤 소재로 팔까?' },
};
function orgDesk(key) {
  const a = agentOf(key), d = ORG_DESKS[key];
  return `<a class="desk" id="desk-${key}" href="#reports/agent:${key}" style="--c:${a.color};">
    <span class="agent-icon" style="background:${a.color}1a;color:${a.color};"><i class="fa-solid ${a.icon}"></i></span>
    <b>${escHtml(a.name.replace(' 담당', ''))}</b>
    <span class="desk-time">${escHtml(d.time)}</span>
    <span class="desk-q">${escHtml(d.q)}</span>
    <span class="desk-status" id="desk-status-${key}"></span>
  </a>`;
}
function orgChartHtml() {
  const right = `<div class="org-arrow"><i class="fa-solid fa-arrow-right-long"></i></div>`;
  const down = (label, cls) => `<div class="org-down ${cls}"><i class="fa-solid fa-arrow-down-long"></i><span>${escHtml(label)}</span></div>`;
  return `<div class="org">
    <div class="org-head"><b><i class="fa-solid fa-building"></i> 매출 성장팀</b><span class="muted small">08:00 어제 매출 숫자판 → 반품·전략·광고 운영이 보고 일하고 → 요약이 한 장으로 마무리</span></div>
    <div class="org-rules">
      <div class="rule"><span class="rule-k daily"><i class="fa-solid fa-sun"></i> 매일 자동</span><span>08:00 숫자판 → 08:15 취소·반품 → 08:30 상품 전략 → 08:35 광고 운영 → 08:45 오늘의 요약 <b class="muted">(알림은 요약 1번)</b></span></div>
      <div class="rule"><span class="rule-k weekly"><i class="fa-solid fa-calendar-week"></i> 매주 자동</span><span>월요일 09:00 광고 소재 — 급상승 5 + 베스트 5 상품 제작안</span></div>
      <div class="rule"><span class="rule-k ask"><i class="fa-solid fa-hand-pointer"></i> 요청할 때</span><span>상세페이지 점검 · 광고 소재 1개 · 담당자에게 질문 — 버튼으로만, 자동 실행 없음</span></div>
    </div>
    <div class="org-grid">
      ${orgDesk('returns')}${right}${orgDesk('strategy')}${right}${orgDesk('ads')}${right}${orgDesk('sales')}
      ${down('부탁', 'd1')}<div></div>${down('부탁', 'd2')}<div></div><div class="org-gap"></div><div class="org-gap"></div><div class="org-gap"></div>
      ${orgDesk('detail')}<div></div>${orgDesk('creative')}<div></div><div class="org-gap"></div><div class="org-gap"></div><div class="org-gap"></div>
    </div>
    <details class="org-help"><summary><i class="fa-regular fa-circle-question"></i> 이 그림 읽는 법</summary>
      <ul>
        <li><b>→</b> 08:00에 모인 매출 숫자판(급등·하락 상품)을 반품·전략이 읽고 답하고, 요약이 둘의 보고서를 합쳐 한 장으로 씁니다. 예: 숫자판 "이 상품 급등" → 반품 "반품률 8%로 안전" → 요약 "확대 적합".</li>
        <li><b>부탁</b> 전략·반품이 "이 상품 상세 점검해 줘", "이 상품 소재 만들어 줘"라고 넘기면, 보고서의 버튼으로 바로 실행합니다.</li>
        <li><b>✓</b> 오늘 보고서가 나왔다는 뜻. 담당자를 누르면 그 보고서로 갑니다. 담당자는 제안만 하고, 결정은 대표가 합니다.</li>
      </ul>
    </details>
  </div>`;
}
function orgChartStatus(rows) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(Date.now() - 86400000));   // 오늘 아침 보고서의 기준일 = 어제
  Object.keys(ORG_DESKS).forEach(key => {
    const el = $('desk-status-' + key); if (!el) return;
    const r = rows.find(x => x.agent === key);
    if (!r) return;
    const done = r.status === 'ok' && r.report_date === today;
    const give = ((r.report || {}).handoffs || []).length;
    el.innerHTML = `${done ? '<span class="desk-ok" title="오늘 보고 완료"><i class="fa-solid fa-check"></i></span>' : r.status === 'error' ? '<span class="desk-ng" title="보고서 실패"><i class="fa-solid fa-exclamation"></i></span>' : ''}${give ? `<span class="desk-ask" title="동료에게 넘긴 요청">부탁 ${give}</span>` : ''}`;
  });
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
    ${active && isAdmin() ? (a.onDemand ? `<div class="agent-actions ondemand">
      <input type="text" id="pick-${a.key}" list="pick-list-${a.key}" placeholder="상품명으로 찾기 (예: 베즈 모달)" autocomplete="off" oninput="pickSuggest('${a.key}')">
      <datalist id="pick-list-${a.key}"></datalist>
      <a class="btn ghost" href="#reports/agent:${a.key}">보고서 보기</a>
      ${a.batch ? `<button class="btn ghost" id="batch-${a.key}" onclick="batchRun('${a.key}')" title="급상승 5 + 베스트 5를 차례로 분석 (10~20분)"><i class="fa-solid fa-layer-group"></i> 10개 분석</button>` : ''}
      <button class="btn primary" id="run-${a.key}" onclick="pickAndRun('${a.key}')"><i class="fa-solid fa-magnifying-glass"></i> ${a.key === 'creative' ? '이 상품 분석' : '이 상품 점검'}</button>
    </div>` : `<div class="agent-actions">
      <a class="btn ghost" href="#reports/agent:${a.key}">보고서 보기</a>
      <button class="btn primary" id="run-${a.key}" onclick="agentRun('${a.key}')"><i class="fa-solid fa-wand-magic-sparkles"></i> 지금 실행</button>
    </div>`) : ''}
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
async function agentRun(key, params = {}) {
  const a = agentOf(key); if (!a || !a.fn || !isAdmin()) return;
  const btn = $('run-' + key);
  const slow = key === 'detail' || key === 'creative';   // 상세 이미지를 읽는 담당자는 오래 걸린다
  btnBusy(btn, slow ? '읽는 중' : '분석 중');
  try {
    const startedAt = Date.now();
    const d = await callFn(a.fn, { action: 'run', ...params }, { method: 'POST', body: '{}' });
    if (d.id) { toast('보고서가 도착했어요'); __reportsCache = null; location.hash = '#reports/' + d.id; return; }
    // 2단계 실행(수집 끝 → 별도 함수가 작성 중) — 새 보고서 행이 생길 때까지 10초마다 확인 (최대 6분: 출력 잘림 자동 재시도 한 번까지 품음, 2026-10-13)
    toast(slow ? (d.message || '상세 이미지 읽는 중 (상품당 2~4분)') : '수집 완료, 보고서 작성 중이에요 (보통 1~2분)');
    btnBusy(btn, '작성 중');
    for (let i = 0; i < (slow ? 48 : 36); i++) {
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
  } finally { btnIdle(btn, a.onDemand ? `<i class="fa-solid fa-magnifying-glass"></i> ${key === 'creative' ? '이 상품 분석' : '이 상품 점검'}` : '<i class="fa-solid fa-wand-magic-sparkles"></i> 지금 실행'); }
}

/* 묶음 실행(광고 소재 담당: 급상승 5 + 베스트 5) — 10~20분 걸려 기다리지 않고 알림으로 받는다 */
async function batchRun(key) {
  const a = agentOf(key); if (!a || !isAdmin()) return;
  if (!confirm('급상승 5개 + 베스트 5개 상품을 차례로 분석할까요?\n10~20분 걸리고 약 2,000원 안팎이 듭니다(상품당 약 200원). 끝나면 알림이 와요.')) return;
  const btn = $('batch-' + key); btnBusy(btn, '시작 중');
  try {
    const d = await callFn(a.fn, { action: 'run' }, { method: 'POST', body: '{}' });
    toast(d.message || '분석을 시작했어요. 끝나면 알림이 와요');
  } catch (e) { toast('실패: ' + e.message); }
  finally { btnIdle(btn, '<i class="fa-solid fa-layer-group"></i> 10개 분석'); }
}

/* ── 상세 점검: 상품 골라 요청 (2026-09-13 사용자 결정 — 자동 실행 없음) ──
   상품 목록은 카페24 최근 30일 조회 상품(summary)에서 가져와 datalist로 검색. 값은 '상품명 · #번호' 형태. */
const pickState = { products: null, loading: false };
async function pickLoadProducts() {
  if (pickState.products || pickState.loading) return pickState.products;
  pickState.loading = true;
  try {
    const end = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()) + 'T12:00:00Z');
    const e = new Date(end); e.setUTCDate(e.getUTCDate() - 1); const st = new Date(end); st.setUTCDate(st.getUTCDate() - 30);
    const d = await callFn('cafe24-analytics', { action: 'summary', start_date: st.toISOString().slice(0, 10), end_date: e.toISOString().slice(0, 10) });
    pickState.products = (d.rows || []).map(r => ({ no: r.product_no, name: r.product_name, views: r.views })).sort((a, b) => b.views - a.views);
  } catch (e) { toast('상품 목록을 못 불러왔어요: ' + e.message); pickState.products = []; }
  finally { pickState.loading = false; }
  return pickState.products;
}
async function pickSuggest(key) {
  const inp = $('pick-' + key), list = $('pick-list-' + key); if (!inp || !list) return;
  const ps = await pickLoadProducts(); const q = inp.value.trim().toLowerCase().replace(/\s+/g, '');
  if (!q) { list.innerHTML = ''; return; }
  list.innerHTML = ps.filter(p => p.name.toLowerCase().replace(/\s+/g, '').includes(q)).slice(0, 12)
    .map(p => `<option value="${escHtml(p.name)} · #${p.no}"></option>`).join('');
}
async function pickAndRun(key) {
  const inp = $('pick-' + key); const v = (inp?.value || '').trim();
  let no = 0;
  const m = v.match(/#(\d+)\s*$/); if (m) no = Number(m[1]);
  else if (/^\d+$/.test(v)) no = Number(v);
  else if (v) { const ps = await pickLoadProducts(); const hit = ps.find(p => p.name.toLowerCase().replace(/\s+/g, '') === v.toLowerCase().replace(/\s+/g, '')) || ps.find(p => p.name.toLowerCase().includes(v.toLowerCase())); if (hit) no = hit.no; }
  if (!no) { toast('상품을 목록에서 골라 주세요 (상품명 입력 후 선택)'); inp?.focus(); return; }
  await agentRun(key, { product_no: String(no) });
}
async function detailRun(no, name) {
  if (!isAdmin()) return;
  if (!confirm(`'${name}' 상세페이지를 점검할까요? (약 1분, 40원 안팎)`)) return;
  toast('상세 이미지를 읽는 중이에요 (1~2분)');
  try {
    const startedAt = Date.now();
    const d = await callFn('detail-agent', { action: 'run', product_no: String(no) }, { method: 'POST', body: '{}' });
    if (d.error) throw new Error(d.error);
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const rows = await reportsLoad(true).catch(() => []);
      const fresh = rows.find(r => r.agent === 'detail' && new Date(r.created_at).getTime() > startedAt - 60000);
      if (fresh) { toast('상세 점검이 도착했어요'); location.hash = '#reports/' + fresh.id; return; }
    }
    toast('아직 읽는 중이에요. 잠시 후 보고서 목록을 확인해 주세요');
  } catch (e) { toast('실패: ' + e.message); }
}

/* ── Claude 크레딧 소진액 (2026-10-18 사용자 요청 — 담당자 화면 맨 위) ──
   서버 agent-ask?action=credit(관리자만): 저장된 호출별 토큰 × claude-opus-5 공개 가격 → 이번 주(월~오늘) 하루 평균.
   남은 크레딧은 Anthropic이 알려 주는 방법이 없어 표시하지 않고(사용자 결정) 충전 페이지 링크, '잔액 부족' 오류가 마지막 성공 뒤에 났으면 빨간 경고. */
const CREDIT_BILLING_URL = 'https://console.anthropic.com/settings/billing';
const USD_KRW = 1400;   // 원화 환산 기준(참고용 — 청구는 달러)
async function creditLoad() {
  const el = $('credit-strip'); if (!el) return;
  let d;
  try { d = await callFn('agent-ask', { action: 'credit' }); }
  catch (e) { el.innerHTML = `<div class="muted small" style="margin-bottom:12px;">Claude 사용액을 불러오지 못했어요 — ${escHtml(e.message)}</div>`; return; }
  const usd = v => '$' + Number(v || 0).toFixed(2);
  const won = v => '약 ' + (Math.round(Number(v || 0) * USD_KRW / 10) * 10).toLocaleString('ko-KR') + '원';
  const days = (d.by_day || []).map(x => `${x.date.slice(5).replace('-', '/')}  ${usd(x.usd)} (${x.calls}회)`).join('&#10;');
  const kinds = Object.entries(d.by_kind || {}).map(([k, v]) => `${k} ${usd(v)}`).join(' · ');
  const low = d.credit_low;
  const at = low ? new Date(low.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  el.innerHTML = `<div class="tiles">
    <div class="tile" title="날짜별 사용액&#10;${days}&#10;&#10;${escHtml(d.price_note || '')}">
      <div class="t-label"><i class="fa-solid fa-coins" style="color:#d97706;"></i> 이번 주 하루 평균 Claude 사용액</div>
      <div class="t-value">${usd(d.avg_usd)} <span class="muted small" style="font-weight:600;">${won(d.avg_usd)}</span></div>
      <div class="t-sub">이번 주 합계 ${usd(d.total_usd)} · ${d.days}일(${String(d.week_start).slice(5).replace('-', '/')}~)${kinds ? ' · ' + escHtml(kinds) : ''}</div>
    </div>
    <div class="tile" style="${low ? 'border-color:#fecaca;background:var(--bad-bg);' : ''}">
      <div class="t-label"><i class="fa-solid fa-wallet" style="color:${low ? 'var(--bad)' : '#4f46e5'};"></i> 남은 크레딧</div>
      ${low
        ? `<div class="t-value" style="color:var(--bad);">크레딧 바닥 — 충전 필요</div><div class="t-sub" style="color:#991b1b;">${escHtml(at)}부터 '잔액 부족'으로 실패 중 · <a href="${CREDIT_BILLING_URL}" target="_blank" rel="noopener">충전하러 가기 <i class="fa-solid fa-arrow-up-right-from-square"></i></a></div>`
        : `<div class="t-value"><a href="${CREDIT_BILLING_URL}" target="_blank" rel="noopener" style="color:inherit;">충전 페이지에서 확인 <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:.8em;"></i></a></div><div class="t-sub">Anthropic이 남은 금액을 알려 주지 않아 충전 페이지에서만 볼 수 있어요</div>`}
    </div>
  </div>`;
}

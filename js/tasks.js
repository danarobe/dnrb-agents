/* ──────────────────────────────────────────
   오늘 할 일 (2026-11-07) — 직원용 팀별 할 일 보드 + 대표 결정함
   데이터: agent-tasks 함수(team_tasks). 매일 보고서 4개의 할 일을 상품 1개 × 할 일 1개로 쪼개 같은 일은 하나로 합친 것.
   - 대표 결정함: 예산·가격처럼 대표 승인이 필요한 일. 관리자만 승인·보류(서버도 강제). 승인 전에는 팀 목록에 안 나온다.
   - 팀 목록: 완료 버튼. 광고 착수·광고 줄이기·상세 보강은 데이터(ON 광고 수·상세 이미지)로 확인되면 저절로 완료.
   - 끝난 일·보류한 일은 다음 날 보고서의 할 일에서 빠진다(_shared/agent.ts weekContext).
   2차(같은 날, 사용자 "주말엔 직원만 쉬고 대표는 대부분 본다"):
   - 직원 일(MD/컨텐츠팀·물류/CS팀)은 출근일(토·일·공휴일 제외)로 '며칠째'·'기한 지남'을 센다. 대표 일은 달력 날짜.
   - 쉬고 온 첫 출근일: '쉬는 동안' 상자(새로 생긴 일·대표가 승인한 일·저절로 끝난 일).
   - 쉬기 전날: '쉬기 전에 할 일'(다음 출근일 전에 마감).
   - 직원이 쉬는 날: 그 사이 마감인 직원 일을 대표 결정함에 올림(내가 처리함 · 다음 출근일로 · 넘기기).
   - 에이전트가 더는 제안하지 않는 일은 사라지지 않고 '확인 후 닫기' 상자에 남는다.
   3차(2026-11-10, 사용자 "근무 관리 직원 명단 = 사무실 팀, 휴가도"): 팀 = 역할(광고팀 마케터·상품팀 MD·물류/CS팀 CS·물류).
   - 팀원 전원이 종일 휴가인 날은 그 팀의 쉬는 날(team_off) — 출근일 계산·쉬기 전·쉬는 동안 마감(대표 결정함)에 팀별로 반영. 반차는 출근.
   - 맨 위 '휴가' 띠(오늘·앞으로 7일), 팀 탭·할 일에 '팀원 휴가'·'팀 전원 휴가' 표시.
   4차(2026-11-10, 사용자 "개선 제안 4개 다 + 종류별로 따로 보기"):
   - 대표 결정함·팀별 할 일 모두 종류(광고 착수·광고 증액…) 칩으로 따로 보기. 결정함은 '전체'일 때 종류별로 묶어 보여 줌.
   - 광고 착수·증액 승인 칸에 방식·하루 예산 → 승인하면 담당 팀에 바로 알림(서버), 직원 카드에 '대표 승인 · 방식 · 하루 n만원'.
   - 광고 일 카드: 지금 광고 상태(ON·꺼짐·7일 광고비·ROAS), '꺼진 광고 n개 보기', 광고 착수는 '제작안 만들기/보기'.
   - 광고 줄이기·기존 예산 안 다시 켜기는 결정함을 거치지 않고 바로 팀 할 일(서버가 needs_ceo=false).
────────────────────────────────────────── */
const tasksState = { data: null, team: '', kind: '', ceoKind: '' };
const TEAMS = ['MD/컨텐츠팀', '물류/CS팀', '대표'];   // 2026-11-10 'CS팀' → '물류/CS팀', 같은 날 광고팀·상품팀 → 'MD/컨텐츠팀'(역할 통합)
const AUTO_KIND = { '광고 착수': 'ON 광고가 늘면', '광고 줄이기': 'ON 광고가 줄면', '상세 보강': '상세 이미지가 바뀌면' };
const KIND_ICON = { '광고 착수': 'fa-play', '광고 증액': 'fa-arrow-trend-up', '광고 줄이기': 'fa-arrow-trend-down', '상세 보강': 'fa-file-image', '노출·기획전': 'fa-store', 'CS·출고': 'fa-truck', '재고·소싱': 'fa-boxes-stacked', '가격·혜택': 'fa-tag', '지킬 원칙': 'fa-shield-halved', '기타': 'fa-circle-dot' };
const KIND_ORDER = Object.keys(KIND_ICON);
const kindRank = k => { const i = KIND_ORDER.indexOf(k); return i < 0 ? 99 : i; };
// 승인할 때 고르는 방식 (서버 agent-tasks METHODS와 같은 코드)
const METHOD_OPTS = { '광고 착수': ['new', 'reuse', 'free'], '광고 증액': ['raise', 'add', 'free'] };
const METHOD_LABEL = { new: '새 소재로 테스트', reuse: '기존 소재·꺼진 광고 다시 켜기', raise: '지금 광고 예산 늘리기', add: '소재 추가해 늘리기', free: '방식은 담당 판단' };
const manwon = w => { const m = Number(w) / 10000; return `${Number.isInteger(m) ? m : m.toFixed(1)}만원`; };
const detailLabel = d => { if (!d) return ''; const p = []; if (d.method && d.method !== 'free' && METHOD_LABEL[d.method]) p.push(METHOD_LABEL[d.method]); if (Number(d.daily_won) > 0) p.push(`하루 ${manwon(d.daily_won)}`); return p.join(' · '); };
const PAUSE_LABEL = { PAUSED: '광고 꺼짐', ADSET_PAUSED: '광고세트 꺼짐', CAMPAIGN_PAUSED: '캠페인 꺼짐' };
const WD = '일월화수목금토';
const isCeo = () => SESSION?.role === 'admin';
const tkName = t => t.product_name ? (typeof tcCore === 'function' ? tcCore(t.product_name) : t.product_name) : '';
const isStaffTask = t => t.owner !== '대표';
const pendingCeo = t => t.status === 'open' && t.needs_ceo && !t.decision;
const kstDate = iso => iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }) : '';
const md2 = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}(${WD[new Date(d + 'T12:00:00Z').getUTCDay()]})`;

// ── 직원 출근일 (토·일 + 공휴일 표) ──
const tdAdd = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const calDiff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const LEAVE_LABEL = { annual: '연차', half: '반차', summer: '여름휴가', sick: '병가' };
function workCal(holidays, extra) {
  const off = new Set([...(holidays || []), ...(extra || [])]);
  const isOff = d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6 || off.has(d); };
  const next = d => { let x = tdAdd(d, 1); for (let i = 0; i < 30 && isOff(x); i++) x = tdAdd(x, 1); return x; };
  const prev = d => { let x = tdAdd(d, -1); for (let i = 0; i < 30 && isOff(x); i++) x = tdAdd(x, -1); return x; };
  const between = (a, b) => { let n = 0, x = a; for (let i = 0; i < 200 && x < b; i++) { x = tdAdd(x, 1); if (!isOff(x)) n++; } return n; };   // (a, b] 출근일 수
  return { isOff, next, prev, between };
}

async function tasksLoad() {
  tasksState.data = await callFn('agent-tasks', { action: 'list' });
  try { tasksState.team = localStorage.getItem('tasks_team') || ''; tasksState.kind = localStorage.getItem('tasks_kind') || ''; tasksState.ceoKind = localStorage.getItem('tasks_ceo_kind') || ''; } catch { /* 저장 불가 */ }
  return tasksState.data;
}

async function renderTasks() {
  const main = $('main');
  main.innerHTML = `<div class="page-head"><div><h1>오늘 할 일</h1><p class="sub">AI 담당자 4명이 낸 할 일을 팀별로 모았어요. 같은 일은 하나로 합쳤고, 광고 켜기·상세 보강은 데이터로 확인되면 저절로 완료돼요. 직원 할 일은 출근일 기준으로 세요.</p></div></div><div id="tasks-body"><div class="muted"><i class="fa-solid fa-spinner fa-spin"></i> 불러오는 중</div></div>`;
  try { await tasksLoad(); tasksDraw(); }
  catch (e) { $('tasks-body').innerHTML = `<div class="box err-text">할 일을 불러오지 못했어요: ${escHtml(e.message)}</div>`; }
}

function srcChips(t) {
  const seen = new Set();
  return (t.sources || []).filter(s => { if (seen.has(s.agent)) return false; seen.add(s.agent); return true; }).map(s => {
    const a = agentOf(s.agent);
    return a ? `<span class="tk-src" style="color:${a.color};background:${a.color}14;" title="${escHtml(a.name)} ${escHtml(s.report_date || '')}"><i class="fa-solid ${a.icon}"></i></span>` : '';
  }).join('');
}
function dueBadge(t, today, cal0) {
  if (!t.due) return '';
  const cal = cal0.of(t.owner);
  const staff = isStaffTask(t);
  if (t.due < today) {
    const n = staff ? cal.between(t.due, today) : calDiff(t.due, today);
    return n > 0 ? `<span class="tk-due late">${staff ? `출근일 ${n}일 지남` : `${n}일 지남`}</span>` : `<span class="tk-due">${md2(t.due)}까지</span>`;
  }
  if (t.due === today) return '<span class="tk-due today">오늘까지</span>';
  const offNote = staff && cal.isOff(t.due) ? ' · 담당 팀 쉬는 날' : '';
  return `<span class="tk-due${offNote ? ' today' : ''}">${md2(t.due)}까지${offNote}</span>`;
}
function ageBadge(t, today, cal0) {
  const cal = cal0.of(t.owner);
  const staff = isStaffTask(t);
  const n = staff ? cal.between(t.first_seen, today) : calDiff(t.first_seen, today);
  if (n < 2) return '';
  return `<span class="tk-age${staff && n >= 4 ? ' hot' : ''}" title="처음 제안된 날 ${escHtml(t.first_seen)}${staff ? ' · 출근일 기준' : ''}">${staff ? `출근 ${n}일째` : `${n}일째`}</span>`;
}
function taskHead(t) {
  const nm = tkName(t);
  return `<div class="tk-title">${nm ? `<b class="tk-prod" title="${escHtml(t.product_name)}">${escHtml(nm)}</b>` : ''}<span class="tk-what">${escHtml(t.title)}</span></div>`;
}
const kindChip = t => `<span class="tk-kind"><i class="fa-solid ${KIND_ICON[t.kind] || 'fa-circle-dot'}"></i> ${escHtml(t.kind)}</span>`;

// ── 광고 일 카드: 지금 광고 상태 · 꺼진 광고 · 제작안 ──
const adInfo = t => String(t.kind).startsWith('광고') && t.product_no ? (tasksState.data?.ad_info || {})[t.product_no] : null;
function adLine(t) {
  const a = adInfo(t); if (!a) return '';
  const p7 = a.ad_7d || {};
  const bits = [a.active_ads != null ? `ON 광고 ${a.active_ads}개` : '', a.paused_ads ? `꺼짐 ${a.paused_ads}개` : '',
    p7.spend != null ? `최근 7일 광고비 ${manwon(p7.spend)}` : '', p7.roas != null ? `ROAS ${p7.roas}` : '', p7.purchases != null ? `구매 ${p7.purchases}건` : ''].filter(Boolean);
  if (!bits.length) return '';
  const src = a.report_id ? `<a class="linkish" href="#reports/${escHtml(a.report_id)}">${a.report_date ? md2(a.report_date) : ''} 광고 운영 보고서</a>` : '';
  return `<div class="tk-ad"><i class="fa-brands fa-meta"></i> 지금 ${bits.map(escHtml).join(' · ')}${src ? ` <span class="muted">· ${src}</span>` : ''}</div>`;
}
function pausedBox(t) {
  const a = adInfo(t); if (!a || !(a.paused_ads > 0)) return '';
  const p = a.paused_30d || {};
  const sum = p.spend != null ? `꺼진 광고들의 최근 30일: 광고비 ${manwon(p.spend)} · ROAS ${p.roas ?? '—'} · 구매 ${p.purchases ?? 0}건` : '';
  const list = (a.paused_list || []).map(x => `<li><span class="tk-adname">${escHtml(x.name || '')}</span> <span class="muted">${escHtml(PAUSE_LABEL[x.status] || x.status || '')}${x.updated ? ` · ${escHtml(String(x.updated).slice(5, 10).replace('-', '/'))} 바뀜` : ''}</span></li>`).join('');
  return `<details class="tk-paused"><summary><i class="fa-solid fa-power-off"></i> 꺼진 광고 ${Number(a.paused_ads)}개 보기</summary>${sum ? `<div class="muted small">${sum}</div>` : ''}${list ? `<ul>${list}</ul>` : ''}${a.paused_ads > (a.paused_list || []).length ? `<div class="muted small">상위 ${(a.paused_list || []).length}개만 보여요</div>` : ''}<div class="muted small">켜기 전에 왜 껐는지(성과·품절·시즌) 확인하세요.</div></details>`;
}
function creativeBtn(t) {
  if (t.kind !== '광고 착수' || !t.product_no || t.reenable) return '';
  const c = (tasksState.data?.creative || {})[t.product_no];
  const view = c && c.report_id ? `<a class="btn sm ghost" href="#reports/${escHtml(c.report_id)}"><i class="fa-solid fa-bullhorn"></i> 제작안 보기 (${escHtml(md2(c.date))})</a>` : '';
  const run = `<button class="btn sm ghost" onclick="taskCreative(${Number(t.product_no)}, this)" data-name="${escHtml(t.product_name || '')}"><i class="fa-solid fa-wand-magic-sparkles"></i> ${view ? '새 제작안' : '제작안 만들기'}</button>`;
  return `<div class="tk-links">${view}${run}</div>`;
}
const reenableChip = t => t.reenable ? '<span class="tk-free" title="하루 총예산을 늘리지 않고 꺼진 광고를 다시 켜는 일 — 대표 승인 없이 바로. 예산을 늘려야 하면 광고 증액으로"><i class="fa-solid fa-power-off"></i> 꺼진 광고 다시 켜기 · 기존 예산 안에서</span>' : (t.kind === '광고 줄이기' ? '<span class="tk-free" title="줄이기는 대표 승인 없이 바로"><i class="fa-solid fa-bolt"></i> 승인 없이 바로</span>' : '');

function taskRow(t, today, cal, extraChip = '') {
  const auto = AUTO_KIND[t.kind];
  const when = auto && /자동 완료|저절로/.test(t.done_when || '') ? '' : t.done_when;   // 기본 문구면 자동 완료 표시와 겹치므로 생략
  const approved = t.decision === 'approve';
  return `<div class="tk-row" data-id="${t.id}">
    <button class="tk-check" onclick="taskDone('${t.id}', this)" title="완료로 표시"><i class="fa-solid fa-check"></i></button>
    <div class="tk-main">
      ${taskHead(t)}
      <div class="tk-meta">${extraChip}${kindChip(t)}${reenableChip(t)}${approved ? `<span class="tk-ok"><i class="fa-solid fa-stamp"></i> 대표 승인${detailLabel(t.decision_detail) ? ` · ${escHtml(detailLabel(t.decision_detail))}` : ''}${t.decision_note ? ` · ${escHtml(t.decision_note)}` : ''}</span>` : ''}${dueBadge(t, today, cal)}${ageBadge(t, today, cal)}<span class="tk-team">${escHtml(t.owner)}</span>${srcChips(t)}</div>
      ${approved && t.decision_detail && !Number(t.decision_detail.daily_won) && ['광고 착수', '광고 증액'].includes(t.kind) ? '<div class="tk-why"><i class="fa-solid fa-coins"></i> 예산은 담당 판단으로 승인됐어요</div>' : ''}
      ${adLine(t)}
      ${when ? `<div class="tk-when"><i class="fa-regular fa-flag"></i> 완료 기준: ${escHtml(when)}${auto ? ` <span class="tk-auto"><i class="fa-solid fa-robot"></i> ${auto} 저절로 완료</span>` : ''}</div>` : (auto ? `<div class="tk-when"><span class="tk-auto"><i class="fa-solid fa-robot"></i> ${auto} 저절로 완료</span></div>` : '')}
      ${t.why ? `<div class="tk-why">${escHtml(t.why)}</div>` : ''}
      ${pausedBox(t)}${creativeBtn(t)}
    </div>
  </div>`;
}
function ceoCard(t, today, cal) {
  const opts = METHOD_OPTS[t.kind];
  // 광고 착수·증액: 승인할 때 방식·하루 예산을 같이 적는다(비우면 '담당 판단')
  const form = opts && isCeo() ? `<div class="tk-dec">
      <label><span>방식</span><select class="tk-m">${opts.map(m => `<option value="${m}">${escHtml(METHOD_LABEL[m])}</option>`).join('')}</select></label>
      <label><span>${t.kind === '광고 증액' ? '늘린 뒤 하루 예산' : '하루 예산'}</span><input class="tk-b" type="number" inputmode="decimal" min="0" step="0.5" placeholder="비우면 담당 판단"><em>만원</em></label>
    </div>` : '';
  return `<div class="tk-ceo" data-id="${t.id}">
    ${taskHead(t)}
    <div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span>${ageBadge(t, today, cal)}${srcChips(t)}</div>
    ${adLine(t)}
    ${t.why ? `<div class="tk-why">${escHtml(t.why)}</div>` : ''}
    ${t.decision_note ? `<div class="tk-why"><i class="fa-solid fa-clock-rotate-left"></i> ${escHtml(t.decision_note)}</div>` : ''}
    ${pausedBox(t)}
    ${t.stale_since ? `<div class="tk-why"><i class="fa-solid fa-circle-question"></i> ${md2(t.stale_since)}부터 에이전트가 더는 제안하지 않아요 — 필요 없으면 닫기</div>` : ''}
    ${form}
    ${isCeo() ? `<div class="tk-ceo-btns"><button class="btn sm primary" onclick="taskDecide('${t.id}','approve',this)"><i class="fa-solid fa-check"></i> 승인${isStaffTask(t) ? ' · 팀에 알림' : ''}</button><button class="btn sm ghost" onclick="taskDecide('${t.id}','hold',this)"><i class="fa-solid fa-pause"></i> 보류</button>${t.stale_since ? `<button class="btn sm ghost" onclick="taskClose('${t.id}', this, '닫을까요? 필요 없음으로 기록돼요.')"><i class="fa-solid fa-xmark"></i> 닫기</button>` : ''}</div>` : '<div class="muted small">대표 승인을 기다리는 중이에요</div>'}
  </div>`;
}
// 종류 칩: 지금 보이는 일들의 종류만(고른 종류는 0개여도 남겨 풀 수 있게)
function kindChips(list, cur, fn) {
  const n = {}; list.forEach(t => { n[t.kind] = (n[t.kind] || 0) + 1; });
  const kinds = Object.keys(n); if (cur && !kinds.includes(cur)) kinds.push(cur);
  if (kinds.length < 2 && !cur) return '';
  kinds.sort((a, b) => kindRank(a) - kindRank(b));
  return `<div class="tk-kinds"><span class="tk-kinds-l">종류</span>${[['', `전체 ${list.length}`], ...kinds.map(k => [k, `${k} ${n[k] || 0}`])].map(([k, l]) => `<button class="kchip${cur === k ? ' on' : ''}" onclick="${fn}('${k}')">${k ? `<i class="fa-solid ${KIND_ICON[k] || 'fa-circle-dot'}"></i> ` : ''}${escHtml(l)}</button>`).join('')}</div>`;
}
// 직원이 쉬는 동안 마감인 일 — 대표가 직접 처리하거나 다음 출근일로 미루거나 넘긴다
function offCard(t, today, cal0) {
  const cal = cal0.of(t.owner), nextW = cal.next(today);
  const why = cal0.base.isOff(today) ? '직원이 쉬는 동안 마감' : `${escHtml(t.owner)} 전원 휴가 중 마감`;
  return `<div class="tk-ceo off" data-id="${t.id}">
    <div class="tk-off-h"><i class="fa-solid fa-umbrella-beach"></i> ${why} · ${md2(t.due)}까지</div>
    ${taskHead(t)}
    <div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span>${srcChips(t)}</div>
    ${t.why ? `<div class="tk-why">${escHtml(t.why)}</div>` : ''}
    ${isCeo() ? `<div class="tk-ceo-btns"><button class="btn sm primary" onclick="taskDone('${t.id}', this)"><i class="fa-solid fa-check"></i> 내가 처리함</button><button class="btn sm ghost" onclick="taskPostpone('${t.id}', this)"><i class="fa-solid fa-calendar-day"></i> ${md2(nextW)}로</button><button class="btn sm ghost" onclick="taskClose('${t.id}', this, '넘길까요? 할 일이 닫히고 다음 보고서에서 빠져요.')"><i class="fa-solid fa-forward"></i> 넘기기</button></div>` : '<div class="muted small">대표가 처리할지 정하는 중이에요</div>'}
  </div>`;
}

function tasksDraw() {
  const d = tasksState.data; if (!d) return;
  const today = d.today, all = d.tasks || [], base = workCal(d.holidays);
  const teamCals = {};
  const cal = { ...base, base, of: owner => owner === '대표' ? base : (teamCals[owner] ??= workCal(d.holidays, (d.team_off || {})[owner])) };
  const offToday = base.isOff(today), prevW = base.prev(today), nextW = base.next(today);
  const leaves = d.leaves || [];
  const leaveToday = t => leaves.filter(l => l.date === today && l.team === t && l.type !== 'half');
  const teamAllOff = t => ((d.team_off || {})[t] || []).includes(today);
  const open = all.filter(t => t.status === 'open');
  const stale = open.filter(t => t.stale_since && !pendingCeo(t));
  const live = open.filter(t => !t.stale_since || pendingCeo(t));
  const ceo = live.filter(pendingCeo);
  // 직원이 쉬는 날: 이번 휴일 안에 마감인 직원 일을 대표에게
  // (에이전트가 실제 마감으로 정한 기한만 — 코드가 정한 기한은 늘 출근일이라 해당 없음)
  // 담당 팀이 쉬는 날(주말·공휴일·팀 전원 휴가)에 그 사이 마감인 일
  const offDue = live.filter(t => { if (!isStaffTask(t) || pendingCeo(t) || t.kind === '지킬 원칙' || t.due_source !== 'agent' || !t.due) return false; const c = cal.of(t.owner); return c.isOff(today) && t.due > c.prev(today) && t.due < c.next(today); });
  const offIds = new Set(offDue.map(t => t.id));
  const rules = live.filter(t => t.kind === '지킬 원칙' && !pendingCeo(t));
  const work = live.filter(t => !pendingCeo(t) && t.kind !== '지킬 원칙' && !offIds.has(t.id));
  // 쉬기 전날: 다음 출근일 전에 마감인 직원 일
  const beforeOff = work.filter(t => { if (!isStaffTask(t) || !t.due) return false; const c = cal.of(t.owner); return !c.isOff(today) && c.isOff(tdAdd(today, 1)) && t.due >= today && t.due < c.next(today); });
  const beforeNext = beforeOff.length ? cal.of(beforeOff[0].owner).next(today) : nextW;
  const beforeIds = new Set(beforeOff.map(t => t.id));
  // 쉬고 온 첫 출근일: 그 사이 생긴 일·승인된 일·저절로 끝난 일
  const afterOff = !offToday && prevW < tdAdd(today, -1);
  const since = t => t > prevW;
  const newIds = new Set(afterOff ? work.filter(t => since(kstDate(t.created_at))).map(t => t.id) : []);
  const approvedOff = afterOff ? work.filter(t => t.decision === 'approve' && since(kstDate(t.decided_at))) : [];
  const autoOff = afterOff ? all.filter(t => t.status === 'done' && t.done_how === 'auto' && since(kstDate(t.done_at))) : [];
  const done = all.filter(t => t.status === 'done' || t.status === 'closed').sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)));
  const held = all.filter(t => t.status === 'held');
  const team = tasksState.team;
  const kind = tasksState.kind;
  const teamWork = work.filter(t => !beforeIds.has(t.id) && (!team || t.owner === team));
  const shown = teamWork.filter(t => !kind || t.kind === kind).sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9')) || String(a.first_seen).localeCompare(String(b.first_seen)));
  const count = k => work.filter(t => t.owner === k).length;
  const tabLeave = k => teamAllOff(k) ? ' 🏖 전원 휴가' : leaveToday(k).length ? ` 🏖${leaveToday(k).length}` : '';
  const tabs = `<div class="tk-tabs">${[['', `전체 ${work.length}`], ...TEAMS.filter(k => count(k)).map(k => [k, `${k} ${count(k)}${tabLeave(k)}`])].map(([k, l]) => `<button class="chip-btn${team === k ? ' on' : ''}" onclick="tasksTeam('${k}')">${escHtml(l)}</button>`).join('')}</div>`;
  // 휴가 띠: 오늘 + 앞으로 7일 (이름·팀·종류만)
  const upcoming = leaves.filter(l => l.date >= today && l.date <= tdAdd(today, 7));
  const byDate = {}; upcoming.forEach(l => (byDate[l.date] ??= []).push(l));
  const leaveStrip = upcoming.length ? `<div class="tk-leave"><b><i class="fa-solid fa-umbrella-beach"></i> 휴가</b>${Object.keys(byDate).sort().map(dt => `<span class="tk-leave-d${dt === today ? ' today' : ''}">${dt === today ? '오늘' : md2(dt)} ${byDate[dt].map(l => `${escHtml(l.name)}(${escHtml(l.team)}${l.type !== 'annual' ? ' ' + escHtml(LEAVE_LABEL[l.type] || l.type) : ''})`).join(', ')}${TEAMS.filter(k => ((d.team_off || {})[k] || []).includes(dt)).map(k => ` <em>${escHtml(k)} 전원 쉼</em>`).join('')}</span>`).join('')}</div>` : '';
  const chipFor = t => (isStaffTask(t) && teamAllOff(t.owner) ? '<span class="tk-new"><i class="fa-solid fa-umbrella-beach"></i> 팀 전원 휴가</span>' : '') + (newIds.has(t.id) ? '<span class="tk-new"><i class="fa-solid fa-moon"></i> 쉬는 동안 생김</span>' : (approvedOff.some(x => x.id === t.id) ? '<span class="tk-new"><i class="fa-solid fa-stamp"></i> 쉬는 동안 대표 승인</span>' : ''));
  const doneRow = t => `<div class="tk-row done"><span class="tk-check on"><i class="fa-solid ${t.status === 'closed' ? 'fa-xmark' : 'fa-check'}"></i></span><div class="tk-main">${taskHead(t)}<div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span><span class="tk-doneby">${t.status === 'closed' ? `<i class="fa-solid fa-xmark"></i> 닫음(필요 없음) · ${escHtml(t.done_by || '')}` : t.done_how === 'auto' ? `<i class="fa-solid fa-robot"></i> 자동 확인${t.done_evidence ? ` · ${escHtml(t.done_evidence)}` : ''}` : `<i class="fa-solid fa-user-check"></i> ${escHtml(t.done_by || '')}`} · ${timeLabel(t.done_at)}</span><button class="linkish" onclick="taskUndo('${t.id}', this)">되돌리기</button></div></div></div>`;
  const ceoBox = ceo.length || offDue.length;
  // 대표 결정함: 종류 칩으로 따로 보기, '전체'면 종류별로 묶어서
  const ck = tasksState.ceoKind;
  const ceoAll = [...offDue, ...ceo];
  // 같은 종류 안에서는 에이전트가 지금도 제안하는 일 먼저, 더는 제안하지 않는 일(닫기 후보)은 뒤로
  const ceoShown = ceo.filter(t => !ck || t.kind === ck).sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || (a.stale_since ? 1 : 0) - (b.stale_since ? 1 : 0) || String(a.first_seen).localeCompare(String(b.first_seen)));
  const offShown = offDue.filter(t => !ck || t.kind === ck);
  let ceoCards = offShown.map(t => offCard(t, today, cal)).join('');
  if (ck) ceoCards += ceoShown.map(t => ceoCard(t, today, cal)).join('');
  else { let last = null; for (const t of ceoShown) { if (t.kind !== last) { last = t.kind; ceoCards += `<div class="tk-grp"><i class="fa-solid ${KIND_ICON[t.kind] || 'fa-circle-dot'}"></i> ${escHtml(t.kind)} <span class="muted">${ceoShown.filter(x => x.kind === t.kind).length}</span></div>`; } ceoCards += ceoCard(t, today, cal); } }
  $('tasks-body').innerHTML = `
    ${leaveStrip}
    ${afterOff && (newIds.size || approvedOff.length || autoOff.length) ? `<div class="box tk-after"><h3><i class="fa-solid fa-mug-hot" style="color:#4f46e5;"></i> 쉬는 동안 (${md2(tdAdd(prevW, 1))}~${md2(tdAdd(today, -1))}) <span class="muted small">아래 목록에 표시돼 있어요</span></h3>
      <div class="tk-after-n"><span><b>${newIds.size}</b>개 새로 생김</span><span><b>${approvedOff.length}</b>개 대표가 승인</span><span><b>${autoOff.length}</b>개 저절로 끝남</span></div>
      ${autoOff.length ? `<div class="tk-why">저절로 끝난 일: ${autoOff.map(t => `${escHtml(tkName(t) || t.title)}(${escHtml(t.done_evidence || '')})`).join(' · ')}</div>` : ''}</div>` : ''}
    ${ceoBox ? `<div class="box tk-ceo-box"><h3><i class="fa-solid fa-stamp" style="color:#b45309;"></i> 대표 결정함 <span class="tk-n">${ceo.length + offDue.length}</span> <span class="muted small">예산·가격처럼 대표 승인이 필요한 일${offDue.length ? ' · 담당 팀이 쉬는 동안 마감인 일' : ''} · 승인하면 팀 할 일로 넘어가고, 보류하면 이유가 다음 날 보고서에 반영돼요</span></h3>${kindChips(ceoAll, ck, 'tasksCeoKind')}<div class="tk-ceo-grid">${ceoCards || '<div class="muted">이 종류는 결정할 일이 없어요</div>'}</div></div>` : ''}
    ${beforeOff.length ? `<div class="box tk-before"><h3><i class="fa-solid fa-hourglass-half" style="color:#b91c1c;"></i> 쉬기 전에 할 일 <span class="tk-n red">${beforeOff.length}</span> <span class="muted small">다음 출근일 ${md2(beforeNext)} 전에 마감 — 오늘 못 하면 쉬는 동안 대표에게 올라가요</span></h3>${beforeOff.map(t => taskRow(t, today, cal)).join('')}</div>` : ''}
    <div class="box tk-box"><h3><i class="fa-solid fa-list-check" style="color:#4f46e5;"></i> 팀별 할 일 <span class="muted small">기한이 가까운 순${offToday ? ` · 오늘은 직원 쉬는 날 — 다음 출근일 ${md2(nextW)}` : ''}</span></h3>
      ${tabs}
      ${kindChips(teamWork, kind, 'tasksKind')}
      ${shown.length ? shown.map(t => taskRow(t, today, cal, chipFor(t))).join('') : `<div class="muted tk-empty">${kind ? `${escHtml(kind)} 할 일이 없어요` : team ? `${escHtml(team)} 할 일이 없어요` : '지금 할 일이 없어요'}</div>`}
      <div class="muted small chk-hint">체크하면 완료로 기록되고, 다음 날 보고서의 할 일에서 빠져요. 잘못 눌렀으면 아래 '최근 완료'에서 되돌릴 수 있어요.</div>
    </div>
    ${stale.length ? `<div class="box tk-stale"><h3><i class="fa-solid fa-circle-question" style="color:#6b7280;"></i> 확인 후 닫기 <span class="tk-n gray">${stale.length}</span> <span class="muted small">에이전트가 더는 제안하지 않는 일 — 했으면 완료, 안 해도 되면 닫기. 누르기 전까지 남아 있어요</span></h3>${stale.map(t => `<div class="tk-row"><span class="tk-check"><i class="fa-solid fa-question"></i></span><div class="tk-main">${taskHead(t)}<div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span><span class="tk-doneby">${md2(t.stale_since)}부터 제안 없음</span>${srcChips(t)}</div><div class="tk-stale-btns"><button class="btn sm ghost" onclick="taskDone('${t.id}', this)"><i class="fa-solid fa-check"></i> 했어요</button><button class="btn sm ghost" onclick="taskClose('${t.id}', this)"><i class="fa-solid fa-xmark"></i> 닫기</button></div></div></div>`).join('')}</div>` : ''}
    ${rules.length ? `<div class="box tk-rules"><h3><i class="fa-solid fa-shield-halved" style="color:#0e7490;"></i> 지킬 원칙 <span class="muted small">할 일이 아니라 계속 지킬 것</span></h3>${rules.map(t => `<div class="tk-rule">${taskHead(t)}<span class="tk-team">${escHtml(t.owner)}</span>${t.why ? `<div class="tk-why">${escHtml(t.why)}</div>` : ''}</div>`).join('')}</div>` : ''}
    ${done.length ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> 최근 완료 ${done.length}개 <span class="muted small">7일 · 자동 확인 ${done.filter(t => t.done_how === 'auto').length}개</span></summary><div class="box">${done.map(doneRow).join('')}</div></details>` : ''}
    ${held.length ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> 대표가 보류한 일 ${held.length}개 <span class="muted small">7일 뒤에도 에이전트가 계속 제안하면 결정함으로 다시 와요</span></summary><div class="box">${held.map(t => `<div class="tk-row done"><span class="tk-check"><i class="fa-solid fa-pause"></i></span><div class="tk-main">${taskHead(t)}<div class="tk-meta">${kindChip(t)}<span class="tk-doneby">${escHtml(t.decided_by || '')} · ${timeLabel(t.decided_at)}${t.decision_note ? ` · ${escHtml(t.decision_note)}` : ''}</span>${isCeo() ? `<button class="linkish" onclick="taskDecide('${t.id}','undo',this)">되돌리기</button>` : ''}</div></div></div>`).join('')}</div></details>` : ''}`;
  tasksNavBadge(ceo.length + offDue.length);
}
function tasksNavBadge(n) {
  const a = document.querySelector('.nav a[data-key="todo"]'); if (!a) return;
  a.querySelector('.nav-n')?.remove();
  if (n && isCeo()) a.insertAdjacentHTML('beforeend', `<span class="nav-n" title="대표 결정 대기">${Number(n)}</span>`);
}
function tasksTeam(k) { tasksState.team = k; try { localStorage.setItem('tasks_team', k); } catch { /* 저장 불가 */ } tasksDraw(); }
function tasksKind(k) { tasksState.kind = k; try { localStorage.setItem('tasks_kind', k); } catch { /* 저장 불가 */ } tasksDraw(); }
function tasksCeoKind(k) { tasksState.ceoKind = k; try { localStorage.setItem('tasks_ceo_kind', k); } catch { /* 저장 불가 */ } tasksDraw(); }

function tasksReplace(task) {
  const list = tasksState.data?.tasks || [];
  const i = list.findIndex(t => t.id === task.id);
  if (i >= 0) list[i] = task; else list.push(task);
  tasksDraw();
}
async function taskCall(action, body, btn, okMsg) {
  btn.disabled = true;
  try { const r = await callFn('agent-tasks', { action }, { method: 'POST', body: JSON.stringify(body) }); tasksReplace(r.task); toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); }
  catch (e) { btn.disabled = false; toast('저장 실패: ' + e.message); }
}
const taskDone = (id, btn) => taskCall('done', { id }, btn, '완료로 표시했어요');
const taskUndo = (id, btn) => taskCall('done', { id, undo: true }, btn, '다시 할 일로 돌렸어요');
const taskPostpone = (id, btn) => taskCall('postpone', { id }, btn, '다음 출근일로 미뤘어요');
function taskClose(id, btn, ask) { if (ask && !confirm(ask)) return; taskCall('close', { id }, btn, '닫았어요 — 다음 보고서에서 빠져요'); }
function taskDecide(id, decision, btn) {
  let note = '', detail = null;
  if (decision === 'hold') { note = prompt('보류 이유를 짧게 적어 주세요 (에이전트가 다음 보고서에서 참고해요)', ''); if (note === null) return; }
  if (decision === 'approve') {
    const card = btn.closest('.tk-ceo'), m = card?.querySelector('.tk-m'), b = card?.querySelector('.tk-b');
    if (m) {
      const v = String(b?.value || '').trim(), won = v ? Math.round(Number(v) * 10000) : 0;
      if (v && !(won > 0)) { toast('하루 예산은 숫자(만원)로 적어 주세요'); b.focus(); return; }
      detail = { method: m.value, daily_won: won || null };
    }
  }
  taskCall('decide', { id, decision, note, detail }, btn, r => decision === 'approve' ? `승인했어요 — 팀 할 일로 넘어갔어요${r.notify_note ? ` · ${r.notify_note}` : ''}` : decision === 'hold' ? '보류했어요' : '결정을 되돌렸어요');
}
// 광고 착수 카드에서 광고 소재 담당 실행 — 승인된(또는 승인 필요 없는) 일만 팀 목록에 보이므로 직원도 누를 수 있다
async function taskCreative(no, btn) {
  const name = btn.dataset.name || '';
  if (!confirm(`'${tkName({ product_name: name }) || name}' 광고 소재 제작안을 만들까요? (2~4분, 약 250원)`)) return;
  btnBusy(btn, '만드는 중');
  const startedAt = Date.now();
  try {
    const d = await callFn('creative-agent', { action: 'run', product_no: String(no) }, { method: 'POST', body: '{}' });
    toast(d.message || '제작안 만드는 중이에요 (2~4분) — 이 화면에 있어도 되고, 다 되면 보고서에 떠요');
    for (let i = 0; i < 36; i++) {
      await new Promise(r => setTimeout(r, 10000));
      const rows = await reportsLoad(true).catch(() => []);
      const fresh = rows.find(r => r.agent === 'creative' && new Date(r.created_at).getTime() > startedAt - 60000);
      if (!fresh) continue;
      if (fresh.status === 'error') { toast('제작안 실패: ' + (fresh.error || '원인 미상')); break; }
      if (fresh.status === 'ok') { (tasksState.data.creative ||= {})[no] = { report_id: fresh.id, date: tasksState.data.today }; toast('제작안이 도착했어요'); if (location.hash.startsWith('#todo') || !location.hash) tasksDraw(); return; }
    }
  } catch (e) { toast('실패: ' + e.message); }
  btnIdle(btn, '<i class="fa-solid fa-wand-magic-sparkles"></i> 제작안 만들기');
}

/* ──────────────────────────────────────────
   오늘 할 일 (2026-11-07) — 직원용 팀별 할 일 보드 + 대표 결정함
   데이터: agent-tasks 함수(team_tasks). 매일 보고서 4개의 할 일을 상품 1개 × 할 일 1개로 쪼개 같은 일은 하나로 합친 것.
   - 대표 결정함: 예산·가격처럼 대표 승인이 필요한 일. 관리자만 승인·보류(서버도 강제). 승인 전에는 팀 목록에 안 나온다.
   - 팀 목록: 완료 버튼. 광고 착수·광고 줄이기·상세 보강은 데이터(ON 광고 수·상세 이미지)로 확인되면 저절로 완료.
   - 끝난 일·보류한 일은 다음 날 보고서의 할 일에서 빠진다(_shared/agent.ts weekContext).
────────────────────────────────────────── */
const tasksState = { data: null, team: '' };
const TEAMS = ['광고팀', '상품팀', 'CS팀', '대표'];
const AUTO_KIND = { '광고 착수': 'ON 광고가 늘면', '광고 줄이기': 'ON 광고가 줄면', '상세 보강': '상세 이미지가 바뀌면' };
const KIND_ICON = { '광고 착수': 'fa-play', '광고 증액': 'fa-arrow-trend-up', '광고 줄이기': 'fa-arrow-trend-down', '상세 보강': 'fa-file-image', '노출·기획전': 'fa-store', 'CS·출고': 'fa-truck', '재고·소싱': 'fa-boxes-stacked', '가격·혜택': 'fa-tag', '지킬 원칙': 'fa-shield-halved', '기타': 'fa-circle-dot' };
const AGENT_OF = { returns: 'returns', strategy: 'strategy', ads: 'ads', sales: 'sales' };
const isCeo = () => SESSION?.role === 'admin';
const tkName = t => t.product_name ? (typeof tcCore === 'function' ? tcCore(t.product_name) : t.product_name) : '';
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const pendingCeo = t => t.status === 'open' && t.needs_ceo && !t.decision;

async function tasksLoad() {
  tasksState.data = await callFn('agent-tasks', { action: 'list' });
  try { tasksState.team = localStorage.getItem('tasks_team') || ''; } catch { /* 저장 불가 */ }
  return tasksState.data;
}

async function renderTasks() {
  const main = $('main');
  main.innerHTML = `<div class="page-head"><div><h1>오늘 할 일</h1><p class="sub">AI 담당자 4명이 낸 할 일을 팀별로 모았어요. 같은 일은 하나로 합쳤고, 광고 켜기·상세 보강은 데이터로 확인되면 저절로 완료돼요.</p></div></div><div id="tasks-body"><div class="muted"><i class="fa-solid fa-spinner fa-spin"></i> 불러오는 중</div></div>`;
  try { await tasksLoad(); tasksDraw(); }
  catch (e) { $('tasks-body').innerHTML = `<div class="box err-text">할 일을 불러오지 못했어요: ${escHtml(e.message)}</div>`; }
}

function srcChips(t) {
  const seen = new Set();
  return (t.sources || []).filter(s => { if (seen.has(s.agent)) return false; seen.add(s.agent); return true; }).map(s => {
    const a = agentOf(AGENT_OF[s.agent] || s.agent);
    return a ? `<span class="tk-src" style="color:${a.color};background:${a.color}14;" title="${escHtml(a.name)} ${escHtml(s.report_date || '')}"><i class="fa-solid ${a.icon}"></i></span>` : '';
  }).join('');
}
function dueBadge(t, today) {
  if (!t.due) return '';
  const d = dayDiff(today, t.due);
  const cls = d < 0 ? 'late' : d === 0 ? 'today' : '';
  const label = d < 0 ? `${-d}일 지남` : d === 0 ? '오늘까지' : d === 1 ? '내일까지' : `${Number(t.due.slice(5, 7))}/${Number(t.due.slice(8, 10))}까지`;
  return `<span class="tk-due ${cls}">${label}</span>`;
}
function ageBadge(t, today) {
  const n = dayDiff(t.first_seen, today);
  return n >= 2 ? `<span class="tk-age${n >= 4 ? ' hot' : ''}" title="처음 제안된 날 ${escHtml(t.first_seen)}">${n}일째</span>` : '';
}
function taskHead(t) {
  const nm = tkName(t);
  return `<div class="tk-title">${nm ? `<b class="tk-prod" title="${escHtml(t.product_name)}">${escHtml(nm)}</b>` : ''}<span class="tk-what">${escHtml(t.title)}</span></div>`;
}
function kindChip(t) { return `<span class="tk-kind"><i class="fa-solid ${KIND_ICON[t.kind] || 'fa-circle-dot'}"></i> ${escHtml(t.kind)}</span>`; }

function taskRow(t, today) {
  const auto = AUTO_KIND[t.kind];
  const when = auto && /자동 완료|저절로/.test(t.done_when || '') ? '' : t.done_when;   // 기본 문구면 자동 완료 표시와 겹치므로 생략
  const approved = t.decision === 'approve';
  return `<div class="tk-row" data-id="${t.id}">
    <button class="tk-check" onclick="taskDone('${t.id}', this)" title="완료로 표시"><i class="fa-solid fa-check"></i></button>
    <div class="tk-main">
      ${taskHead(t)}
      <div class="tk-meta">${kindChip(t)}${approved ? `<span class="tk-ok"><i class="fa-solid fa-stamp"></i> 대표 승인${t.decision_note ? ` · ${escHtml(t.decision_note)}` : ''}</span>` : ''}${dueBadge(t, today)}${ageBadge(t, today)}<span class="tk-team">${escHtml(t.owner)}</span>${srcChips(t)}</div>
      ${when ? `<div class="tk-when"><i class="fa-regular fa-flag"></i> 완료 기준: ${escHtml(when)}${auto ? ` <span class="tk-auto"><i class="fa-solid fa-robot"></i> ${auto} 저절로 완료</span>` : ''}</div>` : (auto ? `<div class="tk-when"><span class="tk-auto"><i class="fa-solid fa-robot"></i> ${auto} 저절로 완료</span></div>` : '')}
      ${t.why ? `<div class="tk-why">${escHtml(t.why)}</div>` : ''}
    </div>
  </div>`;
}
function ceoCard(t, today) {
  return `<div class="tk-ceo" data-id="${t.id}">
    ${taskHead(t)}
    <div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span>${ageBadge(t, today)}${srcChips(t)}</div>
    ${t.why ? `<div class="tk-why">${escHtml(t.why)}</div>` : ''}
    ${t.decision_note ? `<div class="tk-why"><i class="fa-solid fa-clock-rotate-left"></i> ${escHtml(t.decision_note)}</div>` : ''}
    ${isCeo() ? `<div class="tk-ceo-btns"><button class="btn sm primary" onclick="taskDecide('${t.id}','approve',this)"><i class="fa-solid fa-check"></i> 승인</button><button class="btn sm ghost" onclick="taskDecide('${t.id}','hold',this)"><i class="fa-solid fa-pause"></i> 보류</button></div>` : '<div class="muted small">대표 승인을 기다리는 중이에요</div>'}
  </div>`;
}

function tasksDraw() {
  const d = tasksState.data; if (!d) return;
  const today = d.today, all = d.tasks || [];
  const open = all.filter(t => t.status === 'open');
  const ceo = open.filter(pendingCeo);
  const rules = open.filter(t => t.kind === '지킬 원칙' && !pendingCeo(t));
  const work = open.filter(t => !pendingCeo(t) && t.kind !== '지킬 원칙');
  const done = all.filter(t => t.status === 'done').sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)));
  const held = all.filter(t => t.status === 'held');
  const dropped = all.filter(t => t.status === 'dropped');
  const team = tasksState.team;
  const shown = work.filter(t => !team || t.owner === team).sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9')) || String(a.first_seen).localeCompare(String(b.first_seen)));
  const count = k => work.filter(t => t.owner === k).length;
  const tabs = `<div class="tk-tabs">${[['', `전체 ${work.length}`], ...TEAMS.filter(k => count(k)).map(k => [k, `${k} ${count(k)}`])].map(([k, l]) => `<button class="chip-btn${team === k ? ' on' : ''}" onclick="tasksTeam('${k}')">${escHtml(l)}</button>`).join('')}</div>`;
  const doneRow = t => `<div class="tk-row done"><span class="tk-check on"><i class="fa-solid fa-check"></i></span><div class="tk-main">${taskHead(t)}<div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span><span class="tk-doneby">${t.done_how === 'auto' ? `<i class="fa-solid fa-robot"></i> 자동 확인${t.done_evidence ? ` · ${escHtml(t.done_evidence)}` : ''}` : `<i class="fa-solid fa-user-check"></i> ${escHtml(t.done_by || '')}`} · ${timeLabel(t.done_at)}</span><button class="linkish" onclick="taskUndo('${t.id}', this)">되돌리기</button></div></div></div>`;
  $('tasks-body').innerHTML = `
    ${ceo.length ? `<div class="box tk-ceo-box"><h3><i class="fa-solid fa-stamp" style="color:#b45309;"></i> 대표 결정함 <span class="tk-n">${ceo.length}</span> <span class="muted small">예산·가격처럼 대표 승인이 필요한 일 · 승인하면 팀 할 일로 넘어가고, 보류하면 이유가 다음 날 보고서에 반영돼요</span></h3><div class="tk-ceo-grid">${ceo.map(t => ceoCard(t, today)).join('')}</div></div>` : ''}
    <div class="box tk-box"><h3><i class="fa-solid fa-list-check" style="color:#4f46e5;"></i> 팀별 할 일 <span class="muted small">기한이 가까운 순</span></h3>
      ${tabs}
      ${shown.length ? shown.map(t => taskRow(t, today)).join('') : `<div class="muted tk-empty">${team ? `${escHtml(team)} 할 일이 없어요` : '지금 할 일이 없어요'}</div>`}
      <div class="muted small chk-hint">체크하면 완료로 기록되고, 다음 날 보고서의 할 일에서 빠져요. 잘못 눌렀으면 아래 '최근 완료'에서 되돌릴 수 있어요.</div>
    </div>
    ${rules.length ? `<div class="box tk-rules"><h3><i class="fa-solid fa-shield-halved" style="color:#0e7490;"></i> 지킬 원칙 <span class="muted small">할 일이 아니라 계속 지킬 것</span></h3>${rules.map(t => `<div class="tk-rule">${taskHead(t)}<span class="tk-team">${escHtml(t.owner)}</span>${t.why ? `<div class="tk-why">${escHtml(t.why)}</div>` : ''}</div>`).join('')}</div>` : ''}
    ${done.length ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> 최근 완료 ${done.length}개 <span class="muted small">7일 · 자동 확인 ${done.filter(t => t.done_how === 'auto').length}개</span></summary><div class="box">${done.map(doneRow).join('')}</div></details>` : ''}
    ${held.length ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> 대표가 보류한 일 ${held.length}개 <span class="muted small">7일 뒤에도 에이전트가 계속 제안하면 결정함으로 다시 와요</span></summary><div class="box">${held.map(t => `<div class="tk-row done"><span class="tk-check"><i class="fa-solid fa-pause"></i></span><div class="tk-main">${taskHead(t)}<div class="tk-meta">${kindChip(t)}<span class="tk-doneby">${escHtml(t.decided_by || '')} · ${timeLabel(t.decided_at)}${t.decision_note ? ` · ${escHtml(t.decision_note)}` : ''}</span>${isCeo() ? `<button class="linkish" onclick="taskDecide('${t.id}','undo',this)">되돌리기</button>` : ''}</div></div></div>`).join('')}</div></details>` : ''}
    ${dropped.length ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> 내려간 일 ${dropped.length}개 <span class="muted small">에이전트가 더는 제안하지 않아요(끝났다고 봤거나 상황이 바뀜)</span></summary><div class="box">${dropped.map(t => `<div class="tk-row done"><span class="tk-check"><i class="fa-solid fa-minus"></i></span><div class="tk-main">${taskHead(t)}<div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span></div></div></div>`).join('')}</div></details>` : ''}`;
  tasksNavBadge();
}
function tasksNavBadge() {
  const a = document.querySelector('.nav a[data-key="todo"]'); if (!a || !tasksState.data) return;
  const n = (tasksState.data.tasks || []).filter(pendingCeo).length;
  a.querySelector('.nav-n')?.remove();
  if (n && isCeo()) a.insertAdjacentHTML('beforeend', `<span class="nav-n" title="대표 결정 대기">${n}</span>`);
}
function tasksTeam(k) { tasksState.team = k; try { localStorage.setItem('tasks_team', k); } catch { /* 저장 불가 */ } tasksDraw(); }

function tasksReplace(task) {
  const list = tasksState.data?.tasks || [];
  const i = list.findIndex(t => t.id === task.id);
  if (i >= 0) list[i] = task; else list.push(task);
  tasksDraw();
}
async function taskDone(id, btn) {
  btn.disabled = true;
  try { const r = await callFn('agent-tasks', { action: 'done' }, { method: 'POST', body: JSON.stringify({ id }) }); tasksReplace(r.task); toast('완료로 표시했어요'); }
  catch (e) { btn.disabled = false; toast('저장 실패: ' + e.message); }
}
async function taskUndo(id, btn) {
  btn.disabled = true;
  try { const r = await callFn('agent-tasks', { action: 'done' }, { method: 'POST', body: JSON.stringify({ id, undo: true }) }); tasksReplace(r.task); toast('다시 할 일로 돌렸어요'); }
  catch (e) { btn.disabled = false; toast('저장 실패: ' + e.message); }
}
async function taskDecide(id, decision, btn) {
  let note = '';
  if (decision === 'hold') { note = prompt('보류 이유를 짧게 적어 주세요 (에이전트가 다음 보고서에서 참고해요)', ''); if (note === null) return; }
  btn.disabled = true;
  try {
    const r = await callFn('agent-tasks', { action: 'decide' }, { method: 'POST', body: JSON.stringify({ id, decision, note }) });
    tasksReplace(r.task);
    toast(decision === 'approve' ? '승인했어요 — 팀 할 일로 넘어갔어요' : decision === 'hold' ? '보류했어요' : '결정을 되돌렸어요');
  } catch (e) { btn.disabled = false; toast('저장 실패: ' + e.message); }
}

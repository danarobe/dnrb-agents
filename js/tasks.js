/* ──────────────────────────────────────────
   오늘 할 일 (2026-11-07) — 직원용 팀별 할 일 보드 + 대표 결정함
   데이터: agent-tasks 함수(team_tasks). 매일 보고서 4개의 할 일을 상품 1개 × 할 일 1개로 쪼개 같은 일은 하나로 합친 것.
   - 대표 결정함: 예산·가격처럼 대표 승인이 필요한 일. 관리자만 승인·보류(서버도 강제). 승인 전에는 팀 목록에 안 나온다.
   - 팀 목록: 완료 버튼. 광고 착수·광고 줄이기·상세 보강은 데이터(ON 광고 수·상세 이미지)로 확인되면 저절로 완료.
   - 끝난 일·보류한 일은 다음 날 보고서의 할 일에서 빠진다(_shared/agent.ts weekContext).
   2차(같은 날, 사용자 "주말엔 직원만 쉬고 대표는 대부분 본다"):
   - 직원 일(광고팀·상품팀·CS팀)은 출근일(토·일·공휴일 제외)로 '며칠째'·'기한 지남'을 센다. 대표 일은 달력 날짜.
   - 쉬고 온 첫 출근일: '쉬는 동안' 상자(새로 생긴 일·대표가 승인한 일·저절로 끝난 일).
   - 쉬기 전날: '쉬기 전에 할 일'(다음 출근일 전에 마감).
   - 직원이 쉬는 날: 그 사이 마감인 직원 일을 대표 결정함에 올림(내가 처리함 · 다음 출근일로 · 넘기기).
   - 에이전트가 더는 제안하지 않는 일은 사라지지 않고 '확인 후 닫기' 상자에 남는다.
────────────────────────────────────────── */
const tasksState = { data: null, team: '' };
const TEAMS = ['광고팀', '상품팀', 'CS팀', '대표'];
const AUTO_KIND = { '광고 착수': 'ON 광고가 늘면', '광고 줄이기': 'ON 광고가 줄면', '상세 보강': '상세 이미지가 바뀌면' };
const KIND_ICON = { '광고 착수': 'fa-play', '광고 증액': 'fa-arrow-trend-up', '광고 줄이기': 'fa-arrow-trend-down', '상세 보강': 'fa-file-image', '노출·기획전': 'fa-store', 'CS·출고': 'fa-truck', '재고·소싱': 'fa-boxes-stacked', '가격·혜택': 'fa-tag', '지킬 원칙': 'fa-shield-halved', '기타': 'fa-circle-dot' };
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
function workCal(holidays) {
  const off = new Set(holidays || []);
  const isOff = d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6 || off.has(d); };
  const next = d => { let x = tdAdd(d, 1); for (let i = 0; i < 30 && isOff(x); i++) x = tdAdd(x, 1); return x; };
  const prev = d => { let x = tdAdd(d, -1); for (let i = 0; i < 30 && isOff(x); i++) x = tdAdd(x, -1); return x; };
  const between = (a, b) => { let n = 0, x = a; for (let i = 0; i < 200 && x < b; i++) { x = tdAdd(x, 1); if (!isOff(x)) n++; } return n; };   // (a, b] 출근일 수
  return { isOff, next, prev, between };
}

async function tasksLoad() {
  tasksState.data = await callFn('agent-tasks', { action: 'list' });
  try { tasksState.team = localStorage.getItem('tasks_team') || ''; } catch { /* 저장 불가 */ }
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
function dueBadge(t, today, cal) {
  if (!t.due) return '';
  const staff = isStaffTask(t);
  if (t.due < today) {
    const n = staff ? cal.between(t.due, today) : calDiff(t.due, today);
    return n > 0 ? `<span class="tk-due late">${staff ? `출근일 ${n}일 지남` : `${n}일 지남`}</span>` : `<span class="tk-due">${md2(t.due)}까지</span>`;
  }
  if (t.due === today) return '<span class="tk-due today">오늘까지</span>';
  const offNote = staff && cal.isOff(t.due) ? ' · 직원 쉬는 날' : '';
  return `<span class="tk-due${offNote ? ' today' : ''}">${md2(t.due)}까지${offNote}</span>`;
}
function ageBadge(t, today, cal) {
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

function taskRow(t, today, cal, extraChip = '') {
  const auto = AUTO_KIND[t.kind];
  const when = auto && /자동 완료|저절로/.test(t.done_when || '') ? '' : t.done_when;   // 기본 문구면 자동 완료 표시와 겹치므로 생략
  const approved = t.decision === 'approve';
  return `<div class="tk-row" data-id="${t.id}">
    <button class="tk-check" onclick="taskDone('${t.id}', this)" title="완료로 표시"><i class="fa-solid fa-check"></i></button>
    <div class="tk-main">
      ${taskHead(t)}
      <div class="tk-meta">${extraChip}${kindChip(t)}${approved ? `<span class="tk-ok"><i class="fa-solid fa-stamp"></i> 대표 승인${t.decision_note ? ` · ${escHtml(t.decision_note)}` : ''}</span>` : ''}${dueBadge(t, today, cal)}${ageBadge(t, today, cal)}<span class="tk-team">${escHtml(t.owner)}</span>${srcChips(t)}</div>
      ${when ? `<div class="tk-when"><i class="fa-regular fa-flag"></i> 완료 기준: ${escHtml(when)}${auto ? ` <span class="tk-auto"><i class="fa-solid fa-robot"></i> ${auto} 저절로 완료</span>` : ''}</div>` : (auto ? `<div class="tk-when"><span class="tk-auto"><i class="fa-solid fa-robot"></i> ${auto} 저절로 완료</span></div>` : '')}
      ${t.why ? `<div class="tk-why">${escHtml(t.why)}</div>` : ''}
    </div>
  </div>`;
}
function ceoCard(t, today, cal) {
  return `<div class="tk-ceo" data-id="${t.id}">
    ${taskHead(t)}
    <div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span>${ageBadge(t, today, cal)}${srcChips(t)}</div>
    ${t.why ? `<div class="tk-why">${escHtml(t.why)}</div>` : ''}
    ${t.decision_note ? `<div class="tk-why"><i class="fa-solid fa-clock-rotate-left"></i> ${escHtml(t.decision_note)}</div>` : ''}
    ${isCeo() ? `<div class="tk-ceo-btns"><button class="btn sm primary" onclick="taskDecide('${t.id}','approve',this)"><i class="fa-solid fa-check"></i> 승인</button><button class="btn sm ghost" onclick="taskDecide('${t.id}','hold',this)"><i class="fa-solid fa-pause"></i> 보류</button></div>` : '<div class="muted small">대표 승인을 기다리는 중이에요</div>'}
  </div>`;
}
// 직원이 쉬는 동안 마감인 일 — 대표가 직접 처리하거나 다음 출근일로 미루거나 넘긴다
function offCard(t, today, cal) {
  const nextW = cal.next(today);
  return `<div class="tk-ceo off" data-id="${t.id}">
    <div class="tk-off-h"><i class="fa-solid fa-umbrella-beach"></i> 직원이 쉬는 동안 마감 · ${md2(t.due)}까지</div>
    ${taskHead(t)}
    <div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span>${srcChips(t)}</div>
    ${t.why ? `<div class="tk-why">${escHtml(t.why)}</div>` : ''}
    ${isCeo() ? `<div class="tk-ceo-btns"><button class="btn sm primary" onclick="taskDone('${t.id}', this)"><i class="fa-solid fa-check"></i> 내가 처리함</button><button class="btn sm ghost" onclick="taskPostpone('${t.id}', this)"><i class="fa-solid fa-calendar-day"></i> ${md2(nextW)}로</button><button class="btn sm ghost" onclick="taskClose('${t.id}', this, '넘길까요? 할 일이 닫히고 다음 보고서에서 빠져요.')"><i class="fa-solid fa-forward"></i> 넘기기</button></div>` : '<div class="muted small">대표가 처리할지 정하는 중이에요</div>'}
  </div>`;
}

function tasksDraw() {
  const d = tasksState.data; if (!d) return;
  const today = d.today, all = d.tasks || [], cal = workCal(d.holidays);
  const offToday = cal.isOff(today), prevW = cal.prev(today), nextW = cal.next(today);
  const open = all.filter(t => t.status === 'open');
  const stale = open.filter(t => t.stale_since && !pendingCeo(t));
  const live = open.filter(t => !t.stale_since || pendingCeo(t));
  const ceo = live.filter(pendingCeo);
  // 직원이 쉬는 날: 이번 휴일 안에 마감인 직원 일을 대표에게
  // (에이전트가 실제 마감으로 정한 기한만 — 코드가 정한 기한은 늘 출근일이라 해당 없음)
  const offDue = offToday ? live.filter(t => isStaffTask(t) && !pendingCeo(t) && t.kind !== '지킬 원칙' && t.due_source === 'agent' && t.due && t.due > prevW && t.due < nextW) : [];
  const offIds = new Set(offDue.map(t => t.id));
  const rules = live.filter(t => t.kind === '지킬 원칙' && !pendingCeo(t));
  const work = live.filter(t => !pendingCeo(t) && t.kind !== '지킬 원칙' && !offIds.has(t.id));
  // 쉬기 전날: 다음 출근일 전에 마감인 직원 일
  const beforeOff = !offToday && cal.isOff(tdAdd(today, 1)) ? work.filter(t => isStaffTask(t) && t.due && t.due >= today && t.due < nextW) : [];
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
  const shown = work.filter(t => !beforeIds.has(t.id) && (!team || t.owner === team)).sort((a, b) => String(a.due || '9').localeCompare(String(b.due || '9')) || String(a.first_seen).localeCompare(String(b.first_seen)));
  const count = k => work.filter(t => t.owner === k).length;
  const tabs = `<div class="tk-tabs">${[['', `전체 ${work.length}`], ...TEAMS.filter(k => count(k)).map(k => [k, `${k} ${count(k)}`])].map(([k, l]) => `<button class="chip-btn${team === k ? ' on' : ''}" onclick="tasksTeam('${k}')">${escHtml(l)}</button>`).join('')}</div>`;
  const chipFor = t => newIds.has(t.id) ? '<span class="tk-new"><i class="fa-solid fa-moon"></i> 쉬는 동안 생김</span>' : (approvedOff.some(x => x.id === t.id) ? '<span class="tk-new"><i class="fa-solid fa-stamp"></i> 쉬는 동안 대표 승인</span>' : '');
  const doneRow = t => `<div class="tk-row done"><span class="tk-check on"><i class="fa-solid ${t.status === 'closed' ? 'fa-xmark' : 'fa-check'}"></i></span><div class="tk-main">${taskHead(t)}<div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span><span class="tk-doneby">${t.status === 'closed' ? `<i class="fa-solid fa-xmark"></i> 닫음(필요 없음) · ${escHtml(t.done_by || '')}` : t.done_how === 'auto' ? `<i class="fa-solid fa-robot"></i> 자동 확인${t.done_evidence ? ` · ${escHtml(t.done_evidence)}` : ''}` : `<i class="fa-solid fa-user-check"></i> ${escHtml(t.done_by || '')}`} · ${timeLabel(t.done_at)}</span><button class="linkish" onclick="taskUndo('${t.id}', this)">되돌리기</button></div></div></div>`;
  const ceoBox = ceo.length || offDue.length;
  $('tasks-body').innerHTML = `
    ${afterOff && (newIds.size || approvedOff.length || autoOff.length) ? `<div class="box tk-after"><h3><i class="fa-solid fa-mug-hot" style="color:#4f46e5;"></i> 쉬는 동안 (${md2(tdAdd(prevW, 1))}~${md2(tdAdd(today, -1))}) <span class="muted small">아래 목록에 표시돼 있어요</span></h3>
      <div class="tk-after-n"><span><b>${newIds.size}</b>개 새로 생김</span><span><b>${approvedOff.length}</b>개 대표가 승인</span><span><b>${autoOff.length}</b>개 저절로 끝남</span></div>
      ${autoOff.length ? `<div class="tk-why">저절로 끝난 일: ${autoOff.map(t => `${escHtml(tkName(t) || t.title)}(${escHtml(t.done_evidence || '')})`).join(' · ')}</div>` : ''}</div>` : ''}
    ${ceoBox ? `<div class="box tk-ceo-box"><h3><i class="fa-solid fa-stamp" style="color:#b45309;"></i> 대표 결정함 <span class="tk-n">${ceo.length + offDue.length}</span> <span class="muted small">예산·가격처럼 대표 승인이 필요한 일${offDue.length ? ' · 직원이 쉬는 동안 마감인 일' : ''} · 승인하면 팀 할 일로 넘어가고, 보류하면 이유가 다음 날 보고서에 반영돼요</span></h3><div class="tk-ceo-grid">${offDue.map(t => offCard(t, today, cal)).join('')}${ceo.map(t => ceoCard(t, today, cal)).join('')}</div></div>` : ''}
    ${beforeOff.length ? `<div class="box tk-before"><h3><i class="fa-solid fa-hourglass-half" style="color:#b91c1c;"></i> 쉬기 전에 할 일 <span class="tk-n red">${beforeOff.length}</span> <span class="muted small">다음 출근일 ${md2(nextW)} 전에 마감 — 오늘 못 하면 쉬는 동안 대표에게 올라가요</span></h3>${beforeOff.map(t => taskRow(t, today, cal)).join('')}</div>` : ''}
    <div class="box tk-box"><h3><i class="fa-solid fa-list-check" style="color:#4f46e5;"></i> 팀별 할 일 <span class="muted small">기한이 가까운 순${offToday ? ` · 오늘은 직원 쉬는 날 — 다음 출근일 ${md2(nextW)}` : ''}</span></h3>
      ${tabs}
      ${shown.length ? shown.map(t => taskRow(t, today, cal, chipFor(t))).join('') : `<div class="muted tk-empty">${team ? `${escHtml(team)} 할 일이 없어요` : '지금 할 일이 없어요'}</div>`}
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

function tasksReplace(task) {
  const list = tasksState.data?.tasks || [];
  const i = list.findIndex(t => t.id === task.id);
  if (i >= 0) list[i] = task; else list.push(task);
  tasksDraw();
}
async function taskCall(action, body, btn, okMsg) {
  btn.disabled = true;
  try { const r = await callFn('agent-tasks', { action }, { method: 'POST', body: JSON.stringify(body) }); tasksReplace(r.task); toast(okMsg); }
  catch (e) { btn.disabled = false; toast('저장 실패: ' + e.message); }
}
const taskDone = (id, btn) => taskCall('done', { id }, btn, '완료로 표시했어요');
const taskUndo = (id, btn) => taskCall('done', { id, undo: true }, btn, '다시 할 일로 돌렸어요');
const taskPostpone = (id, btn) => taskCall('postpone', { id }, btn, '다음 출근일로 미뤘어요');
function taskClose(id, btn, ask) { if (ask && !confirm(ask)) return; taskCall('close', { id }, btn, '닫았어요 — 다음 보고서에서 빠져요'); }
function taskDecide(id, decision, btn) {
  let note = '';
  if (decision === 'hold') { note = prompt('보류 이유를 짧게 적어 주세요 (에이전트가 다음 보고서에서 참고해요)', ''); if (note === null) return; }
  taskCall('decide', { id, decision, note }, btn, decision === 'approve' ? '승인했어요 — 팀 할 일로 넘어갔어요' : decision === 'hold' ? '보류했어요' : '결정을 되돌렸어요');
}

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
   5차(2026-11-11, 사용자 "각 상품의 최근 7일 일평균 판매량도"): 상품 카드마다 '최근 7일 하루 평균 n개 · 앞 7일 대비 ▲▼% · 조회' (sales_7d, sync가 채움).
   6차(2026-11-11, 사용자 "팀 작업보드 메뉴 + 진행 중 단계"): 메뉴를 #decide 대표 결정함 / #board 팀 작업보드로 나눔.
     보드 = 팀 현황 카드(할 일·진행 중·기한 지남·7일 완료, 누르면 그 팀만) + 칸 3개(할 일 → 진행 중 → 완료 7일). '▶ 시작' = started_at(서버 start).
   7차(2026-11-11, 사용자): 승인 방식 이름 '소재 공급 필요'·'담당 부서 판단' / 할 일·진행 중 카드에 '미진행'(이유 필수 → closed·done_how skip·skip_reason, 결정함에 접힌 목록)
     / 미진행은 이유별로 쉬는 기간(skip_until — 시즌 90일·재고 14일·더 급한 일 7일·그 외 30일), 그 사이 판매 급등이면 다시(서버 sync, reopen_note 칩)
     / 같은 날 '시작·완료 체크 통합': 할 일 카드 = '▶ 시작' · '시작과 함께 완료'(done start:true) · '미진행', 왼쪽 동그라미 = 고르기 →
       아래 묶음 막대에서 한 번에 시작 / 시작과 함께 완료 / 미진행(이유 하나). 칸 제목의 '모두 고르기'.
     / 상세 보강 카드의 '자세히&권장방안' — 제목·근거의 사유(사이즈·기장·색상·원단·취소)로 고칠 방법 + 상세 점검 담당 결과(detail_review, 있으면).
   같은 날 사용자 "광고 착수 상품 중 5일 이상 ON됐던 광고·지금 활성 광고 수": 광고 착수 카드에 기존 광고 이력(ad_hist — 최근 90일 Meta 지출 있던 날 5일↑ 광고 수, 켜짐/꺼짐, 꺼진 것들 ROAS, 목록).
────────────────────────────────────────── */
const tasksState = { data: null, team: '', kind: '', ceoKind: '', sel: new Set() };   // sel = 보드에서 고른 할 일(한 번에 처리)
const TEAMS = ['MD/컨텐츠팀', '물류/CS팀', '대표'];   // 2026-11-10 'CS팀' → '물류/CS팀', 같은 날 광고팀·상품팀 → 'MD/컨텐츠팀'(역할 통합)
const AUTO_KIND = { '광고 착수': 'ON 광고가 늘면', '광고 소재': '새 광고가 켜지면', '광고 줄이기': 'ON 광고가 줄면', '상세 보강': '상세 이미지가 바뀌면' };
const KIND_ICON = { '광고 착수': 'fa-play', '광고 소재': 'fa-clapperboard', '광고 증액': 'fa-arrow-trend-up', '광고 줄이기': 'fa-arrow-trend-down', '상세 보강': 'fa-file-image', '노출·기획전': 'fa-store', 'CS·출고': 'fa-truck', '재고·소싱': 'fa-boxes-stacked', '가격·혜택': 'fa-tag', '지킬 원칙': 'fa-shield-halved', '기타': 'fa-circle-dot' };
const KIND_ORDER = Object.keys(KIND_ICON);
const kindRank = k => { const i = KIND_ORDER.indexOf(k); return i < 0 ? 99 : i; };
// 승인할 때 고르는 방식 (서버 agent-tasks METHODS와 같은 코드)
const METHOD_OPTS = { '광고 착수': ['new', 'reuse', 'free'], '광고 증액': ['raise', 'add', 'free'] };
const METHOD_LABEL = { new: '소재 공급 필요', reuse: '기존 소재·꺼진 광고 다시 켜기', raise: '지금 광고 예산 늘리기', add: '소재 추가해 늘리기', free: '담당 부서 판단' };
const manwon = w => { const m = Number(w) / 10000; return `${Number.isInteger(m) ? m : m.toFixed(1)}만원`; };
const detailLabel = d => { if (!d) return ''; const p = []; if (d.method && d.method !== 'free' && METHOD_LABEL[d.method]) p.push(METHOD_LABEL[d.method]); if (Number(d.daily_won) > 0) p.push(`하루 ${manwon(d.daily_won)}`); return p.join(' · '); };
const PAUSE_LABEL = { PAUSED: '광고 꺼짐', ADSET_PAUSED: '광고세트 꺼짐', CAMPAIGN_PAUSED: '캠페인 꺼짐' };
const WD = '일월화수목금토';
const isCeo = () => SESSION?.role === 'admin';
// 상품명은 앞 괄호(판 구분: '(기모ver.)'·'[Best] (2사이즈)')를 살린다 — 클레르 블라우스처럼 같은 이름의 다른 판이 많아 헷갈림(2026-11-11 사용자 지적). 끝의 '(n colors)'·브랜드 꼬리만 뗌
const tkName = t => { if (!t.product_name) return ''; const s = String(t.product_name).replace(/\s*[-–—|]\s*(danarobe|dana|다나로브|다나)\s*$/i, '').replace(/\s*\([^)]*colors?[^)]*\)\s*$/i, '').trim(); return s || t.product_name; };
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

async function renderTasks(view) {
  tasksState.view = view === 'decide' ? 'decide' : 'board';
  const main = $('main');
  const head = tasksState.view === 'decide' ? ['대표 결정함', '승인하면 담당 팀에 바로 알림 · 팀 칸을 누르면 작업보드로'] : ['팀 작업보드', '▶ 시작 또는 시작과 함께 완료 · 동그라미로 여러 개 골라 한 번에 · 광고 켜기·상세 보강은 자동 완료'];
  main.innerHTML = `<div class="page-head"><div><h1>${head[0]}</h1><p class="sub">${head[1]}</p></div></div><div id="tasks-body"><div class="muted"><i class="fa-solid fa-spinner fa-spin"></i> 불러오는 중</div></div>`;
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
  // 대표가 방식을 바꾼 일은 제목 = 대표가 정한 방식(처음 제안 문장은 changeLine에)
  const what = changed(t) && METHOD_LABEL[t.decision_detail.method] && t.decision_detail.method !== 'free' ? METHOD_LABEL[t.decision_detail.method] : t.title;
  return `<div class="tk-title">${nm ? `<b class="tk-prod" title="${escHtml(t.product_name)}">${escHtml(nm)}</b>` : ''}<span class="tk-what">${escHtml(what)}</span></div>`;
}
const kindChip = t => `<span class="tk-kind"><i class="fa-solid ${KIND_ICON[t.kind] || 'fa-circle-dot'}"></i> ${escHtml(t.kind)}</span>`;

// ── 카드 단순화(2026-11-11 사용자 "설명이 복잡해졌다 — 중요한 건 강조, 줄글은 최소, 가시성 있게") ──
//   카드 = 제목 → 숫자 칸 2~3개(큰 숫자) → 추천 한 줄(칩) → 근거 1~2줄(잘림) → 버튼 → '자세히'(나머지 전부 접음)
const f1 = x => x >= 10 ? String(Math.round(x)) : x.toFixed(1);
const pctOf = (a, b) => b > 0 ? Math.round((a - b) / b * 100) : null;
const adInfo = t => String(t.kind).startsWith('광고') && t.product_no ? (tasksState.data?.ad_info || {})[t.product_no] : null;
// tip: 칸 이름에 마우스를 올리면 뜨는 설명(휴대폰은 칸을 누르면 같은 설명이 잠깐 뜸)
const cell = (label, val, sub = '', cls = '', tip = '') => `<div class="tk-stat${cls ? ' ' + cls : ''}${tip ? ' tip' : ''}"${tip ? ` title="${escHtml(tip)}" onclick="toast(this.title)"` : ''}><span class="tk-stat-l">${label}${tip ? ' <i class="fa-regular fa-circle-question"></i>' : ''}</span><b>${val}</b>${sub ? `<span class="tk-stat-s">${sub}</span>` : ''}</div>`;
const chg = p => p == null ? '' : `<em class="${p <= -30 ? 'down' : p >= 30 ? 'up' : ''}">${p > 0 ? '▲' : p < 0 ? '▼' : ''}${Math.abs(p)}%</em>`;
function statCells(t) {
  if (!t.product_no) return '';
  const c = [], s = t.sales_7d, h = t.ad_hist, a = adInfo(t);
  if (s) { const p = pctOf(s.qty_7d, s.qty_prev7d); c.push(cell('하루 판매', `${f1(s.qty_7d / 7)}개 ${chg(p)}`, p == null && s.qty_7d ? '새로 팔림' : '최근 7일', p != null && p <= -30 ? 'bad' : p != null && p >= 30 ? 'good' : '')); }
  if (t.kind === '광고 착수' && h) {
    c.push(cell('검증 소재', `${h.proven}개`, h.proven ? (h.proven_off ? `꺼짐 ${h.proven_off}` : '모두 켜짐') : '', h.proven ? '' : 'zero', `최근 ${h.days || 90}일 동안 광고비가 실제로 나간 날이 ${h.proven_days || 5}일 이상인 광고`));
    c.push(cell('켜진 광고', `${h.active}개`, '', h.active ? '' : 'zero'));
  } else if (a) {
    const p7 = a.ad_7d || {};
    c.push(cell('켜진 광고', `${a.active_ads ?? '—'}개`, a.paused_ads ? `꺼짐 ${a.paused_ads}` : ''));
    if (p7.roas != null) c.push(cell('7일 ROAS', `${p7.roas}`, p7.spend != null ? `광고비 ${manwon(p7.spend)}` : '', p7.roas >= 3 ? 'good' : p7.roas < 1.5 ? 'bad' : ''));
  }
  return c.length ? `<div class="tk-stats${c.length === 1 ? ' one' : ''}">${c.join('')}</div>` : '';   // 숫자 하나면 한 줄짜리 작은 칸
}
// 추천 한 줄 — 광고 착수만(데이터로 판단 가능한 경우)
function adviceChip(t) {
  if (t.kind !== '광고 착수' || changed(t)) return '';
  const h = t.ad_hist; if (!h) return '';
  if (h.proven_off > 0) return `<div class="tk-advice on"><i class="fa-solid fa-power-off"></i> 꺼진 검증 소재 다시 켜기 먼저${h.proven_off_roas != null ? ` · ROAS ${h.proven_off_roas}` : ''}</div>`;
  if (!h.proven && !h.active) return `<div class="tk-advice new"><i class="fa-solid fa-wand-magic-sparkles"></i> 새 소재 필요</div>`;
  return '';
}
// 가격·마진(2026-11-12 사용자 "공급가·판매가·마진 금액·마진율도"): 판매가 · 공급가(중국 사입은 실질 원가) · 마진 금액 · 마진율 — 원가는 부가세 포함 기준
const won = v => `${Math.round(Number(v)).toLocaleString()}원`;
function priceLine(t) {
  const p = t.price_info; if (!p || !(p.price > 0)) return '';
  const costCell = p.cn ? `<span title="중국 사입 실질 원가(부가세 몫 포함)">원가 <b>${p.cost ? won(p.cost) : '—'}</b> <em>중국 사입</em></span>` : `<span title="카페24 공급가(부가세 별도) — 마진은 ×1.1로 계산">공급가 <b>${p.supply > 0 ? won(p.supply) : '미입력'}</b></span>`;
  const r = p.margin_rate, cls = r == null ? '' : r < 35 ? ' low' : r >= 55 ? ' high' : '';
  return `<div class="tk-price"><span>판매가 <b>${won(p.price)}</b></span>${costCell}<span class="tk-mg${cls}">마진 <b>${p.margin_won != null ? won(p.margin_won) : '—'}</b>${r != null ? ` <em>${r}%</em>` : ''}</span></div>`;
}
// 대표가 바꾼 일(2026-11-12): 처음 제안 대신 대표가 정한 방식을 크게
const changed = t => !!(t.decision_detail && t.decision_detail.changed);
// 2026-11-12 사용자 "어떤 걸로 바뀌었는지 한눈에": 카드 맨 위 보라 상자 — 원래 제안(취소선) → 바뀐 방식(굵은 칩), 아래에 하루 예산·메모
function changeLine(t) {
  if (!changed(t)) return '';
  const d = t.decision_detail;
  const to = d.method && METHOD_LABEL[d.method] ? METHOD_LABEL[d.method] : (t.decision_note ? '메모대로' : '담당 부서 판단');
  const sub = [Number(d.daily_won) > 0 ? `하루 예산 <b>${manwon(d.daily_won)}</b>` : '', t.decision_note ? `메모 <b>${escHtml(t.decision_note)}</b>` : ''].filter(Boolean).join(' · ');
  return `<div class="tk-chg-line">
    <div class="tk-chg-h"><i class="fa-solid fa-pen-to-square"></i> 대표가 바꿨어요${t.decided_by ? ` <span>${escHtml(t.decided_by)} · ${md2(kstDate(t.decided_at))}</span>` : ''}</div>
    <div class="tk-chg-ft"><s title="에이전트가 처음 제안한 것">${escHtml(t.title || d.from_label || '')}</s><i class="fa-solid fa-arrow-right"></i><b class="tk-chg-to">${escHtml(to)}</b></div>
    ${sub ? `<div class="tk-chg-sub">${sub}</div>` : ''}
  </div>`;
}
// 변경 칸(대표만): 광고 착수·증액은 방식·하루 예산, 모든 일에 메모 · 보류 · 결정 되돌리기
function changeForm(t) {
  if (!isCeo()) return '';
  const opts = METHOD_OPTS[t.kind], d = t.decision_detail || {};
  const curM = d.method || (t.reenable ? 'reuse' : '');
  return `<div class="tk-chg" hidden>
    <div class="tk-skip-h"><i class="fa-solid fa-pen-to-square"></i> 이 일 바꾸기 <span class="muted">저장하면 담당 팀에 바로 알림 · 에이전트도 다음 보고서부터 반영</span></div>
    ${opts ? `<div class="tk-dec"><select class="tk-m" aria-label="방식">${opts.map(m => `<option value="${m}"${m === curM ? ' selected' : ''}>${escHtml(METHOD_LABEL[m])}</option>`).join('')}</select>
      <label><input class="tk-b" type="number" inputmode="decimal" min="0" step="0.5" value="${Number(d.daily_won) > 0 ? Number(d.daily_won) / 10000 : ''}" placeholder="${t.kind === '광고 증액' ? '늘린 뒤 하루' : '하루 예산'}" aria-label="하루 예산(만원)"><em>만원</em></label></div>` : ''}
    <div class="tk-skip-f"><input class="tk-n" type="text" maxlength="200" placeholder="메모 (선택 — 팀에 보여요)" aria-label="대표 메모" value="${escHtml(changed(t) ? (t.decision_note || '') : '')}"><button class="btn sm primary" onclick="taskChange('${t.id}', this)">변경 저장</button><button class="linkish" onclick="this.closest('.tk-chg').hidden=true">취소</button></div>
    <div class="tk-chg-more">${t.started_at ? '' : `<button class="linkish" onclick="taskDecide('${t.id}','hold',this)"><i class="fa-solid fa-pause"></i> 보류로</button>`}${t.decision ? `<button class="linkish" onclick="if(confirm('대표 결정을 지울까요? 승인이 필요한 일이면 결정함으로 돌아가요.'))taskDecide('${t.id}','undo',this)"><i class="fa-solid fa-rotate-left"></i> 결정 되돌리기</button>` : ''}</div>
  </div>`;
}
const whyLine = t => t.why ? `<div class="tk-why clamp" title="${escHtml(t.why)}">${escHtml(t.why)}</div>` : '';
// 상세 보강 권장 방안(2026-11-11 사용자 "'자세히'에서 권장 보강 방식이 보이게"): 제목·근거에 적힌 반품·문의 사유로 고칠 방법을 고른다.
//   숫자는 지어내지 않고 ○ 자리표시. 상세 점검 담당이 그 상품을 읽은 적 있으면(detail_review) 그 결과도 함께.
const DETAIL_TIPS = [
  [/사이즈|실측|크게|커요|크다|큼|큽|넉넉|작게|작아|작음|타이트|핏/, x => ['실측표(어깨·가슴·소매·총장)를 상세 첫 화면 바로 아래로',
    /크게|커요|크다|큼|큽|넉넉/.test(x) ? "'평소보다 크게 나와요 — 한 치수 작게 추천' 문구" : /작게|작아|작음|타이트/.test(x) ? "'작게 나와요 — 한 치수 크게 추천' 문구" : '사이즈 추천 문구(평소 사이즈 기준으로 어떻게 고르면 되는지)',
    '모델 키·착용 사이즈 표기 (예: 키 ○cm · M 착용)', '반품 많은 옵션(근거의 색상·사이즈)은 그 옵션 실측을 따로 강조']],
  [/기장|길이|숏|롱|키 작/, () => ['키별 기장 위치 안내 (예: 키 160cm 기준 무릎 아래 ○cm)', '총장 실측 + 숏·롱 버전을 나란히 비교한 컷']],
  [/색상|컬러|실물|화면과|사진과|화면이랑|색이/, () => ['자연광에서 보정 없이 찍은 실물 색 컷 추가', "'화면보다 조금 어둡게/밝게 보일 수 있어요' 안내 문구", '옵션 대표 이미지 색 보정이 실물과 맞는지 확인']],
  [/원단|소재|두께|두꺼|무게|무겁|처짐|촉감|까끌|비침|얇/, x => ['원단 정보 눈금표 (두께·비침·신축·무게감 — 얇음~두꺼움)', '원단 클로즈업·손으로 늘려 본 컷',
    ...(/까끌|촉감/.test(x) ? ['촉감 안내 (까끌한 정도·안감 유무·이너 추천)'] : []), ...(/무게|무겁|처짐/.test(x) ? ['무게감·처짐 안내 (걸었을 때·입었을 때 컷)'] : [])]],
  [/취소/, () => ['취소 사유를 CS에서 먼저 확인 → 그 사유에 상세 상단에서 답하기']],
];
function detailReco(t) {
  const x = [t.title, t.why, ...(t.sources || []).map(s => s.why)].join(' ');
  const tips = [];
  for (const [re, f] of DETAIL_TIPS) if (re.test(x)) for (const it of f(x)) if (!tips.includes(it)) tips.push(it);
  if (!tips.length) tips.push('반품·문의 사유를 상세 첫 화면에서 미리 답하기', '실측표·소재·색상별 착용컷이 다 있는지 확인');
  const r = t.product_no ? (tasksState.data?.detail_review || {})[t.product_no] : null;
  const txt = v => typeof v === 'string' ? v : (v?.text ? `${v.where ? v.where + ': ' : ''}${v.text}` : '');
  const ai = r ? `<div class="tk-reco-ai"><b><i class="fa-solid fa-file-image"></i> 상세 점검 담당 결과</b> <span class="muted">${md2(r.date)}${r.score != null ? ` · ${Number(r.score)}점` : ''}</span>
      <div><b>1순위</b> ${escHtml(r.top?.what || '')}${r.top?.why ? ` <span class="muted">— ${escHtml(r.top.why)}</span>` : ''}</div>
      ${(r.missing || []).length ? `<div><b>빠진 것</b><ul>${r.missing.map(m => `<li>${escHtml(txt(m))}</li>`).join('')}</ul></div>` : ''}
      ${(r.snippets || []).length ? `<div><b>붙여 넣을 문장</b><ul>${r.snippets.map(m => `<li>${escHtml(txt(m))}</li>`).join('')}</ul></div>` : ''}</div>` : '';
  return `<div class="tk-reco"><b><i class="fa-solid fa-lightbulb"></i> 권장 방안</b><ol>${tips.slice(0, 6).map(it => `<li>${escHtml(it)}</li>`).join('')}</ol>${ai}</div>`;
}
// 자세히: 판매·조회 비교, 광고 성과, 5일↑ 돈 광고 목록, 꺼진 광고 목록, 보고서 링크 (상세 보강은 맨 위에 권장 방안)
function moreBox(t, extra = '') {
  const parts = [];
  const isDetail = t.kind === '상세 보강';
  if (isDetail) parts.push(detailReco(t));
  const s = t.sales_7d;
  if (s) parts.push(`<div><b>판매</b> 최근 7일 ${s.qty_7d}개 · 앞 7일 ${s.qty_prev7d}개${s.views_prev7d > 0 ? ` · 조회 ${Number(s.views_7d).toLocaleString()} (앞 7일 ${Number(s.views_prev7d).toLocaleString()})` : ''} <span class="muted">${md2(tdAdd(s.through, -6))}~${md2(s.through)}</span></div>`);
  const a = adInfo(t);
  if (a) { const p7 = a.ad_7d || {}; parts.push(`<div><b>광고 7일</b> 광고비 ${p7.spend != null ? manwon(p7.spend) : '—'} · ROAS ${p7.roas ?? '—'} · 구매 ${p7.purchases ?? '—'}건${a.report_id ? ` · <a class="linkish" href="#reports/${escHtml(a.report_id)}">광고 운영 보고서</a>` : ''}</div>`); }
  const h = t.kind === '광고 착수' ? t.ad_hist : null;
  if (h && (h.list || []).length) parts.push(`<div><b>5일↑ 돈 광고</b> <span class="muted">최근 90일 · 광고비 큰 순</span><ul>${h.list.map(x => `<li>${escHtml(x.name)} <span class="muted">${x.on ? '<b class="tk-on">켜짐</b>' : '꺼짐'} · ${Number(x.days)}일 · ROAS ${x.roas ?? '—'} · ${manwon(x.spend)}${x.last ? ` · 마지막 ${escHtml(String(x.last).slice(5).replace('-', '/'))}` : ''}</span></li>`).join('')}</ul></div>`);
  else if (a && a.paused_ads > 0 && (a.paused_list || []).length) parts.push(`<div><b>꺼진 광고</b> ${a.paused_ads}개${a.paused_30d?.roas != null ? ` · 30일 ROAS ${a.paused_30d.roas}` : ''}<ul>${a.paused_list.map(x => `<li>${escHtml(x.name || '')}</li>`).join('')}</ul></div>`);
  if (h && h.short) parts.push(`<div class="muted">4일 이하로만 돈 광고 ${h.short}개</div>`);
  const auto = AUTO_KIND[t.kind];
  if (auto) parts.push(`<div class="muted"><i class="fa-solid fa-robot"></i> ${auto} 자동 완료</div>`);
  else if (t.done_when) parts.push(`<div class="muted"><i class="fa-regular fa-flag"></i> 완료 기준: ${escHtml(t.done_when)}</div>`);
  if (extra) parts.push(extra);
  if (!parts.length) return '';
  return `<details class="tk-more${isDetail ? ' reco' : ''}"><summary>${isDetail ? '자세히&권장방안' : '자세히'}</summary>${parts.join('')}</details>`;
}
function creativeBtn(t) {
  if (!['광고 착수', '광고 소재'].includes(t.kind) || !t.product_no || t.reenable) return '';
  const c = (tasksState.data?.creative || {})[t.product_no];
  const view = c && c.report_id ? `<a class="btn sm ghost" href="#reports/${escHtml(c.report_id)}"><i class="fa-solid fa-bullhorn"></i> 제작안 보기</a>` : '';
  return `${view}<button class="btn sm ghost" onclick="taskCreative(${Number(t.product_no)}, this)" data-name="${escHtml(t.product_name || '')}"><i class="fa-solid fa-wand-magic-sparkles"></i> ${view ? '새 제작안' : '제작안 만들기'}</button>`;
}
const freeChip = t => changed(t) ? '' : t.reenable ? '<span class="tk-free"><i class="fa-solid fa-power-off"></i> 다시 켜기 · 승인 불필요</span>' : (t.kind === '광고 줄이기' ? '<span class="tk-free"><i class="fa-solid fa-bolt"></i> 승인 불필요</span>' : '');

function taskRow(t, today, cal, extraChip = '') {
  const approved = t.decision === 'approve';
  const dl = approved ? detailLabel(t.decision_detail) : '';
  const cb = creativeBtn(t);
  // 진행 중(started_at): 맨 위 파란 칩 + '완료' 버튼 / 아직이면 '▶ 시작'
  const doing = !!t.started_at;
  const skipBtn = `<button class="btn sm ghost tk-skip-btn" onclick="taskSkipOpen(this)"><i class="fa-solid fa-ban"></i> 미진행</button>`
    + (isCeo() ? `<button class="btn sm ghost tk-chg-btn" onclick="taskChgOpen(this)"><i class="fa-solid fa-pen-to-square"></i> 변경</button>` : '');   // 2026-11-12 대표(관리자)만
  // 2026-11-11 사용자 "시작·완료 체크 통합": 할 일 = '▶ 시작' · '시작과 함께 완료' / 왼쪽 동그라미 = 여러 개 고르기(아래 묶음 막대로 한 번에)
  const acts = doing
    ? `<button class="btn sm primary" onclick="taskDone('${t.id}', this)"><i class="fa-solid fa-check"></i> 완료</button>${skipBtn}<button class="linkish" onclick="taskStart('${t.id}', this, true)">시작 취소</button>`
    : `<button class="btn sm ghost" onclick="taskStart('${t.id}', this)"><i class="fa-solid fa-play"></i> 시작</button><button class="btn sm ghost tk-sd-btn" onclick="taskStartDone('${t.id}', this)"><i class="fa-solid fa-check-double"></i> 시작과 함께 완료</button>${skipBtn}`;
  const sel = tasksState.sel.has(t.id);
  return `<div class="tk-row${doing ? ' doing' : ''}${sel ? ' sel' : ''}${changed(t) ? ' chg' : ''}" data-id="${t.id}">
    <button class="tk-check pick${sel ? ' on' : ''}" onclick="taskSel('${t.id}', this)" title="골라서 한 번에 처리" aria-pressed="${sel}"><i class="fa-solid fa-check"></i></button>
    <div class="tk-main">
      ${taskHead(t)}
      ${changeLine(t)}
      ${reopenLine(t)}
      ${doing ? `<div class="tk-doing"><i class="fa-solid fa-person-running"></i> 진행 중${t.started_by ? ` · ${escHtml(t.started_by)}` : ''} · ${md2(kstDate(t.started_at))}부터</div>` : ''}
      <div class="tk-meta">${extraChip}${kindChip(t)}${freeChip(t)}${approved ? `<span class="tk-ok"><i class="fa-solid fa-stamp"></i> ${changed(t) ? '대표 변경' : `승인${dl ? ` · ${escHtml(dl)}` : ''}`}</span>` : ''}${dueBadge(t, today, cal)}${ageBadge(t, today, cal)}${AUTO_KIND[t.kind] ? '<span class="tk-auto" title="데이터로 확인되면 저절로 완료"><i class="fa-solid fa-robot"></i> 자동 완료</span>' : ''}</div>
      ${statCells(t)}${priceLine(t)}${adviceChip(t)}${whyLine(t)}
      <div class="tk-links">${acts}${cb}</div>
      ${skipForm(t)}${changeForm(t)}
      ${moreBox(t, approved && t.decision_note ? `<div class="muted">대표 메모: ${escHtml(t.decision_note)}</div>` : '')}
    </div>
  </div>`;
}
// 미진행했던 일이 기간이 끝났거나 판매 급등으로 다시 올라온 경우 그 사연
const reopenLine = t => t.reopen_note ? `<div class="tk-reopen"><i class="fa-solid fa-rotate-left"></i> ${escHtml(t.reopen_note)}</div>` : '';
// 미진행(2026-11-11 사용자 "할 일에 '미진행' 버튼 + 이유 기입"): 누르면 카드 안에 이유 칸(빠른 선택 + 직접 쓰기)
const SKIP_QUICK = ['재고 부족', '시즌 지남', '효과 없을 것 같음', '다른 일이 더 급함'];
const skipForm = t => `<div class="tk-skip" hidden>
    <div class="tk-skip-h"><i class="fa-solid fa-ban"></i> 왜 진행하지 않나요? <span class="muted">이유별로 쉬었다가 다시 검토해요(시즌 90일 · 재고 14일 · 더 급한 일 7일 · 그 외 30일) · 그 사이 판매가 급등하면 바로 다시 올라와요</span></div>
    <div class="tk-skip-q">${SKIP_QUICK.map(r => `<button type="button" class="kchip" onclick="taskSkipPick(this)">${escHtml(r)}</button>`).join('')}</div>
    <div class="tk-skip-f"><input type="text" maxlength="200" placeholder="미진행 이유" aria-label="미진행 이유" onkeydown="if(event.key==='Enter'&&!event.isComposing)this.nextElementSibling.click()"><button class="btn sm primary" onclick="taskSkip('${t.id}', this)">미진행으로 닫기</button><button class="linkish" onclick="this.closest('.tk-skip').hidden=true">취소</button></div>
  </div>`;
function ceoCard(t, today, cal) {
  const opts = METHOD_OPTS[t.kind];
  // 광고 착수·증액: 승인할 때 방식·하루 예산(비우면 '담당 판단')
  const form = opts && isCeo() ? `<div class="tk-dec">
      <select class="tk-m" aria-label="방식">${opts.map(m => `<option value="${m}">${escHtml(METHOD_LABEL[m])}</option>`).join('')}</select>
      <label><input class="tk-b" type="number" inputmode="decimal" min="0" step="0.5" placeholder="${t.kind === '광고 증액' ? '늘린 뒤 하루' : '하루 예산'}" aria-label="하루 예산(만원)"><em>만원</em></label>
    </div>` : '';
  return `<div class="tk-ceo${t.stale_since ? ' stale' : ''}" data-id="${t.id}">
    ${taskHead(t)}${reopenLine(t)}
    <div class="tk-meta">${kindChip(t)}${ageBadge(t, today, cal)}${t.stale_since ? '<span class="tk-stale-chip" title="에이전트가 더는 제안하지 않아요 — 필요 없으면 닫기">제안 끝남</span>' : ''}</div>
    ${statCells(t)}${priceLine(t)}${adviceChip(t)}${whyLine(t)}
    ${form}
    ${isCeo() ? `<div class="tk-ceo-btns"><button class="btn sm primary" onclick="taskDecide('${t.id}','approve',this)"><i class="fa-solid fa-check"></i> 승인</button><button class="btn sm ghost" onclick="taskDecide('${t.id}','hold',this)"><i class="fa-solid fa-pause"></i> 보류</button>${t.stale_since ? `<button class="btn sm ghost" onclick="taskClose('${t.id}', this, '닫을까요? 필요 없음으로 기록돼요.')"><i class="fa-solid fa-xmark"></i> 닫기</button>` : ''}</div>` : '<div class="muted small">대표 승인 대기</div>'}
    ${moreBox(t, t.decision_note ? `<div class="muted"><i class="fa-solid fa-clock-rotate-left"></i> ${escHtml(t.decision_note)}</div>` : '')}
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
    <div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span></div>
    ${statCells(t)}${whyLine(t)}
    ${isCeo() ? `<div class="tk-ceo-btns"><button class="btn sm primary" onclick="taskDone('${t.id}', this)"><i class="fa-solid fa-check"></i> 내가 처리함</button><button class="btn sm ghost" onclick="taskPostpone('${t.id}', this)"><i class="fa-solid fa-calendar-day"></i> ${md2(nextW)}로</button><button class="btn sm ghost" onclick="taskClose('${t.id}', this, '넘길까요? 할 일이 닫히고 다음 보고서에서 빠져요.')"><i class="fa-solid fa-forward"></i> 넘기기</button></div>` : '<div class="muted small">대표가 처리할지 정하는 중이에요</div>'}
  </div>`;
}

// ── 화면 2개(2026-11-11 사용자 "팀 작업보드 메뉴 + 진행 중 단계"): #decide 대표 결정함 / #board 팀 작업보드 ──
function tasksModel(d) {
  const today = d.today, all = d.tasks || [], base = workCal(d.holidays);
  const teamCals = {};
  const cal = { ...base, base, of: owner => owner === '대표' ? base : (teamCals[owner] ??= workCal(d.holidays, (d.team_off || {})[owner])) };
  const offToday = base.isOff(today), prevW = base.prev(today), nextW = base.next(today);
  const open = all.filter(t => t.status === 'open');
  const stale = open.filter(t => t.stale_since && !pendingCeo(t));
  const live = open.filter(t => !t.stale_since || pendingCeo(t));
  const ceo = live.filter(pendingCeo);
  // 담당 팀이 쉬는 날(주말·공휴일·팀 전원 휴가)에 그 사이 마감인 직원 일 → 대표 결정함에도 카드로(에이전트가 정한 실제 기한만)
  const offDue = live.filter(t => { if (!isStaffTask(t) || pendingCeo(t) || t.kind === '지킬 원칙' || t.due_source !== 'agent' || !t.due) return false; const c = cal.of(t.owner); return c.isOff(today) && t.due > c.prev(today) && t.due < c.next(today); });
  const rules = live.filter(t => t.kind === '지킬 원칙' && !pendingCeo(t));
  const work = live.filter(t => !pendingCeo(t) && t.kind !== '지킬 원칙');
  // 쉬기 전날: 다음 출근일 전에 마감인 직원 일 → 보드에서 맨 위 + '쉬기 전 마감' 칩
  const beforeIds = new Set(work.filter(t => { if (!isStaffTask(t) || !t.due) return false; const c = cal.of(t.owner); return !c.isOff(today) && c.isOff(tdAdd(today, 1)) && t.due >= today && t.due < c.next(today); }).map(t => t.id));
  const afterOff = !offToday && prevW < tdAdd(today, -1);
  const since = t => t > prevW;
  const newIds = new Set(afterOff ? work.filter(t => since(kstDate(t.created_at))).map(t => t.id) : []);
  const approvedOff = afterOff ? work.filter(t => t.decision === 'approve' && since(kstDate(t.decided_at))) : [];
  const autoOff = afterOff ? all.filter(t => t.status === 'done' && t.done_how === 'auto' && since(kstDate(t.done_at))) : [];
  const done = all.filter(t => t.status === 'done' || t.status === 'closed').sort((a, b) => String(b.done_at).localeCompare(String(a.done_at)));
  const held = all.filter(t => t.status === 'held');
  return { today, cal, offToday, prevW, nextW, stale, ceo, offDue, rules, work, beforeIds, afterOff, newIds, approvedOff, autoOff, done, held };
}
const isLate = (t, m) => { if (!t.due || t.due >= m.today) return false; const c = m.cal.of(t.owner); return isStaffTask(t) ? c.between(t.due, m.today) > 0 : true; };
// 팀 현황 카드(두 화면 공통): 할 일 · 진행 중 · 기한 지남 · 7일 완료, 누르면 그 팀만
function teamSummary(m, d, clickable) {
  const teams = TEAMS.filter(k => m.work.some(t => t.owner === k) || m.done.some(t => t.owner === k));
  if (!teams.length) return '';
  const leaveToday = k => (d.leaves || []).filter(l => l.date === m.today && l.team === k && l.type !== 'half').length;
  const allOff = k => ((d.team_off || {})[k] || []).includes(m.today);
  const cur = tasksState.team;
  const card = k => {
    const w = m.work.filter(t => t.owner === k), doing = w.filter(t => t.started_at).length, late = w.filter(t => isLate(t, m)).length;
    const dn = m.done.filter(t => t.owner === k && t.status === 'done').length;
    const lv = allOff(k) ? '<span class="ts-leave">🏖 전원 휴가</span>' : leaveToday(k) ? `<span class="ts-leave">🏖 ${leaveToday(k)}명 휴가</span>` : '';
    return `<${clickable ? 'button' : 'a'} class="ts-card${cur === k && clickable ? ' on' : ''}" ${clickable ? `onclick="tasksTeam('${cur === k ? '' : k}')"` : `href="#board" onclick="tasksState.team='${k}'"`}>
      <div class="ts-h"><b>${escHtml(k)}</b>${lv}</div>
      <div class="ts-n"><span><b>${w.length - doing}</b>할 일</span><span class="doing"><b>${doing}</b>진행 중</span><span class="${late ? 'late' : ''}"><b>${late}</b>기한 지남</span><span class="done"><b>${dn}</b>7일 완료</span></div>
    </${clickable ? 'button' : 'a'}>`;
  };
  return `<div class="ts-row">${teams.map(card).join('')}</div>`;
}
function leaveStripHtml(m, d) {
  const leaves = d.leaves || [], today = m.today;
  const upcoming = leaves.filter(l => l.date >= today && l.date <= tdAdd(today, 7));
  if (!upcoming.length) return '';
  const byDate = {}; upcoming.forEach(l => (byDate[l.date] ??= []).push(l));
  return `<div class="tk-leave"><b><i class="fa-solid fa-umbrella-beach"></i> 휴가</b>${Object.keys(byDate).sort().map(dt => `<span class="tk-leave-d${dt === today ? ' today' : ''}">${dt === today ? '오늘' : md2(dt)} ${byDate[dt].map(l => `${escHtml(l.name)}(${escHtml(l.team)}${l.type !== 'annual' ? ' ' + escHtml(LEAVE_LABEL[l.type] || l.type) : ''})`).join(', ')}${TEAMS.filter(k => ((d.team_off || {})[k] || []).includes(dt)).map(k => ` <em>${escHtml(k)} 전원 쉼</em>`).join('')}</span>`).join('')}</div>`;
}

function tasksDraw() {
  const d = tasksState.data; if (!d) return;
  const m = tasksModel(d);
  tasksNavBadge(m.ceo.length + m.offDue.length);
  if (tasksState.view === 'decide') return drawDecide(m, d);
  return drawBoard(m, d);
}

function drawDecide(m, d) {
  const { today, cal, ceo, offDue, held } = m;
  const skipped = m.done.filter(t => t.status === 'closed' && t.done_how === 'skip');
  const ck = tasksState.ceoKind;
  const ceoAll = [...offDue, ...ceo];
  // 같은 종류 안에서는 에이전트가 지금도 제안하는 일 먼저, 더는 제안하지 않는 일(닫기 후보)은 뒤로
  const ceoShown = ceo.filter(t => !ck || t.kind === ck).sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || (a.stale_since ? 1 : 0) - (b.stale_since ? 1 : 0) || String(a.first_seen).localeCompare(String(b.first_seen)));
  let cards = offDue.filter(t => !ck || t.kind === ck).map(t => offCard(t, today, cal)).join('');
  if (ck) cards += ceoShown.map(t => ceoCard(t, today, cal)).join('');
  else { let last = null; for (const t of ceoShown) { if (t.kind !== last) { last = t.kind; cards += `<div class="tk-grp"><i class="fa-solid ${KIND_ICON[t.kind] || 'fa-circle-dot'}"></i> ${escHtml(t.kind)} <span class="muted">${ceoShown.filter(x => x.kind === t.kind).length}</span></div>`; } cards += ceoCard(t, today, cal); } }
  $('tasks-body').innerHTML = `
    ${teamSummary(m, d, false)}
    <div class="box tk-ceo-box"><h3><i class="fa-solid fa-stamp" style="color:#b45309;"></i> 결정 대기 <span class="tk-n">${ceoAll.length}</span></h3>
      ${ceoAll.length ? `${kindChips(ceoAll, ck, 'tasksCeoKind')}<div class="tk-ceo-grid">${cards || '<div class="muted">이 종류는 결정할 일이 없어요</div>'}</div>` : '<div class="muted tk-empty">결정할 일이 없어요</div>'}
    </div>
    ${held.length ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> 보류한 일 ${held.length}개 <span class="muted small">7일 뒤 다시 결정함으로</span></summary><div class="box">${held.map(t => `<div class="tk-row done"><span class="tk-check"><i class="fa-solid fa-pause"></i></span><div class="tk-main">${taskHead(t)}<div class="tk-meta">${kindChip(t)}<span class="tk-doneby">${escHtml(t.decided_by || '')} · ${timeLabel(t.decided_at)}${t.decision_note ? ` · ${escHtml(t.decision_note)}` : ''}</span>${isCeo() ? `<button class="linkish" onclick="taskDecide('${t.id}','undo',this)">되돌리기</button>` : ''}</div></div></div>`).join('')}</div></details>` : ''}
    ${skipped.length ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> <i class="fa-solid fa-ban" style="color:#9a3412;"></i> 팀이 미진행한 일 ${skipped.length}개 <span class="muted small">쉬는 기간이 끝나거나 판매가 급등하면 다시 올라와요</span></summary><div class="box">${skipped.map(t => `<div class="tk-row done"><span class="tk-check"><i class="fa-solid fa-ban"></i></span><div class="tk-main">${taskHead(t)}<div class="tk-skip-r"><b>이유</b> ${escHtml(t.skip_reason || '')}${t.skip_until ? ` · ${md2(t.skip_until)}까지 쉼` : ''}</div><div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span><span class="tk-doneby">${escHtml(t.done_by || '')} · ${timeLabel(t.done_at)}</span><button class="linkish" onclick="taskUndo('${t.id}', this)">다시 할 일로</button></div></div></div>`).join('')}</div></details>` : ''}`;
}

function drawBoard(m, d) {
  const { today, cal, work, done, stale, rules, beforeIds, newIds, approvedOff, autoOff } = m;
  const team = tasksState.team, kind = tasksState.kind;
  const teamAllOff = k => ((d.team_off || {})[k] || []).includes(today);
  const inTeam = t => !team || t.owner === team;
  const teamWork = work.filter(inTeam);
  const pick = t => !kind || t.kind === kind;
  const byDue = (a, b) => (beforeIds.has(b.id) ? 1 : 0) - (beforeIds.has(a.id) ? 1 : 0) || String(a.due || '9').localeCompare(String(b.due || '9')) || String(a.first_seen).localeCompare(String(b.first_seen));
  const todo = teamWork.filter(t => !t.started_at && pick(t)).sort(byDue);
  const doing = teamWork.filter(t => t.started_at && pick(t)).sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  const fin = done.filter(t => inTeam(t) && pick(t) && kstDate(t.done_at) >= tdAdd(today, -7));   // 미진행 기간 중인 옛 일은 결정함 목록에만
  const chipFor = t => (beforeIds.has(t.id) ? `<span class="tk-new red"><i class="fa-solid fa-hourglass-half"></i> 쉬기 전 마감</span>` : '')
    + (isStaffTask(t) && teamAllOff(t.owner) ? '<span class="tk-new"><i class="fa-solid fa-umbrella-beach"></i> 팀 전원 휴가</span>' : '')
    + (newIds.has(t.id) ? '<span class="tk-new"><i class="fa-solid fa-moon"></i> 쉬는 동안 생김</span>' : (approvedOff.some(x => x.id === t.id) ? '<span class="tk-new"><i class="fa-solid fa-stamp"></i> 쉬는 동안 승인</span>' : ''))
    + (team ? '' : `<span class="tk-team">${escHtml(t.owner)}</span>`);
  const doneRow = t => { const sk = t.status === 'closed' && t.done_how === 'skip'; return `<div class="kb-done${sk ? ' skip' : ''}"><i class="fa-solid ${sk ? 'fa-ban' : t.status === 'closed' ? 'fa-xmark' : t.done_how === 'auto' ? 'fa-robot' : 'fa-check'}"></i><div><b>${escHtml(tkName(t) || '')}</b> ${escHtml(t.title)}${sk ? `<div class="tk-skip-r"><b>미진행</b> ${escHtml(t.skip_reason || '')}${t.skip_until ? ` · ${md2(t.skip_until)}까지 쉼` : ''}</div>` : ''}<div class="muted small">${sk ? escHtml(t.done_by || '') : t.status === 'closed' ? '닫음' : t.done_how === 'auto' ? `자동 확인${t.done_evidence ? ` · ${escHtml(t.done_evidence)}` : ''}` : escHtml(t.done_by || '')} · ${timeLabel(t.done_at)} <button class="linkish" onclick="taskUndo('${t.id}', this)">되돌리기</button></div></div></div>`; };
  // 고른 할 일은 지금 보이는 할 일·진행 중 카드 안에서만 유지(필터를 바꾸거나 처리되면 빠짐)
  const visible = new Set([...todo, ...doing].map(t => t.id));
  for (const id of [...tasksState.sel]) if (!visible.has(id)) tasksState.sel.delete(id);
  const allBtn = list => list.length ? `<button class="linkish kb-all" onclick="taskSelAll('${list.map(t => t.id).join(',')}')">${list.every(t => tasksState.sel.has(t.id)) ? '고르기 해제' : '모두 고르기'}</button>` : '';
  const col = (cls, icon, title, n, body, empty, extra = '') => `<section class="kb-col ${cls}"><h4><i class="fa-solid ${icon}"></i> ${title} <span class="kb-n">${n}</span>${extra}</h4>${body || `<div class="muted small kb-empty">${empty}</div>`}</section>`;
  $('tasks-body').innerHTML = `
    ${leaveStripHtml(m, d)}
    ${m.afterOff && (newIds.size || approvedOff.length || autoOff.length) ? `<div class="tk-afterline"><i class="fa-solid fa-mug-hot"></i> 쉬는 동안 · 새로 생김 <b>${newIds.size}</b> · 대표 승인 <b>${approvedOff.length}</b> · 자동 완료 <b>${autoOff.length}</b></div>` : ''}
    ${teamSummary(m, d, true)}
    ${kindChips(teamWork, kind, 'tasksKind')}
    <div class="kb">
      ${col('todo', 'fa-inbox', '할 일', todo.length, todo.map(t => taskRow(t, today, cal, chipFor(t))).join(''), kind || team ? '해당하는 할 일이 없어요' : '할 일이 없어요', allBtn(todo))}
      ${col('doing', 'fa-person-running', '진행 중', doing.length, doing.map(t => taskRow(t, today, cal, chipFor(t))).join(''), '할 일에서 ▶ 시작을 누르면 여기로 와요', allBtn(doing))}
      ${col('fin', 'fa-circle-check', '완료 · 7일', fin.length, fin.map(doneRow).join(''), '아직 없어요')}
    </div>
    ${stale.filter(inTeam).length ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> 확인 후 닫기 ${stale.filter(inTeam).length}개 <span class="muted small">더는 제안 안 됨 — 했으면 완료, 아니면 닫기</span></summary><div class="box">${stale.filter(inTeam).map(t => `<div class="tk-row"><span class="tk-check"><i class="fa-solid fa-question"></i></span><div class="tk-main">${taskHead(t)}<div class="tk-meta">${kindChip(t)}<span class="tk-team">${escHtml(t.owner)}</span><span class="tk-doneby">${md2(t.stale_since)}부터 제안 없음</span></div><div class="tk-stale-btns"><button class="btn sm ghost" onclick="taskDone('${t.id}', this)"><i class="fa-solid fa-check"></i> 했어요</button><button class="btn sm ghost" onclick="taskClose('${t.id}', this)"><i class="fa-solid fa-xmark"></i> 닫기</button></div></div></div>`).join('')}</div></details>` : ''}
    ${rules.filter(inTeam).length ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> <i class="fa-solid fa-shield-halved" style="color:#0e7490;"></i> 지킬 원칙 ${rules.filter(inTeam).length}개</summary><div class="box">${rules.filter(inTeam).map(t => `<div class="tk-rule">${taskHead(t)}<span class="tk-team">${escHtml(t.owner)}</span>${t.why ? `<div class="tk-why">${escHtml(t.why)}</div>` : ''}</div>`).join('')}</div></details>` : ''}
    <div id="tk-bulk-slot"></div>`;
  bulkBar();
}
// ── 여러 개 골라 한 번에(2026-11-11 사용자) ──
function bulkBar() {
  const slot = $('tk-bulk-slot'); if (!slot) return;
  const list = tasksState.data?.tasks || [];
  const picked = [...tasksState.sel].map(id => list.find(t => t.id === id)).filter(Boolean);
  if (!picked.length) { slot.innerHTML = ''; return; }
  const ns = picked.filter(t => !t.started_at).length;
  slot.innerHTML = `<div class="tk-bulk" role="region" aria-label="고른 할 일 한 번에 처리">
    <div class="tk-bulk-row"><b>${picked.length}개 고름</b>
      <button class="btn sm ghost" ${ns ? '' : 'disabled title="고른 일이 모두 이미 진행 중이에요"'} onclick="taskBulk('start', this)"><i class="fa-solid fa-play"></i> 한 번에 시작${ns && ns < picked.length ? ` (${ns})` : ''}</button>
      <button class="btn sm primary" onclick="taskBulk('done', this)"><i class="fa-solid fa-check-double"></i> 한 번에 시작과 함께 완료</button>
      <button class="btn sm ghost tk-skip-btn" onclick="const f=this.closest('.tk-bulk').querySelector('.tk-skip');f.hidden=!f.hidden;if(!f.hidden)f.querySelector('input').focus()"><i class="fa-solid fa-ban"></i> 한 번에 미진행</button>
      <button class="linkish" onclick="taskSelClear()">고르기 취소</button></div>
    <div class="tk-skip" hidden>
      <div class="tk-skip-h"><i class="fa-solid fa-ban"></i> ${picked.length}개 모두 같은 이유로 닫아요 <span class="muted">시즌 90일 · 재고 14일 · 더 급한 일 7일 · 그 외 30일 쉬었다가 다시 검토 · 판매 급등하면 바로 다시</span></div>
      <div class="tk-skip-q">${SKIP_QUICK.map(r => `<button type="button" class="kchip" onclick="taskSkipPick(this)">${escHtml(r)}</button>`).join('')}</div>
      <div class="tk-skip-f"><input type="text" maxlength="200" placeholder="미진행 이유" aria-label="미진행 이유" onkeydown="if(event.key==='Enter'&&!event.isComposing)this.nextElementSibling.click()"><button class="btn sm primary" onclick="taskBulkSkip(this)">${picked.length}개 미진행으로 닫기</button></div>
    </div>
  </div>`;
}
function taskSel(id, btn) {
  const s = tasksState.sel, on = !s.has(id);
  if (on) s.add(id); else s.delete(id);
  btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on));
  btn.closest('.tk-row')?.classList.toggle('sel', on);
  bulkBar();
}
function taskSelAll(ids) {
  const a = ids.split(',').filter(Boolean), all = a.every(id => tasksState.sel.has(id));
  a.forEach(id => all ? tasksState.sel.delete(id) : tasksState.sel.add(id));
  tasksDraw();
}
function taskSelClear() { tasksState.sel.clear(); tasksDraw(); }
function taskBulkSkip(btn) {
  const i = btn.closest('.tk-skip').querySelector('input'), reason = String(i.value || '').trim();
  if (reason.length < 2) { toast('미진행 이유를 적어 주세요'); i.focus(); return; }
  taskBulk('skip', btn, reason);
}
// 고른 일을 5개씩 나눠 서버에 보냄 — 하나가 실패해도 나머지는 처리하고, 실패한 것은 고른 채로 남긴다
async function taskBulk(kind, btn, reason = '') {
  const list = tasksState.data?.tasks || [];
  const picked = [...tasksState.sel].map(id => list.find(t => t.id === id)).filter(Boolean);
  const jobs = kind === 'start' ? picked.filter(t => !t.started_at).map(t => ['start', { id: t.id }])
    : kind === 'done' ? picked.map(t => ['done', t.started_at ? { id: t.id } : { id: t.id, start: true }])
    : picked.map(t => ['skip', { id: t.id, reason }]);
  if (!jobs.length) return;
  const label = { start: '시작', done: '시작과 함께 완료', skip: '미진행' }[kind];
  if (jobs.length >= 5 && !confirm(`${jobs.length}개를 한 번에 '${label}' 할까요?`)) return;
  btn.closest('.tk-bulk')?.querySelectorAll('button').forEach(b => { b.disabled = true; });
  let ok = 0; const failed = [];
  for (let i = 0; i < jobs.length; i += 5) {
    const part = jobs.slice(i, i + 5);
    const res = await Promise.allSettled(part.map(([a, b]) => callFn('agent-tasks', { action: a }, { method: 'POST', body: JSON.stringify(b) })));
    res.forEach((r, j) => {
      const id = part[j][1].id;
      if (r.status === 'fulfilled' && r.value?.task) { const k = list.findIndex(t => t.id === id); if (k >= 0) list[k] = r.value.task; tasksState.sel.delete(id); ok++; }
      else failed.push(id);
    });
  }
  tasksDraw();
  toast(`${ok}개 ${kind === 'skip' ? '미진행으로 닫았어요' : label + '했어요'}${failed.length ? ` · ${failed.length}개는 실패해서 고른 채로 남겼어요(새로고침 후 다시)` : ''}`);
}
function tasksNavBadge(n) {
  const a = document.querySelector('.nav a[data-key="decide"]'); if (!a) return;
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
const taskStartDone = (id, btn) => taskCall('done', { id, start: true }, btn, '시작과 함께 완료했어요');
const taskStart = (id, btn, undo) => taskCall('start', undo ? { id, undo: true } : { id }, btn, undo ? '시작을 취소했어요' : '진행 중으로 옮겼어요');
const taskUndo = (id, btn) => taskCall('done', { id, undo: true }, btn, '다시 할 일로 돌렸어요');
function taskChgOpen(btn) { const f = btn.closest('.tk-main')?.querySelector('.tk-chg'); if (!f) return; f.hidden = !f.hidden; if (!f.hidden) (f.querySelector('.tk-m') || f.querySelector('.tk-n'))?.focus(); }
function taskChange(id, btn) {
  const f = btn.closest('.tk-chg'), m = f.querySelector('.tk-m'), b = f.querySelector('.tk-b'), n = f.querySelector('.tk-n');
  const v = String(b?.value || '').trim(), w = v ? Math.round(Number(v) * 10000) : 0;
  if (v && !(w > 0)) { toast('하루 예산은 숫자(만원)로 적어 주세요'); b.focus(); return; }
  if (!m && !String(n?.value || '').trim()) { toast('바꿀 내용(메모)을 적어 주세요'); n?.focus(); return; }
  taskCall('change', { id, method: m ? m.value : '', daily_won: w || null, note: String(n?.value || '').trim() }, btn, r => `바꿨어요${m ? ` — ${METHOD_LABEL[m.value]}` : ''}${r.notify_note ? ` · ${r.notify_note}` : ' · 담당 팀에 알렸어요'}`);
}
function taskSkipOpen(btn) { const f = btn.closest('.tk-main')?.querySelector('.tk-skip'); if (!f) return; f.hidden = !f.hidden; if (!f.hidden) f.querySelector('input')?.focus(); }
function taskSkipPick(b) { const i = b.closest('.tk-skip').querySelector('input'); i.value = b.textContent; i.focus(); }
function taskSkip(id, btn) {
  const i = btn.closest('.tk-skip').querySelector('input'), reason = String(i.value || '').trim();
  if (reason.length < 2) { toast('미진행 이유를 적어 주세요'); i.focus(); return; }
  taskCall('skip', { id, reason }, btn, r => `미진행으로 닫았어요 — ${r.task?.skip_until ? md2(r.task.skip_until) + '까지 쉬고' : ''} 판매가 급등하면 바로 다시 올라와요`);
}
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
      if (fresh.status === 'ok') { (tasksState.data.creative ||= {})[no] = { report_id: fresh.id, date: tasksState.data.today }; toast('제작안이 도착했어요'); if (/^#(board|decide)/.test(location.hash)) tasksDraw(); return; }
    }
  } catch (e) { toast('실패: ' + e.message); }
  btnIdle(btn, '<i class="fa-solid fa-wand-magic-sparkles"></i> 제작안 만들기');
}

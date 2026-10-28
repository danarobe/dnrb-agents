/* ──────────────────────────────────────────
   보고서 피드 — agent_reports (db 프록시, admin)
   #reports        : 목록 + 최신 보고서
   #reports/<id>   : 그 보고서
────────────────────────────────────────── */
let __reportsCache = null;
const reportsState = { filter: '' };
function reportsFilter(k) { reportsState.filter = k; if (k) location.hash = '#reports/agent:' + k; else if (location.hash !== '#reports') location.hash = '#reports'; else renderReports(); }
async function reportsLoad(force) {
  if (__reportsCache && !force) return __reportsCache;
  const SEL = 'agent_reports?select=id,agent,report_date,trigger,status,report,data,error,model,created_at&status=in.(ok,error)&order=created_at.desc';   // collected(08:00 숫자판)는 보고서가 아님
  const rare = AGENTS.filter(a => a.status === 'active' && a.onDemand).map(a => a.key);
  const [recent, rareRows] = await Promise.all([
    dbProxy(SEL + '&limit=60'),
    rare.length ? dbProxy(SEL + `&agent=in.(${rare.join(',')})&limit=20`).catch(() => []) : [],
  ]);
  const byId = new Map([...(recent || []), ...(rareRows || [])].map(r => [r.id, r]));
  const rows = [...byId.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  // 같은 날을 여러 번 실행했으면 최신 것만 보여준다 (재실행으로 목록이 어지러워지는 것 방지, 2026-09-11)
  const seen = new Set();
  __reportsCache = rows.filter(r => { const k = r.agent + '|' + r.report_date; if (seen.has(k)) return false; seen.add(k); return true; });
  return __reportsCache;
}

/* ── 할 일 완료 체크 (agent_actions, 2026-09-11) ──
   키 = 에이전트가 붙인 week_actions[].id. id가 없는 옛 보고서 항목은 since+제목으로 임시 키를 만든다. */
const actionsState = { map: null };
async function actionsLoad(force) {
  if (actionsState.map && !force) return actionsState.map;
  const rows = await dbProxy('agent_actions?select=agent,action_id,done,done_by,done_at,title,owner,week_start,carried_to,why,since').catch(() => []);
  actionsState.map = new Map((rows || []).map(r => [r.agent + '|' + r.action_id, r]));
  return actionsState.map;
}
const actionKey = x => x.id || ('legacy:' + (x.since || '') + ':' + String(x.title || '').slice(0, 40));
async function actionToggle(input) {
  const key = input.dataset.key, agent = input.dataset.agent || 'sales', checked = input.checked;
  input.disabled = true;
  try {
    const rows = await dbProxy('agent_actions?on_conflict=agent,action_id', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=representation',
      body: { agent, action_id: key, week_start: input.dataset.week || null, title: input.dataset.title, owner: input.dataset.owner,
        done: checked, done_by: checked ? SESSION.name : null, done_at: checked ? new Date().toISOString() : null },
    });
    const row = rows && rows[0];
    if (row) actionsState.map.set(agent + '|' + key, row);
    const wrap = input.closest('.act');
    if (wrap) {
      wrap.classList.toggle('done', checked);
      const meta = wrap.querySelector('.done-meta');
      if (meta) meta.textContent = checked ? `완료 · ${SESSION.name} · ${timeLabel(new Date().toISOString())}` : '';
    }
    toast(checked ? '완료로 표시했어요' : '완료를 취소했어요');
  } catch (e) {
    input.checked = !checked;
    toast('저장 실패: ' + e.message);
  } finally { input.disabled = false; }
}
document.addEventListener('change', e => { if (e.target.classList && e.target.classList.contains('act-chk')) actionToggle(e.target); });
/* 저번 주 할 일 → 이번 주로 가져오기 (2026-10-27): agent_actions.carried_to = 이번 주 월요일. 화면은 바로 이번 주 할 일에 합치고, 담당자는 다음 보고서부터 week_actions에 유지한다 */
async function actCarry(btn) {
  const d = btn.dataset; btn.disabled = true;
  try {
    const rows = await dbProxy('agent_actions?on_conflict=agent,action_id', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=representation',
      body: { agent: d.agent, action_id: d.key, week_start: d.week || null, title: d.title, owner: d.owner, why: d.why || null, since: d.since || null, carried_to: d.to, done: false, done_by: null, done_at: null },
    });
    const row = rows && rows[0];
    if (row) (actionsState.map || (actionsState.map = new Map())).set(d.agent + '|' + d.key, row);
    toast('이번 주 할 일로 가져왔어요 — 다음 보고서부터 자동으로 이어집니다');
    if (d.rid) renderReports(d.rid);
  } catch (e) { toast('저장 실패: ' + e.message); btn.disabled = false; }
}
function actFilter(btn) {
  const box = btn.closest('.box'), o = btn.dataset.o || '';
  box.querySelectorAll('.act-filter .chip-btn').forEach(b => b.classList.toggle('on', b === btn));
  box.querySelectorAll('.act').forEach(a => { a.style.display = (!o || a.dataset.owner === o) ? '' : 'none'; });
}

async function renderReports(id) {
  const main = $('main');
  if (!isAdmin()) {
    main.innerHTML = `<div class="page-head"><h1>보고서</h1></div><div class="notice">보고서에는 매출 금액이 들어 있어 관리자만 볼 수 있어요.</div>`;
    return;
  }
  main.innerHTML = `<div class="page-head">
      <div><h1>보고서</h1><p class="sub">담당자들이 쓴 보고서가 날짜순으로 쌓입니다.</p></div>
      <div class="head-actions"><button class="btn primary" id="run-sales" onclick="agentRun('sales')"><i class="fa-solid fa-wand-magic-sparkles"></i> 지금 실행</button></div>
    </div>
    <div id="setup-notice"></div>
    <div class="filter-chips" id="report-filter"></div>
    <div class="reports-layout">
      <aside class="report-list" id="report-list"><div class="muted pad"><i class="fa-solid fa-spinner fa-spin"></i> 불러오는 중</div></aside>
      <section class="report-view" id="report-view"></section>
    </div>`;
  renderSetupNotice();
  let rows;
  try { [rows] = await Promise.all([reportsLoad(), actionsLoad()]); }
  catch (e) { $('report-list').innerHTML = `<div class="muted pad">불러오기 실패: ${escHtml(e.message)}</div>`; return; }
  // #reports/agent:<key> (담당자 카드의 '보고서 보기', 2026-09-28): 그 담당자로 필터 + 그 담당자의 최신 보고서
  let wantAgent = '';
  if (!id) reportsState.filter = '';   // 메뉴의 '보고서'(#reports)는 항상 전체 목록
  if (id && String(id).startsWith('agent:')) { wantAgent = decodeURIComponent(String(id).slice(6)); reportsState.filter = agentOf(wantAgent) ? wantAgent : ''; id = ''; }
  const byIdRow = id ? rows.find(r => r.id === id) : null;
  if (byIdRow && reportsState.filter && byIdRow.agent !== reportsState.filter) reportsState.filter = byIdRow.agent;   // 다른 담당자 보고서를 직접 열면 필터를 맞춘다
  const filterAgent = reportsState.filter;
  const shown = filterAgent ? rows.filter(r => r.agent === filterAgent) : rows;
  const cur = byIdRow || shown[0] || null;   // 필터가 있으면 그 담당자 것 중 최신 (예전엔 전체 최신 rows[0]이 떠서 다른 담당자 보고서가 보였음)
  const runAgent = agentOf(filterAgent) && !agentOf(filterAgent).onDemand ? filterAgent : (filterAgent ? '' : 'sales');
  const ha = document.querySelector('.head-actions');
  if (ha) ha.innerHTML = runAgent ? `<button class="btn primary" id="run-${runAgent}" onclick="agentRun('${runAgent}')"><i class="fa-solid fa-wand-magic-sparkles"></i> ${escHtml(agentOf(runAgent).name)} 지금 실행</button>` : '';
  $('report-filter').innerHTML = [['', '전체'], ...AGENTS.filter(a => a.status === 'active').map(a => [a.key, a.name])]
    .map(([k, label]) => `<button class="chip-btn ${filterAgent === k ? 'on' : ''}" onclick="reportsFilter('${k}')">${label}</button>`).join('');
  $('report-list').innerHTML = shown.length ? shown.map(r => {
    const a = agentOf(r.agent) || { name: r.agent, color: '#6b7280', icon: 'fa-robot' };
    return `<a class="report-item ${cur && r.id === cur.id ? 'active' : ''} ${r.status === 'error' ? 'err' : ''}" href="#reports/${r.id}">
      <span class="dot" style="background:${r.status === 'error' ? '#dc2626' : a.color};"></span>
      <span class="ri-body">
        <span class="ri-top"><b>${dateShort(r.report_date)}</b> <span class="muted">${a.short || a.name} · ${r.trigger === 'cron' ? '자동' : '수동'}</span></span>
        <span class="ri-line">${r.status === 'error' ? '보고서 실패' : escHtml(r.report?.headline || a.name)}</span>
      </span></a>`;
  }).join('') : `<div class="muted pad">${filterAgent ? escHtml(agentOf(filterAgent)?.name || '') + '의 보고서가 아직 없어요.' : '아직 보고서가 없어요. 매일 아침 8시에 자동으로 도착하고, <b>지금 실행</b>으로 바로 만들 수도 있어요.'}</div>`;
  $('report-view').innerHTML = cur ? reportHtml(cur) : '<div class="muted pad">왼쪽에서 보고서를 고르세요.</div>';
  stackTables($('report-view'));
  if (cur && cur.status === 'ok' && cur.report && typeof askLoad === 'function') askLoad(cur.id);   // 담당자에게 질문 (2026-09-15)
  if (cur && window.innerWidth <= 800) $('report-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function reportHtml(r) {
  const a = agentOf(r.agent) || { name: r.agent, color: '#6b7280', icon: 'fa-robot' };
  const head = `<div class="rv-head">
      <span class="agent-icon sm" style="background:${a.color}1a;color:${a.color};"><i class="fa-solid ${a.icon}"></i></span>
      <div><b>${a.name}</b><div class="muted">기준일 ${dateLabel(r.report_date)} · ${timeLabel(r.created_at)} 작성 · ${r.trigger === 'cron' ? '자동 실행' : '수동 실행'}${r.model ? ' · ' + escHtml(r.model) : ''}</div></div>
    </div>`;
  if (r.status === 'error' || !r.report) {
    return head + `<div class="notice err"><b><i class="fa-solid fa-triangle-exclamation"></i> 이번 보고서는 만들지 못했어요.</b><br>${escHtml(r.error || '원인 미상')}</div>` + dataErrors(r.data);
  }
  const rp = r.report, d = r.data || {}, rev = d.revenue || {}, ch = rev.change_pct || {}, ads = d.ads;
  const md = d => d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '';
  const tile = (label, value, sub) => `<div class="tile"><div class="t-label">${label}</div><div class="t-value">${value}</div><div class="t-sub">${sub}</div></div>`;
  let tiles = '', extraBoxes = '', headExtra = '', headBody = '', tilesCls = '';
  if (r.agent === 'returns') {
    const ts = d.top_sellers_return || {}, co = d.cohorts || {};
    const weeks = co.weeks || [], ms = co.mature_weeks_summary, lm = ms?.latest_mature, cur = weeks.find(w => w.partial) || weeks[0];
    const wk = w => w ? `${md(w.start)}~${md(w.end)}` : '';
    const pr = v => v == null ? '—' : v + '%';
    if (weeks.length) {
      // 2026-10-26 사용자 요청: 취소율·반품률은 '최근 성숙 주 + 최근 성숙 주를 포함한 4주 총합', 이번 주(집계 중)는 표시하지 않음
      const m4 = co.mature_4w || (() => {   // 옛 보고서: 성숙 주 4개를 화면에서 합산
        const ws = weeks.filter(w => w.maturity === '성숙').slice(0, 4); if (!ws.length) return null;
        const sum = k => ws.reduce((t, w) => t + (Number(w[k]) || 0), 0);
        return { count: ws.length, weeks: ws.map(w => w.week), paid: sum('paid'), cancel: sum('cancel'), ret: sum('ret'), cancel_rate: sum('paid') ? +(sum('cancel') / sum('paid') * 100).toFixed(2) : null, return_rate: sum('paid') ? +(sum('ret') / sum('paid') * 100).toFixed(2) : null };
      })();
      const m4Range = m4 && m4.weeks?.length ? `${md(String(m4.weeks[m4.weeks.length - 1]).slice(0, 10))}~${md(String(m4.weeks[0]).slice(11, 21))}` : '';
      tiles = [
        tile('취소율', lm ? `${pr(lm.cancel_rate)} <span class="t-sub-inline">· 4주 ${m4 ? pr(m4.cancel_rate) : '—'}</span>` : '—', lm ? `최근 성숙 주 ${wk(lm)} · 성숙 ${m4?.count || 0}주 총합 취소 ${fmt(m4?.cancel)}건 ÷ 결제 ${fmt(m4?.paid)}건` : '성숙한 주가 아직 없음'),
        tile('반품률', lm ? `${pr(lm.return_rate)} <span class="t-sub-inline">· 4주 ${m4 ? pr(m4.return_rate) : '—'}</span>` : '—', lm ? `최근 성숙 주 ${wk(lm)} · 성숙 ${m4?.count || 0}주 총합 반품 ${fmt(m4?.ret)}건 ÷ 결제 ${fmt(m4?.paid)}건` : '성숙한 주가 아직 없음'),
        tile('위험·주의 상품', (rp.risk_products || []).length + '개', `상위 상품 14일 순반품률 ${ts.rate_14d != null ? ts.rate_14d + '%' : '—'} · 관리 ${fmt(d.watched_count || 0)}개`),
        tile('성숙 4주 결제', m4 ? fmt(m4.paid) + '건' : '—', m4 ? `${m4Range} · 취소 ${fmt(m4.cancel)}건 · 반품 ${fmt(m4.ret)}건` : '성숙한 주가 아직 없음'),
      ].join('');
      // 헤드라인 안: 최근 6주 취소율·반품률 꺾은선 그래프 (2026-10-27 사용자 요청 — 요약의 코호트 흐름 문장 대신; 막대 → 꺾은선). 진행 중인 주는 빼고 꽉 찬 주 6개,
      //   집계 중인 주로 이어지는 구간은 점선 + 빈 점 + '집계 중' 글자 (아직 늘어날 수 있는 숫자임을 색 말고도 알 수 있게)
      const full = weeks.filter(w => !w.partial).slice(0, 6).reverse();
      if (full.length >= 2) {
        const W = 640, H = 220, padL = 44, padR = 44, padT = 28, padB = 44;
        const maxV = Math.max(5, ...full.flatMap(w => [Number(w.cancel_rate) || 0, Number(w.return_rate) || 0])) * 1.4;
        const x = i => padL + (W - padL - padR) * (full.length === 1 ? 0.5 : i / (full.length - 1));
        const y = v => padT + (H - padT - padB) * (1 - (Number(v) || 0) / maxV);
        const ticks = [0, Math.round(maxV / 3), Math.round(maxV * 2 / 3)].filter((v, i, a) => a.indexOf(v) === i);
        const grid = ticks.map(t => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" stroke="#e5e7eb" stroke-width="1"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end" font-size="10" fill="#6b7280">${t}%</text>`).join('');
        const series = (key, color, label, dy) => {
          const segs = full.slice(1).map((w, i) => `<line x1="${x(i)}" y1="${y(full[i][key])}" x2="${x(i + 1)}" y2="${y(w[key])}" stroke="${color}" stroke-width="2" stroke-linecap="round" ${w.maturity !== '성숙' ? 'stroke-dasharray="5 4"' : ''}/>`).join('');
          const dots = full.map((w, i) => {
            const imm = w.maturity !== '성숙', cnt = key === 'cancel_rate' ? `${fmt(w.cancel)}/${fmt(w.paid)}건` : `${fmt(w.ret)}/${fmt(w.paid)}건`;
            return `<g><circle cx="${x(i)}" cy="${y(w[key])}" r="4.5" fill="${imm ? '#fff' : color}" stroke="${color}" stroke-width="2"><title>${escHtml(`${md(w.start)}~${md(w.end)} ${label} ${pr(w[key])} (${cnt})${imm ? ' · 집계 중' : ''}`)}</title></circle>
              <text x="${x(i)}" y="${y(w[key]) + dy}" text-anchor="middle" font-size="10" font-weight="700" fill="#374151">${pr(w[key])}</text></g>`;
          }).join('');
          return segs + dots;
        };
        // 값 글자: 반품률은 점 위, 취소율은 점 아래로 고정 (두 선이 가까워도 서로 겹치지 않게)
        const xLabels = full.map((w, i) => `<text x="${x(i)}" y="${H - padB + 16}" text-anchor="middle" font-size="10.5" fill="#374151">${md(w.start)}~${md(w.end)}</text>` + (w.maturity !== '성숙' ? `<text x="${x(i)}" y="${H - padB + 30}" text-anchor="middle" font-size="9.5" fill="#9ca3af">집계 중</text>` : '')).join('');
        headExtra += `<div class="cohort-chart"><div class="cc-head"><b>최근 ${full.length}주 취소율 · 반품률</b><span class="muted small">결제 주차 기준 · 점선·빈 점 = 집계 중(아직 늘어날 수 있음)</span>
          <span class="cc-legend"><i style="background:#2563eb"></i>취소율 <i style="background:#b91c1c"></i>반품률</span></div>
          <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 ${full.length}주 취소율과 반품률">
            ${grid}<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="#9ca3af" stroke-width="1"/>
            ${series('cancel_rate', '#2563eb', '취소율', 17)}${series('return_rate', '#b91c1c', '반품률', -10)}
            ${xLabels}
          </svg></div>`;
      }
      // 개요 바로 아래: Best 30 중 취소율 TOP5 / 순반품률 TOP5 (코드 집계, 2026-10-26 사용자 요청)
      const b30 = d.best30;
      if (b30 && ((b30.cancel_top5 || []).length || (b30.return_top5 || []).length)) {
        const lvl = l => l === '위험' ? 'bad' : l === '주의' ? 'warn' : 'good';
        const row = (i, name, main, sub, chip = '') => `<div class="b30-row"><span class="num">${i + 1}</span><div><b>${escHtml(name)}</b><div class="muted small">${sub}</div></div><div class="b30-val">${main}${chip}</div></div>`;
        headExtra += `<div class="two b30">
          <div class="box"><h3><i class="fa-solid fa-ban" style="color:#b91c1c;"></i> Best 30 중 취소율 TOP 5 <span class="muted small">결제일 기준 14일 · 취소완료</span></h3>
            ${(b30.cancel_top5 || []).map((x, i) => row(i, x.name, `<b>${pr(x.cancel_rate)}</b>`, `판매 ${x.rank}위 · 취소 ${fmt(x.cancel_qty)}개 / 결제 ${fmt(x.paid_qty)}개`)).join('') || '<div class="muted">취소가 있는 상품 없음</div>'}</div>
          <div class="box"><h3><i class="fa-solid fa-rotate-left" style="color:#b91c1c;"></i> Best 30 중 순반품률 TOP 5 <span class="muted small">배송완료 기준 14일 창</span></h3>
            ${(b30.return_top5 || []).map((x, i) => row(i, x.name, `<b>${pr(x.rate_14d)}</b>`, `판매 ${x.rank}위 · 반품 ${fmt(x.returned_14d)}개 / 배송완료 ${fmt(x.delivered_14d)}개`, ` <span class="chip ${lvl(x.level)}">${escHtml(x.level)}</span>`)).join('') || '<div class="muted">반품이 있는 상품 없음</div>'}</div>
        </div>`;
      }
    } else {
      // 코호트 도입 전 보고서(2026-09-11 이전 데이터)
      const cl = d.claims || {}, cc = cl.cancel || {}, rt = cl.return || {};
      tiles = [
        tile('최근 7일 취소', cc.last7 ? fmt(cc.last7.count) + '건' : '—', '주문일 기준 · 미성숙 집계'),
        tile('최근 7일 반품', rt.last7 ? fmt(rt.last7.count) + '건' : '—', '주문일 기준 · 미성숙 집계'),
        tile('상위 상품 순반품률', ts.rate_14d != null ? ts.rate_14d + '%' : '—', `14일 창 · 배송완료 ${fmt(ts.delivered_14d)}개 중 반품 ${fmt(ts.returned_14d)}개`),
        tile('위험·주의 상품', (rp.risk_products || []).length + '개', `관리 상품 ${fmt(d.watched_count || 0)}개 점검`),
      ].join('');
    }
    const matColor = { '성숙': 'good', '집계 중': '', '진행 중': 'new' };
    const cohortRows = (rp.cohort_table || []).map(x => {
      const raw = weeks.find(w => `${w.start}~${w.end}` === x.week) || {};
      return `<tr><td><b>${escHtml(x.week.replace(/\d{4}-/g, ''))}</b><div class="muted">${raw.age_days != null ? raw.age_days + '일 경과' : ''}</div></td>
        <td><span class="chip ${matColor[x.maturity] || ''}">${escHtml(x.maturity)}</span></td>
        <td class="r">${fmt(x.paid)}건</td><td class="r"><b>${pr(x.cancel_rate)}</b>${raw.cancel != null ? `<div class="muted">${fmt(raw.cancel)}건</div>` : ''}</td>
        <td class="r"><b>${pr(x.return_rate)}</b>${raw.ret != null ? `<div class="muted">${fmt(raw.ret)}건</div>` : ''}</td><td>${escHtml(x.verdict)}</td></tr>`;
    }).join('');
    const cohortBox = cohortRows ? `<div class="box"><h3><i class="fa-regular fa-calendar-check" style="color:#4f46e5;"></i> 결제 주차별 취소·반품률 <span class="muted small">그 주에 결제된 주문 중 지금까지 취소·반품된 비율 · 성숙 = 14일 이상 경과</span></h3>
      <div class="tbl-wrap"><table class="risk stack t-cohort"><thead><tr><th>결제 주(월~일)</th><th>상태</th><th class="r">결제</th><th class="r">취소율</th><th class="r">반품률</th><th>판단</th></tr></thead><tbody>${cohortRows}</tbody></table></div>
      <div class="muted small chk-hint">취소가 다음 주에 일어나도 결제한 주로 돌아갑니다. 집계 중인 주는 앞으로 더 올라갑니다.</div></div>` : '';
    const lvColor = { '위험': 'down', '주의': 'warn' };
    const riskRows = (rp.risk_products || []).map(x => `<tr><td><b>${escHtml(x.name)}</b><div class="muted">${escHtml(x.cause)}</div></td><td class="r"><b class="${lvColor[x.level] || ''}">${escHtml(x.level)}</b><div class="muted">${x.rate_14d}% · ${fmt(x.delivered_14d)}개</div></td><td>${escHtml(x.fix)}</td></tr>`).join('');
    const vColor = { '개선': 'up-good', '유지': '', '악화': 'down' };
    const watchRows = (rp.watch_review || []).map(x => `<div class="li"><div class="li-top"><b>${escHtml(x.name)}</b><span class="chip ${x.verdict === '개선' ? 'good' : x.verdict === '악화' ? 'bad' : ''}">${escHtml(x.verdict)}</span></div><div>${escHtml(x.detail)}</div></div>`).join('');
    extraBoxes = cohortBox + `
    <div class="box"><h3><i class="fa-solid fa-triangle-exclamation down"></i> 위험·주의 상품 <span class="muted small">14일 창 · 순반품률 ${((r.data || {}).policy || {}).risk_at_pct || 20}%↑ 위험, ${((r.data || {}).policy || {}).warn_at_pct || 10}~${((r.data || {}).policy || {}).risk_at_pct || 20}% 주의</span></h3>
      ${riskRows ? `<div class="tbl-wrap"><table class="risk stack t-risk"><thead><tr><th>상품 · 원인 추정</th><th class="r">판정</th><th>대응</th></tr></thead><tbody>${riskRows}</tbody></table></div>` : '<div class="muted">위험·주의 상품이 없어요</div>'}
    </div>
    <div class="box"><h3><i class="fa-solid fa-star" style="color:#b45309;"></i> 관리 상품 점검 <span class="muted small">워크스페이스 반품 관리에서 지정한 상품</span></h3>${watchRows || '<div class="muted">관리 상품이 없어요</div>'}</div>`;
  } else if (r.agent === 'detail') {
    const revs = rp.reviews || [];
    const scoreColor = sc => sc == null ? 'var(--muted)' : sc >= 75 ? 'var(--good)' : sc >= 55 ? '#b45309' : 'var(--bad)';
    tiles = [
      tile('점검 상품', `${revs.length}개`, revs.map(x => (x.product_name || '').replace(/^\(.*?\)\s*/, '').slice(0, 12)).join(' · ')),
      tile('평균 점수', revs.filter(x => x.review).length ? Math.round(revs.filter(x => x.review).reduce((t, x) => t + (x.review.score || 0), 0) / revs.filter(x => x.review).length) + '점' : '—', '실측표·사이즈·소재·컷 구성·첫 화면 기준'),
      tile('빠진 요소', revs.reduce((t, x) => t + ((x.review?.missing || []).length), 0) + '개', '상품별 상세에서 확인'),
      tile('읽은 이미지', revs.reduce((t, x) => t + (x.image_count || 0), 0) + '장', 'Gemini 읽기 · 같은 상세는 재사용'),
    ].join('');
    extraBoxes = revs.map(x => {
      if (x.status !== 'ok' || !x.review) return `<div class="box"><h3>${escHtml(x.product_name)}</h3><div class="notice err">점검 실패: ${escHtml(x.error || '원인 미상')}</div></div>`;
      const v = x.review, c = v.context || {};
      const ctxBits = [];
      if (c.new_arrival) ctxBits.push(`신상품 ${escHtml(c.new_arrival.quadrant)} · 주문율 ${c.new_arrival.rate_14d}%`);
      if (c.focus) ctxBits.push(escHtml(c.focus.why));
      if (c.returns) ctxBits.push(`반품 ${escHtml(c.returns.level)} ${c.returns.rate_14d}% (${(c.returns.reasons_top3 || []).slice(0, 2).map(escHtml).join(', ')})`);
      if (c.rising_keywords) ctxBits.push(`급상승 키워드 ${c.rising_keywords.map(escHtml).join(', ')}`);
      return `<div class="box detail-box">
        <div class="dt-head"><div><b>${escHtml(x.product_name)}</b><div class="muted small">${escHtml(x.reason || '')}${ctxBits.length ? ' · ' + ctxBits.join(' · ') : ''} · 이미지 ${x.image_count}장</div></div>
          <div class="score" style="color:${scoreColor(v.score)}">${v.score}<span>점</span></div></div>
        <div class="fx"><b>총평</b> ${escHtml(v.verdict)}</div>
        ${v.top_priority ? `<div class="fx top-fix"><b>가장 먼저</b> <strong>${escHtml(v.top_priority.what)}</strong> <span class="muted">— ${escHtml(v.top_priority.why)}</span></div>` : ''}
        ${(v.keyword_review || []).length ? `<div class="fx"><b>키워드 검증</b>${v.keyword_review.map(k => `<div class="kw-row"><span class="chip ${k.fits === '맞음' ? 'good' : k.fits === '안 맞음' ? 'bad' : ''}">${escHtml(k.keyword)} · ${escHtml(k.fits)}</span> <span class="muted small">${escHtml(k.reason)}</span></div>`).join('')}</div>` : ''}
        <div class="dt-grid">
          <div><h4><i class="fa-solid fa-circle-xmark down"></i> 빠졌거나 약한 것</h4>${(v.missing || []).length ? '<ul>' + v.missing.map(m => `<li>${escHtml(m)}</li>`).join('') + '</ul>' : '<div class="muted small">없음</div>'}
            <h4 style="margin-top:8px;"><i class="fa-solid fa-circle-check up"></i> 잘 된 것</h4>${(v.keep || []).length ? '<ul>' + v.keep.map(m => `<li>${escHtml(m)}</li>`).join('') + '</ul>' : '<div class="muted small">—</div>'}</div>
          <div><h4><i class="fa-solid fa-star" style="color:#7c3aed;"></i> 첫 화면에 내세울 것</h4>${(v.first_screen || []).map(f => `<div class="li"><b>${escHtml(f.what)}</b><div>${escHtml(f.why)}</div></div>`).join('') || '<div class="muted small">—</div>'}
            ${(v.reorder || []).length ? `<h4 style="margin-top:8px;"><i class="fa-solid fa-arrow-down-up-across-line" style="color:#7c3aed;"></i> 순서·강조 변경</h4><ul>${v.reorder.map(m => `<li>${escHtml(m)}</li>`).join('')}</ul>` : ''}</div>
        </div>
        ${(v.copy_snippets || []).length ? `<h4 style="margin-top:10px;"><i class="fa-regular fa-clipboard" style="color:#7c3aed;"></i> 붙여 넣을 문장</h4>${v.copy_snippets.map(sn => `<div class="snippet"><div class="muted small">${escHtml(sn.where)}</div><div class="snip-text">${escHtml(sn.text)}</div><button class="btn ghost sm" onclick="copyText(this)" data-text="${escHtml(sn.text)}"><i class="fa-regular fa-copy"></i> 복사</button></div>`).join('')}` : ''}
      </div>`;
    }).join('');
  } else if (r.agent === 'creative') {
    // 광고 소재 담당 (2026-09-18): 상품별 후킹 포인트·제작안. 숫자·리뷰 인용은 서버가 모은 것만, 문구는 복사 버튼으로.
    const bs = rp.briefs || [], fs = d.format_stats, acc = fs?.account;
    const okb = bs.filter(x => x.status === 'ok' && x.brief);
    const hooksAll = okb.flatMap(x => x.brief.plans || x.brief.hooks || []);   // v2 제작안(plans) 또는 v1 훅(hooks)
    const won = v => v == null ? '—' : Math.round(v).toLocaleString('ko-KR') + '원';
    const rvOk = okb.filter(x => x.review_status === 'ok').length;
    tiles = [
      tile('분석 상품', `${okb.length}개`, `급상승 ${okb.filter(x => x.kind === 'surge').length} · 베스트 ${okb.filter(x => x.kind === 'best').length}${okb.some(x => x.kind === 'manual') ? ' · 직접 고름 ' + okb.filter(x => x.kind === 'manual').length : ''}`),
      tile(okb.some(x => x.brief.plans) ? '소재 제작안' : '후킹 포인트', `${hooksAll.length}개`, `전환형 ${hooksAll.filter(h => h.goal === '전환형').length} · 클릭형 ${hooksAll.filter(h => h.goal === '클릭형').length}`),
      tile('리뷰 반영', d.review_scope_missing ? '권한 대기' : `${rvOk}/${okb.length}`, d.review_scope_missing ? '카페24 재연동 후 자동 반영' : `리뷰 ${fmt(okb.reduce((t, x) => t + (x.review_count || 0), 0))}건 읽음`),
      tile('계정 평균 (30일)', acc ? `CTR ${acc.ctr ?? '—'}%` : '—', acc ? `CPC ${won(acc.cpc)} · 구매당 ${won(acc.cost_per_purchase)} · ROAS ${acc.roas ?? '—'}` : 'Meta 성과를 못 받았어요'),
    ].join('');
    const cmp = (v, base, lowerBetter) => (v == null || base == null) ? '' : ((lowerBetter ? v < base : v > base) ? 'up-good' : 'down-bad');
    const fsRows = (fs?.styles || []).map(s => `<tr><td><b>${escHtml(s.style)}</b><div class="muted">${fmt(s.ads)}개 · 지출 ${fmtMan(s.spend)}</div></td>
        <td class="r ${cmp(s.ctr, acc?.ctr, false)}">${s.ctr ?? '—'}%</td><td class="r ${cmp(s.cpc, acc?.cpc, true)}">${won(s.cpc)}</td>
        <td class="r ${cmp(s.cost_per_purchase, acc?.cost_per_purchase, true)}">${won(s.cost_per_purchase)}</td><td class="r ${cmp(s.roas, acc?.roas, false)}">${s.roas ?? '—'}</td></tr>`).join('');
    const fsBox = fsRows ? `<div class="box"><h3><i class="fa-solid fa-ranking-star" style="color:#b45309;"></i> 소재 유형별 효율 <span class="muted small">최근 30일 · 광고명 규칙으로 읽은 유형 · 초록 = 계정 평균보다 좋음</span></h3>
      <div class="tbl-wrap"><table class="risk stack t-format"><thead><tr><th>유형</th><th class="r">CTR</th><th class="r">CPC</th><th class="r">구매당 비용</th><th class="r">ROAS</th></tr></thead><tbody>${fsRows}</tbody></table></div>
      <div class="muted small chk-hint">계정 평균: CTR ${acc?.ctr ?? '—'}% · CPC ${won(acc?.cpc)} · 구매당 ${won(acc?.cost_per_purchase)} · ROAS ${acc?.roas ?? '—'}. 꺼진 소재도 포함(실패한 유형도 근거).</div></div>` : '';
    const copyBtn = t => `<button class="btn ghost sm" onclick="copyText(this)" data-text="${escHtml(t)}"><i class="fa-regular fa-copy"></i> 복사</button>`;
    const cards = bs.map(x => {
      if (x.status !== 'ok' || !x.brief) return `<div class="focus-card"><b>${escHtml(x.product_name)}</b><div class="notice err" style="margin-top:8px;">제작안 실패: ${escHtml(x.error || '원인 미상')}</div></div>`;
      const b = x.brief, m = x.metrics || {};
      const rvChip = x.review_status === 'ok' ? `<span class="chip good">리뷰 ${fmt(x.review_count)}건${x.rating_avg ? ' · ★' + x.rating_avg : ''}</span>` : x.review_status === 'scope_missing' ? '<span class="chip">리뷰 권한 대기</span>' : '<span class="chip">리뷰 없음</span>';
      const head = `<div class="focus-head"><div><b>${escHtml(x.product_name)}</b> <span class="chip ${x.kind === 'surge' ? 'new' : ''}">${escHtml(m.why || '')}</span> ${rvChip} <span class="chip">신뢰도 ${escHtml(b.confidence)}</span>
          <div class="muted">14일 조회 ${fmt(m.views_14d)} · 주문율 ${m.rate_14d ?? '—'}% · 판매 ${fmt(m.qty_14d)}개${m.margin_rate != null ? ' · 마진 ' + m.margin_rate + '%' : ''}${(m.promos || []).length ? ' · ' + m.promos.map(escHtml).join(', ') : ''}</div></div></div>
        <div class="fx"><b>한 문장</b> ${escHtml(b.one_liner)}</div>
        <div class="fx"><b>핵심 고객</b> ${escHtml(b.target)}</div>`;
      const adRows = (x.ads || []).slice(0, 4).map(a => `<tr><td><b>${escHtml(a.name || a.ad_name || '')}</b>${a.body ? `<div class="muted">${escHtml(String(a.body).slice(0, 90))}</div>` : ''}</td><td class="r">${a.ctr ?? '—'}%</td><td class="r">${won(a.cpc)}</td><td class="r">${won(a.cost_per_purchase)}</td><td class="r">${a.roas ?? '—'}</td></tr>`).join('');
      const tail = `${(b.proof_quotes || []).length ? `<h4 class="cr-h"><i class="fa-solid fa-quote-left" style="color:#b45309;"></i> 자막에 쓸 리뷰 원문 <span class="muted small">실구매 후기 그대로 — 원문 대조 완료</span></h4>${b.proof_quotes.map(q => `<div class="snippet"><div class="snip-text">“${escHtml(q)}”</div>${copyBtn(q)}</div>`).join('')}` : ''}
        ${(b.used_angles || []).length ? `<h4 class="cr-h"><i class="fa-solid fa-rotate" style="color:#b45309;"></i> 이미 쓴 앵글 평가</h4>${b.used_angles.map(u => `<div class="li"><div class="li-top"><b>${escHtml(u.angle)}</b><span class="chip ${u.verdict === '폐기' ? 'bad' : u.verdict === '변주해서 확대' ? 'good' : ''}">${escHtml(u.verdict)}</span></div><div>${escHtml(u.reason)}</div></div>`).join('')}` : ''}
        ${(b.avoid || []).length ? `<h4 class="cr-h"><i class="fa-solid fa-ban down"></i> 피할 소구</h4><ul class="cr-ul">${b.avoid.map(a => `<li>${escHtml(a)}</li>`).join('')}</ul>` : ''}
        <div class="fx"><b>상세와 맞추기</b> ${escHtml(b.landing_match)}</div>
        <div class="fx"><b>테스트 순서</b> ${escHtml(b.test_plan)}</div>
        <div class="muted small" style="margin-top:6px;"><i class="fa-regular fa-circle-question"></i> 신뢰도 ${escHtml(b.confidence)} — ${escHtml(b.confidence_reason)}${(b.quote_check?.dropped || []).length ? ` · 원문과 다른 리뷰 인용 ${b.quote_check.dropped.length}개는 지웠어요` : ''}</div>
        ${adRows ? `<details class="raw"><summary>이 상품의 기존 소재 성과 (30일)</summary><table><thead><tr><th>소재 · 문구</th><th class="r">CTR</th><th class="r">CPC</th><th class="r">구매당</th><th class="r">ROAS</th></tr></thead><tbody>${adRows}</tbody></table></details>` : (x.ads === null ? '<div class="muted small">Meta 광고 성과를 못 받아 기존 소재는 반영되지 않았어요</div>' : '<div class="muted small">최근 30일에 이 상품으로 돌린 소재가 없어요</div>')}`;

      if (b.plans) {
        // v2 제작안(2026-10-13 사용자 요청): 근거판(사는 이유·망설임) → 제작안마다 ① 0~3초 멈춤 → ② 3~10초 유지·실구매 후기 증명 → ③ 전환 포인트 3단 흐름. 1순위는 펼치고 나머지는 접어 한눈에.
        const ins = b.insight || {};
        const insRow = (chip, title, sub) => `<div class="ins-row">${chip}<div><b>${title}</b>${sub ? `<div class="ins-sub">${sub}</div>` : ''}</div></div>`;
        const insight = `<div class="insight-grid">
          <div class="ins"><h5><i class="fa-solid fa-heart" style="color:#be123c;"></i> 왜 사나 <span class="muted small">${x.review_status === 'ok' ? `리뷰 ${fmt(x.review_count)}건 중 언급 수` : '상세·광고 근거'}</span></h5>
            ${(ins.buy_reasons || []).map(r => insRow(`<span class="chip ${r.count ? 'good' : ''}">${r.count ? r.count + '건' : escHtml(r.source || '')}</span>`, escHtml(r.point), r.quote ? `<span class="ins-q">“${escHtml(r.quote)}”</span>` : (r.count ? escHtml(r.source || '') : ''))).join('') || '<div class="muted small">없음</div>'}</div>
          <div class="ins"><h5><i class="fa-solid fa-circle-question" style="color:#b45309;"></i> 왜 망설이나 → 광고에서 답하기</h5>
            ${(ins.hesitations || []).map(h => insRow(`<span class="chip warn">${h.count ? h.count + '건' : escHtml(h.source || '')}</span>`, escHtml(h.worry), `<i class="fa-solid fa-arrow-turn-down-right muted"></i> ${escHtml(h.answer)}${h.count ? ` <span class="muted">(${escHtml(h.source || '')})</span>` : ''}`)).join('') || '<div class="muted small">없음</div>'}</div>
        </div>
        ${ins.detail_promise ? `<div class="fx"><b>상세가 앞세우는 것</b> ${escHtml(ins.detail_promise)}</div>` : ''}`;
        const planBody = (p) => {
          const h = p.hook || {}, ho = p.hold || {}, c = p.convert || {}, cp = p.copy || {};
          return `<div class="steps">
            <div class="step s1"><div class="st-label">① 0~3초 · 멈추게</div><div class="st-head">${escHtml(h.headline)}</div><div class="st-sub"><b>첫 장면</b> ${escHtml(h.scene)}</div><div class="st-why">${escHtml(h.why_stop)}</div></div>
            <div class="step s2"><div class="st-label">② 3~10초 · 붙잡고 증명</div><div class="st-sub"><b>장치</b> ${escHtml(ho.device)}</div>${ho.proof_quote ? `<div class="st-quote">“${escHtml(ho.proof_quote)}”<div class="muted small">실구매 후기${ho.proof_rating ? ' · ★' + ho.proof_rating : ''} · 원문 그대로</div></div>` : '<div class="st-sub muted">리뷰 인용 없음 — 상세의 사실로 증명</div>'}<div class="st-sub"><b>보여줄 것</b> ${escHtml(ho.visual)}</div></div>
            <div class="step s3"><div class="st-label">③ 전환 포인트</div><div class="st-head">${escHtml(c.point)}</div><div class="st-sub"><b>근거</b> ${escHtml(c.evidence)}</div><div class="st-cta"><i class="fa-solid fa-arrow-right"></i> ${escHtml(c.cta)}</div></div>
          </div>
          <div class="plan-copy">
            <div class="snippet"><div class="muted small">광고 본문 <span class="muted">(훅 → 후기 → 살 이유 → 행동)</span></div><div class="snip-text" style="white-space:pre-line;">${escHtml(cp.primary_text)}</div>${copyBtn(cp.primary_text)}</div>
            <div class="snippet"><div class="muted small">헤드라인</div><div class="snip-text">${escHtml(cp.headline)}</div>${copyBtn(cp.headline)}</div>
          </div>
          <div class="fx"><b>왜 전환되나</b> ${escHtml(p.rationale)}</div>
          <div class="fx"><b>형식</b> ${escHtml(p.format)}</div>
          <div class="fx"><b>기대 효과</b> ${escHtml(p.expected)}</div>`;
        };
        const planHead = (p, i) => `<span class="num">${i + 1}</span><b class="plan-title">${escHtml(p.title)}</b><span class="chip ${p.goal === '전환형' ? 'good' : 'new'}">${escHtml(p.goal)}</span><span class="chip">${escHtml(p.angle)}</span>${(p.evidence || []).map(e => `<span class="chip ev">${escHtml(e)}</span>`).join('')}`;
        const plans = (b.plans || []).map((p, i) => i === 0
          ? `<div class="plan plan-first"><div class="plan-head">${planHead(p, i)}<span class="chip first">1순위</span></div>${planBody(p)}</div>`
          : `<details class="plan"><summary><div class="plan-head">${planHead(p, i)}</div><div class="plan-sum muted">“${escHtml(p.hook?.headline || '')}” → ${escHtml(p.convert?.point || '')}</div></summary>${planBody(p)}</details>`).join('');
        return `<div class="focus-card creative-card">${head}
          <h4 class="cr-h"><i class="fa-solid fa-magnifying-glass-chart" style="color:#b45309;"></i> 근거판 <span class="muted small">리뷰(실구매 평가)와 상세페이지를 함께 본 것</span></h4>
          ${insight}
          <h4 class="cr-h"><i class="fa-solid fa-film" style="color:#b45309;"></i> 소재 제작안 <span class="muted small">기대 효과 큰 순 · 전환형 = 구매당 비용↓ / 클릭형 = CPC↓ · 2순위부터는 눌러서 펼치기</span></h4>
          ${plans}
          ${tail}
        </div>`;
      }

      // v1 제작안(2026-10-13 이전 보고서): 훅 목록
      const hooks = (b.hooks || []).map((h, i) => `<div class="hook">
          <div class="hook-top"><span class="num">${i + 1}</span><b class="hook-text">${escHtml(h.hook_text)}</b></div>
          <div class="hook-chips"><span class="chip ${h.goal === '전환형' ? 'good' : 'new'}">${escHtml(h.goal)}</span><span class="chip">${escHtml(h.angle)}</span>${(h.evidence || []).map(e => `<span class="chip ev">${escHtml(e)}</span>`).join('')}</div>
          <div class="hook-why">${escHtml(h.why)}</div>
          <div class="fx"><b>형식</b> ${escHtml(h.format)}</div>
          <div class="fx"><b>첫 장면</b> ${escHtml(h.first_scene)}</div>
          <div class="snippet"><div class="muted small">광고 본문</div><div class="snip-text" style="white-space:pre-line;">${escHtml(h.primary_text)}</div>${copyBtn(h.primary_text)}</div>
          <div class="snippet"><div class="muted small">헤드라인</div><div class="snip-text">${escHtml(h.headline)}</div>${copyBtn(h.headline)}</div>
        </div>`).join('');
      return `<div class="focus-card creative-card">${head}
        <h4 class="cr-h"><i class="fa-solid fa-fish-fins" style="color:#b45309;"></i> 후킹 포인트 <span class="muted small">기대 효과 큰 순 · 클릭형 = CPC↓ / 전환형 = 구매당 비용↓</span></h4>
        ${hooks}
        ${tail}
      </div>`;
    }).join('');
    const scopeNote = d.review_scope_missing ? `<div class="notice warn"><b><i class="fa-solid fa-key"></i> 리뷰는 아직 반영되지 않았어요.</b> 카페24 개발자센터에서 게시판 읽기 권한을 켠 뒤, 워크스페이스의 <b>카페24 연동</b> 버튼으로 한 번 재연동하면 다음 분석부터 리뷰(고객이 실제로 쓰는 말)가 훅의 근거로 들어갑니다.</div>` : '';
    extraBoxes = scopeNote + fsBox + `<div class="box"><h3><i class="fa-solid fa-bullhorn" style="color:#b45309;"></i> 상품별 소재 제작안</h3>${cards || '<div class="muted">없음</div>'}</div>`;
  } else if (r.agent === 'ads') {
    // 광고 운영 담당(2026-10-28 자체 발행): 요약 카드 7(친구 보고서와 같은 구성) → ① 전체 흐름(14일 꺾은선 3개 + 상위 5 ×3) → ② 신규 테스트(상품별) → ③ 치고 올라오는 소재 → ④ 하락하는 소재 → ⑤ 주의 → ⑥ 상품별 운영 판단
    const k = d.kpi || null, y = k && k.yesterday, y2 = k && k.day_before, a7 = k && k.avg_7d;
    const wonF = v => v == null ? '–' : Math.round(v).toLocaleString('ko-KR') + '원';
    const won = v => v == null ? '—' : v >= 10000 ? (v / 10000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '') + '만' : Math.round(v).toLocaleString('ko-KR') + '원';
    const delta = (cur, base, dir, label) => {
      if (base == null || !base || cur == null) return `<span class="bf-dl muted">${label} –</span>`;
      const p = (cur - base) / base * 100, cls = Math.abs(p) < 1 || dir === 0 ? '' : (p > 0) === (dir > 0) ? 'up' : 'down';
      return `<span class="bf-dl">${label} <b class="${cls}">${p > 0 ? '+' : ''}${p.toFixed(0)}%</b></span>`;
    };
    const BK = [['spend', '지출', wonF, 0], ['value', '매출(전환값)', wonF, 1], ['cafe24', '카페24 매출 (자사몰)', wonF, 1], ['roas', 'ROAS', n => (+n).toFixed(2), 1], ['purchases', '구매', n => fmt(Math.round(n)) + '건', 1], ['cpa', 'CPA', wonF, -1], ['cpc', 'CPC', wonF, -1]];
    const kpis = y ? `<div class="bf-kpis">${BK.map(([key, name, f, dir]) => `<div class="bf-kt"><div class="bf-kl">${name}</div><div class="bf-kv">${y[key] == null ? '–' : f(y[key])}</div><div class="bf-ks">${delta(y[key], y2 && y2[key], dir, '그제')}${delta(y[key], a7 && a7[key], dir, '7일 평균')}${key === 'cafe24' ? `<span class="bf-dl muted">주문 ${fmt(y.cafe24_orders || 0)}건 · 카페24 ROAS ${y.cafe24_roas ?? '–'}</span>` : ''}</div></div>`).join('')}</div>` : '<div class="notice warn">Meta 일별 성과를 받지 못해 요약 카드를 만들 수 없어요.</div>';
    tiles = ''; tilesCls = 'none';
    headBody = `${(rp.summary || []).length ? `<div class="h-sub">${(rp.summary || []).slice(0, 2).map(escHtml).join('<br>')}</div>` : ''}`;
    headExtra += kpis;
    // ① 전체 흐름: 14일 꺾은선 3개(광고비 / 메타 ROAS·카페24 ROAS / 자연 매출 비율) + 상위 5 ×3
    const flow = d.flow || [];
    const DOWK = ['일', '월', '화', '수', '목', '금', '토'];
    const mdw = dt => `${md(dt)}(${DOWK[new Date(dt + 'T00:00:00Z').getUTCDay()]})`;
    const miniLine = (title, series, opt) => {
      const pts = flow.map((f, i) => ({ i, f })), W = 640, H = 156, pl = 48, pr = 52, pt = 22, pb = 28;
      const vals = series.flatMap(sr => flow.map(f => f[sr.key]).filter(v => v != null));
      if (!vals.length) return '';
      const maxV = Math.max(...vals) * 1.15 || 1, minV = 0;
      const x = i => pl + (W - pl - pr) * (flow.length === 1 ? 0.5 : i / (flow.length - 1)), yv = v => pt + (H - pt - pb) * (1 - (v - minV) / (maxV - minV));
      const ticks = [0, maxV / 2, maxV].map(v => `<line x1="${pl}" x2="${W - pr}" y1="${yv(v)}" y2="${yv(v)}" stroke="#eef0f3"/><text x="${pl - 5}" y="${yv(v) + 4}" text-anchor="end" font-size="9.5" fill="#9ca3af">${opt.tick(v)}</text>`).join('');
      const lines = series.map(sr => {
        const ps = pts.filter(p => p.f[sr.key] != null);
        const path = ps.map((p, j) => `${j ? 'L' : 'M'}${x(p.i).toFixed(1)},${yv(p.f[sr.key]).toFixed(1)}`).join(' ');
        const dots = ps.map(p => `<circle cx="${x(p.i)}" cy="${yv(p.f[sr.key])}" r="3" fill="${sr.color}"/>`).join('');
        const last = ps[ps.length - 1];
        return `<path d="${path}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linejoin="round"/>${dots}${last ? `<text x="${x(last.i) + 5}" y="${yv(last.f[sr.key]) + 4}" font-size="10" font-weight="700" fill="${sr.color}">${escHtml(opt.fmt(last.f[sr.key]))}</text>` : ''}`;
      }).join('');
      const xl = flow.map((f, i) => i % 2 === flow.length % 2 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="#6b7280">${mdw(f.date)}</text>` : '').join('');
      // 마우스를 올리면 그 날짜의 값(모든 선) — 세로 안내선 + 말풍선 (2026-10-28 사용자 요청)
      const hit = flow.map((f, i) => `<rect class="fl-hit" data-i="${i}" x="${i === 0 ? pl : (x(i - 1) + x(i)) / 2}" y="0" width="${(i === flow.length - 1 ? W - pr : (x(i) + x(i + 1)) / 2) - (i === 0 ? pl : (x(i - 1) + x(i)) / 2)}" height="${H}" fill="transparent"/>`).join('');
      const tipData = escHtml(JSON.stringify(flow.map(f => ({ d: mdw(f.date), v: series.map(sr => `${sr.label} ${f[sr.key] == null ? '—' : opt.fmt(f[sr.key])}`) }))));
      const xs = escHtml(JSON.stringify(flow.map((f, i) => +x(i).toFixed(1))));
      return `<div class="fl-chart" data-tip="${tipData}" data-xs="${xs}" data-pl="${pl}" data-pr="${pr}"><div class="fl-t">${title} <span class="cc-legend">${series.map(sr => `<i style="background:${sr.color}"></i>${sr.label}`).join(' ')}</span></div><div class="fl-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escHtml(title)}">${ticks}${lines}${xl}<line class="fl-cursor" x1="0" x2="0" y1="${pt}" y2="${H - pb}" stroke="#9ca3af" stroke-dasharray="3 3" style="display:none"/>${hit}</svg><div class="fl-tip" style="display:none"></div></div></div>`;
    };
    // 광고비(막대, 왼쪽 축) + 메타·카페24 ROAS(꺾은선, 오른쪽 축)를 한 그래프에 (2026-10-28 사용자 요청 "광고비가 나뉘어져 있다")
    const comboChart = () => {
      const W = 640, H = 170, pl = 48, pr = 52, pt = 22, pb = 28, n = flow.length;
      const maxS = Math.max(...flow.map(f => f.spend || 0)) * 1.2 || 1, rv = flow.flatMap(f => [f.meta_roas, f.cafe24_roas]).filter(v => v != null), maxR = (rv.length ? Math.max(...rv) : 1) * 1.2 || 1;
      const x = i => pl + (W - pl - pr) * (n === 1 ? 0.5 : i / (n - 1)), bw = Math.max(6, (W - pl - pr) / n * 0.55);
      const ys = v => pt + (H - pt - pb) * (1 - v / maxS), yr = v => pt + (H - pt - pb) * (1 - v / maxR);
      const tickS = [0, maxS / 2, maxS].map(v => `<line x1="${pl}" x2="${W - pr}" y1="${ys(v)}" y2="${ys(v)}" stroke="#eef0f3"/><text x="${pl - 5}" y="${ys(v) + 4}" text-anchor="end" font-size="9.5" fill="#6366f1">${v >= 10000 ? Math.round(v / 10000) + '만' : Math.round(v)}</text>`).join('');
      const tickR = [0, maxR / 2, maxR].map(v => `<text x="${W - pr + 5}" y="${yr(v) + 4}" font-size="9.5" fill="#b45309">${(+v).toFixed(1)}</text>`).join('');
      const bars = flow.map((f, i) => `<rect x="${x(i) - bw / 2}" y="${ys(f.spend || 0)}" width="${bw}" height="${Math.max(0, ys(0) - ys(f.spend || 0))}" fill="#c7d2fe" rx="2"/>`).join('');
      const line = (key, color) => { const ps = flow.map((f, i) => ({ i, v: f[key] })).filter(p => p.v != null); const last = ps[ps.length - 1]; return `<path d="${ps.map((p, j) => `${j ? 'L' : 'M'}${x(p.i).toFixed(1)},${yr(p.v).toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>${ps.map(p => `<circle cx="${x(p.i)}" cy="${yr(p.v)}" r="3" fill="${color}"/>`).join('')}${last ? `<text x="${x(last.i) + 5}" y="${yr(last.v) + 4}" font-size="10" font-weight="700" fill="${color}">${(+last.v).toFixed(2)}</text>` : ''}`; };
      const lastS = flow[n - 1];
      const spendLbl = lastS ? `<text x="${x(n - 1)}" y="${ys(lastS.spend || 0) - 4}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#4f46e5">${won(lastS.spend)}</text>` : '';
      const xl = flow.map((f, i) => i % 2 === n % 2 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="#6b7280">${mdw(f.date)}</text>` : '').join('');
      const hit = flow.map((f, i) => `<rect class="fl-hit" data-i="${i}" x="${i === 0 ? pl : (x(i - 1) + x(i)) / 2}" y="0" width="${(i === n - 1 ? W - pr : (x(i) + x(i + 1)) / 2) - (i === 0 ? pl : (x(i - 1) + x(i)) / 2)}" height="${H}" fill="transparent"/>`).join('');
      const tipData = escHtml(JSON.stringify(flow.map(f => ({ d: mdw(f.date), v: [`광고비 ${won(f.spend)}`, `메타 ROAS ${f.meta_roas == null ? '—' : f.meta_roas.toFixed(2)}`, `카페24 ROAS ${f.cafe24_roas == null ? '—' : f.cafe24_roas.toFixed(2)}`, `메타 전환값 ${won(f.value)} · 카페24 매출 ${won(f.cafe24_revenue)}`] }))));
      const xs = escHtml(JSON.stringify(flow.map((f, i) => +x(i).toFixed(1))));
      return `<div class="fl-chart" data-tip="${tipData}" data-xs="${xs}"><div class="fl-t">광고비 · ROAS <span class="cc-legend"><i style="background:#c7d2fe"></i>광고비(왼쪽 축) <i style="background:#2563eb"></i>메타 ROAS(오른쪽 축) <i style="background:#b45309"></i>카페24 ROAS(오른쪽 축)</span></div><div class="fl-wrap"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 14일 광고비와 ROAS">${tickS}${tickR}${bars}${spendLbl}${line('meta_roas', '#2563eb')}${line('cafe24_roas', '#b45309')}${xl}<line class="fl-cursor" x1="0" x2="0" y1="${pt}" y2="${H - pb}" stroke="#9ca3af" stroke-dasharray="3 3" style="display:none"/>${hit}</svg><div class="fl-tip" style="display:none"></div></div></div>`;
    };
    const charts = flow.length >= 2 ? comboChart()
      + miniLine('자연 매출 비율', [{ key: 'organic_share', color: '#15803d', label: '자연 매출 비율(카페24 매출 중 메타 전환 밖)' }], { fmt: v => v + '%', tick: v => Math.round(v) + '%' }) : '<div class="muted">14일 흐름 데이터가 없어요</div>';
    const t5 = d.top5 || {};
    const list5 = (title, rows, line) => `<div class="t5"><div class="t5-t">${title}</div>${(rows || []).length ? `<ol>${rows.map(line).join('')}</ol>` : '<div class="muted small">없음</div>'}</div>`;
    const prodOf = a => a.product ? `<span class="muted">${escHtml(pn(a.product))}</span>` : '';
    const top5 = `<div class="t5-grid">
      ${list5('판매 상위 5 (어제 결제수량)', t5.sales, r => `<li><b>${escHtml(pn(r.name))}</b><span class="t5-n">${fmt(r.qty)}개${r.rate != null ? ` · 주문율 ${r.rate}%` : ''}${r.ad_spend_y ? ` · 광고 ${won(r.ad_spend_y)}` : ' · 광고 0원'}</span></li>`)}
      ${list5('광고비 소진 상위 5 (어제 소재)', t5.spend, a => `<li><b>${escHtml(a.name)}</b> ${prodOf(a)}<span class="t5-n">${won(a.spend)} · ${fmt(a.purchases)}건 · ROAS ${a.roas ?? '—'}</span></li>`)}
      ${list5('전환 상위 5 (어제 소재)', t5.conversions, a => `<li><b>${escHtml(a.name)}</b> ${prodOf(a)}<span class="t5-n">${fmt(a.purchases)}건 · ${won(a.spend)} · ROAS ${a.roas ?? '—'}</span></li>`)}
    </div>`;
    headExtra += `<div class="box"><h3><i class="fa-solid fa-chart-line" style="color:#4f46e5;"></i> 전체 흐름 <span class="muted small">최근 14일 · 자연 매출 비율 = (카페24 매출 − 메타 전환 매출) ÷ 카페24 매출</span></h3>
      ${rp.flow_note ? `<div class="fx"><b>흐름</b> ${escHtml(rp.flow_note)}</div>` : ''}${charts}${top5}</div>`;
    // ② 신규 테스트(상품별)
    const tests = (rp.tests && rp.tests.length ? rp.tests : (d.tests || []));
    const TV = { '확대': 'v-push', '계속': 'v-on', '지켜보기': 'v-hold', '중단': 'v-check' };
    const testCards = tests.map(t => `<div class="test-card">
        <div class="tc-head"><b>${escHtml(pn(t.product))}</b> <span class="chip new">${t.day}일차</span> <span class="chip">소재 ${t.ads}개</span>${t.verdict ? ` <span class="vd-chip ${TV[t.verdict] || 'v-keep'}">${escHtml(t.verdict)}</span>` : ''}</div>
        <div class="tc-nums">지출 <b>${won(t.spend)}</b> · 구매 <b>${fmt(t.purchases)}건</b> · ROAS <b class="${t.roas == null ? '' : t.roas >= 2 ? 'up' : t.roas < 1 ? 'down' : ''}">${t.roas ?? '—'}</b> · CPA ${t.cpa != null ? won(t.cpa) : '—'} · CTR ${t.ctr != null ? t.ctr + '%' : '—'}${t.margin_rate != null ? ` · 마진 ${t.margin_rate}%` : ''}</div>
        ${(t.by_day || []).length > 1 ? `<div class="tc-days">${t.by_day.map(x => `<span>${escHtml(x.date)} ${won(x.spend)} · ${fmt(x.purchases)}건${x.roas != null ? ` · ${x.roas}` : ''}</span>`).join('')}</div>` : ''}
        ${t.note ? `<div class="tc-note">${escHtml(t.note)}</div>` : ''}
        <details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> 소재별 <span class="muted small">${t.ads}개</span></summary><table class="mini"><tbody>${(t.per_ad || []).map(a => `<tr><td>${escHtml(a.name)}</td><td class="r">${won(a.spend)}</td><td class="r">${fmt(a.purchases)}건</td><td class="r">ROAS ${a.roas ?? '—'}</td><td class="r">CTR ${a.ctr != null ? a.ctr + '%' : '—'}</td></tr>`).join('')}</tbody></table></details>
      </div>`).join('');
    headExtra += `<div class="box"><h3><i class="fa-solid fa-flask" style="color:#7c3aed;"></i> 신규 테스트 <span class="muted small">테스트 소재(세트·광고명 test) 중 첫 지출 3일 안 · 상품별로 묶음</span></h3>${testCards || '<div class="muted">최근 3일 안에 시작한 테스트가 없어요</div>'}</div>`;
    // ③ 치고 올라오는 소재 / ④ 하락하는 소재
    const seriesCell = sr => `<div class="ser">${(sr || []).map(x => `<span title="${escHtml(x.date)}"><i>${escHtml(x.date.slice(3))}</i>${fmt(x.purchases)}건<em>${x.roas != null ? x.roas : '—'}</em></span>`).join('')}</div>`;
    const rising = rp.rising && rp.rising.length ? rp.rising : [];
    const risingRows = rising.map(a => `<tr><td><b>${escHtml(a.name)}</b>${a.strong === false ? ` <span class="chip">${a.tier === 'fill' ? '기준 미달 · 상승 중' : '약한 신호'}</span>` : ''}${a.product ? `<div class="muted">${escHtml(pn(a.product))}</div>` : ''}</td>
        <td class="r"><b>${fmt(a.purchases_y)}건</b><div class="muted">3일 평균 ${a.avg3_purchases}</div></td><td class="r"><b class="up">${a.roas_y ?? '—'}</b><div class="muted">3일 평균 ${a.avg3_roas ?? '—'}</div></td><td class="r">${won(a.spend_y)}<div class="muted">빈도 ${a.frequency_y ?? '—'}</div></td><td>${seriesCell(a.series)}</td><td>${escHtml(a.why || '')}</td></tr>`).join('');
    headExtra += `<div class="box"><h3><i class="fa-solid fa-arrow-trend-up up"></i> 치고 올라오는 소재 <span class="muted small">어제 지출 3만↑·구매 3건↑·ROAS 3↑ 이면서 직전 3일 평균 대비 구매 1.5배↑ 또는 ROAS 1.3배↑ (테스트 제외) · 3개가 안 되면 약한 신호로 채움</span></h3>
      ${risingRows ? `<div class="tbl-wrap"><table class="risk stack t-rise"><thead><tr><th>소재</th><th class="r">어제 구매</th><th class="r">어제 ROAS</th><th class="r">어제 광고비</th><th>최근 4일</th><th>해석 · 할 일</th></tr></thead><tbody>${risingRows}</tbody></table></div>` : `<div class="muted">기준을 넘는 소재가 없어요${(d.rising || []).length ? ` (후보 ${d.rising.length}개는 담당자가 의미 없다고 봄)` : ''}</div>`}</div>`;
    const falling = rp.falling && rp.falling.length ? rp.falling : [];
    const fallingRows = falling.map(a => `<tr><td><b>${escHtml(a.name)}</b>${a.strong === false ? ' <span class="chip">약한 신호</span>' : ''}${a.product ? `<div class="muted">${escHtml(pn(a.product))}</div>` : ''}<div class="muted">7일 ${won(a.spend_7d)} · ${fmt(a.purchases_7d)}건 · ROAS ${a.roas_7d ?? '—'}</div></td>
        <td class="r"><b class="down">${a.last2_roas ?? '—'}</b><div class="muted">앞 5일 ${a.prev5_roas ?? '—'}${a.roas_drop_pct ? ` (−${a.roas_drop_pct}%)` : ''}</div></td><td class="r"><b class="down">${a.last2_purchases_avg}</b><div class="muted">앞 5일 ${a.prev5_purchases_avg}${a.purchase_drop_pct ? ` (−${a.purchase_drop_pct}%)` : ''}</div></td><td class="r">${a.frequency_y ?? '—'}<div class="muted">CPA ${a.cpa_y != null ? won(a.cpa_y) : '—'}</div></td><td>${seriesCell(a.series)}</td><td>${escHtml(a.why || '')}${a.action ? `<div class="fx-act"><i class="fa-solid fa-arrow-right"></i> ${escHtml(a.action)}</div>` : ''}</td></tr>`).join('');
    headExtra += `<div class="box"><h3><i class="fa-solid fa-arrow-trend-down down"></i> 하락하는 소재 <span class="muted small">주축 소재(7일 지출 상위 15 또는 7일 구매 20↑) 중 최근 2일 평균이 앞선 5일 평균보다 ROAS 30%↓ 또는 구매 40%↓ · 3개가 안 되면 약한 신호로 채움</span></h3>
      ${fallingRows ? `<div class="tbl-wrap"><table class="risk stack t-fall"><thead><tr><th>소재</th><th class="r">최근 2일 ROAS</th><th class="r">하루 구매</th><th class="r">어제 빈도</th><th>최근 4일</th><th>원인 · 할 일</th></tr></thead><tbody>${fallingRows}</tbody></table></div>` : `<div class="muted">꺾인 주축 소재가 없어요${(d.falling || []).length ? ` (후보 ${d.falling.length}개는 담당자가 일시적이라고 봄)` : ''}</div>`}</div>`;
    // ⑤ 주의
    const cautions = rp.cautions || [];
    headExtra += `<div class="box caution-box"><h3><i class="fa-solid fa-triangle-exclamation" style="color:#b45309;"></i> 주의할 상품 · 소재 <span class="muted small">잘 팔리고 효율 좋은데 취소율·순반품률(배송완료 대비 반품, 취소 제외)이 높은 것, 구매 0건·소재 피로·품절 등</span></h3>
      ${cautions.length ? cautions.map(c => `<div class="li"><b class="down">${escHtml(pn(c.target))}</b><div>${escHtml(c.why)}${c.action ? ` <span class="fx-act"><i class="fa-solid fa-arrow-right"></i> ${escHtml(c.action)}</span>` : ''}</div></div>`).join('') : '<div class="muted">오늘 주의할 것이 없어요</div>'}</div>`;
    // ⑥ 상품별 광고 운영 판단 (유지)
    const DK = { '힘주기': 'v-push', '증액 보류': 'v-hold', '다시 켜기': 'v-on', '줄이기': 'v-check', '유지': 'v-keep' };
    const DI = { '힘주기': 'fa-arrow-up', '증액 보류': 'fa-pause', '다시 켜기': 'fa-power-off', '줄이기': 'fa-arrow-down', '유지': 'fa-equals' };
    const dcs = rp.decisions || [];
    const chips = dcs.length ? `<div class="verdicts">${dcs.map(x => `<div class="vd ${DK[x.kind] || 'v-keep'}"><span class="vd-k"><i class="fa-solid ${DI[x.kind] || 'fa-circle'}"></i> ${escHtml(x.kind)}</span><div class="vd-body"><b>${escHtml(pn(x.product))}</b><span class="vd-r">${escHtml(x.reason)}</span></div></div>`).join('')}</div>` : '';
    const prods = d.products || [];
    const perfCell = p => p ? `${won(p.spend)}<div class="muted">${p.roas != null ? `ROAS <b class="${p.roas >= 2 ? 'up' : p.roas < 1 ? 'down' : ''}">${p.roas}</b>` : '—'} · ${fmt(p.purchases)}건</div>` : '<span class="muted" title="광고 정보 없음">모름</span>';
    const decided = new Map(dcs.map(x => [x.product, x]));
    const rowsHtml = prods.map(p => {
      const dcs1 = decided.get(p.name);
      const kind = dcs1 ? dcs1.kind : (p.hint || '유지');
      const rt = p.returns, cn = p.cancel;
      return `<tr class="${dcs1 ? '' : 'dim'}">
        <td><b>${escHtml(pn(p.name))}</b>${p.is_new ? ' <span class="chip new">신상</span>' : ''}${p.codi_share != null && p.codi_share >= 20 ? ` <span class="chip codi ${p.codi_share >= 40 ? 'hi' : 'mid'}">코디 ${p.codi_share}%</span>` : ''}<div class="muted">${(p.src || []).map(escHtml).join(' · ')}${(p.promos || []).length ? ` · <span class="chip ev">${escHtml(p.promos[0])}</span>` : ''}</div></td>
        <td><span class="vd-chip ${DK[kind] || 'v-keep'}"><i class="fa-solid ${DI[kind] || 'fa-circle'}"></i> ${escHtml(kind)}</span>${dcs1 ? '' : '<div class="muted small">규칙 판단</div>'}</td>
        <td>${escHtml(dcs1 ? dcs1.reason : (p.hint_why || ''))}</td>
        <td class="r">${p.active_ads == null ? '<span class="muted">모름</span>' : `${p.active_ads}개`}<div class="muted">${p.paused_ads ? `꺼짐 ${p.paused_ads}` : ''}</div></td>
        <td class="r">${perfCell(p.ad_7d)}</td>
        <td class="r">${perfCell(p.ad_14d)}</td>
        <td class="r">${p.margin_rate != null ? p.margin_rate + '%' : '—'}<div class="muted">${rt ? `<b class="${String(rt.level) === '위험' ? 'down' : ''}">순반품 ${rt.rate_14d ?? '—'}%</b>` : cn ? `취소율 ${cn.rate}%` : (p.rate_14d != null ? `주문율 ${p.rate_14d}%` : '')}</div></td>
      </tr>`;
    }).join('');
    headExtra += `<div class="box ours-box"><h3><i class="fa-solid fa-sliders" style="color:#ea580c;"></i> 상품별 광고 운영 판단 <span class="muted small">전략 담당 후보 + 반품·취소 위험 상품 ${prods.length}개 · 광고비·ROAS = 그 상품 광고 전부의 Meta 합</span></h3>
      ${chips}
      ${rowsHtml ? `<div class="tbl-wrap" style="margin-top:10px;"><table class="risk stack t-ads"><thead><tr><th>상품</th><th>판단</th><th>근거</th><th class="r">ON 광고</th><th class="r">7일 광고비</th><th class="r">14일 광고비</th><th class="r">마진</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` : '<div class="muted">후보 상품이 없어요</div>'}
      ${d.ads_known === false ? '<div class="muted small warn-text">Meta 광고 정보를 받지 못해 광고 칸은 비어 있어요 (광고가 없다는 뜻이 아님)</div>' : ''}
      <div class="muted small">흐린 줄은 담당자가 따로 결론 내지 않은 상품(규칙 판단). 판단은 제안이에요 — 예산 변경·ON/OFF는 광고팀이 광고관리자에서 직접 하고, 꺼진 광고를 켜기 전엔 왜 껐는지 확인하세요.</div></div>`;
  } else if (r.agent === 'strategy') {
    const na = d.new_arrivals || {}, mx = rp.matrix || [];
    const cnt = q => (na.matrix || []).filter(p => String(p.quadrant).startsWith(q)).length;
    const s7 = d.sold_7d || null;
    // 2026-10-27 대표 요청: 신상품 타일 대신 최근 7일 판매 상품 전체의 평균 마진율·구매 전환율
    tiles = [
      s7 ? tile('최근 7일 평균 마진율', s7.margin_avg != null ? `${s7.margin_avg}%` : '—', `판매된 ${fmt(s7.products)}개 상품 · 수량 가중${s7.margin_products < s7.products ? ` · 원가 있는 ${fmt(s7.margin_products)}개 기준` : ''}`) : tile('최근 7일 평균 마진율', '—', '이 보고서에는 아직 없음'),
      s7 ? tile('최근 7일 구매 전환율', s7.conversion != null ? `${s7.conversion}%` : '—', `판매된 상품의 주문 ÷ 조회${s7.conversion_all != null ? ` · 전체 상품 ${s7.conversion_all}%` : ''}`) : tile('최근 7일 구매 전환율', '—', '이 보고서에는 아직 없음'),
      tile('판매 확대 · 노출 부족', `${cnt('판매 확대')} · ${cnt('노출 부족')}`, '힘을 실을 신상품'),
      tile('상세·가격 점검 · 집중도 낮춤', `${cnt('상세·가격')} · ${cnt('집중도')}`, '손보거나 뒤로 보낼 신상품'),
      tile('집중 상품', `${(rp.focus || []).length}개`, `급상승 ${(d.trending || []).length} · TOP10 순환 · 행사 ${fmt(d.benefits_active || 0)}건 적용 중`),
    ].join('');
    tilesCls = 'five';
    // 맨 위 결론 칩 (verdicts) — 글 대신 종류 칩 + 상품 + 근거 한 줄. 옛 보고서(verdicts 없음)는 summary 그대로
    const vds = rp.verdicts || [];
    if (vds.length) {
      const VK = { '밀기': 'v-push', '보류': 'v-hold', '점검': 'v-check', '시즌': 'v-season', '소싱': 'v-source' };
      const VI = { '밀기': 'fa-arrow-up', '보류': 'fa-pause', '점검': 'fa-magnifying-glass', '시즌': 'fa-cloud-sun', '소싱': 'fa-cart-plus' };
      headBody = `${(rp.summary || []).length ? `<div class="h-sub">${escHtml(rp.summary[0])}</div>` : ''}
        <div class="verdicts">${vds.map(v => `<div class="vd ${VK[v.kind] || 'v-check'}"><span class="vd-k"><i class="fa-solid ${VI[v.kind] || 'fa-circle'}"></i> ${escHtml(v.kind)}</span><div class="vd-body">${v.product ? `<b>${escHtml(pn(v.product))}</b>` : ''}<span class="vd-r">${escHtml(v.reason)}</span></div></div>`).join('')}</div>`;
    }
    // 판매량 급증 TOP10 (워크스페이스 홈과 같은 규칙) + 광고 수·7일 광고비·ROAS·주문율
    const sg = d.surge_top10 || [];
    if (sg.length) {
      const won = v => v == null ? '—' : v >= 10000 ? (v / 10000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '') + '만' : Math.round(v).toLocaleString('ko-KR') + '원';
      const sgRows = sg.map(x => `<tr>
          <td class="r sg-rank">${x.rank}</td>
          <td><b>${escHtml(pn(x.name))}</b>${x.is_new ? ' <span class="chip new">신상</span>' : ''}${codiChip(x.codi, true)}${x.product_no ? ` <button class="icon-btn" onclick="detailRun(${Number(x.product_no)}, this.dataset.n)" data-n="${escHtml(x.name)}" title="상세페이지 점검"><i class="fa-solid fa-file-image"></i></button>` : ''}</td>
          <td class="r"><b>${fmt(x.qty_prev7d)} → ${fmt(x.qty_7d)}개</b> ${x.change_pct == null ? '<span class="chip new">NEW</span>' : `<span class="up">+${fmt(x.change_pct)}%</span>`}</td>
          <td class="r">${x.rate_7d != null ? x.rate_7d + '%' : '—'}</td>
          <td class="r">${x.active_ads == null ? '<span class="muted" title="광고 연결 확인 필요">모름</span>' : x.active_ads ? `${x.active_ads}개` : '<span class="chip bad">없음</span>'}</td>
          <td class="r">${x.active_ads === 0 ? '—' : won(x.ad_spend_7d)}</td>
          <td class="r">${x.active_ads === 0 ? '—' : x.ad_roas_7d == null ? '—' : `<b class="${x.ad_roas_7d >= 2 ? 'up' : x.ad_roas_7d < 1 ? 'down' : ''}">${x.ad_roas_7d}</b>`}</td>
        </tr>`).join('');
      const pr7 = d.periods?.last7, md2 = v => v ? `${Number(v.slice(5, 7))}/${Number(v.slice(8, 10))}` : '';
      headExtra += `<div class="box surge"><h3><i class="fa-solid fa-arrow-trend-up up"></i> 판매량 급증 TOP ${sg.length} <span class="muted small">${pr7 ? `${md2(pr7[0])}~${md2(pr7[1])} vs 직전 7일 · ` : ''}이번 주 10개 이상 판매 · 광고비·ROAS는 Meta 최근 7일</span></h3>
        <div class="tbl-wrap"><table class="risk stack t-surge"><thead><tr><th class="r">#</th><th>상품</th><th class="r">판매량 변화</th><th class="r">주문율 7일</th><th class="r">광고</th><th class="r">광고비 7일</th><th class="r">ROAS 7일</th></tr></thead><tbody>${sgRows}</tbody></table></div>
        ${d.ads_known === false ? '<div class="muted small warn-text">Meta 광고 정보를 받지 못해 광고 칸은 비어 있어요 (광고가 없다는 뜻이 아님)</div>' : ''}</div>`;
    }
    const qColor = { '판매 확대': 'q-grow', '노출 부족': 'q-expose', '상세·가격 점검': 'q-fix', '집중도 낮춤': 'q-low' };
    const qc = q => { const k = Object.keys(qColor).find(k => String(q).startsWith(k)); return k ? qColor[k] : 'q-na'; };
    const won = v => v == null ? '' : Math.round(v).toLocaleString('ko-KR') + '원';
    const mxRows = mx.map(x => `<tr>
        <td><b>${escHtml(x.name)}</b>${x.product_no ? ` <button class="icon-btn" onclick="detailRun(${Number(x.product_no)}, this.dataset.n)" data-n="${escHtml(x.name)}" title="상세페이지 점검"><i class="fa-solid fa-file-image"></i></button>` : ''}<div class="muted">${x.age_days != null ? `등록 ${x.age_days}일` : ''}${x.sold_out ? ' · <b class="down">품절</b>' : ''}${x.active_ads == null ? ' · <span class="warn">광고 정보 없음</span>' : x.active_ads ? ` · 광고 ${x.active_ads}개` : ' · 광고 없음'}${x.codi ? ' · ' + codiChip(x.codi, true) : ''}</div></td>
        <td><span class="qbadge ${qc(x.quadrant)}">${escHtml(x.quadrant)}</span></td>
        <td class="r">${fmt(x.views_14d)}<div class="muted">${x.rate_14d != null ? x.rate_14d + '%' : '—'} · ${fmt(x.qty_14d)}개</div></td>
        <td class="r">${x.margin_rate != null ? x.margin_rate + '%' : '—'}<div class="muted">${x.discount_price ? `할인가 ${won(x.discount_price)}` : won(x.price)}</div></td>
        <td>${(x.promos || []).length ? (x.promos || []).map(p => `<span class="chip">${escHtml(p)}</span>`).join(' ') : '<span class="muted">—</span>'}</td>
        <td>${escHtml(x.strategy)}</td></tr>`).join('');
    // 집중 상품 카드(2026-10-27 대표 요청 2차): 소재·참고 소재·견인 소재 없이 숫자 7칸(조회·주문율·판매·마진·ON 광고·14일 광고비·14일 ROAS) + 진행 중 이벤트 + 현재 상태 + 판매 확대 액션
    const focusCards = (rp.focus || []).map(f => {
      const adsUnknown = d.ads_known === false || f.active_ads == null;
      const st = (l, v, sub, cls) => `<div class="fs ${cls || ''}"><div class="fs-l">${l}</div><div class="fs-v">${v}</div>${sub ? `<div class="fs-s">${sub}</div>` : ''}</div>`;
      const roas = f.ad_roas_14d;
      const stats = [
        st('14일 조회', fmt(f.views_14d)),
        st('주문율', `${f.rate_14d ?? '—'}%`, f.codi ? `코디 ${f.codi.share ?? '—'}%` : ''),
        st('판매', `${fmt(f.qty_14d)}개`, f.why ? escHtml(f.why) : ''),
        st('마진율', `${f.margin_rate ?? '—'}%`, f.discount_price ? `할인가 ${Math.round(f.discount_price).toLocaleString('ko-KR')}원` : (f.price ? `${Math.round(f.price).toLocaleString('ko-KR')}원` : '')),
        st('ON 광고', adsUnknown ? '<span class="muted">모름</span>' : `${f.active_ads}개`, adsUnknown ? '광고 정보 없음' : '', f.active_ads === 0 ? 'bad' : ''),
        st('14일 광고비', f.ad_spend_14d == null ? '—' : f.ad_spend_14d === 0 ? '0원' : fmtMan(f.ad_spend_14d), f.ad_purchases_14d != null ? `구매 ${fmt(f.ad_purchases_14d)}건` : ''),
        st('14일 ROAS', roas == null ? '—' : roas, '', roas == null ? '' : roas >= 2 ? 'good' : roas < 1 ? 'bad' : ''),
      ].join('');
      const events = (f.promos || []).length ? `<div class="fc-ev"><i class="fa-solid fa-tag"></i> 진행 중 이벤트 ${f.promos.map(x => `<span class="chip ev">${escHtml(x)}</span>`).join(' ')}</div>` : '<div class="fc-ev muted small"><i class="fa-solid fa-tag"></i> 진행 중 이벤트 없음</div>';
      const grow = Array.isArray(f.grow) ? f.grow : [];
      const body = f.status ? `<div class="fc-status"><b>현재 상태</b> ${escHtml(f.status)}</div>${grow.length ? `<div class="fc-grow"><b>판매 확대</b><ol>${grow.map(g => `<li>${escHtml(g)}</li>`).join('')}</ol></div>` : ''}`
        : `${f.plan ? `<div class="fx"><b>판매 계획</b> ${escHtml(f.plan)}</div>` : ''}${f.detail_focus ? `<div class="fx"><b>상세에서 강조</b> ${escHtml(f.detail_focus)}</div>` : ''}`;   // 옛 보고서(개편 전) 호환
      return `<div class="focus-card fc">
        <div class="fc-head"><div class="fc-title"><b>${escHtml(pn(f.name))}</b>${f.is_new ? ' <span class="chip new">신상</span>' : ''}${f.sold_out ? ' <span class="chip bad">품절</span>' : ''}${codiChip(f.codi, true)}${f.product_no ? ` <button class="icon-btn" onclick="detailRun(${Number(f.product_no)}, this.dataset.n)" data-n="${escHtml(f.name)}" title="상세페이지 점검 담당에게 이 상품을 맡깁니다"><i class="fa-solid fa-file-image"></i></button>` : ''}${f.category ? ` <span class="muted small">${escHtml(f.category)}</span>` : ''}</div></div>
        <div class="fc-stats">${stats}</div>
        ${events}
        ${body}</div>`;
    }).join('');
    // 신상품 4분면 격자(2026-10-27): 표 대신 2×2 칸. 칸마다 개수 + 상품 칩(전략 있는 상품은 누르면 전략 한 줄). 15줄 표는 접음
    const naM = na.matrix || [];
    const inQ = (q, k) => String(q || '').startsWith(k);
    const QUAD = [
      { k: '노출 부족', cls: 'q-expose', sub: '주문율↑ 조회↓' }, { k: '판매 확대', cls: 'q-grow', sub: '조회↑ 주문율↑' },
      { k: '집중도 낮춤', cls: 'q-low', sub: '둘 다 낮음' }, { k: '상세·가격 점검', cls: 'q-fix', sub: '조회↑ 주문율↓' },
    ];
    const quadCells = QUAD.map(q => {
      const all = naM.filter(p => inQ(p.quadrant, q.k));
      const withS = mx.filter(x => inQ(x.quadrant, q.k));
      const sNames = new Set(withS.map(x => x.name));
      const rest = all.filter(p => !sNames.has(p.name));
      const sChip = x => `<button type="button" class="qchip ${q.cls}" onclick="this.classList.toggle('open')"><span>${escHtml(pn(x.name))}${x.active_ads ? ` <em class="ads">광고 ${x.active_ads}</em>` : ''}${codiChip(x.codi)}</span><small>${escHtml(x.strategy)}</small></button>`;
      return `<div class="qcell ${q.cls}"><div class="qhead"><span class="qbadge ${q.cls}">${q.k}</span><span class="muted small">${q.sub}</span><b>${all.length}개</b></div>
        <div class="qchips">${withS.map(sChip).join('')}${rest.slice(0, 6).map(p => `<span class="qchip plain" title="${escHtml(pn(p.name))}">${escHtml(pn(p.name))}${codiChip(p.codi)}</span>`).join('')}${rest.length > 6 ? `<span class="qchip plain more">+${rest.length - 6}</span>` : ''}</div></div>`;
    }).join('');
    const otherQ = {};
    for (const p of naM) if (!QUAD.some(q => inQ(p.quadrant, q.k))) otherQ[p.quadrant] = (otherQ[p.quadrant] || 0) + 1;
    const otherLine = Object.keys(otherQ).length ? `<div class="muted small" style="margin-top:6px;">격자 밖: ${Object.entries(otherQ).map(([k, v]) => `${escHtml(k)} ${v}개`).join(' · ')}</div>` : '';
    const quadBox = `<div class="box"><h3><i class="fa-solid fa-table-cells" style="color:#0891b2;"></i> 신상품 4분면 <span class="muted small">조회수 × 주문율, 신상품 중앙값(조회 ${fmt(na.median_views_14d)} · 주문율 ${na.median_rate_14d ?? '—'}%) 기준 · 색 칩은 누르면 전략이 열려요 · <i class="fa-solid fa-link"></i> 코디 n% = 잘 팔리는 상품 페이지의 코디 상품이라 주문율이 부풀 수 있음(n = 부모와 같은 주문 비율)</span></h3>
      ${naM.length ? `<div class="quad-wrap"><div class="quad-y">주문율 ↑</div><div class="quad">${quadCells}</div><div class="quad-x">조회수 →</div></div>${otherLine}` : '<div class="muted">판정할 신상품이 없어요</div>'}
      ${mxRows ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> 표로 보기 <span class="muted small">전략 있는 ${mx.length}개 · 마진율 = (판매가 − 공급가×1.1) ÷ 판매가</span></summary><div class="tbl-wrap"><table class="risk stack t-matrix"><thead><tr><th>상품</th><th>판정</th><th class="r">조회 14일<br><span class="muted">주문율 · 판매</span></th><th class="r">마진율<br><span class="muted">가격</span></th><th>행사</th><th>전략</th></tr></thead><tbody>${mxRows}</tbody></table></div></details>` : ''}
    </div>`;
    // 트렌드·날씨 (2026-09-13 → 2026-10-27 압축): 날씨 띠 + 날씨 계획, 우리 상품 있는 키워드만, 키워드 제안은 표. 전체 인기 검색어는 접음
    const tr = d.trends || {}, w = tr.weather, ws = w?.summary || {};
    const dayCell = (x, past) => `<div class="wday ${past ? 'past' : ''}"><div class="wd">${x.date.slice(5).replace('-', '/')}</div><div class="wt"><b>${Math.round(x.max)}°</b>/${Math.round(x.min)}°</div>${x.rain_prob >= 60 ? '<div class="wr">☔ ' + x.rain_prob + '%</div>' : ''}</div>`;
    const weatherStrip = w ? `<div class="wstrip">${(w.past_7d || []).map(x => dayCell(x, true)).join('')}<div class="wsep">오늘</div>${(w.next_7d || []).map(x => dayCell(x, false)).join('')}</div>
      <div class="muted small">지난 7일 평균 ${ws.past_avg_max}°/${ws.past_avg_min}° → 앞으로 7일 ${ws.next_avg_max}°/${ws.next_avg_min}°${ws.first_min_below_15 ? ` · 최저 15°↓ 첫날 ${ws.first_min_below_15.slice(5)}` : ''}${(ws.rainy_days_next || []).length ? ` · 비 ${ws.rainy_days_next.map(x => x.slice(5)).join(', ')}` : ''}</div>` : '<div class="muted">날씨 데이터 없음</div>';
    const kchip = r => `<span class="kchip ${r.our_products.length ? 'hit' : ''}" title="${r.our_products.map(p => escHtml(pn(p.name))).join('\n')}">${escHtml(r.keyword)} <em>${r.kind === 'new' ? 'NEW ' + r.rank + '위' : r.prev_rank + '→' + r.rank + '위'}</em>${r.our_products.length ? `<i>${r.our_products.length}</i>` : ''}</span>`;
    const naverCats = (tr.naver || []).filter(c => (c.top10 || []).length || (c.rising || []).length);
    const hitChips = naverCats.map(c => { const hits = (c.rising || []).filter(r => r.our_products.length); return hits.length ? `<div class="tr-cat"><b>${escHtml(c.category)}</b> <span class="muted small">뜨는 검색어 ${c.rising.length}개 중 우리 상품 있는 ${hits.length}개</span><div class="chips">${hits.map(kchip).join('')}</div></div>` : ''; }).join('');
    const allChips = naverCats.map(c => `<div class="tr-cat"><b>${escHtml(c.category)}</b> <span class="muted small">TOP10: ${c.top10.map(escHtml).join(' · ')}</span>
        <div class="chips">${(c.rising || []).slice(0, 18).map(kchip).join('')}</div></div>`).join('');
    const trendRows = (rp.trend_actions || []).map(x => `<tr><td><b>${escHtml(x.keyword)}</b></td><td><span class="chip new">${escHtml(x.signal)}</span></td><td class="muted">${escHtml(x.our_products || '—')}</td><td>${escHtml(x.suggestion)}</td></tr>`).join('');
    const trendBox = `<div class="box"><h3><i class="fa-solid fa-arrow-trend-up" style="color:#0891b2;"></i> 트렌드 · 날씨 <span class="muted small">서울 날씨 · 네이버 쇼핑 인기 검색어(여성) 어제 vs 7일 전</span></h3>
      ${weatherStrip}
      ${rp.weather_plan ? `<div class="fx"><b>날씨 계획</b> ${escHtml(rp.weather_plan)}</div>` : ''}
      ${naverCats.length ? (hitChips || '<div class="muted small" style="margin-top:8px;">뜨는 검색어 중 우리 상품이 있는 것은 없어요</div>') : '<div class="muted small" style="margin-top:8px;">인기 검색어 순위표를 이날은 받지 못했어요 (네이버 데이터랩 응답 없음 — 다음 보고서에서 다시 시도)</div>'}
      ${trendRows ? `<div class="tbl-wrap" style="margin-top:10px;"><table class="risk stack t-trend"><thead><tr><th>키워드</th><th>순위 변화</th><th>우리 상품</th><th>할 일</th></tr></thead><tbody>${trendRows}</tbody></table></div>` : ''}
      ${allChips ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> 전체 인기 검색어 보기 <span class="muted small">숫자는 우리 상품 개수, 마우스를 올리면 상품명 · 브랜드명은 판단에서 뺍니다</span></summary>${allChips}</details>` : ''}
    </div>`;
    const ma = d.match_audit;
    const adsWarn = d.ads_known === false ? `<div class="notice warn"><b><i class="fa-solid fa-plug-circle-xmark"></i> Meta 광고 정보를 못 받았어요.</b> 이 보고서의 광고 개수·소재 분석은 비어 있습니다. 광고가 없다는 뜻이 아니라 수집이 실패한 것이니, 광고 관련 판단은 다음 보고서에서 확인하세요.</div>`
      : (ma && ma.status === 'suspect') ? `<div class="notice warn"><b><i class="fa-solid fa-link-slash"></i> 광고↔상품 연결이 깨진 것 같아요.</b> 활성 광고 ${fmt(ma.total_ads)}개 중 ${ma.matched_share}%만 상품에 연결됐고, 광고 이름에 상품명이 있는데 연결 0개인 상품이 ${ma.suspects.length}개입니다. 이 상품들은 '광고 정보 없음'으로 두었습니다. 상품명 표기 규칙(접미사 등)이 바뀌었는지 확인해 주세요.</div>`
      : (ma && (ma.suspects || []).length) ? `<div class="muted small" style="margin-bottom:10px;"><i class="fa-solid fa-link-slash"></i> 광고 이름이 줄임말이라 자동 연결이 안 된 상품 ${ma.suspects.length}개(${ma.suspects.slice(0, 3).map(s => escHtml(s.name.replace(/^\s*(?:\([^)]*\)|\[[^\]]*\])\s*/g, '').slice(0, 18))).join(', ')})는 '광고 정보 없음'으로 표시했어요. 광고 이름에 상품명을 그대로 쓰면 연결됩니다.</div>` : '';
    extraBoxes = adsWarn + trendBox + quadBox + `
    <div class="box"><h3><i class="fa-solid fa-bullseye" style="color:#0891b2;"></i> 집중 상품 <span class="muted small">급상승 3 + 판매 TOP10 순환 3 · 현재 상태와 판매 확대 액션 · 소재 분석은 광고 소재 담당</span></h3>${focusCards || '<div class="muted">없음</div>'}</div>`;
  } else {
    tiles = [
      tile('어제 매출', fmtMan(rev.yesterday?.revenue), `지난주 같은 요일 대비 ${fmtDelta(ch.vs_same_dow_last_week)} · 주문 ${rev.yesterday ? fmt(rev.yesterday.orders) + '건' : '—'}`),
      tile('최근 7일 매출', fmtMan(rev.last7?.revenue), `직전 7일 대비 ${fmtDelta(ch.last7_vs_prev7)}`),
      tile('이달 누적', fmtMan(rev.mtd?.revenue), `지난달 같은 기간 대비 ${fmtDelta(ch.mtd_vs_last_month_same)}`),
      ads?.yesterday ? tile('어제 광고비', fmtMan(ads.yesterday.spend), `ROAS(카페24) ${ads.roas_cafe24?.yesterday ?? '—'} · 최근 7일 ${ads.roas_cafe24?.last7 ?? '—'}`)
        : tile('어제 광고비', '—', 'Meta 데이터 없음'),
    ].join('');
    // 오늘의 요약(2026-10-22): 대표가 직접 결정할 것만 따로
    if (Array.isArray(rp.decisions) && rp.decisions.length) {
      extraBoxes = `<div class="box decide-box"><h3><i class="fa-solid fa-gavel" style="color:#b45309;"></i> 대표 결정 필요</h3>${rp.decisions.map(x => `<div class="li"><b>${escHtml(x.what)}</b><div>${escHtml(x.why)}</div></div>`).join('')}</div>`;
    }
  }
  const list = (arr, cls) => (arr || []).length ? (arr || []).map(x => `<div class="li"><b class="${cls}">${escHtml(x.title)}</b><div>${escHtml(x.detail)}</div></div>`).join('') : '<div class="muted">없음</div>';
  const chips = x => `${x.status === 'new' ? '<span class="chip new">NEW</span>' : ''}${(x.dates || []).length ? `<span class="chip">${x.dates.map(md).join(' · ')}</span>` : ''}`;
  const wlist = (arr, cls) => (arr || []).length ? (arr || []).map(x => `<div class="li"><div class="li-top"><b class="${cls}">${escHtml(x.title)}</b>${chips(x)}</div><div>${escHtml(x.detail)}</div></div>`).join('') : '<div class="muted">아직 없음</div>';
  const doneMap = actionsState.map || new Map();
  const actRow = (x, i, opts = {}) => {
    const key = actionKey(x), st = doneMap.get(r.agent + '|' + key), done = !!(st && st.done);
    const doneMeta = done ? `완료 · ${escHtml(st.done_by || '')} · ${st.done_at ? timeLabel(st.done_at) : ''}` : '';
    const carriedRow = doneMap.get(r.agent + '|' + key);
    const carriedHere = opts.past && carriedRow && carriedRow.carried_to && rp.week && carriedRow.carried_to === rp.week.start;
    const carryBtn = opts.past && !done && opts.carryTo ? (carriedHere ? '<span class="chip src"><i class="fa-solid fa-arrow-turn-down"></i> 이번 주로 가져옴</span>'
      : `<button class="btn ghost sm carry-btn" onclick="actCarry(this)" data-agent="${escHtml(r.agent)}" data-key="${escHtml(key)}" data-week="${escHtml(opts.week || '')}" data-to="${escHtml(opts.carryTo)}" data-title="${escHtml(x.title)}" data-owner="${escHtml(x.owner || '')}" data-why="${escHtml(x.why || '')}" data-since="${escHtml(x.since || '')}" data-rid="${escHtml(r.id)}"><i class="fa-solid fa-arrow-turn-down"></i> 이번 주로 가져오기</button>`) : '';
    return `<div class="act ${opts.past ? 'past' : ''} ${done ? 'done' : ''}" data-owner="${escHtml(x.owner || '')}">
      <label class="chk" title="완료 체크"><input type="checkbox" class="act-chk" ${done ? 'checked' : ''} data-key="${escHtml(key)}" data-agent="${escHtml(r.agent)}" data-week="${escHtml(opts.week || '')}" data-title="${escHtml(x.title)}" data-owner="${escHtml(x.owner || '')}"><span class="num">${i + 1}</span></label>
      <div><div class="act-top"><b>${escHtml(x.title)}</b><span class="owner o-${escHtml(x.owner)}">${escHtml(x.owner || '')}</span>${x.status === 'new' ? '<span class="chip new">NEW</span>' : ''}${x.since ? `<span class="chip">${md(x.since)}부터</span>` : ''}${x.source && x.source !== '오늘의 요약' ? `<span class="chip src">${escHtml(x.source.replace(' 담당', ''))} 제안</span>` : ''}${x.carried || x.status === 'carried' ? '<span class="chip src"><i class="fa-solid fa-arrow-turn-down"></i> 저번 주에서</span>' : ''}</div><div class="muted">${escHtml(x.why)}</div><div class="done-meta">${doneMeta}</div>${carryBtn}</div>
    </div>`;
  };
  const hasWeek = Array.isArray(rp.week_actions) || Array.isArray(rp.week_highlights);
  const weekLabel = rp.week ? `${md(rp.week.start)} ~ ${md(rp.week.end)}` : '';
  const weekActions0 = (hasWeek ? rp.week_actions : rp.actions) || [];
  // 앱에서 '이번 주로 가져오기'한 저번 주 할 일(아직 보고서에 안 실린 것)을 바로 합친다
  const carriedExtra = (hasWeek && rp.week) ? [...doneMap.values()].filter(c => c.agent === r.agent && c.carried_to === rp.week.start && !c.done && !weekActions0.some(a => a.id === c.action_id))
    .map(c => ({ id: c.action_id, title: c.title, owner: c.owner, why: c.why || '', since: c.since || '', status: 'carried' })) : [];
  const weekActions = [...weekActions0, ...carriedExtra];
  const lw = rp.last_week || null;
  const lwLabel = lw ? `${md(lw.start)} ~ ${md(lw.end)}` : '';
  // 이번 주 흐름 표(2026-10-27): 주목(P)·주의(N) 항목 × 요일 점. 주 첫날은 오늘의 주목·주의와 같으니 숨김
  const weekFlow = (() => {
    if (!hasWeek || !rp.week) return '';
    const items = [...(rp.week_highlights || []).map(x => ({ ...x, k: 'p' })), ...(rp.week_warnings || []).map(x => ({ ...x, k: 'n' }))];
    if (!items.length) return '';
    if (rp.week.start === rp.week.end) return `<div class="week-first muted small"><i class="fa-regular fa-calendar"></i> 이번 주 첫날 — 이번 주 주목·주의는 위 '오늘의 주목·주의'와 같아요. 내일부터 요일별 흐름 표로 쌓입니다.</div>`;
    const days = []; for (let i = 0; i < 7; i++) { const dt = new Date(rp.week.start + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + i); days.push(dt.toISOString().slice(0, 10)); }
    const DOW = ['월', '화', '수', '목', '금', '토', '일'];
    const rows = items.map(x => `<tr class="wf ${x.k}"><td class="wf-t"><details><summary><span class="pn ${x.k}">${x.k === 'p' ? 'P' : 'N'}</span> <span class="wf-title">${escHtml(x.title)}</span>${x.status === 'new' ? ' <span class="chip new">NEW</span>' : ''}</summary><div class="wf-d">${escHtml(x.detail || '')}</div></details></td>${days.map(dd => `<td class="wf-c ${dd > rp.week.end ? 'future' : ''} ${dd === rp.week.end ? 'today' : ''}">${(x.dates || []).includes(dd) ? `<span class="dot ${x.k}"></span>` : ''}</td>`).join('')}</tr>`).join('');
    return `<div class="box wf-box"><h3><i class="fa-regular fa-calendar" style="color:#4f46e5;"></i> 이번 주 흐름 <span class="muted small">${weekLabel} · 점 = 그날 보고서에 등장(며칠째 이어지는지) · 제목을 누르면 설명</span></h3>
      <div class="tbl-wrap"><table class="wf-table"><thead><tr><th></th>${days.map((dd, i) => `<th class="${dd === rp.week.end ? 'today' : ''} ${dd > rp.week.end ? 'future' : ''}">${DOW[i]}<br><span class="muted">${md(dd)}</span></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
  })();
  const doneCount = weekActions.filter(x => { const st = doneMap.get(r.agent + '|' + actionKey(x)); return st && st.done; }).length;
  const owners = [...new Set(weekActions.map(x => x.owner).filter(Boolean))];
  const actFilterBar = owners.length > 1 ? `<div class="act-filter"><button class="chip-btn on" data-o="" onclick="actFilter(this)">전체 ${weekActions.length}</button>${owners.map(o => `<button class="chip-btn" data-o="${escHtml(o)}" onclick="actFilter(this)">${escHtml(o)} ${weekActions.filter(x => x.owner === o).length}</button>`).join('')}</div>` : '';
  const progress = weekActions.length ? `<span class="prog"><b>${doneCount}/${weekActions.length}</b> 완료</span><div class="prog-bar"><i style="width:${Math.round(doneCount / weekActions.length * 100)}%"></i></div>` : '';
  const lwUndone = lw ? (lw.actions || []).filter(x => { const st = doneMap.get(r.agent + '|' + actionKey(x)); return !(st && st.done); }) : [];
  return head + `
    ${`<div class="headline mood-${rp.mood || 'neutral'}">
      <div class="h-text">${escHtml(rp.headline)}</div>
      ${headBody || `<ul>${(rp.summary || []).map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>`}
    </div>`}
    ${headExtra}
    ${tilesCls === 'none' ? '' : `<div class="tiles ${tilesCls}">${tiles}</div>`}
    ${(r.agent === 'ads' || (['detail', 'creative'].includes(r.agent) && !(rp.highlights || []).length && !(rp.warnings || []).length)) ? '' : `<div class="two">
      <div class="box"><h3><i class="fa-solid fa-arrow-trend-up up"></i> 오늘의 주목</h3>${list(rp.highlights, 'up')}</div>
      <div class="box"><h3><i class="fa-solid fa-triangle-exclamation down"></i> 오늘의 주의</h3>${list(rp.warnings, 'down')}</div>
    </div>`}
    ${teamBox(rp, r.agent === 'strategy')}
    ${extraBoxes}
    ${hasWeek ? `<div class="week-head"><i class="fa-regular fa-calendar"></i> 이번 주 누적 <span class="muted">${weekLabel} · 앞선 날 보고서와 합친 것. 그날 못 봤어도 여기서 확인</span></div>${weekFlow}` : ''}
    ${(!weekActions.length && ['detail', 'creative'].includes(r.agent)) ? '' : `<div class="box todo-box"><h3><i class="fa-solid fa-list-check" style="color:#4f46e5;"></i> ${r.agent === 'sales' && hasWeek ? '팀 통합 할 일' : '이번 주 할 일'}${weekLabel ? ` <span class="muted small">${weekLabel}</span>` : ''}${progress}</h3>${actFilterBar}${weekActions.length ? weekActions.map((x, i) => actRow(x, i, { week: rp.week?.start })).join('') : '<div class="muted">없음</div>'}<div class="muted small chk-hint">체크하면 완료로 기록되고, 다음 날 보고서의 할 일에서 빠집니다.</div></div>`}
    ${lw ? `<details class="fold past-fold"><summary><i class="fa-solid fa-chevron-right"></i> 저번 주 미완료 ${lwUndone.length}개 <span class="muted small">${lwLabel}${lw.from_report_date ? ` · ${md(lw.from_report_date)} 보고서 기준` : ''} · 이어서 할 것은 '이번 주로 가져오기'</span></summary><div class="box past-box">${lwUndone.length ? lwUndone.map((x, i) => actRow(x, i, { past: true, week: lw.start, carryTo: rp.week?.start || '' })).join('') : '<div class="muted">저번 주 할 일은 모두 끝났거나 없어요</div>'}</div></details>` : ''}
    ${rp.note ? `<div class="muted small"><i class="fa-regular fa-circle-question"></i> ${escHtml(rp.note)}</div>` : ''}
    ${dataErrors(r.data)}
    ${typeof askBoxHtml === 'function' ? askBoxHtml(r) : ''}
    <details class="raw"><summary>수집한 숫자 보기</summary>${rawTable(r.data, r.agent)}</details>`;
}

/* 꺾은선 그래프 마우스 툴팁 (2026-10-28): .fl-chart 안에서 가장 가까운 날짜의 값을 말풍선으로 */
document.addEventListener('mousemove', e => {
  const ch = e.target.closest && e.target.closest('.fl-chart'); if (!ch) return;
  const svg = ch.querySelector('svg'), tip = ch.querySelector('.fl-tip'), cur = ch.querySelector('.fl-cursor'); if (!svg || !tip) return;
  const r = svg.getBoundingClientRect(), W = svg.viewBox.baseVal.width, vx = (e.clientX - r.left) / r.width * W;
  const xs = JSON.parse(ch.dataset.xs || '[]'), data = JSON.parse(ch.dataset.tip || '[]'); if (!xs.length) return;
  let i = 0; for (let k = 1; k < xs.length; k++) if (Math.abs(xs[k] - vx) < Math.abs(xs[i] - vx)) i = k;
  cur.setAttribute('x1', xs[i]); cur.setAttribute('x2', xs[i]); cur.style.display = '';
  tip.innerHTML = `<b>${escHtml(data[i].d)}</b>${data[i].v.map(v => `<div>${escHtml(v)}</div>`).join('')}`;
  const px = xs[i] / W * r.width; tip.style.display = '';
  tip.style.left = Math.min(Math.max(px - tip.offsetWidth / 2, 0), r.width - tip.offsetWidth) + 'px';
});
document.addEventListener('mouseout', e => { const ch = e.target.closest && e.target.closest('.fl-chart'); if (!ch || (e.relatedTarget && ch.contains(e.relatedTarget))) return; const t = ch.querySelector('.fl-tip'), c = ch.querySelector('.fl-cursor'); if (t) t.style.display = 'none'; if (c) c.style.display = 'none'; });

/* 모바일용 표 → 카드: th 제목을 td의 data-label로 옮겨 두면 CSS(max-width 800px)가 행을 세로 카드로 펼친다 (2026-09-18) */
function stackTables(root) {
  (root || document).querySelectorAll('table.risk.stack').forEach(t => {
    const labels = [...t.querySelectorAll('thead th')].map(th => th.innerHTML.replace(/<br\s*\/?>/gi, ' · ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    t.querySelectorAll('tbody tr').forEach(tr => [...tr.children].forEach((td, i) => { if (labels[i]) td.setAttribute('data-label', labels[i]); }));
  });
}

function dataErrors(data) {
  const errs = data?.errors || [];
  return errs.length ? `<div class="muted small warn-text"><i class="fa-solid fa-plug-circle-xmark"></i> 일부 데이터 수집 실패: ${errs.map(escHtml).join(' / ')}</div>` : '';
}

/* 수집 숫자 표 — 보고서 근거 확인용 */
function rawTable(d, agent) {
  if (!d) return '';
  if (agent === 'returns') return rawTableReturns(d);
  if (agent === 'strategy') return rawTableStrategy(d);
  if (agent === 'creative') return `<div class="muted small">상품별 읽기 원문·리뷰는 creative_briefs 행에 저장돼 있어요. 묶음 ${escHtml(String(d.batch_id || ''))} · ${d.count || 0}개 상품</div>`;
  if (agent === 'detail') return `<div class="muted small">읽기 원문은 상세 점검 행(detail_reviews)에 저장돼 있어요. 묶음 ${escHtml(String(d.batch_id || ''))} · ${d.count || 0}개 상품</div>`;
  const rev = d.revenue || {}, pr = d.periods || {};
  const row = (label, r, p) => r ? `<tr><td>${label}</td><td class="muted">${Array.isArray(p) ? p[0] + ' ~ ' + p[1] : (p || '')}</td><td class="r">${fmt(r.revenue)}원</td><td class="r">${fmt(r.orders)}건</td></tr>` : '';
  const products = (arr, cols) => (arr || []).length
    ? `<table><thead><tr>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr></thead><tbody>${arr.map(x => `<tr>${cols.map(c => `<td class="${c[2] || ''}">${c[1](x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : '<div class="muted">없음</div>';
  const p = d.products || {};
  return `<h4>매출 (카페24 결제완료 기준)</h4>
    <table><thead><tr><th>구간</th><th>기간</th><th class="r">매출</th><th class="r">주문</th></tr></thead><tbody>
      ${row('어제', rev.yesterday, pr.yesterday)}${row('그저께', rev.day_before, pr.day_before)}${row('지난주 같은 요일', rev.same_dow_last_week, pr.same_dow_last_week)}
      ${row('최근 7일', rev.last7, pr.last7)}${row('직전 7일', rev.prev7, pr.prev7)}${row('이달 누적', rev.mtd, pr.mtd)}${row('지난달 같은 기간', rev.last_month_same, pr.last_month_same)}${row('지난달 전체', rev.last_month, pr.last_month)}
    </tbody></table>
    <h4>어제 많이 팔린 상품</h4>${products(p.top_yesterday, [['상품', x => escHtml(x.name)], ['수량', x => fmt(x.qty), 'r'], ['조회', x => fmt(x.views), 'r'], ['주문율', x => x.rate + '%', 'r']])}
    <h4>급등 상품 (최근 7일 vs 직전 7일)</h4>${products(p.trending_7d, [['상품', x => escHtml(x.name)], ['직전', x => fmt(x.qty_prev7d), 'r'], ['최근', x => fmt(x.qty_7d), 'r'], ['주문율', x => x.rate_7d + '%', 'r']])}
    <h4>주문율 하락 상품</h4>${products(p.rate_drops_7d, [['상품', x => escHtml(x.name)], ['조회', x => fmt(x.views_7d), 'r'], ['직전 주문율', x => x.rate_prev7d + '%', 'r'], ['최근 주문율', x => x.rate_7d + '%', 'r']])}
    ${d.claims_last7 ? `<h4>최근 7일 취소·반품</h4><div class="muted">취소 ${fmt(d.claims_last7.cancel_count)}건 (${(d.claims_last7.cancel_reasons_top3 || []).join(', ')}) · 반품 ${fmt(d.claims_last7.return_count)}건 (${(d.claims_last7.return_reasons_top3 || []).join(', ')})</div>` : ''}
    ${d.ads ? `<h4>Meta 광고</h4><div class="muted">어제 광고비 ${fmt(d.ads.yesterday?.spend)}원 · 최근 7일 ${fmt(d.ads.last7?.spend)}원 (직전 7일 ${fmt(d.ads.prev7?.spend)}원) · ROAS(카페24) 어제 ${d.ads.roas_cafe24?.yesterday ?? '—'} / 7일 ${d.ads.roas_cafe24?.last7 ?? '—'} / 직전 7일 ${d.ads.roas_cafe24?.prev7 ?? '—'}</div>` : ''}`;
}

function rawTableReturns(d) {
  const cl = d.claims || {}, ts = d.top_sellers_return || {}, co = d.cohorts || {}, cr = d.claim_reasons_last7 || {};
  const bucket = (label, b) => b && b.last7 ? `<tr><td>${label}</td><td class="r">${fmt(b.prev7?.count)}건</td><td class="r">${fmt(b.last7.count)}건</td><td class="r">${fmt(b.last7.amount)}원</td><td>${(b.reasons || []).slice(0, 4).map(x => `${escHtml(x.reason)} ${x.cnt}(${x.prev_cnt})`).join(', ')}</td></tr>` : '';
  const pr = v => v == null ? '—' : v + '%';
  const dayRows = (co.days_last14 || []).map(x => `<tr><td>${x.date}</td><td class="r">${x.age_days}일</td><td class="r">${fmt(x.paid)}</td><td class="r">${fmt(x.cancel)} (${pr(x.cancel_rate)})</td><td class="r">${fmt(x.ret)} (${pr(x.return_rate)})</td></tr>`).join('');
  const reasonRow = (label, b) => b ? `<tr><td>${label}</td><td class="r">${fmt(b.count_so_far)}건</td><td>${(b.reasons || []).slice(0, 5).map(x => `${escHtml(x.reason)} ${x.cnt}`).join(', ')}</td></tr>` : '';
  const cohortRaw = (co.weeks || []).length ? `<h4>결제 일별 코호트 (최근 14일, 괄호 = 비율)</h4><table><thead><tr><th>결제일</th><th class="r">경과</th><th class="r">결제</th><th class="r">취소</th><th class="r">반품</th></tr></thead><tbody>${dayRows}</tbody></table>
    <h4>최근 7일 주문의 취소·반품 사유 (사유 분포 참고용, 건수 추세 아님)</h4><table><thead><tr><th>구분</th><th class="r">지금까지</th><th>사유</th></tr></thead><tbody>${reasonRow('취소', cr.cancel)}${reasonRow('반품', cr.return)}</tbody></table>` : '';
  const risk = (ts.risk_products || []).map(p => `<tr><td>${escHtml(p.name)}${p.watched ? ' <span class="chip">관리</span>' : ''}</td><td class="r">${p.win7.rate}% (${p.win7.delivered})</td><td class="r">${p.win14.rate}% (${p.win14.delivered})</td><td class="r">${p.win30.rate}% (${p.win30.delivered})</td><td>${(p.risk_options || []).map(o => `${escHtml(o.option)} ${o.rate_14d}%`).join(', ') || '—'}</td><td>${(p.reasons_top3 || []).map(escHtml).join(', ') || '—'}</td></tr>`).join('');
  const legacy = cl.cancel ? `<h4>취소·반품 (주문일 기준, 최근 7일 vs 직전 7일 — 코호트 도입 전 방식)</h4>
    <table><thead><tr><th>구분</th><th class="r">직전 7일</th><th class="r">최근 7일</th><th class="r">금액</th><th>사유 최근(직전)</th></tr></thead><tbody>${bucket('취소', cl.cancel)}${bucket('반품', cl.return)}</tbody></table>` : '';
  return `${cohortRaw}${legacy}
    <h4>위험·주의 후보 (배송완료일 기준 순반품률, 괄호 = 배송완료 수량)</h4>
    ${risk ? `<table><thead><tr><th>상품</th><th class="r">7일</th><th class="r">14일</th><th class="r">30일</th><th>위험 옵션(14일)</th><th>사유 TOP3(14일)</th></tr></thead><tbody>${risk}</tbody></table>` : '<div class="muted">없음</div>'}
    <div class="muted small">판정 기준일 ${d.judge_date || ''} (기준일보다 3일 앞 — 반품은 배송완료 후 며칠 뒤 들어와서)</div>`;
}

function rawTableStrategy(d) {
  const na = d.new_arrivals || {};
  const rows = (na.matrix || []).map(p => `<tr><td>${escHtml(p.name)}</td><td>${escHtml(p.category || '')}</td><td>${escHtml(p.quadrant)}</td><td class="r">${p.age_days ?? '—'}</td><td class="r">${fmt(p.views_14d)}</td><td class="r">${p.rate_14d}%</td><td class="r">${fmt(p.qty_14d)}</td><td class="r">${p.margin_rate ?? '—'}</td><td class="r">${p.active_ads ?? '—'}</td><td>${p.codi ? `${escHtml(String(p.codi.share ?? '—'))}% (${(p.codi.parents || []).map(x => escHtml(pn(x.name))).join(', ')})` : ''}</td><td>${(p.promos || []).map(escHtml).join(', ')}</td></tr>`).join('');
  const top = (d.top10 || []).map(t => `<tr><td>${t.rank}</td><td>${escHtml(t.name)}</td><td class="r">${fmt(t.qty_14d)}</td><td class="r">${t.rate_14d}%</td><td class="r">${t.active_ads ?? '—'}</td></tr>`).join('');
  const sg = (d.surge_top10 || []).map(t => `<tr><td>${t.rank}</td><td>${escHtml(t.name)}</td><td class="r">${fmt(t.qty_prev7d)} → ${fmt(t.qty_7d)}</td><td class="r">${fmt(t.views_7d)}</td><td class="r">${t.rate_7d}%</td><td class="r">${t.active_ads ?? '—'}</td><td class="r">${t.ad_spend_7d != null ? fmt(t.ad_spend_7d) + '원' : '—'}</td><td class="r">${t.ad_roas_7d ?? '—'}</td></tr>`).join('');
  const s7 = d.sold_7d;
  return `${s7 ? `<h4>최근 7일 판매 상품 전체</h4><div class="muted">${fmt(s7.products)}개 상품 · ${fmt(s7.qty)}개 판매 · 주문 ${fmt(s7.orders)}건 / 조회 ${fmt(s7.views)} → 전환율 ${s7.conversion ?? '—'}% (전체 상품 ${s7.conversion_all ?? '—'}%) · 평균 마진율 ${s7.margin_avg ?? '—'}% (원가 있는 ${fmt(s7.margin_products)}개, 수량 가중)</div>` : ''}
    ${sg ? `<h4>판매량 급증 TOP10 (7일 vs 직전 7일)</h4><table><thead><tr><th>#</th><th>상품</th><th class="r">판매</th><th class="r">조회</th><th class="r">주문율</th><th class="r">광고</th><th class="r">광고비 7일</th><th class="r">ROAS 7일</th></tr></thead><tbody>${sg}</tbody></table>` : ''}
    <h4>신상품 전체 (${fmt(na.count)}개)</h4>
    <table><thead><tr><th>상품</th><th>카테고리</th><th>판정</th><th class="r">등록일수</th><th class="r">조회 14일</th><th class="r">주문율</th><th class="r">판매</th><th class="r">마진%</th><th class="r">광고</th><th>코디(부모)</th><th>행사</th></tr></thead><tbody>${rows}</tbody></table>
    <h4>판매 TOP10 (14일 결제수량)</h4>
    <table><thead><tr><th>#</th><th>상품</th><th class="r">판매</th><th class="r">주문율</th><th class="r">활성 광고</th></tr></thead><tbody>${top}</tbody></table>`;
}

/* ── 팀 협업 칸 (2026-10-17): 동료 보고서에서 가져온 것 · 받은 요청 · 동료에게 넘기는 요청 ──
   handoffs[].to 가 상세 점검·광고 소재 담당이고 상품 번호가 맞춰져 있으면 바로 실행 버튼, 아니면 담당자 카드로 가서 상품을 고르게. */
const TEAM_KEY = { '오늘의 요약': 'sales', '매출 분석 담당': 'sales', '취소·반품 감시 담당': 'returns', '상품 전략 담당': 'strategy', '광고 운영 담당': 'ads', '광고 소재 담당': 'creative', '상세페이지 점검 담당': 'detail' };
function teamChip(label) { const k = TEAM_KEY[label], a = k && agentOf(k); return a ? `<span class="chip team" style="color:${a.color};background:${a.color}1a;"><i class="fa-solid ${a.icon}"></i> ${escHtml(label)}</span>` : `<span class="chip">${escHtml(label || '')}</span>`; }
/* 카페24 통계 상품명의 ' - Danarobe' 접미사는 화면에서 뗀다 */
const pn = n => String(n || '').replace(/\s*[-–—|]\s*(danarobe|dana|다나로브|다나)\s*$/i, '');
/* 코디 상품 칩(2026-10-27): 잘 팔리는 상품 페이지의 '코디 상품(추가구성)'이라 주문율이 부풀 수 있는 상품. share = 14일 주문 중 부모와 같은 주문 비율 */
const codiChip = (c, long) => {
  if (!c) return '';
  const ps = c.parents || [], top = ps[0];
  const tip = `잘 팔리는 상품 페이지의 코디 상품 — 14일 주문 ${fmt(c.orders_14d)}건 중 ${fmt(c.with_parent)}건(${c.share ?? '—'}%)이 ${ps.map(x => pn(x.name)).join(', ')}와(과) 같은 주문`;
  const lvl = c.share == null ? '' : c.share >= 40 ? ' hi' : c.share >= 20 ? ' mid' : '';
  return `<span class="chip codi${lvl}" title="${escHtml(tip)}"><i class="fa-solid fa-link"></i> 코디 ${c.share ?? '—'}%${long && top ? ` <em>↳ ${escHtml(pn(top.name).slice(0, 14))}</em>` : ''}</span>`;
};
function teamBox(rp, compact) {
  const notes = rp.colleague_notes || [], got = rp.handoffs_received || [], give = rp.handoffs || [], seen = rp.colleagues_seen || [];
  if (!notes.length && !got.length && !give.length && !seen.length) return '';
  const md = d => d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '';
  const runBtn = h => {
    const k = TEAM_KEY[h.to]; if (!['detail', 'creative'].includes(k) || !isAdmin()) return '';
    const label = k === 'detail' ? '지금 점검' : '제작안 만들기';
    return `<button class="btn ghost sm" onclick="handoffRun('${k}', ${Number(h.product_no) || 0}, this.dataset.name)" data-name="${escHtml(h.product || '')}"><i class="fa-solid fa-play"></i> ${label}</button>`;
  };
  if (compact) {
    // 압축형(2026-10-27, 전략 담당): 머리에 개수 칩, 받은 요청·넘기는 요청만 한 줄씩 펼치고 '가져온 것'은 접는다
    const line = (chip, h, extra = '') => `<div class="team-line">${chip}<div><b>${escHtml(h.ask)}</b>${h.product ? ` <span class="muted">· ${escHtml(pn(h.product))}</span>` : ''}${h.why ? `<div class="muted small">${h.report_date ? md(h.report_date) + ' · ' : ''}${escHtml(h.why)}</div>` : ''}${extra}</div></div>`;
    return `<div class="box team-box compact"><h3><i class="fa-solid fa-people-group" style="color:#0e7490;"></i> 팀 협업 <span class="tsum"><span class="chip">가져온 것 ${notes.length}</span><span class="chip warn">받은 요청 ${got.length}</span><span class="chip new">넘긴 요청 ${give.length}</span><span class="chip">읽은 보고서 ${seen.length}</span></span></h3>
      <div class="team-cols">
        ${got.length ? `<div><h5>받은 요청</h5>${got.map(h => line(teamChip(h.from), h)).join('')}</div>` : ''}
        ${give.length ? `<div><h5>동료에게 넘기는 요청</h5>${give.map(h => line(teamChip(h.to), h, runBtn(h))).join('')}</div>` : ''}
      </div>
      ${(notes.length || seen.length) ? `<details class="fold"><summary><i class="fa-solid fa-chevron-right"></i> 동료에게서 가져온 것 ${notes.length}개 <span class="muted small">· 읽은 보고서 ${seen.length}개</span></summary>${notes.map(n => `<div class="team-line">${teamChip(n.from)}<div>${escHtml(n.took)}</div></div>`).join('') || '<div class="muted small">이번엔 반영한 것 없음</div>'}${seen.length ? `<div class="muted small" style="margin-top:6px;">읽은 보고서: ${seen.map(c => `${escHtml(c.agent)} ${md(c.report_date)}`).join(', ')}</div>` : ''}</details>` : ''}
    </div>`;
  }
  return `<div class="box team-box"><h3><i class="fa-solid fa-people-group" style="color:#0e7490;"></i> 팀 협업 <span class="muted small">동료 보고서를 읽고 함께 판단한 것${seen.length ? ' · 읽은 보고서: ' + seen.map(c => `${escHtml(c.agent)} ${md(c.report_date)}`).join(', ') : ''}</span></h3>
    <div class="team-grid">
      <div><h5>동료에게서 가져온 것</h5>${notes.length ? notes.map(n => `<div class="team-row">${teamChip(n.from)}<div>${escHtml(n.took)}</div></div>`).join('') : '<div class="muted small">이번엔 반영한 것 없음</div>'}</div>
      <div><h5>받은 요청${got.length ? ` <span class="chip warn">${got.length}</span>` : ''}</h5>${got.length ? got.map(h => `<div class="team-row">${teamChip(h.from)}<div><b>${escHtml(h.ask)}</b>${h.product ? ` <span class="muted">· ${escHtml(h.product)}</span>` : ''}<div class="muted small">${md(h.report_date)} · ${escHtml(h.why)}</div></div></div>`).join('') : '<div class="muted small">없음</div>'}</div>
      <div><h5>동료에게 넘기는 요청${give.length ? ` <span class="chip new">${give.length}</span>` : ''}</h5>${give.length ? give.map(h => `<div class="team-row">${teamChip(h.to)}<div><b>${escHtml(h.ask)}</b>${h.product ? ` <span class="muted">· ${escHtml(h.product)}</span>` : ''}<div class="muted small">${escHtml(h.why)}</div>${runBtn(h)}</div></div>`).join('') : '<div class="muted small">없음</div>'}</div>
    </div>
    <div class="muted small chk-hint">자동 담당자(매출·반품·전략)는 다음 아침 보고서에서 받은 요청에 답해요. 상세 점검·광고 소재 요청은 버튼으로 바로 실행할 수 있어요.</div></div>`;
}
async function handoffRun(key, no, name) {
  if (!isAdmin()) return;
  if (key === 'detail' && no) return detailRun(no, name);
  if (key === 'creative' && no) {
    if (!confirm(`'${name}' 광고 소재 제작안을 만들까요? (2~4분, 약 250원)`)) return;
    __reportsCache = null; location.hash = '#home';
    await new Promise(r => setTimeout(r, 300));
    return agentRun('creative', { product_no: String(no) });
  }
  // 상품 번호를 못 맞춘 경우: 담당자 카드로 가서 상품명을 채워 준다
  location.hash = '#home';
  await new Promise(r => setTimeout(r, 300));
  const inp = $('pick-' + key); if (inp) { inp.value = name || ''; inp.focus(); if (typeof pickSuggest === 'function') pickSuggest(key); }
  toast('목록에서 상품을 고른 뒤 실행해 주세요');
}
function copyText(btn) {
  const t = btn.dataset.text || '';
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('복사했어요')).catch(() => { window.prompt('복사할 문장', t); });
}

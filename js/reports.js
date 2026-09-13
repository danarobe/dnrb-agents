/* ──────────────────────────────────────────
   보고서 피드 — agent_reports (db 프록시, admin)
   #reports        : 목록 + 최신 보고서
   #reports/<id>   : 그 보고서
────────────────────────────────────────── */
let __reportsCache = null;
const reportsState = { filter: '' };
function reportsFilter(k) { reportsState.filter = k; renderReports(location.hash.split('/')[1]); }
async function reportsLoad(force) {
  if (__reportsCache && !force) return __reportsCache;
  const rows = await dbProxy('agent_reports?select=id,agent,report_date,trigger,status,report,data,error,model,created_at&order=created_at.desc&limit=60') || [];
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
  const rows = await dbProxy('agent_actions?select=agent,action_id,done,done_by,done_at,title,owner,week_start').catch(() => []);
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
  const cur = rows.find(r => r.id === id) || rows[0];
  // 담당자 필터 — 보고 있는 보고서의 담당자 또는 '전체'
  const filterAgent = reportsState.filter;
  const shown = filterAgent ? rows.filter(r => r.agent === filterAgent) : rows;
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
  }).join('') : `<div class="muted pad">아직 보고서가 없어요. 매일 아침 8시에 자동으로 도착하고, <b>지금 실행</b>으로 바로 만들 수도 있어요.</div>`;
  $('report-view').innerHTML = cur ? reportHtml(cur) : '';
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
  let tiles = '', extraBoxes = '';
  if (r.agent === 'returns') {
    const ts = d.top_sellers_return || {}, co = d.cohorts || {};
    const weeks = co.weeks || [], ms = co.mature_weeks_summary, lm = ms?.latest_mature, cur = weeks.find(w => w.partial) || weeks[0];
    const wk = w => w ? `${md(w.start)}~${md(w.end)}` : '';
    const pr = v => v == null ? '—' : v + '%';
    if (weeks.length) {
      tiles = [
        tile('취소율 (최근 성숙 주)', lm ? pr(lm.cancel_rate) : '—', lm ? `결제 주 ${wk(lm)} · 성숙 주 평균 ${pr(ms.avg_cancel_rate)}` : '성숙한 주가 아직 없음'),
        tile('반품률 (최근 성숙 주)', lm ? pr(lm.return_rate) : '—', lm ? `결제 ${fmt(lm.paid)}건 중 반품 ${fmt(lm.ret)}건 · 평균 ${pr(ms.avg_return_rate)}` : '성숙한 주가 아직 없음'),
        tile('이번 주 (집계 중)', cur ? `${pr(cur.cancel_rate)} · ${pr(cur.return_rate)}` : '—', cur ? `취소 · 반품 · 결제 ${fmt(cur.paid)}건 · 아직 늘어날 수 있음` : ''),
        tile('위험·주의 상품', (rp.risk_products || []).length + '개', `상위 상품 14일 순반품률 ${ts.rate_14d != null ? ts.rate_14d + '%' : '—'} · 관리 ${fmt(d.watched_count || 0)}개`),
      ].join('');
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
      <div class="tbl-wrap"><table class="risk"><thead><tr><th>결제 주(월~일)</th><th>상태</th><th class="r">결제</th><th class="r">취소율</th><th class="r">반품률</th><th>판단</th></tr></thead><tbody>${cohortRows}</tbody></table></div>
      <div class="muted small chk-hint">취소가 다음 주에 일어나도 결제한 주로 돌아갑니다. 집계 중인 주는 앞으로 더 올라갑니다.</div></div>` : '';
    const lvColor = { '위험': 'down', '주의': 'warn' };
    const riskRows = (rp.risk_products || []).map(x => `<tr><td><b>${escHtml(x.name)}</b><div class="muted">${escHtml(x.cause)}</div></td><td class="r"><b class="${lvColor[x.level] || ''}">${escHtml(x.level)}</b><div class="muted">${x.rate_14d}% · ${fmt(x.delivered_14d)}개</div></td><td>${escHtml(x.fix)}</td></tr>`).join('');
    const vColor = { '개선': 'up-good', '유지': '', '악화': 'down' };
    const watchRows = (rp.watch_review || []).map(x => `<div class="li"><div class="li-top"><b>${escHtml(x.name)}</b><span class="chip ${x.verdict === '개선' ? 'good' : x.verdict === '악화' ? 'bad' : ''}">${escHtml(x.verdict)}</span></div><div>${escHtml(x.detail)}</div></div>`).join('');
    extraBoxes = cohortBox + `
    <div class="box"><h3><i class="fa-solid fa-triangle-exclamation down"></i> 위험·주의 상품 <span class="muted small">14일 창 · 순반품률 20%↑ 위험, 10~20% 주의</span></h3>
      ${riskRows ? `<div class="tbl-wrap"><table class="risk"><thead><tr><th>상품 · 원인 추정</th><th class="r">판정</th><th>대응</th></tr></thead><tbody>${riskRows}</tbody></table></div>` : '<div class="muted">위험·주의 상품이 없어요</div>'}
    </div>
    <div class="box"><h3><i class="fa-solid fa-star" style="color:#b45309;"></i> 관리 상품 점검 <span class="muted small">워크스페이스 반품 관리에서 지정한 상품</span></h3>${watchRows || '<div class="muted">관리 상품이 없어요</div>'}</div>`;
  } else if (r.agent === 'strategy') {
    const na = d.new_arrivals || {}, mx = rp.matrix || [];
    const cnt = q => (na.matrix || []).filter(p => String(p.quadrant).startsWith(q)).length;
    tiles = [
      tile('신상품', `${fmt(na.count)}개`, `판정 가능 ${fmt(na.eligible)}개 · 기준 조회 ${fmt(na.median_views_14d)} / 주문율 ${na.median_rate_14d ?? '—'}%`),
      tile('판매 확대 · 노출 부족', `${cnt('판매 확대')} · ${cnt('노출 부족')}`, '힘을 실을 상품'),
      tile('상세·가격 점검 · 집중도 낮춤', `${cnt('상세·가격')} · ${cnt('집중도')}`, '손보거나 뒤로 보낼 상품'),
      tile('집중 상품', `${(rp.focus || []).length}개`, `급상승 ${(d.trending || []).length} · TOP10 순환 · 행사 ${fmt(d.benefits_active || 0)}건 적용 중`),
    ].join('');
    const qColor = { '판매 확대': 'q-grow', '노출 부족': 'q-expose', '상세·가격 점검': 'q-fix', '집중도 낮춤': 'q-low' };
    const qc = q => { const k = Object.keys(qColor).find(k => String(q).startsWith(k)); return k ? qColor[k] : 'q-na'; };
    const won = v => v == null ? '' : Math.round(v).toLocaleString('ko-KR') + '원';
    const mxRows = mx.map(x => `<tr>
        <td><b>${escHtml(x.name)}</b><div class="muted">${x.age_days != null ? `등록 ${x.age_days}일` : ''}${x.sold_out ? ' · <b class="down">품절</b>' : ''}${x.active_ads ? ` · 광고 ${x.active_ads}개` : ' · 광고 없음'}</div></td>
        <td><span class="qbadge ${qc(x.quadrant)}">${escHtml(x.quadrant)}</span></td>
        <td class="r">${fmt(x.views_14d)}<div class="muted">${x.rate_14d != null ? x.rate_14d + '%' : '—'} · ${fmt(x.qty_14d)}개</div></td>
        <td class="r">${x.margin_rate != null ? x.margin_rate + '%' : '—'}<div class="muted">${x.discount_price ? `할인가 ${won(x.discount_price)}` : won(x.price)}</div></td>
        <td>${(x.promos || []).length ? (x.promos || []).map(p => `<span class="chip">${escHtml(p)}</span>`).join(' ') : '<span class="muted">—</span>'}</td>
        <td>${escHtml(x.strategy)}</td></tr>`).join('');
    const focusCards = (rp.focus || []).map(f => {
      const adRow = (a, ref) => `<div class="ad-row">
          ${a.thumb ? `<img src="${escHtml(a.thumb)}" alt="" loading="lazy">` : '<span class="ad-noimg"></span>'}
          <div class="ad-info"><div class="ad-name">${ref ? `<span class="chip">${escHtml(a.product_name || '')}</span> ` : ''}${escHtml(a.name)} <span class="chip">${a.is_video ? '영상' : '이미지'}</span></div>
          <div class="muted">${a.last14 ? `14일 지출 ${fmtMan(a.last14.spend)} · 구매 ${fmt(a.last14.purchases)} · ROAS ${a.last14.roas} · CTR ${a.last14.ctr}% · 빈도 ${a.last14.frequency}` : (a.since_start ? `누적 지출 ${fmtMan(a.since_start.spend)} · 구매 ${fmt(a.since_start.purchases)} · ROAS ${a.since_start.roas}` : '성과 없음')}</div>
          ${a.body ? `<div class="ad-body">${escHtml(a.body)}</div>` : ''}</div></div>`;
      return `<div class="focus-card">
        <div class="focus-head"><div><b>${escHtml(f.name)}</b><div class="muted">${escHtml(f.why)}${f.category ? ` · ${escHtml(f.category)}` : ''} · 14일 조회 ${fmt(f.views_14d)} · 주문율 ${f.rate_14d ?? '—'}% · 마진 ${f.margin_rate ?? '—'}%${(f.promos || []).length ? ' · ' + f.promos.map(escHtml).join(', ') : ''}</div></div></div>
        <div class="focus-grid">
          <div><h4>지금 붙은 소재${f.own_ads.length ? '' : ' <span class="chip bad">광고 없음</span>'}</h4>${f.own_ads.map(a => adRow(a, false)).join('') || '<div class="muted small">이 상품에 붙은 활성 광고가 없어요</div>'}
            <div class="fx"><b>견인 소재</b> ${escHtml(f.driver)}</div></div>
          <div><h4>같은 카테고리 우수 소재</h4>${f.reference_ads.map(a => adRow(a, true)).join('') || '<div class="muted small">참고할 우수 소재가 없어요</div>'}
            <div class="fx"><b>추가 소재 컨셉</b> ${escHtml(f.creative_plan)}</div></div>
        </div>
        <div class="fx-row">
          <div class="fx"><b>릴스 첫 3초 훅</b><ol>${(f.reels_hooks || []).map(h => `<li>${escHtml(h)}</li>`).join('')}</ol></div>
          <div class="fx"><b>상세에서 강조</b> ${escHtml(f.detail_focus)}</div>
          <div class="fx"><b>판매 계획</b> ${escHtml(f.plan)}</div>
        </div></div>`;
    }).join('');
    // 트렌드·날씨 (2026-09-13)
    const tr = d.trends || {}, w = tr.weather, ws = w?.summary || {};
    const dayCell = (x, past) => `<div class="wday ${past ? 'past' : ''}"><div class="wd">${x.date.slice(5).replace('-', '/')}</div><div class="wt"><b>${Math.round(x.max)}°</b>/${Math.round(x.min)}°</div>${x.rain_prob >= 60 ? '<div class="wr">☔ ' + x.rain_prob + '%</div>' : ''}</div>`;
    const weatherStrip = w ? `<div class="wstrip">${(w.past_7d || []).map(x => dayCell(x, true)).join('')}<div class="wsep">오늘</div>${(w.next_7d || []).map(x => dayCell(x, false)).join('')}</div>
      <div class="muted small">지난 7일 평균 ${ws.past_avg_max}°/${ws.past_avg_min}° → 앞으로 7일 ${ws.next_avg_max}°/${ws.next_avg_min}°${ws.first_min_below_15 ? ` · 최저 15°↓ 첫날 ${ws.first_min_below_15.slice(5)}` : ''}${(ws.rainy_days_next || []).length ? ` · 비 ${ws.rainy_days_next.map(x => x.slice(5)).join(', ')}` : ''}</div>` : '<div class="muted">날씨 데이터 없음</div>';
    const risingChips = (tr.naver || []).map(c => `<div class="tr-cat"><b>${escHtml(c.category)}</b> <span class="muted small">TOP10: ${c.top10.map(escHtml).join(' · ')}</span>
        <div class="chips">${(c.rising || []).slice(0, 18).map(r => `<span class="kchip ${r.our_products.length ? 'hit' : ''}" title="${r.our_products.map(p => escHtml(p.name)).join('\n')}">${escHtml(r.keyword)} <em>${r.kind === 'new' ? 'NEW ' + r.rank + '위' : r.prev_rank + '→' + r.rank + '위'}</em>${r.our_products.length ? `<i>${r.our_products.length}</i>` : ''}</span>`).join('')}</div></div>`).join('');
    const trendRows = (rp.trend_actions || []).map(x => `<div class="li"><div class="li-top"><b>${escHtml(x.keyword)}</b><span class="chip new">${escHtml(x.signal)}</span><span class="muted small">${escHtml(x.our_products)}</span></div><div>${escHtml(x.suggestion)}</div></div>`).join('');
    const trendBox = `<div class="box"><h3><i class="fa-solid fa-arrow-trend-up" style="color:#0891b2;"></i> 트렌드 · 날씨 <span class="muted small">네이버 쇼핑 인기 검색어(여성) 어제 vs 7일 전 · 서울 날씨</span></h3>
      ${weatherStrip}
      ${rp.weather_plan ? `<div class="fx"><b>날씨 계획</b> ${escHtml(rp.weather_plan)}</div>` : ''}
      ${risingChips}
      <div class="muted small">색칠된 키워드 = 우리 상품이 있는 것(숫자는 개수, 마우스를 올리면 상품명). 브랜드명은 판단에서 뺍니다.</div>
      ${trendRows ? `<h4 style="margin-top:10px;">키워드 기반 제안</h4>${trendRows}` : ''}
    </div>`;
    extraBoxes = trendBox + `
    <div class="box"><h3><i class="fa-solid fa-table-cells" style="color:#0891b2;"></i> 신상품 4분면 <span class="muted small">조회수 × 주문율, 신상품 중앙값 기준 · 마진율 = (판매가 − 공급가×1.1) ÷ 판매가</span></h3>
      <div class="qlegend"><span class="qbadge q-grow">판매 확대</span> 둘 다 높음 <span class="qbadge q-expose">노출 부족</span> 주문율↑ 조회↓ <span class="qbadge q-fix">상세·가격 점검</span> 조회↑ 주문율↓ <span class="qbadge q-low">집중도 낮춤</span> 둘 다 낮음</div>
      ${mxRows ? `<div class="tbl-wrap"><table class="risk"><thead><tr><th>상품</th><th>판정</th><th class="r">조회 14일<br><span class="muted">주문율 · 판매</span></th><th class="r">마진율<br><span class="muted">가격</span></th><th>행사</th><th>전략</th></tr></thead><tbody>${mxRows}</tbody></table></div>` : '<div class="muted">판정할 신상품이 없어요</div>'}
    </div>
    <div class="box"><h3><i class="fa-solid fa-bullseye" style="color:#0891b2;"></i> 집중 상품 <span class="muted small">급상승 3 + 판매 TOP10 순환 3 · 광고 소재 분석</span></h3>${focusCards || '<div class="muted">없음</div>'}</div>`;
  } else {
    tiles = [
      tile('어제 매출', fmtMan(rev.yesterday?.revenue), `지난주 같은 요일 대비 ${fmtDelta(ch.vs_same_dow_last_week)} · 주문 ${rev.yesterday ? fmt(rev.yesterday.orders) + '건' : '—'}`),
      tile('최근 7일 매출', fmtMan(rev.last7?.revenue), `직전 7일 대비 ${fmtDelta(ch.last7_vs_prev7)}`),
      tile('이달 누적', fmtMan(rev.mtd?.revenue), `지난달 같은 기간 대비 ${fmtDelta(ch.mtd_vs_last_month_same)}`),
      ads?.yesterday ? tile('어제 광고비', fmtMan(ads.yesterday.spend), `ROAS(카페24) ${ads.roas_cafe24?.yesterday ?? '—'} · 최근 7일 ${ads.roas_cafe24?.last7 ?? '—'}`)
        : tile('어제 광고비', '—', 'Meta 데이터 없음'),
    ].join('');
  }
  const list = (arr, cls) => (arr || []).length ? (arr || []).map(x => `<div class="li"><b class="${cls}">${escHtml(x.title)}</b><div>${escHtml(x.detail)}</div></div>`).join('') : '<div class="muted">없음</div>';
  const chips = x => `${x.status === 'new' ? '<span class="chip new">NEW</span>' : ''}${(x.dates || []).length ? `<span class="chip">${x.dates.map(md).join(' · ')}</span>` : ''}`;
  const wlist = (arr, cls) => (arr || []).length ? (arr || []).map(x => `<div class="li"><div class="li-top"><b class="${cls}">${escHtml(x.title)}</b>${chips(x)}</div><div>${escHtml(x.detail)}</div></div>`).join('') : '<div class="muted">아직 없음</div>';
  const doneMap = actionsState.map || new Map();
  const actRow = (x, i, opts = {}) => {
    const key = actionKey(x), st = doneMap.get(r.agent + '|' + key), done = !!(st && st.done);
    const doneMeta = done ? `완료 · ${escHtml(st.done_by || '')} · ${st.done_at ? timeLabel(st.done_at) : ''}` : '';
    return `<div class="act ${opts.past ? 'past' : ''} ${done ? 'done' : ''}">
      <label class="chk" title="완료 체크"><input type="checkbox" class="act-chk" ${done ? 'checked' : ''} data-key="${escHtml(key)}" data-agent="${escHtml(r.agent)}" data-week="${escHtml(opts.week || '')}" data-title="${escHtml(x.title)}" data-owner="${escHtml(x.owner || '')}"><span class="num">${i + 1}</span></label>
      <div><div class="act-top"><b>${escHtml(x.title)}</b><span class="owner o-${escHtml(x.owner)}">${escHtml(x.owner || '')}</span>${x.status === 'new' ? '<span class="chip new">NEW</span>' : ''}${x.since ? `<span class="chip">${md(x.since)}부터</span>` : ''}</div><div class="muted">${escHtml(x.why)}</div><div class="done-meta">${doneMeta}</div></div>
    </div>`;
  };
  const hasWeek = Array.isArray(rp.week_actions) || Array.isArray(rp.week_highlights);
  const weekLabel = rp.week ? `${md(rp.week.start)} ~ ${md(rp.week.end)}` : '';
  const weekActions = (hasWeek ? rp.week_actions : rp.actions) || [];
  const lw = rp.last_week || null;
  const lwLabel = lw ? `${md(lw.start)} ~ ${md(lw.end)}` : '';
  return head + `
    <div class="headline mood-${rp.mood || 'neutral'}">
      <div class="h-text">${escHtml(rp.headline)}</div>
      <ul>${(rp.summary || []).map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>
    </div>
    <div class="tiles">${tiles}</div>
    <div class="two">
      <div class="box"><h3><i class="fa-solid fa-arrow-trend-up up"></i> 오늘의 주목</h3>${list(rp.highlights, 'up')}</div>
      <div class="box"><h3><i class="fa-solid fa-triangle-exclamation down"></i> 오늘의 주의</h3>${list(rp.warnings, 'down')}</div>
    </div>
    ${extraBoxes}
    ${hasWeek ? `<div class="week-head"><i class="fa-regular fa-calendar"></i> 이번 주 누적 <span class="muted">${weekLabel} · 앞선 날 보고서와 합친 것. 그날 못 봤어도 여기서 확인</span></div>
    <div class="two">
      <div class="box wk-p"><h3><span class="pn p">P</span> 이번 주 주목</h3>${wlist(rp.week_highlights, 'up')}</div>
      <div class="box wk-n"><h3><span class="pn n">N</span> 이번 주 주의</h3>${wlist(rp.week_warnings, 'down')}</div>
    </div>` : ''}
    <div class="box"><h3><i class="fa-solid fa-list-check" style="color:#4f46e5;"></i> 이번 주 할 일${weekLabel ? ` <span class="muted small">${weekLabel}</span>` : ''}</h3>${weekActions.length ? weekActions.map((x, i) => actRow(x, i, { week: rp.week?.start })).join('') : '<div class="muted">없음</div>'}<div class="muted small chk-hint">체크하면 완료로 기록되고, 다음 날 보고서의 할 일에서 빠집니다.</div></div>
    ${lw ? `<div class="box past-box"><h3><i class="fa-regular fa-clock" style="color:#9ca3af;"></i> 저번 주 해야 했을 일 <span class="muted small">${lwLabel}${lw.from_report_date ? ` · ${md(lw.from_report_date)} 보고서 기준` : ''}</span></h3>${(lw.actions || []).length ? lw.actions.map((x, i) => actRow(x, i, { past: true, week: lw.start })).join('') : '<div class="muted">저번 주 보고서가 없어요</div>'}</div>` : ''}
    ${rp.note ? `<div class="muted small"><i class="fa-regular fa-circle-question"></i> ${escHtml(rp.note)}</div>` : ''}
    ${dataErrors(r.data)}
    <details class="raw"><summary>수집한 숫자 보기</summary>${rawTable(r.data, r.agent)}</details>`;
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
  const rows = (na.matrix || []).map(p => `<tr><td>${escHtml(p.name)}</td><td>${escHtml(p.category || '')}</td><td>${escHtml(p.quadrant)}</td><td class="r">${p.age_days ?? '—'}</td><td class="r">${fmt(p.views_14d)}</td><td class="r">${p.rate_14d}%</td><td class="r">${fmt(p.qty_14d)}</td><td class="r">${p.margin_rate ?? '—'}</td><td class="r">${p.active_ads}</td><td>${(p.promos || []).map(escHtml).join(', ')}</td></tr>`).join('');
  const top = (d.top10 || []).map(t => `<tr><td>${t.rank}</td><td>${escHtml(t.name)}</td><td class="r">${fmt(t.qty_14d)}</td><td class="r">${t.rate_14d}%</td><td class="r">${t.active_ads}</td></tr>`).join('');
  return `<h4>신상품 전체 (${fmt(na.count)}개)</h4>
    <table><thead><tr><th>상품</th><th>카테고리</th><th>판정</th><th class="r">등록일수</th><th class="r">조회 14일</th><th class="r">주문율</th><th class="r">판매</th><th class="r">마진%</th><th class="r">광고</th><th>행사</th></tr></thead><tbody>${rows}</tbody></table>
    <h4>판매 TOP10 (14일 결제수량)</h4>
    <table><thead><tr><th>#</th><th>상품</th><th class="r">판매</th><th class="r">주문율</th><th class="r">활성 광고</th></tr></thead><tbody>${top}</tbody></table>`;
}

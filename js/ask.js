/* ──────────────────────────────────────────
   담당자에게 질문하기 (2026-09-15)
   - 보고서 화면 맨 아래 '담당자에게 질문' 상자. agent-ask 함수가 그 보고서(본문+수집 데이터)와 앞선 문답을 맥락으로 답하고,
     필요하면 워크스페이스 데이터(매출·상품·취소반품·코호트·순반품률·광고·상품 정보)를 다시 조회한다.
   - 문답은 보고서별로 agent_questions에 남아 다른 관리자도 본다. 답변은 Claude 출력이라 escHtml을 거친다.
────────────────────────────────────────── */
const ASK_SUGGEST = {
  sales: ['어제 매출이 지난주 같은 요일과 다른 이유가 뭐야?', '이번 주 광고 효율은 좋아지고 있어?', '급등 상품 중 광고를 더 밀 만한 건?'],
  returns: ['반품률이 높은 상품의 사유는 뭐가 많아?', '최근 성숙 주 취소율은 전 주보다 나아졌어?', '관리 상품 중 판매 중단을 고민할 게 있어?'],
  strategy: ['노출 부족 상품 중 먼저 광고할 걸 하나만 꼽으면?', '집중 상품의 소재 빈도가 높은 건 어떤 거야?', '급상승 키워드 중 우리 상품과 맞는 건?'],
  creative: ['1순위 훅을 릴스 15초 콘티로 풀어줘', '이 상품 훅을 다른 앵글로 3개 더 뽑아줘', '할인 없이도 먹힐 전환형 훅은 뭐야?'],
  detail: ['점검 상품 중 가장 먼저 고칠 건 뭐야?', '실측표가 빠진 상품이 있어?', '첫 화면에 넣을 문장을 하나 더 만들어 줘'],
};
const askState = { loading: new Set() };

function askBoxHtml(r) {
  const chips = (ASK_SUGGEST[r.agent] || []).map(q => `<button type="button" class="chip-btn ask-chip" onclick="askFill(this.dataset.q)" data-q="${escHtml(q)}">${escHtml(q)}</button>`).join('');
  return `<div class="box ask-box" id="ask-box" data-report="${escHtml(r.id)}">
    <h3><i class="fa-regular fa-comments" style="color:#4f46e5;"></i> 담당자에게 질문 <span class="muted small">이 보고서와 그날 수집한 숫자를 근거로 답하고, 부족하면 데이터를 다시 조회해요 · 질문당 약 50~200원</span></h3>
    <div id="ask-thread"><div class="muted small"><i class="fa-solid fa-spinner fa-spin"></i> 문답 불러오는 중</div></div>
    <div class="filter-chips ask-chips">${chips}</div>
    <form class="ask-form" onsubmit="askSend(event)">
      <input type="text" id="ask-input" maxlength="500" placeholder="예: 어제 매출이 떨어진 이유가 뭐야?" autocomplete="off">
      <button class="btn primary" id="ask-btn" type="submit"><i class="fa-solid fa-paper-plane"></i> 질문</button>
    </form>
  </div>`;
}
function askFill(q) { const inp = $('ask-input'); if (!inp) return; inp.value = q; inp.focus(); }

async function askLoad(reportId) {
  const el = $('ask-thread'); if (!el) return;
  try {
    const d = await callFn('agent-ask', { action: 'list', report_id: reportId });
    if ($('ask-box')?.dataset.report !== reportId) return;   // 그 사이 다른 보고서로 이동
    askRender(d.rows || []);
  } catch (e) { el.innerHTML = `<div class="muted small">문답을 못 불러왔어요: ${escHtml(e.message)}</div>`; }
}
function askAnswerHtml(text) {
  // 줄바꿈 유지, '- ' 줄은 글머리로
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => /^[-•]\s*/.test(l) ? `<li>${escHtml(l.replace(/^[-•]\s*/, ''))}</li>` : `<p>${escHtml(l)}</p>`)
    .join('').replace(/(<li>.*?<\/li>)+/g, m => `<ul>${m}</ul>`);
}
function askRender(rows) {
  const el = $('ask-thread'); if (!el) return;
  if (!rows.length) { el.innerHTML = '<div class="muted small">아직 질문이 없어요. 아래에서 물어보세요.</div>'; return; }
  el.innerHTML = rows.map(x => `<div class="qa ${x.status === 'error' ? 'err' : ''}">
      <div class="q"><i class="fa-regular fa-user"></i> <b>${escHtml(x.question)}</b> <span class="muted small">${escHtml(x.asked_by_name || '')} · ${timeLabel(x.created_at)}</span></div>
      <div class="a">${x.status === 'error' ? `<span class="down">답변 실패: ${escHtml(x.error || '')}</span>` : askAnswerHtml(x.answer)}
        ${(x.tools_used || []).length ? `<div class="ask-tools"><i class="fa-solid fa-database"></i> 다시 조회: ${x.tools_used.map(t => `<span class="chip">${escHtml(t.label)}</span>`).join(' ')}</div>` : ''}</div>
    </div>`).join('');
}
async function askSend(ev) {
  ev.preventDefault();
  const box = $('ask-box'), inp = $('ask-input'), btn = $('ask-btn');
  const reportId = box?.dataset.report, q = (inp?.value || '').trim();
  if (!reportId || !q || askState.loading.has(reportId)) return;
  askState.loading.add(reportId);
  btnBusy(btn, '답하는 중');
  // 내 질문을 먼저 보여주고 답을 기다린다
  const th = $('ask-thread');
  if (th) { if (th.querySelector('.muted.small') && !th.querySelector('.qa')) th.innerHTML = ''; th.insertAdjacentHTML('beforeend', `<div class="qa pending" id="ask-pending"><div class="q"><i class="fa-regular fa-user"></i> <b>${escHtml(q)}</b></div><div class="a muted"><i class="fa-solid fa-spinner fa-spin"></i> 보고서와 숫자를 확인하고 있어요 (10초~1분)</div></div>`); th.lastElementChild.scrollIntoView({ block: 'nearest' }); }
  try {
    const d = await callFn('agent-ask', { action: 'ask' }, { method: 'POST', body: JSON.stringify({ report_id: reportId, question: q }) });
    inp.value = '';
    if ($('ask-box')?.dataset.report === reportId) await askLoad(reportId);
    toast(`답변이 도착했어요 (${Math.round((d.took_ms || 0) / 1000)}초)`);
  } catch (e) {
    const p = $('ask-pending'); if (p) p.querySelector('.a').innerHTML = `<span class="down">답변 실패: ${escHtml(e.message)}</span>`;
    toast('질문 실패: ' + e.message);
  } finally { askState.loading.delete(reportId); btnIdle(btn, '<i class="fa-solid fa-paper-plane"></i> 질문'); }
}

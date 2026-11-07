// ═══════════════════════════════════════════════
// agent-tasks (2026-11-07, 사용자 승인 "추천하는 순서대로 해줘") — 직원용 '오늘 할 일' 보드 + 대표 결정함
//   배경(평가 결과): 매일 보고서 4개가 할 일을 하루 약 24개 냈지만 완료 체크는 누적 3건·완료 0건, 같은 일이 보고서 3곳에 다른 문장으로 반복,
//   광고 할 일 대부분이 '대표 확인 후'에 막혀 며칠째 반복(르 플리츠 광고 착수 11/2~). → 할 일을 한 화면에 모으고, 대표 승인 창구를 만들고, 완료는 데이터로 자동 확인.
//
//   sync (cron·보고서 저장 직후·관리자) ─ 담당자 4명(반품·전략·광고 운영·요약)의 최신 보고서 week_actions를 상품 1개 × 할 일 1개로 쪼개고
//        같은 일(종류|상품번호)은 하나로 합쳐 team_tasks에 반영. 2일 연속 어느 보고서에도 없으면 dropped(에이전트가 더는 제안 안 함).
//        자동 완료: 광고 착수 = 그 상품 ON 광고 수가 처음보다 늘면 / 광고 줄이기 = 줄면 / 상세 보강 = 상세 이미지 해시가 바뀌면.
//        &auto=1(아침 cron만): 상세페이지 점검 요청이 서로 다른 날 2번 이상 쌓인 상품은 상세 점검 담당을 자동 실행(하루 2개, 14일 안에 점검한 상품 제외, 크레딧 부족이면 건너뜀).
//   list (에이전트 사용자) ─ 보드 / done (에이전트 사용자) ─ 완료·되돌리기 / decide (관리자 = 대표) ─ 승인·보류·되돌리기
//   보고서 쪽: _shared/agent.ts weekContext가 team_board(open·done_7d·held)를 담당자에게 주고, 끝났거나 보류된 일은 그 담당자 할 일에서 뺀다.
// ═══════════════════════════════════════════════
import { handleOptions, json, verifyAuthToken } from "../_shared/util.ts";
import { addDays, AGENT_LABELS, callFn, canUseAgents, isCronRequest, rest, Row, seoulToday, TASK_KINDS } from "../_shared/agent.ts";
import { paGroups, paKey, paNorm, PaProd, paPickBest, paVerTok } from "../strategy-agent/def.ts";

const SOURCES = ["returns", "strategy", "ads", "sales"];   // 같은 일이 여럿이면 앞 담당(원래 제안자)의 문장을 쓴다 — 요약은 옮겨 적은 것이라 마지막
const AUTO_KINDS = new Set(["광고 착수", "광고 줄이기", "상세 보강"]);
const sq = (s: unknown) => String(s ?? "").normalize("NFC").replace(/\s+/g, "");
const CEO_RE = /\s*[(,·]?\s*(?:예산은\s*)?대표\s*(?:확인|승인|결정)\s*(?:후|필요)?\s*\)?/g;
const cleanTitle = (t: unknown) => {
  let s = String(t ?? "").replace(/\(\s*(?:예산은\s*)?대표\s*(?:확인|승인|결정)\s*(?:후|필요)?\s*,\s*/g, "(").replace(CEO_RE, "").replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim();
  if ((s.match(/\(/g) ?? []).length > (s.match(/\)/g) ?? []).length) s += ")";   // '(할인 11/7 종료 전, 대표 확인 후)'에서 뒷부분만 빠진 경우
  return s;
};
function guessKind(t: string): string {   // 옛 보고서(종류 칸이 없던 때)용
  if (/금지|유지$|보류 유지|보류$|하지 않/.test(t) && !/착수|켜기|보강|점검/.test(t)) return "지킬 원칙";
  if (/광고|소재|test|테스트/.test(t) && /착수|켜기|다시 켜|시작|첫 소재/.test(t)) return "광고 착수";
  if (/메인|기획전|배치|진열/.test(t)) return "노출·기획전";
  if (/상세|실측|사이즈 안내|기장|사진|컷/.test(t)) return "상세 보강";
  if (/증액|예산.*(이동|늘|배)|확대/.test(t)) return "광고 증액";
  if (/광고|소재|test/.test(t) && /끄|줄이|정리|중단/.test(t)) return "광고 줄이기";
  if (/노출/.test(t)) return "노출·기획전";
  if (/출고|배송|포장|라벨|오배송|CS|문의/.test(t)) return "CS·출고";
  if (/재고|재입고|소싱|입고|발주/.test(t)) return "재고·소싱";
  if (/할인|가격|쿠폰|1\+1|혜택/.test(t)) return "가격·혜택";
  return "기타";
}
const DONE_WHEN: Record<string, string> = { "광고 착수": "그 상품 ON 광고가 늘면 자동 완료", "광고 줄이기": "그 상품 ON 광고가 줄면 자동 완료", "상세 보강": "상세 이미지가 바뀌면 자동 완료" };

type Item = { key: string; kind: string; title: string; owner: string; why: string; done_when: string; due: string; needs_ceo: boolean; product_no: number | null; product_name: string | null; sources: Row[]; first_seen: string; last_seen: string };

async function latestReports(): Promise<Row[]> {
  const r = await rest(`agent_reports?agent=in.(${SOURCES.join(",")})&status=eq.ok&report_date=gte.${addDays(seoulToday(), -5)}&select=id,agent,report_date,report,data,created_at&order=report_date.desc,created_at.desc&limit=40`);
  const rows: Row[] = r.ok ? await r.json() : [];
  const seen = new Set<string>(), out: Row[] = [];
  for (const row of rows) if (!seen.has(String(row.agent))) { seen.add(String(row.agent)); out.push(row); }
  return out.sort((a, b) => SOURCES.indexOf(String(a.agent)) - SOURCES.indexOf(String(b.agent)));
}

function collectItems(reports: Row[]): Map<string, Item> {
  const items = new Map<string, Item>();
  for (const rep of reports) {
    const agent = String(rep.agent), label = AGENT_LABELS[agent], D = String(rep.report_date);
    for (const a of ((((rep.report ?? {}) as Row).week_actions ?? []) as Row[])) {
      const refs0 = ((a.product_refs ?? []) as Row[]);
      const refs = refs0.length ? refs0 : ((a.products ?? []) as string[]).map((n) => ({ name: n, no: null }));
      // 요약 담당이 동료 할 일을 옮겨 적은 것(상품 없음)은 원래 담당 것으로 충분 — 문장만 달라 중복으로 보이므로 뺀다
      if (agent === "sales" && a.source && String(a.source) !== label && !refs.length) continue;
      const rawTitle = String(a.title ?? "");
      const kind = TASK_KINDS.includes(String(a.kind)) ? String(a.kind) : guessKind(rawTitle);
      const title = cleanTitle(rawTitle);
      if (!title) continue;
      const due = /^\d{4}-\d{2}-\d{2}$/.test(String(a.due ?? "")) ? String(a.due) : addDays(/^\d{4}-\d{2}-\d{2}$/.test(String(a.since ?? "")) ? String(a.since) : D, 3);
      const base = {
        kind, title, owner: String(a.owner ?? "대표"), why: String(a.why ?? ""), done_when: String(a.done_when ?? "") || (DONE_WHEN[kind] ?? ""), due,
        needs_ceo: a.needs_ceo === true || /대표\s*(확인|승인|결정)/.test(rawTitle),
        first_seen: /^\d{4}-\d{2}-\d{2}$/.test(String(a.since ?? "")) ? String(a.since) : D, last_seen: D,
      };
      const src = { agent, report_date: D, action_id: String(a.id ?? ""), why: String(a.why ?? "").slice(0, 160) };
      const targets = refs.length ? refs.map((r) => ({ no: Number(r.no) > 0 ? Number(r.no) : null, name: String(r.name ?? "") })) : [{ no: null, name: "" }];
      for (const t of targets) {
        // 상품이 없는 일은 담당자가 날마다 유지하는 할 일 id로 묶는다(문장이 조금 바뀌어도 같은 일 — 대표 승인이 날아가지 않게)
        const key = t.name || t.no ? `${kind}|${t.no ?? "n:" + sq(paKey(t.name))}` : (a.id ? `${kind}|a:${agent}:${String(a.id)}` : `${kind}|t:${sq(title).slice(0, 30)}`);
        const cur = items.get(key);
        if (!cur) { items.set(key, { key, ...base, product_no: t.no, product_name: t.name || null, sources: [src] }); continue; }
        cur.sources.push(src);
        cur.needs_ceo = cur.needs_ceo || base.needs_ceo;
        if (base.due < cur.due) cur.due = base.due;
        if (base.first_seen < cur.first_seen) cur.first_seen = base.first_seen;
        if (base.last_seen > cur.last_seen) cur.last_seen = base.last_seen;
      }
    }
  }
  return items;
}

// ── 자동 완료 판정 재료 ──
async function adCounter(reports: Row[], extra: { no: number; name: string }[]) {
  const act = await callFn("meta-ads", { action: "activeads" }).catch(() => null);
  const ads = ((act as Row | null)?.ads ?? null) as Row[] | null;
  if (!ads) return null;
  const adsRep = reports.find((r) => r.agent === "ads");
  const list = ((((adsRep?.data ?? {}) as Row).products ?? []) as Row[]).map((p) => ({ no: Number(p.product_no), name: String(p.name ?? ""), qty: Number(p.qty_14d ?? 0) }));
  for (const e of extra) if (!list.some((p) => p.no === e.no)) list.push({ no: e.no, name: e.name, qty: 0 });
  const prods: PaProd[] = list.filter((p) => p.no > 0 && p.name).map((p) => ({ no: p.no, name: p.name, key: paNorm(paKey(p.name)), ver: paVerTok(p.name) ? paNorm(paVerTok(p.name)!) : null, qty: p.qty })).filter((p) => p.key.length >= 3);
  const groups = paGroups(prods);
  const count = new Map<number, number>();
  for (const a of ads) { const best = paPickBest(paNorm(String(a.ad_name ?? "")), prods, groups); if (best) count.set(best.no, (count.get(best.no) ?? 0) + 1); }
  return (no: number) => count.get(no) ?? 0;
}
const descHash = async (no: number): Promise<string | null> => {
  const pd = await callFn("cafe24-analytics", { action: "productdesc", product_no: String(no) }).catch(() => null);
  return pd && (pd as Row).desc_hash ? String((pd as Row).desc_hash) : null;
};

async function sync(auto: boolean) {
  const reports = await latestReports();
  if (!reports.length) return { ok: true, note: "최근 보고서 없음" };
  const D = reports.map((r) => String(r.report_date)).sort().pop()!;
  const items = collectItems(reports);
  const lr = await rest(`team_tasks?or=(status.in.(open,held),done_at.gte.${addDays(D, -7)}T00:00:00Z)&select=*`);
  const existing: Row[] = lr.ok ? await lr.json() : [];
  const live = new Map(existing.filter((t) => ["open", "held"].includes(String(t.status))).map((t) => [String(t.task_key), t]));
  const recentDone = new Set(existing.filter((t) => t.status === "done").map((t) => String(t.task_key)));
  const now = new Date().toISOString();
  const stat = { inserted: 0, updated: 0, dropped: 0, reopened: 0, auto_done: 0, detail_runs: [] as Row[] };
  for (const it of items.values()) {
    const cur = live.get(it.key);
    if (cur) {
      const old = (cur.sources ?? []) as Row[];
      const merged = [...it.sources, ...old.filter((o) => !it.sources.some((n) => n.agent === o.agent && n.action_id === o.action_id))].slice(0, 10);
      const patch: Row = { last_seen: it.last_seen > String(cur.last_seen) ? it.last_seen : cur.last_seen, sources: merged, why: it.why || cur.why, done_when: it.done_when || cur.done_when, updated_at: now };
      if (!cur.decision) patch.needs_ceo = it.needs_ceo || !!cur.needs_ceo;
      await rest(`team_tasks?id=eq.${cur.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      stat.updated++;
      continue;
    }
    if (recentDone.has(it.key)) continue;   // 최근 7일 안에 끝난 일 — 에이전트가 하루 늦게 빼는 경우가 있어 다시 열지 않는다
    if (it.last_seen < addDays(D, -1)) continue;   // 오래된 보고서에만 있는 일은 새로 만들지 않음
    const ins = await rest("team_tasks", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
      task_key: it.key, kind: it.kind, title: it.title, product_no: it.product_no, product_name: it.product_name, owner: it.owner, why: it.why, done_when: it.done_when,
      due: it.due, needs_ceo: it.needs_ceo, sources: it.sources, first_seen: it.first_seen, last_seen: it.last_seen,
    }) });
    if (ins.ok) stat.inserted++;   // 동시에 두 번 돌면 같은 키는 고유 색인이 막는다(409) — 무시
  }
  // 담당자들의 최신 보고서 어디에도 없는 진행 중 일 → dropped(에이전트가 뺐음 — 끝났다고 봤거나 의미가 없어짐. 아직 안 온 오늘 보고서는 어제 것이 대신하므로 안전)
  // 보류 7일이 지난 일: 아직 제안되면 결정함으로 다시, 아니면 내림
  const lr2 = await rest(`team_tasks?status=in.(open,held)&select=*`);
  const tasks: Row[] = lr2.ok ? await lr2.json() : [];
  const drop = async (t: Row) => { await rest(`team_tasks?id=eq.${t.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "dropped", updated_at: now }) }); stat.dropped++; t.status = "dropped"; };
  for (const t of tasks) {
    const proposed = items.has(String(t.task_key));
    if (t.status === "open" && !proposed) { await drop(t); continue; }
    if (t.status === "held" && String(t.decided_at ?? "") < addDays(D, -6)) {
      if (!proposed) { await drop(t); continue; }
      await rest(`team_tasks?id=eq.${t.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "open", decision: null, decision_note: `지난 보류(${String(t.decided_at).slice(5, 10)}): ${t.decision_note ?? ""}`.slice(0, 200), decided_at: null, decided_by: null, updated_at: now }) });
      stat.reopened++; t.status = "open"; t.decision = null;
    }
  }
  // 자동 완료 판정
  const checks = tasks.filter((t) => t.status === "open" && AUTO_KINDS.has(String(t.kind)) && Number(t.product_no) > 0);
  const adTasks = checks.filter((t) => String(t.kind).startsWith("광고"));
  const adCount = adTasks.length ? await adCounter(reports, adTasks.map((t) => ({ no: Number(t.product_no), name: String(t.product_name ?? "") }))) : null;
  for (const t of checks) {
    const bl = (t.baseline ?? {}) as Row, no = Number(t.product_no);
    let evidence: string | null = null; const nb: Row = { ...bl };
    if (String(t.kind).startsWith("광고") && adCount) {
      const n = adCount(no);
      if (bl.active_ads == null) nb.active_ads = n;
      else if (t.kind === "광고 착수" && n > Number(bl.active_ads)) evidence = `ON 광고 ${bl.active_ads}개 → ${n}개`;
      else if (t.kind === "광고 줄이기" && n < Number(bl.active_ads)) evidence = `ON 광고 ${bl.active_ads}개 → ${n}개`;
      nb.active_ads_now = n;
    }
    if (t.kind === "상세 보강") {
      const h = await descHash(no);
      if (h) { if (!bl.desc_hash) nb.desc_hash = h; else if (h !== bl.desc_hash) evidence = "상세 이미지가 바뀜"; }
    }
    const body: Row = { baseline: nb, updated_at: now };
    if (evidence) Object.assign(body, { status: "done", done_how: "auto", done_at: now, done_by: "자동 확인", done_evidence: evidence });
    await rest(`team_tasks?id=eq.${t.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
    if (evidence) stat.auto_done++;
  }
  // 상세 점검 자동 실행 (아침 cron만)
  if (auto) stat.detail_runs = await autoDetail(D);
  return { ok: true, report_date: D, reports: reports.map((r) => `${r.agent} ${r.report_date}`), items: items.size, ...stat };
}

async function autoDetail(D: string): Promise<Row[]> {
  const since = new Date(Date.now() - 86400000).toISOString();
  const credit = await rest(`detail_reviews?error=ilike.*credit*&updated_at=gte.${since}&select=id&limit=1`);
  if (credit.ok && ((await credit.json()) as unknown[]).length) return [{ skipped: "API 크레딧 부족(최근 24시간 실패) — 충전 후 다시" }];
  const today = await rest(`detail_reviews?created_at=gte.${addDays(seoulToday(), 0)}T00:00:00%2B09:00&reason=like.*동료 요청*&select=id`);
  const doneToday = today.ok ? ((await today.json()) as unknown[]).length : 0;
  if (doneToday >= 2) return [{ skipped: "오늘 자동 점검 2개 다 함" }];
  const r = await rest(`agent_reports?agent=in.(sales,returns,strategy,ads)&status=eq.ok&report_date=gte.${addDays(D, -6)}&select=agent,report_date,report&order=created_at.desc&limit=40`);
  const rows: Row[] = r.ok ? await r.json() : [];
  const days = new Map<number, { name: string; dates: Set<string> }>();
  for (const row of rows) for (const h of ((((row.report ?? {}) as Row).handoffs ?? []) as Row[])) {
    if (String(h.to) !== AGENT_LABELS.detail || !(Number(h.product_no) > 0)) continue;
    const no = Number(h.product_no), e = days.get(no) ?? { name: String(h.product ?? ""), dates: new Set<string>() };
    e.dates.add(String(row.report_date)); days.set(no, e);
  }
  const cands = [...days.entries()].filter(([, e]) => e.dates.size >= 2).sort((a, b) => b[1].dates.size - a[1].dates.size);
  const out: Row[] = [];
  for (const [no, e] of cands) {
    if (out.length + doneToday >= 2) break;
    const rec = await rest(`detail_reviews?product_no=eq.${no}&created_at=gte.${addDays(D, -14)}T00:00:00Z&status=in.(ok,reading,judging)&select=id&limit=1`);
    if (rec.ok && ((await rec.json()) as unknown[]).length) continue;
    const reason = `동료 요청 ${e.dates.size}번(팀 할 일 자동 점검)`;
    const d = await rest("rpc/agent_call", { method: "POST", body: JSON.stringify({ p_fn: "detail-agent", p_qs: `action=run&product_no=${no}&reason=${encodeURIComponent(reason)}` }) });
    out.push({ product_no: no, name: e.name, requests: e.dates.size, dispatched: d.ok });
  }
  return out;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req); if (opt) return opt;
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "list";
  const viaCron = isCronRequest(req);
  const me = viaCron ? null : await verifyAuthToken(req);
  if (!viaCron && !(await canUseAgents(me))) return json({ error: "접근 권한이 없습니다" }, 403);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) as Row : {};
  try {
    if (action === "sync") {
      if (!viaCron && me?.role !== "admin") return json({ error: "관리자만" }, 403);
      return json(await sync(url.searchParams.get("auto") === "1"));
    }
    if (action === "list") {
      const D = seoulToday();
      const r = await rest(`team_tasks?or=(status.in.(open,held),done_at.gte.${addDays(D, -7)}T00:00:00Z,and(status.eq.dropped,updated_at.gte.${addDays(D, -3)}T00:00:00Z))&select=*&order=due.asc,first_seen.asc&limit=300`);
      if (!r.ok) return json({ error: `불러오기 실패 ${r.status}` }, 500);
      return json({ tasks: await r.json(), today: D, me: { name: me?.name, admin: me?.role === "admin" } });
    }
    const id = String(body.id ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "id 필요" }, 400);
    const now = new Date().toISOString();
    // 상태 전환은 PATCH 조건으로 강제(보안 검토 2026-11-07): 화면을 거치지 않고 직접 불러도 대표 승인 전·보류된 일을 완료하거나 되살릴 수 없게
    const patch = async (b: Row, cond = "") => {
      const r = await rest(`team_tasks?id=eq.${id}${cond}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...b, updated_at: now }) });
      const rows = r.ok ? await r.json() as Row[] : [];
      return rows.length ? json({ ok: true, task: rows[0] }) : json({ error: "지금 상태에서는 바꿀 수 없어요(대표 승인 전이거나 이미 바뀐 할 일) — 새로고침해 주세요" }, 409);
    };
    if (action === "done") {
      if (body.undo) return await patch({ status: "open", done_how: null, done_by: null, done_at: null, done_evidence: null }, "&status=eq.done");
      return await patch({ status: "done", done_how: "manual", done_by: String(me?.name ?? ""), done_at: now, done_evidence: null },
        "&status=eq.open&or=(needs_ceo.eq.false,decision.eq.approve)");
    }
    if (action === "decide") {
      if (me?.role !== "admin") return json({ error: "대표(관리자)만 결정할 수 있어요" }, 403);
      const d = String(body.decision ?? "");
      if (d === "undo") return await patch({ status: "open", decision: null, decision_note: null, decided_by: null, decided_at: null });
      if (!["approve", "hold"].includes(d)) return json({ error: "decision은 approve·hold·undo" }, 400);
      return await patch({ decision: d, decision_note: String(body.note ?? "").slice(0, 200) || null, decided_by: String(me?.name ?? ""), decided_at: now, status: d === "hold" ? "held" : "open" });
    }
    return json({ error: "알 수 없는 action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});

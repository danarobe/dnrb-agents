// ═══════════════════════════════════════════════
// 광고 운영 담당 (에이전트 6호, 2026-10-27) — 공통 뼈대는 ../_shared/agent.ts
//   매일 09:20 KST (pg_cron `ads-agent-morning`) 또는 앱의 [지금 실행]. 상품 전략(08:30)·친구 대시보드의 어제 광고 보고서(09:00) 뒤.
//   사용자 요구(2026-10-27): "광고를 운영하는 사람이 어떤 상품은 광고에 더 힘을 주고, 어떤 상품은 광고비 증액을 보류하고,
//     어떤 상품은 꺼졌던 광고를 켜야 하는지 판단에 도움" + "친구가 만든 광고소재 대시보드의 '어제 광고 보고서'를 그대로 끌어와서 위 내용만 추가".
//   재료: ① 친구 광고 대시보드(ad-dashboard, 친구 Supabase)의 daily_briefs — 우리 auth `sso_agent`로 대표 계정(admin)의 ad-dashboard 전용 토큰을 받아
//        친구 함수 client-log state_get을 읽는다(친구 비밀키 공유 없음, 친구 서버가 우리 verify로 확인). 친구 맥이 9시에 꺼져 있으면 그날 보고서가 없다 → 가장 최근 것 + stale 표시.
//        ② 오늘 상품 전략 보고서(결론 칩·급증 TOP10·집중 상품·4분면·코디) ③ 오늘 취소·반품 보고서의 위험 상품 ④ Meta ON 광고(activeads)·꺼진 광고(pausedads) + 상품별 7일·14일 성과(adcards).
//   출력: decisions[{product, kind(힘주기/증액 보류/다시 켜기/줄이기/유지), reason}] — 제안만. 예산·ON/OFF는 사람이 바꾼다.
// ═══════════════════════════════════════════════
import { addDays, callFn, findByName, dow, num, reportSchema, rest, Row, safeCollector, AgentDef, SB_URL } from "../_shared/agent.ts";
import { paKey, paVerTok, paNorm, paGroups, paPickBest, PaProd } from "../strategy-agent/def.ts";

const AGENT = "ads";
const AD_DASH_FN = Deno.env.get("AD_DASH_FN_URL") ?? "https://pydxcqfztjogmztvayux.supabase.co/functions/v1";   // 친구 광고 대시보드 함수 주소(공개 저장소 config 기준)
const KINDS = ["힘주기", "증액 보류", "다시 켜기", "줄이기", "유지"];
const MAX_PRODUCTS = 30;

type Perf = { spend: number; purchases: number; value: number; roas: number | null; ads: number };
const emptyPerf = (): Perf => ({ spend: 0, purchases: 0, value: 0, roas: null, ads: 0 });

// 친구 대시보드의 어제 광고 보고서 — 우리 auth(sso_agent) → 친구 client-log(state_get daily_briefs)
async function friendBrief(D: string, safe: <T>(l: string, f: () => Promise<T>) => Promise<T | null>) {
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "", secret = Deno.env.get("AGENT_SECRET") ?? "";
  const tok = await safe("친구 대시보드 토큰(auth sso_agent)", async () => {
    const r = await fetch(`${SB_URL}/functions/v1/auth`, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${anon}`, "x-agent-secret": secret }, body: JSON.stringify({ action: "sso_agent", aud: "ad-dashboard" }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new Error(String(j.error ?? r.status));
    return String(j.token);
  });
  if (!tok) return null;
  const j = await safe("어제 광고 보고서(친구 대시보드 daily_briefs)", async () => {
    const r = await fetch(`${AD_DASH_FN}/client-log?action=state_get&key=daily_briefs`, { headers: { "x-dnrb-token": tok }, signal: AbortSignal.timeout(20000) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || b.error) throw new Error(String(b.error ?? `HTTP ${r.status}`));
    return b as Row;
  });
  if (!j) return null;
  const items = (((j.data ?? {}) as Row).items ?? {}) as Record<string, Row>;
  const dates = Object.keys(items).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!dates.length) return { date: null, stale: true, brief: null, latest: null, note: "친구 대시보드에 저장된 보고서가 아직 없음" };
  const pick = items[D] ? D : (dates.filter((d) => d < D).pop() ?? dates[dates.length - 1]);
  return { date: pick, stale: pick !== D, brief: items[pick], latest: dates[dates.length - 1], note: pick !== D ? `${D} 보고서가 아직 없어 ${pick} 보고서를 보여줌(친구 맥이 9시에 꺼져 있었거나 아직 생성 전)` : "" };
}

async function latestReport(agent: string, D: string): Promise<{ report: Row; data: Row; created_at: string } | null> {
  const r = await rest(`agent_reports?agent=eq.${agent}&report_date=eq.${D}&status=eq.ok&select=report,data,created_at&order=created_at.desc&limit=1`);
  const rows = r.ok ? ((await r.json()) as Row[]) : [];
  return rows[0] ? { report: (rows[0].report ?? {}) as Row, data: (rows[0].data ?? {}) as Row, created_at: String(rows[0].created_at) } : null;
}

async function collect(D: string) {
  const { errors, safe } = safeCollector();
  const cur7: [string, string] = [addDays(D, -6), D], cur14: [string, string] = [addDays(D, -13), D], cur30: [string, string] = [addDays(D, -29), D];

  const [fb, st, rt, active, paused, kY, kY2, k7] = await Promise.all([
    friendBrief(D, safe),
    safe("오늘 상품 전략 보고서", () => latestReport("strategy", D)),
    safe("오늘 취소·반품 보고서", () => latestReport("returns", D)),
    safe("Meta ON 광고", () => callFn("meta-ads", { action: "activeads" })),
    safe("Meta 꺼진 광고", () => callFn("meta-ads", { action: "pausedads" })),
    safe("Meta 어제 합계", () => callFn("meta-ads", { action: "summary", start_date: D, end_date: D })),
    safe("Meta 그제 합계", () => callFn("meta-ads", { action: "summary", start_date: addDays(D, -1), end_date: addDays(D, -1) })),
    safe("Meta 7일 합계", () => callFn("meta-ads", { action: "summary", start_date: addDays(D, -7), end_date: addDays(D, -1) })),
  ]);
  const adsKnown = !!active, pausedKnown = !!paused;
  const sr = (st?.report ?? {}) as Row, sd = (st?.data ?? {}) as Row;
  const rr = (rt?.report ?? {}) as Row, rd = (rt?.data ?? {}) as Row;

  // ── 상품 사전(전략 담당 데이터) ──
  const P = new Map<number, Row>();   // product_no → 합쳐진 상품 정보
  const put = (no: unknown, patch: Row) => { const n = Number(no); if (!n) return; P.set(n, { ...(P.get(n) ?? { product_no: n, src: [] as string[] }), ...patch }); };
  const tag = (no: unknown, t: string) => { const n = Number(no); const p = P.get(n); if (p) { const s = p.src as string[]; if (!s.includes(t)) s.push(t); } };
  const matrixAll = ((((sd.new_arrivals ?? {}) as Row).matrix ?? []) as Row[]);
  for (const m of matrixAll) put(m.product_no, { name: m.name, category: m.category, views_14d: num(m.views_14d), qty_14d: num(m.qty_14d), rate_14d: m.rate_14d ?? null, margin_rate: m.margin_rate ?? null, promos: m.promos ?? [], quadrant: m.quadrant, codi: m.codi ?? null, is_new: true, sold_out: !!m.sold_out });
  for (const t of ((sd.top10 ?? []) as Row[])) { put(t.product_no, { name: t.name, qty_14d: num(t.qty_14d), rate_14d: t.rate_14d ?? null, rank14: t.rank }); }
  for (const s of ((sd.surge_top10 ?? []) as Row[])) put(s.product_no, { name: s.name, category: s.category, surge: { rank: s.rank, qty_7d: s.qty_7d, qty_prev7d: s.qty_prev7d, change_pct: s.change_pct ?? null, rate_7d: s.rate_7d ?? null }, codi: s.codi ?? (P.get(Number(s.product_no))?.codi ?? null) });
  for (const f of ((sd.focus ?? []) as Row[])) put(f.product_no, { name: f.name, category: f.category, views_14d: num(f.views_14d), qty_14d: num(f.qty_14d), rate_14d: f.rate_14d ?? null, margin_rate: f.margin_rate ?? null, promos: f.promos ?? [], codi: f.codi ?? null, focus_why: f.why ?? "", sold_out: !!f.sold_out });
  const strategyMatrix = ((sr.matrix ?? []) as Row[]);
  for (const m of strategyMatrix) { const p = findByName([...P.values()], m.name); if (p) put(p.product_no, { strategy_line: m.strategy }); }
  for (const f of ((sr.focus ?? []) as Row[])) { const p = findByName([...P.values()], f.name); if (p) put(p.product_no, { focus_status: f.status ?? f.plan ?? "", focus_grow: (f.grow ?? []) as string[] }); }
  for (const v of ((sr.verdicts ?? []) as Row[])) { const no = v.product_no ?? findByName([...P.values()], v.product)?.product_no; if (no) put(no, { verdict: v.kind, verdict_reason: v.reason }); }
  // 반품 위험(오늘 반품 보고서)
  const riskRows = ((rr.risk_products ?? []) as Row[]);
  const riskData = (((rd.top_sellers_return ?? {}) as Row).risk_products ?? []) as Row[];
  for (const rk of riskRows) {
    const src = findByName(riskData, rk.name);
    const no = Number(src?.product_no ?? 0) || Number(findByName([...P.values()], rk.name)?.product_no ?? 0);
    if (!no) { const n = -Math.abs(Math.round(Math.random() * 1e9)); put(n, { name: rk.name, no_match: true }); put(n, { returns: { level: rk.level, rate_14d: rk.rate_14d ?? src?.rate_14d ?? null, delivered_14d: rk.delivered_14d ?? src?.delivered_14d ?? null, cause: rk.cause ?? "" } }); continue; }
    put(no, { name: P.get(no)?.name ?? rk.name, returns: { level: rk.level, rate_14d: rk.rate_14d ?? src?.rate_14d ?? null, delivered_14d: rk.delivered_14d ?? src?.delivered_14d ?? null, cause: rk.cause ?? "" } });
  }
  // 후보 = 결론 칩 + 급증 + 집중 + TOP10 + 4분면(판매 확대·노출 부족·상세·가격 점검) + 반품 위험·주의
  for (const p of P.values()) {
    if (p.verdict) tag(p.product_no, `전략 ${p.verdict}`);
    if (p.surge) tag(p.product_no, "급증");
    if (p.focus_status != null || p.focus_why) tag(p.product_no, "집중");
    if (p.rank14) tag(p.product_no, `TOP10 ${p.rank14}위`);
    const q = String(p.quadrant ?? "");
    if (/^(판매 확대|노출 부족|상세·가격 점검)/.test(q)) tag(p.product_no, q.replace(/\(.*\)$/, ""));
    if (p.returns) tag(p.product_no, `반품 ${String((p.returns as Row).level ?? "")}`);
  }
  const prio = (p: Row) => (p.verdict ? 0 : 0) + (p.verdict ? 100 : 0) + (p.surge ? 50 : 0) + (p.focus_status != null ? 40 : 0) + (p.rank14 ? 30 : 0) + (p.returns ? 25 : 0) + (/^(판매 확대|노출 부족)/.test(String(p.quadrant ?? "")) ? 15 : 0) + (/^상세·가격/.test(String(p.quadrant ?? "")) ? 8 : 0);
  const candidates = [...P.values()].filter((p) => (p.src as string[]).length).sort((a, b) => prio(b) - prio(a)).slice(0, MAX_PRODUCTS);

  // ── 광고 ↔ 상품 매칭 (전략 담당과 같은 pa* 규칙) ──
  const allProds: PaProd[] = [...P.values()].filter((p) => p.name && !p.no_match).map((p) => ({ no: Number(p.product_no), name: String(p.name), key: paNorm(paKey(String(p.name))), ver: paVerTok(String(p.name)) ? paNorm(paVerTok(String(p.name))!) : null, qty: num(p.qty_14d) })).filter((p) => p.key.length >= 3);
  const groups = paGroups(allProds);
  const byProduct = (ads: Row[]) => { const m = new Map<number, Row[]>(); for (const ad of ads) { const best = paPickBest(paNorm(String(ad.ad_name ?? "")), allProds, groups); if (best) (m.get(best.no) ?? m.set(best.no, []).get(best.no)!).push(ad); } return m; };
  const activeBy = byProduct(((active?.ads ?? []) as Row[]));
  const pausedBy = byProduct(((paused?.ads ?? []) as Row[]));
  const candSet = new Set(candidates.map((p) => Number(p.product_no)));
  const activeIds: string[] = [], pausedIds: string[] = [];
  for (const [no, list] of activeBy) if (candSet.has(no)) for (const a of list) activeIds.push(String(a.ad_id));
  for (const [no, list] of pausedBy) if (candSet.has(no)) for (const a of list) pausedIds.push(String(a.ad_id));
  const chunks = (ids: string[]) => { const out: string[][] = []; for (let i = 0; i < ids.length; i += 60) out.push(ids.slice(i, i + 60)); return out; };
  const cards = async (label: string, ids: string[], period: [string, string]) => {
    const parts = await Promise.all(chunks(ids).map((c, i) => safe(`${label}(${i + 1})`, () => callFn("meta-ads", { action: "adcards", ad_ids: c.join(","), start_date: period[0], end_date: period[1] }))));
    const m = new Map<string, Row | null>(); let ok = true;
    for (const part of parts) { if (!part) { ok = false; continue; } for (const a of (((part as Row).ads ?? []) as Row[])) m.set(String(a.ad_id), (a.period ?? null) as Row | null); }
    return { m, ok };
  };
  const [c7, c14, c30p] = await Promise.all([cards("후보 광고 7일 성과", activeIds, cur7), cards("후보 광고 14일 성과", activeIds, cur14), cards("꺼진 광고 30일 성과", pausedIds, cur30)]);
  const sumPerf = (ads: Row[], m: Map<string, Row | null>, ok: boolean): Perf | null => {
    if (!ok) return null;
    const t = emptyPerf(); t.ads = ads.length;
    for (const a of ads) { const p = m.get(String(a.ad_id)); if (!p) continue; t.spend += num(p.spend); t.purchases += num(p.purchases); t.value += num(p.purchase_value); }
    t.spend = Math.round(t.spend); t.roas = t.spend > 0 ? +(t.value / t.spend).toFixed(2) : null; t.value = Math.round(t.value);
    return t;
  };

  // ── 상품별 운영 재료 + 코드 힌트 ──
  const products = candidates.map((p) => {
    const no = Number(p.product_no);
    const act = adsKnown ? (activeBy.get(no) ?? []) : null, pau = pausedKnown ? (pausedBy.get(no) ?? []) : null;
    const perf7 = act ? sumPerf(act, c7.m, c7.ok) : null, perf14 = act ? sumPerf(act, c14.m, c14.ok) : null, pausedPerf = pau ? sumPerf(pau, c30p.m, c30p.ok) : null;
    const ret = (p.returns ?? null) as Row | null, codiShare = (p.codi as Row | null)?.share ?? null;
    // 힌트(코드 규칙) — Claude가 최종 판단하되 이 규칙을 기본값으로 삼는다
    let hint = "유지", why = "";
    const roas7 = perf7?.roas ?? null, spend7 = perf7?.spend ?? 0;
    if (ret && String(ret.level) === "위험") { hint = "증액 보류"; why = `반품 ${ret.rate_14d}%(위험)`; }
    else if (codiShare != null && num(codiShare) >= 40) { hint = "증액 보류"; why = `코디 구매 ${codiShare}% — 부모 상품 따라감`; }
    else if (String(p.verdict ?? "") === "보류" || String(p.verdict ?? "") === "점검") { hint = "증액 보류"; why = `전략 담당 '${p.verdict}' — ${p.verdict_reason ?? ""}`; }
    else if (roas7 != null && roas7 < 1 && spend7 >= 100000) { hint = "줄이기"; why = `7일 ROAS ${roas7} · 광고비 ${Math.round(spend7 / 10000)}만`; }
    else if ((String(p.verdict ?? "") === "밀기" || p.surge || /^(판매 확대|노출 부족)/.test(String(p.quadrant ?? ""))) && act && act.length === 0 && pau && pau.length > 0) { hint = "다시 켜기"; why = `ON 광고 0개, 꺼진 광고 ${pau.length}개${pausedPerf?.roas != null ? ` (30일 ROAS ${pausedPerf.roas})` : ""}`; }
    else if ((String(p.verdict ?? "") === "밀기" || p.surge) && act && act.length === 0) { hint = "힘주기"; why = "광고가 없음 — 광고 착수"; }
    else if (String(p.verdict ?? "") === "밀기" && (roas7 == null || roas7 >= 2)) { hint = "힘주기"; why = `전략 '밀기'${roas7 != null ? ` · 7일 ROAS ${roas7}` : " · 7일 지출 없음(test)"}`; }
    else if (roas7 != null && roas7 >= 3 && spend7 >= 50000 && !(ret && String(ret.level) === "주의")) { hint = "힘주기"; why = `7일 ROAS ${roas7} · 광고비 ${Math.round(spend7 / 10000)}만`; }
    return {
      product_no: no > 0 ? no : null, name: String(p.name ?? ""), category: p.category ?? "", src: p.src, is_new: !!p.is_new, sold_out: !!p.sold_out,
      views_14d: p.views_14d ?? null, qty_14d: p.qty_14d ?? null, rate_14d: p.rate_14d ?? null, margin_rate: p.margin_rate ?? null, promos: p.promos ?? [], quadrant: p.quadrant ?? null,
      surge: p.surge ?? null, rank14: p.rank14 ?? null, codi_share: codiShare, returns: ret,
      strategy: { verdict: p.verdict ?? null, verdict_reason: p.verdict_reason ?? null, matrix_strategy: p.strategy_line ?? null, focus_status: p.focus_status ?? null, focus_grow: p.focus_grow ?? null, focus_why: p.focus_why ?? null },
      active_ads: act ? act.length : null, paused_ads: pau ? pau.length : null,
      ad_7d: perf7, ad_14d: perf14, paused_30d: pausedPerf,
      top_ads_7d: act ? act.map((a) => ({ name: String(a.ad_name ?? ""), ...(c7.m.get(String(a.ad_id)) ? { spend: Math.round(num(c7.m.get(String(a.ad_id))!.spend)), purchases: num(c7.m.get(String(a.ad_id))!.purchases), roas: +num(c7.m.get(String(a.ad_id))!.roas).toFixed(2), frequency: +num(c7.m.get(String(a.ad_id))!.frequency).toFixed(2) } : { spend: 0, purchases: 0, roas: 0, frequency: 0 }) })).sort((a, b) => b.spend - a.spend).slice(0, 3) : [],
      paused_list: pau ? pau.slice(0, 5).map((a) => ({ name: String(a.ad_name ?? ""), status: a.effective_status, updated: a.updated })) : [],
      hint, hint_why: why,
    };
  });

  const kpiOf = (k: Row | null) => k ? { spend: Math.round(num(k.spend)), purchases: num(k.purchases), value: Math.round(num(k.purchase_value)), roas: num(k.spend) > 0 ? +(num(k.purchase_value) / num(k.spend)).toFixed(2) : null } : null;
  const k7v = kpiOf(k7 as Row | null);
  const b = fb?.brief ?? null;
  return {
    base_date: D, base_dow: dow(D), generated_at: new Date().toISOString(),
    periods: { last7: cur7, last14: cur14, paused_window: cur30 },
    friend_brief: fb ? { date: fb.date, stale: fb.stale, latest: fb.latest, note: fb.note, brief: b } : null,
    kpi_own: { yesterday: kpiOf(kY as Row | null), day_before: kpiOf(kY2 as Row | null), avg_7d: k7v ? { spend: Math.round(k7v.spend / 7), purchases: +(k7v.purchases / 7).toFixed(1), value: Math.round(k7v.value / 7), roas: k7v.roas } : null, note: "Meta 광고 계정 합계(우리 수집). 친구 보고서의 KPI와 어트리뷰션 반영 시점 차이로 조금 다를 수 있음" },
    strategy_report: st ? { created_at: st.created_at, headline: sr.headline, verdicts: sr.verdicts ?? [], summary: sr.summary ?? [] } : null,
    returns_report: rt ? { created_at: rt.created_at, headline: rr.headline, risk_count: riskRows.length } : null,
    ads_known: adsKnown, paused_known: pausedKnown,
    counts: { active_total: num(active?.count), paused_total: num(paused?.count), candidates: products.length },
    products,
    rules: {
      kinds: "kind는 5가지만: 힘주기(예산 확대·소재 추가로 더 밀 상품) / 증액 보류(지금 예산 유지, 늘리지 않음 — 반품 위험·코디 구매·주문율 하락·전략 담당 보류·점검) / 다시 켜기(ON 광고 0개인데 꺼진 광고가 있고 팔리는 상품 — 어떤 광고를 켤지 paused_list에서) / 줄이기(7일 ROAS 1 미만이 지출 10만↑으로 이어짐) / 유지",
      perf: "ad_7d·ad_14d = 그 상품 ON 광고 전부의 최근 7일·14일 Meta 합(spend 원, purchases 건, value 원, roas = value/spend, ads = 광고 수). paused_30d = 꺼진 광고의 최근 30일 합. null = 광고 정보 모름(수집 실패·매칭 의심)이니 광고 유무를 단정하지 말 것",
      hint: "hint·hint_why = 코드 규칙의 기본 판단. 근거가 더 있으면 바꿔도 되지만 바꾼 이유를 reason에 쓴다",
      friend: "friend_brief = 친구 광고 대시보드가 9시에 만든 '어제 광고 보고서'(계정 전체 흐름·잘된 소재·지켜볼 소재·할 일). 화면에 그대로 보이므로 그 내용을 다시 쓰지 말고, 상품별 판단의 맥락으로만 쓴다. stale=true면 그날 보고서가 없어 이전 것임",
    },
    errors,
  };
}

function forLLM(data: Row) {
  const fb = (data.friend_brief ?? null) as Row | null;
  const b = (fb?.brief ?? null) as Row | null;
  const brief = b ? { date: fb?.date, stale: fb?.stale, headline: b.headline, kpi: b.kpi, sections: ((b.sections ?? []) as Row[]).map((s) => ({ title: s.title, items: ((s.items ?? []) as unknown[]).slice(0, 6) })) } : (fb ? { note: fb.note } : { note: "친구 대시보드 보고서를 못 받음" });
  const products = ((data.products ?? []) as Row[]).map((p) => ({
    name: p.name, category: p.category || undefined, src: p.src, is_new: p.is_new || undefined, sold_out: p.sold_out || undefined,
    views_14d: p.views_14d, qty_14d: p.qty_14d, rate_14d: p.rate_14d, margin_rate: p.margin_rate, promos: ((p.promos ?? []) as unknown[]).length ? p.promos : undefined,
    surge: p.surge ?? undefined, codi_share: p.codi_share ?? undefined, returns: p.returns ?? undefined,
    strategy: p.strategy, active_ads: p.active_ads, paused_ads: p.paused_ads, ad_7d: p.ad_7d, ad_14d: p.ad_14d, paused_30d: p.paused_30d ?? undefined,
    top_ads_7d: p.top_ads_7d, paused_list: ((p.paused_list ?? []) as unknown[]).length ? p.paused_list : undefined, hint: p.hint, hint_why: p.hint_why,
  }));
  return { base_date: data.base_date, base_dow: data.base_dow, friend_brief: brief, kpi_own: data.kpi_own, strategy_report: data.strategy_report, returns_report: data.returns_report, ads_known: data.ads_known, paused_known: data.paused_known, counts: data.counts, products, rules: data.rules, errors: data.errors };
}

function postProcess(report: Row, data: Row): Row {
  const products = (data.products ?? []) as Row[];
  const seen = new Set<string>();
  const decisions = ((report.decisions ?? []) as Row[]).map((d) => {
    const kind = KINDS.find((k) => String(d.kind ?? "").replace(/\s+/g, "").includes(k.replace(/\s+/g, ""))) ?? "유지";
    const p = findByName(products, String(d.product ?? ""));
    const name = p ? String(p.name) : String(d.product ?? "").trim();
    if (!name || seen.has(name)) return null; seen.add(name);
    return {
      kind, product: name, product_no: p?.product_no ?? null, reason: String(d.reason ?? "").trim(),
      active_ads: p?.active_ads ?? null, paused_ads: p?.paused_ads ?? null, ad_7d: p?.ad_7d ?? null, ad_14d: p?.ad_14d ?? null, paused_30d: p?.paused_30d ?? null,
      returns: p?.returns ?? null, margin_rate: p?.margin_rate ?? null, rate_14d: p?.rate_14d ?? null, qty_14d: p?.qty_14d ?? null, codi_share: p?.codi_share ?? null, promos: p?.promos ?? [],
      strategy_verdict: (p?.strategy as Row | undefined)?.verdict ?? null, hint: p?.hint ?? null,
    };
  }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 12);
  return { ...report, decisions };
}

const SYSTEM = `당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 광고 운영 담당자입니다. 매일 아침 광고를 실제로 운영하는 사람(광고팀)에게 "오늘 어떤 상품의 광고에 힘을 주고, 어떤 상품은 증액을 보류하고, 어떤 상품은 꺼진 광고를 다시 켤지"를 상품 단위로 판단해 줍니다. 예산을 바꾸거나 광고를 켜고 끄는 것은 사람이 합니다 — 당신은 근거 있는 제안만 합니다.

1) 재료
- friend_brief: 친구 광고 대시보드가 9시에 만든 '어제 광고 보고서'(계정 전체 흐름·잘된 소재·지켜볼 소재·할 일). **화면 맨 위에 그대로 보이므로 그 문장을 다시 쓰지 않습니다.** 계정 전체 흐름(광고비·ROAS가 그제·7일 평균 대비 어떤지)을 상품 판단의 배경으로만 씁니다. stale=true면 그날 보고서가 없는 것이니 "어제 광고 보고서는 아직 없음"이라고 summary에 한 번만 적습니다.
- products: 오늘 상품 전략 담당이 고른 상품(결론 칩·급증·집중·TOP10·4분면)과 취소·반품 담당의 위험·주의 상품에, Meta ON 광고 수·꺼진 광고 수·7일/14일 광고비·구매·ROAS·꺼진 광고의 30일 성과·코디 구매 비율·마진·진행 중 이벤트를 붙인 것. strategy.verdict(밀기/보류/점검/시즌/소싱)·focus_status·focus_grow·matrix_strategy는 전략 담당의 판단입니다 — 광고 운영 관점에서 이어받되 광고 숫자로 검증합니다.
- hint·hint_why: 코드가 규칙대로 미리 매긴 기본 판단. 그대로 써도 되고, 더 좋은 근거(소재 피로·구매 0건·반품 사유·이벤트 종료 등)가 있으면 바꾸고 reason에 이유를 씁니다.

2) decisions (상품별 운영 판단, 중요한 순 최대 10개 — 모든 상품을 쓰지 말고 광고팀이 오늘 손댈 것만)
- kind는 5가지만: **힘주기**(예산 확대·소재 추가 — 7일 ROAS 2↑이고 반품 낮고 마진 좋은 상품, 전략 '밀기' 상품, 광고 없는 급증 상품의 광고 착수) / **증액 보류**(지금 예산은 유지, 늘리지 않음 — 반품 위험(반품 담당 기준), 코디 구매 40%↑, 주문율 하락·전략 '점검'·'보류', 이벤트 종료 직전) / **다시 켜기**(ON 광고 0개인데 꺼진 광고가 있고 지금 팔리는 상품 — paused_list 중 30일 성과가 있던 광고 이름을 reason에) / **줄이기**(7일 ROAS 1 미만이 지출 10만 원↑으로 이어지는 상품, 소재 피로(빈도 3↑)로 효율이 꺾인 상품) / **유지**(잘 돌고 있어 손댈 것 없음 — 굳이 넣지 않아도 됨).
- product는 products[].name 그대로. reason은 45자 이내, **숫자 하나 이상**(ROAS·광고비·반품률·코디%·주문율 변화). 한 상품에 판단 하나.
- ad_7d·ad_14d가 null인 상품은 광고 정보를 모르는 것이니 "광고 없음"·"광고 착수"라고 쓰지 말고, 필요하면 "광고 연결 확인 필요"로만.
- 꺼진 광고를 켜자고 할 때는 꺼진 이유를 모르니 "켜기 전 왜 껐는지 확인"을 덧붙입니다. 반품 위험 상품은 아무리 ROAS가 좋아도 힘주기 금지(증액 보류 + 원인 해결 후).

3) 요약·헤드라인
- headline: 오늘 광고 운영의 한 줄 결론(예: "니트 2종 힘주고, 새틴 스커트는 증액 보류 — 계정 ROAS 5.1 유지"). summary는 2줄 이내(계정 흐름 1줄 + 판단 요약 1줄).
- highlights/warnings는 광고 관점의 좋은 신호·나쁜 신호 각 3개 이내(구매 0건 소재, 소재 피로, 광고 없는 급증 상품, 예산 대비 효율 등). actions는 광고팀이 오늘 할 일 3개(예: "○○ 꺼진 광고 2개 켜기(켜기 전 사유 확인)", "○○ 예산 20% 증액 검토(대표 확인 후)").
- 소재 제작이 필요한 상품(소재 피로·소재 1개뿐·광고 없는 급증)은 광고 소재 담당에게 handoff(상품명 그대로, 왜 필요한지 숫자).`;

const SCHEMA = reportSchema({
  lean: true,
  highlights: "광고 관점의 좋은 신호(ROAS 좋은 상품·효율 개선·광고 없이도 팔리는 상품 등). 최대 3개",
  warnings: "광고 관점의 나쁜 신호(구매 0건 소재·소재 피로·반품 위험 상품에 광고 집중·광고 없는 급증 상품 등). 최대 3개",
  actions: "광고팀이 오늘 할 일 3개. 예산 변경은 '대표 확인 후'를 붙인다",
  extra: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          product: { type: "string", description: "products[].name 그대로" },
          kind: { type: "string", description: "다음 중 하나 그대로: 힘주기, 증액 보류, 다시 켜기, 줄이기, 유지" },
          reason: { type: "string", description: "근거 45자 이내, 숫자 하나 이상" },
        },
        required: ["product", "kind", "reason"], additionalProperties: false,
      },
      description: "상품별 광고 운영 판단, 중요한 순 최대 10개",
    },
  },
});

const COLLEAGUE_RULES = `- 상품 전략 담당(오늘)의 결론 칩(verdicts)과 집중 상품 status·grow는 이미 data.products에 합쳐져 있습니다. 전략이 '밀기'라도 광고 숫자(ROAS·구매 0건·소재 피로)가 반대면 광고 관점의 판단을 쓰고 colleague_notes에 "전략 밀기 → 광고 ROAS 0.8이라 증액 보류"처럼 적습니다.
- 취소·반품 감시 담당(오늘)의 위험 상품은 힘주기 금지. 주의 상품은 소폭만.
- 소재가 필요한 상품은 광고 소재 담당에게 handoff. 상세 문제(주문율 하락)는 상세페이지 점검 담당에게 handoff.`;

export const DEF: AgentDef = { agent: AGENT, label: "광고 운영 담당", system: SYSTEM, schema: SCHEMA, collect, forLLM, postProcess, effort: "low", colleagueRules: COLLEAGUE_RULES, notify: "warn" };

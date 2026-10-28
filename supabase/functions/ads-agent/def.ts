// ═══════════════════════════════════════════════
// 광고 운영 담당 (에이전트 6호, 2026-10-27 신설 → 2026-10-28 자체 발행으로 개편) — 공통 뼈대는 ../_shared/agent.ts
//   매일 09:20 KST (pg_cron `ads-agent-morning`) 또는 앱의 [지금 실행]. 상품 전략(08:30) 뒤.
//   사용자 요구(2026-10-28): 친구 대시보드의 '어제 광고 보고서'는 친구 맥이 꺼지면 안 나오니 **우리가 직접 Meta·카페24에서 모아 발행**한다.
//     맨 위 요약 카드 7개(지출·매출(전환값)·카페24 매출·ROAS·구매·CPA·CPC)는 친구 것과 같은 구성으로 유지하고, 그 아래는
//     1) 전체 흐름(최근 14일 광고비·메타 ROAS·카페24 ROAS·자연 매출 비율 꺾은선 + 판매/광고비 소진/전환 상위 5)
//     2) 신규 테스트(테스트 3일차까지, 상품별로 묶어 분석) 3) 치고 올라오는 소재 4) 하락하는 소재(주축 소재가 꺾일 때)
//     5) 주의할 상품·소재(잘 팔리고 효율 좋은데 취소·순반품률 높은 것 등) 6) 상품별 광고 운영 판단(힘주기/증액 보류/다시 켜기/줄이기/유지).
//   재료: meta-ads `addaily`(소재별 일별 14일) · `activeads`·`pausedads` · `adcards`(꺼진 광고 30일) / cafe24-analytics `revenue_daily`·`summary`(어제 상품별) /
//        오늘 전략 보고서(결론 칩·급증·집중·4분면·코디) · 오늘 반품 보고서(위험 상품·Best30 취소율·순반품률 TOP5).
//   코드가 숫자·후보를 다 만들고(테스트 묶음·급상승·하락·주의·힌트) Claude는 해석 한 줄씩만 쓴다. 예산·ON/OFF는 사람이 바꾼다.
// ═══════════════════════════════════════════════
import { addDays, callFn, findByName, dow, num, reportSchema, rest, Row, safeCollector, AgentDef } from "../_shared/agent.ts";
import { paKey, paVerTok, paNorm, paGroups, paPickBest, PaProd } from "../strategy-agent/def.ts";

const AGENT = "ads";
const KINDS = ["힘주기", "증액 보류", "다시 켜기", "줄이기", "유지"];
const MAX_PRODUCTS = 30;
const TEST_RE = /test|테스트/i;
const isTestAd = (a: { name: string; adset: string; campaign: string }) => TEST_RE.test(a.adset) || TEST_RE.test(a.name) || /테스트/.test(a.campaign);

type Perf = { spend: number; purchases: number; value: number; roas: number | null; ads: number };
const r2 = (v: number) => Math.round(v * 100) / 100;
const roasOf = (spend: number, value: number) => spend > 0 ? r2(value / spend) : null;
const perfOf = (rows: { spend: number; purchases: number; value: number }[], ads: number): Perf => { let sp = 0, pu = 0, v = 0; for (const r of rows) { sp += r.spend; pu += r.purchases; v += r.value; } return { spend: Math.round(sp), purchases: pu, value: Math.round(v), roas: roasOf(sp, v), ads }; };

async function latestReport(agent: string, D: string): Promise<{ report: Row; data: Row; created_at: string } | null> {
  const r = await rest(`agent_reports?agent=eq.${agent}&report_date=eq.${D}&status=eq.ok&select=report,data,created_at&order=created_at.desc&limit=1`);
  const rows = r.ok ? ((await r.json()) as Row[]) : [];
  return rows[0] ? { report: (rows[0].report ?? {}) as Row, data: (rows[0].data ?? {}) as Row, created_at: String(rows[0].created_at) } : null;
}

type DayRow = { date: string; spend: number; impressions: number; clicks: number; frequency: number; purchases: number; value: number };
type AdAgg = { ad_id: string; name: string; adset: string; adset_id: string; campaign: string; days: Map<string, DayRow>; test: boolean };

async function collect(D: string) {
  const { errors, safe } = safeCollector();
  const days14: string[] = []; for (let i = 13; i >= 0; i--) days14.push(addDays(D, -i));
  const Y2 = addDays(D, -1), w7: [string, string] = [addDays(D, -7), Y2], cur7: [string, string] = [addDays(D, -6), D], cur14: [string, string] = [days14[0], D], cur30: [string, string] = [addDays(D, -29), D];

  const [daily, rev, s1, st, rt, active, paused] = await Promise.all([
    safe("Meta 소재 일별 성과(14일)", () => callFn("meta-ads", { action: "addaily", start_date: cur14[0], end_date: cur14[1] })),
    safe("카페24 일별 매출(14일)", () => callFn("cafe24-analytics", { action: "revenue_daily", start_date: cur14[0], end_date: cur14[1] })),
    safe("카페24 어제 상품별 판매", () => callFn("cafe24-analytics", { action: "summary", start_date: D, end_date: D })),
    safe("오늘 상품 전략 보고서", () => latestReport("strategy", D)),
    safe("오늘 취소·반품 보고서", () => latestReport("returns", D)),
    safe("Meta ON 광고", () => callFn("meta-ads", { action: "activeads" })),
    safe("Meta 꺼진 광고", () => callFn("meta-ads", { action: "pausedads" })),
  ]);
  const metaKnown = !!daily, adsKnown = !!active, pausedKnown = !!paused;
  const sr = (st?.report ?? {}) as Row, sd = (st?.data ?? {}) as Row;
  const rr = (rt?.report ?? {}) as Row, rd = (rt?.data ?? {}) as Row;

  // ── 소재별·일별 집계 ──
  const ads = new Map<string, AdAgg>();
  const dayTot = new Map<string, DayRow>();
  for (const d of days14) dayTot.set(d, { date: d, spend: 0, impressions: 0, clicks: 0, frequency: 0, purchases: 0, value: 0 });
  for (const it of (((daily as Row | null)?.items ?? []) as Row[])) {
    const row: DayRow = { date: String(it.date), spend: num(it.spend), impressions: num(it.impressions), clicks: num(it.clicks), frequency: num(it.frequency), purchases: num(it.purchases), value: num(it.purchase_value) };
    const id = String(it.ad_id);
    let a = ads.get(id);
    if (!a) { a = { ad_id: id, name: String(it.ad_name ?? ""), adset: String(it.adset_name ?? ""), adset_id: String(it.adset_id ?? ""), campaign: String(it.campaign_name ?? ""), days: new Map(), test: false }; a.test = isTestAd(a); ads.set(id, a); }
    a.days.set(row.date, row);
    const t = dayTot.get(row.date); if (t) { t.spend += row.spend; t.impressions += row.impressions; t.clicks += row.clicks; t.purchases += row.purchases; t.value += row.value; }
  }
  const revByDay = new Map<string, { revenue: number; order_count: number }>();
  for (const r of (((rev as Row | null)?.days ?? []) as Row[])) revByDay.set(String(r.date), { revenue: num(r.revenue), order_count: num(r.order_count) });
  const sum = (dates: string[]) => { const t = { spend: 0, clicks: 0, purchases: 0, value: 0, revenue: 0, orders: 0, n: 0 }; for (const d of dates) { const x = dayTot.get(d); if (x) { t.spend += x.spend; t.clicks += x.clicks; t.purchases += x.purchases; t.value += x.value; } const rv = revByDay.get(d); if (rv) { t.revenue += rv.revenue; t.orders += rv.order_count; } t.n++; } return t; };
  const kpiOf = (dates: string[], avg = false) => { const t = sum(dates); const k = avg && t.n ? t.n : 1; return { spend: Math.round(t.spend / k), value: Math.round(t.value / k), purchases: r2(t.purchases / k), clicks: Math.round(t.clicks / k), roas: roasOf(t.spend, t.value), cpa: t.purchases > 0 ? Math.round(t.spend / t.purchases) : null, cpc: t.clicks > 0 ? Math.round(t.spend / t.clicks) : null, cafe24: Math.round(t.revenue / k), cafe24_orders: Math.round(t.orders / k), cafe24_roas: roasOf(t.spend, t.revenue) }; };
  const kpi = metaKnown ? { yesterday: kpiOf([D]), day_before: kpiOf([Y2]), avg_7d: kpiOf(days14.slice(6, 13), true), cafe24_known: !!rev } : null;
  // 전체 흐름(14일)
  const flow = days14.map((d) => { const x = dayTot.get(d)!, rv = revByDay.get(d); const revenue = rv ? rv.revenue : null; return { date: d, spend: Math.round(x.spend), purchases: x.purchases, value: Math.round(x.value), meta_roas: roasOf(x.spend, x.value), cafe24_revenue: revenue != null ? Math.round(revenue) : null, cafe24_roas: revenue != null ? roasOf(x.spend, revenue) : null, organic_share: revenue != null && revenue > 0 ? Math.max(0, Math.round((revenue - x.value) / revenue * 100)) : null }; });

  // ── 상품 사전 + 광고 ↔ 상품 매칭 (전략 담당과 같은 pa* 규칙) ──
  const P = new Map<number, Row>();
  const put = (no: unknown, patch: Row) => { const n = Number(no); if (!n) return; P.set(n, { ...(P.get(n) ?? { product_no: n, src: [] as string[] }), ...patch }); };
  const tag = (no: unknown, t: string) => { const p = P.get(Number(no)); if (p) { const s = p.src as string[]; if (!s.includes(t)) s.push(t); } };
  for (const m of ((((sd.new_arrivals ?? {}) as Row).matrix ?? []) as Row[])) put(m.product_no, { name: m.name, category: m.category, views_14d: num(m.views_14d), qty_14d: num(m.qty_14d), rate_14d: m.rate_14d ?? null, margin_rate: m.margin_rate ?? null, promos: m.promos ?? [], quadrant: m.quadrant, codi: m.codi ?? null, is_new: true, sold_out: !!m.sold_out });
  for (const t of ((sd.top10 ?? []) as Row[])) put(t.product_no, { name: t.name, qty_14d: num(t.qty_14d), rate_14d: t.rate_14d ?? null, rank14: t.rank });
  for (const s of ((sd.surge_top10 ?? []) as Row[])) put(s.product_no, { name: s.name, category: s.category, surge: { rank: s.rank, qty_7d: s.qty_7d, qty_prev7d: s.qty_prev7d, change_pct: s.change_pct ?? null, rate_7d: s.rate_7d ?? null }, codi: s.codi ?? (P.get(Number(s.product_no))?.codi ?? null) });
  for (const f of ((sd.focus ?? []) as Row[])) put(f.product_no, { name: f.name, category: f.category, views_14d: num(f.views_14d), qty_14d: num(f.qty_14d), rate_14d: f.rate_14d ?? null, margin_rate: f.margin_rate ?? null, promos: f.promos ?? [], codi: f.codi ?? null, focus_why: f.why ?? "", sold_out: !!f.sold_out });
  const allP = () => [...P.values()];
  for (const m of ((sr.matrix ?? []) as Row[])) { const p = findByName(allP(), m.name); if (p) put(p.product_no, { strategy_line: m.strategy }); }
  for (const f of ((sr.focus ?? []) as Row[])) { const p = findByName(allP(), f.name); if (p) put(p.product_no, { focus_status: f.status ?? f.plan ?? "", focus_grow: (f.grow ?? []) as string[] }); }
  for (const v of ((sr.verdicts ?? []) as Row[])) { const no = v.product_no ?? findByName(allP(), v.product)?.product_no; if (no) put(no, { verdict: v.kind, verdict_reason: v.reason }); }
  // 어제 판매 상품(카페24 summary) — 매칭 사전·판매 상위 5
  const yRows = (((s1 as Row | null)?.rows ?? []) as Row[]).map((r) => ({ product_no: Number(r.product_no), name: String(r.product_name ?? ""), qty: num(r.order_qty), orders: num(r.order_count), views: num(r.views), rate: r.rate ?? null }));
  for (const r of yRows) if (r.product_no && !P.has(r.product_no)) P.set(r.product_no, { product_no: r.product_no, name: r.name, src: [] as string[], qty_y: r.qty });
  // 반품 위험 + Best30 취소·반품 TOP5
  const riskRows = ((rr.risk_products ?? []) as Row[]);
  const riskData = (((rd.top_sellers_return ?? {}) as Row).risk_products ?? []) as Row[];
  const b30 = (rd.best30 ?? {}) as Row;
  for (const rk of riskRows) {
    const src = findByName(riskData, rk.name);
    const no = Number(src?.product_no ?? 0) || Number(findByName(allP(), rk.name)?.product_no ?? 0);
    const ret = { level: rk.level, rate_14d: rk.rate_14d ?? src?.rate_14d ?? null, delivered_14d: rk.delivered_14d ?? src?.delivered_14d ?? null, cause: rk.cause ?? "" };
    if (no) put(no, { name: P.get(no)?.name ?? rk.name, returns: ret }); else { const n = -(riskRows.indexOf(rk) + 1); P.set(n, { product_no: n, name: rk.name, src: [] as string[], no_match: true, returns: ret }); }
  }
  for (const c of ((b30.cancel_top5 ?? []) as Row[])) { const no = Number(c.product_no) || Number(findByName(allP(), c.name)?.product_no ?? 0); if (no) put(no, { name: P.get(no)?.name ?? c.name, cancel: { rate: c.cancel_rate, paid: c.paid_qty, cancel: c.cancel_qty, rank: c.rank } }); }
  for (const c of ((b30.return_top5 ?? []) as Row[])) { const no = Number(c.product_no) || Number(findByName(allP(), c.name)?.product_no ?? 0); if (no && !P.get(no)?.returns) put(no, { name: P.get(no)?.name ?? c.name, returns: { level: c.level, rate_14d: c.rate_14d, delivered_14d: c.delivered_14d, cause: "" } }); }
  for (const p of allP()) {
    if (p.verdict) tag(p.product_no, `전략 ${p.verdict}`);
    if (p.surge) tag(p.product_no, "급증");
    if (p.focus_status != null || p.focus_why) tag(p.product_no, "집중");
    if (p.rank14) tag(p.product_no, `TOP10 ${p.rank14}위`);
    const q = String(p.quadrant ?? "");
    if (/^(판매 확대|노출 부족|상세·가격 점검)/.test(q)) tag(p.product_no, q.replace(/\(.*\)$/, ""));
    if (p.returns) tag(p.product_no, `반품 ${String((p.returns as Row).level ?? "")}`);
    if (p.cancel) tag(p.product_no, `취소율 ${String((p.cancel as Row).rate ?? "")}%`);
  }
  const allProds: PaProd[] = allP().filter((p) => p.name && !p.no_match).map((p) => ({ no: Number(p.product_no), name: String(p.name), key: paNorm(paKey(String(p.name))), ver: paVerTok(String(p.name)) ? paNorm(paVerTok(String(p.name))!) : null, qty: num(p.qty_14d ?? p.qty_y) })).filter((p) => p.key.length >= 3);
  const groups = paGroups(allProds);
  const matchCache = new Map<string, number | null>();
  const productOfAd = (name: string): number | null => { const k = paNorm(name); if (matchCache.has(k)) return matchCache.get(k)!; const best = paPickBest(k, allProds, groups); const no = best ? best.no : null; matchCache.set(k, no); return no; };
  const nameOf = (no: number | null) => no != null ? String(P.get(no)?.name ?? "") : "";
  const byProduct = (list: Row[]) => { const m = new Map<number, Row[]>(); for (const ad of list) { const no = productOfAd(String(ad.ad_name ?? "")); if (no != null) (m.get(no) ?? m.set(no, []).get(no)!).push(ad); } return m; };
  const activeBy = byProduct(((active as Row | null)?.ads ?? []) as Row[]);
  const pausedBy = byProduct(((paused as Row | null)?.ads ?? []) as Row[]);
  const dailyBy = new Map<number, AdAgg[]>();
  for (const a of ads.values()) { const no = productOfAd(a.name); if (no != null) (dailyBy.get(no) ?? dailyBy.set(no, []).get(no)!).push(a); }

  // ── 소재 단위 지표 도우미 ──
  const dayOf = (a: AdAgg, d: string) => a.days.get(d) ?? null;
  const rangeOf = (a: AdAgg, dates: string[]) => dates.map((d) => dayOf(a, d)).filter((x): x is DayRow => !!x);
  const adPerf = (a: AdAgg, dates: string[]) => perfOf(rangeOf(a, dates), 1);
  const firstSpendDay = (a: AdAgg) => { for (const d of days14) { const x = a.days.get(d); if (x && x.spend > 0) return d; } return null; };
  const adBrief = (a: AdAgg) => ({ ad_id: a.ad_id, name: a.name, adset: a.adset, product: nameOf(productOfAd(a.name)), test: a.test });
  const series4 = (a: AdAgg) => days14.slice(-4).map((d) => { const x = dayOf(a, d); return { date: d.slice(5), spend: x ? Math.round(x.spend) : 0, purchases: x ? x.purchases : 0, roas: x ? roasOf(x.spend, x.value) : null, ctr: x && x.impressions > 0 ? r2(x.clicks / x.impressions * 100) : null, frequency: x ? r2(x.frequency) : null }; });

  // ── 상위 5 (어제) ──
  const sales_top5 = [...yRows].sort((a, b) => b.qty - a.qty).slice(0, 5).map((r) => ({ product_no: r.product_no, name: r.name, qty: r.qty, orders: r.orders, views: r.views, rate: r.rate, ad_spend_y: Math.round((dailyBy.get(r.product_no) ?? []).reduce((t, a) => t + (dayOf(a, D)?.spend ?? 0), 0)) }));
  const yAds = [...ads.values()].map((a) => ({ ...adBrief(a), ...(() => { const x = dayOf(a, D); return { spend: Math.round(x?.spend ?? 0), purchases: x?.purchases ?? 0, value: Math.round(x?.value ?? 0), roas: x ? roasOf(x.spend, x.value) : null, ctr: x && x.impressions > 0 ? r2(x.clicks / x.impressions * 100) : null }; })() })).filter((a) => a.spend > 0);
  const spend_top5 = [...yAds].sort((a, b) => b.spend - a.spend).slice(0, 5);
  const conv_top5 = [...yAds].sort((a, b) => b.purchases - a.purchases || b.value - a.value).slice(0, 5);

  // ── 신규 테스트: 테스트 소재 중 첫 지출일이 3일 안(D-2..D) → 상품별 묶음 ──
  const testGroups = new Map<string, { product_no: number | null; product: string; ads: AdAgg[]; first: string }>();
  for (const a of ads.values()) {
    if (!a.test) continue;
    const f = firstSpendDay(a); if (!f || f < addDays(D, -2)) continue;
    const no = productOfAd(a.name), key = no != null ? String(no) : paNorm(paKey(a.name)) || a.name;
    const g = testGroups.get(key) ?? testGroups.set(key, { product_no: no, product: no != null ? nameOf(no) : a.name.split("_")[0], ads: [], first: f }).get(key)!;
    g.ads.push(a); if (f < g.first) g.first = f;
  }
  const dayIdx = (first: string) => Math.round((new Date(D + "T00:00:00Z").getTime() - new Date(first + "T00:00:00Z").getTime()) / 86400000) + 1;
  const tests = [...testGroups.values()].map((g) => {
    const dates = days14.filter((d) => d >= g.first);
    const all = perfOf(g.ads.flatMap((a) => rangeOf(a, dates)), g.ads.length);
    const imp = g.ads.reduce((t, a) => t + rangeOf(a, dates).reduce((s, x) => s + x.impressions, 0), 0), clk = g.ads.reduce((t, a) => t + rangeOf(a, dates).reduce((s, x) => s + x.clicks, 0), 0);
    const p = g.product_no != null ? P.get(g.product_no) : null;
    return {
      product_no: g.product_no, product: g.product, day: dayIdx(g.first), started: g.first, ads: g.ads.length,
      spend: all.spend, purchases: all.purchases, value: all.value, roas: all.roas, cpa: all.purchases > 0 ? Math.round(all.spend / all.purchases) : null, ctr: imp > 0 ? r2(clk / imp * 100) : null,
      margin_rate: p?.margin_rate ?? null, rate_14d: p?.rate_14d ?? null, qty_14d: p?.qty_14d ?? null,
      per_ad: g.ads.map((a) => { const x = perfOf(rangeOf(a, dates), 1); const im = rangeOf(a, dates).reduce((s, r) => s + r.impressions, 0), ck = rangeOf(a, dates).reduce((s, r) => s + r.clicks, 0); return { name: a.name, spend: x.spend, purchases: x.purchases, roas: x.roas, ctr: im > 0 ? r2(ck / im * 100) : null }; }).sort((a, b) => b.spend - a.spend),
      by_day: dates.map((d) => { const rows = g.ads.map((a) => dayOf(a, d)).filter((x): x is DayRow => !!x); const x = perfOf(rows, rows.length); return { date: d.slice(5), spend: x.spend, purchases: x.purchases, roas: x.roas }; }),
    };
  }).filter((t) => t.spend >= 10000 || t.ads >= 2).sort((a, b) => b.spend - a.spend).slice(0, 12);   // 지출 1만 미만·소재 1개짜리 막 켠 묶음은 뺀다(25개 중 절반이 수백 원짜리였음)

  // ── 치고 올라오는 소재: 어제 지출 3만↑, 구매 3건↑, 직전 3일 평균 대비 구매 1.5배↑ 또는 ROAS 1.3배↑(ROAS 3↑). 테스트 소재 제외 ──
  const prev3 = days14.slice(-4, -1);
  const risingCands = [...ads.values()].filter((a) => !a.test).map((a) => {
    const y = dayOf(a, D); if (!y || y.spend < 30000) return null;
    const p3 = adPerf(a, prev3), avgP = p3.purchases / 3, avgS = p3.spend / 3, yR = roasOf(y.spend, y.value), p3R = p3.roas;
    const purchaseLift = avgP > 0 ? y.purchases / avgP : (y.purchases >= 3 ? 9 : 0);
    const roasLift = p3R != null && p3R > 0 && yR != null ? yR / p3R : (yR != null && yR >= 3 && p3.spend === 0 ? 9 : 0);
    const ok = y.purchases >= 3 && yR != null && yR >= 3 && (purchaseLift >= 1.5 || roasLift >= 1.3);
    if (!ok) return null;
    return { ...adBrief(a), spend_y: Math.round(y.spend), purchases_y: y.purchases, roas_y: yR, ctr_y: y.impressions > 0 ? r2(y.clicks / y.impressions * 100) : null, frequency_y: r2(y.frequency), avg3_purchases: r2(avgP), avg3_spend: Math.round(avgS), avg3_roas: p3R, purchase_lift: r2(purchaseLift), roas_lift: r2(roasLift), first_spend: firstSpendDay(a), series: series4(a), score: purchaseLift + roasLift + y.purchases / 10 };
  }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.score - a.score).slice(0, 8);

  // ── 하락하는 소재: 주축(직전 7일 지출 상위 15 또는 7일 구매 20↑) 중 최근 2일 평균이 앞선 5일 평균보다 ROAS 30%↓ 또는 구매 40%↓ ──
  const last2 = days14.slice(-2), prev5 = days14.slice(-7, -2);
  const majors = [...ads.values()].filter((a) => !a.test).map((a) => ({ a, p7: adPerf(a, days14.slice(-8, -1)) })).filter((x) => x.p7.spend > 0);
  const top15 = new Set([...majors].sort((x, y) => y.p7.spend - x.p7.spend).slice(0, 15).map((x) => x.a.ad_id));
  const fallingCands = majors.filter((x) => top15.has(x.a.ad_id) || x.p7.purchases >= 20).map(({ a, p7 }) => {
    const l2 = adPerf(a, last2), p5 = adPerf(a, prev5);
    if (l2.spend < 20000 || p5.spend === 0) return null;
    const l2R = l2.roas, p5R = p5.roas, l2P = l2.purchases / 2, p5P = p5.purchases / 5;
    const roasDrop = l2R != null && p5R != null && p5R > 0 ? 1 - l2R / p5R : (p5R != null && p5R > 0 && l2.purchases === 0 ? 1 : 0);
    const purDrop = p5P > 0 ? 1 - l2P / p5P : 0;
    if (!(roasDrop >= 0.3 || purDrop >= 0.4)) return null;
    const y = dayOf(a, D);
    return { ...adBrief(a), spend_7d: p7.spend, purchases_7d: p7.purchases, roas_7d: p7.roas, prev5_roas: p5R, prev5_purchases_avg: r2(p5P), last2_roas: l2R, last2_purchases_avg: r2(l2P), roas_drop_pct: Math.round(roasDrop * 100), purchase_drop_pct: Math.round(purDrop * 100), frequency_y: y ? r2(y.frequency) : null, cpa_y: y && y.purchases > 0 ? Math.round(y.spend / y.purchases) : null, series: series4(a), score: Math.max(roasDrop, purDrop) * p7.spend };
  }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.score - a.score).slice(0, 8);

  // ── 상품별 광고 숫자(ON 광고 전부의 7일·14일 합은 일별 자료에서, 꺼진 광고 30일은 adcards) + 운영 판단 후보 ──
  const prio = (p: Row) => (p.verdict ? 100 : 0) + (p.surge ? 50 : 0) + (p.focus_status != null ? 40 : 0) + (p.rank14 ? 30 : 0) + (p.returns ? 25 : 0) + (p.cancel ? 20 : 0) + (/^(판매 확대|노출 부족)/.test(String(p.quadrant ?? "")) ? 15 : 0) + (/^상세·가격/.test(String(p.quadrant ?? "")) ? 8 : 0);
  const candidates = allP().filter((p) => (p.src as string[]).length).sort((a, b) => prio(b) - prio(a)).slice(0, MAX_PRODUCTS);
  const candSet = new Set(candidates.map((p) => Number(p.product_no)));
  const pausedIds: string[] = [];
  for (const [no, list] of pausedBy) if (candSet.has(no)) for (const a of list) pausedIds.push(String(a.ad_id));
  const chunks: string[][] = []; for (let i = 0; i < pausedIds.length; i += 60) chunks.push(pausedIds.slice(i, i + 60));
  const pausedParts = await Promise.all(chunks.map((c, i) => safe(`꺼진 광고 30일 성과(${i + 1})`, () => callFn("meta-ads", { action: "adcards", ad_ids: c.join(","), start_date: cur30[0], end_date: cur30[1] }))));
  const pausedPerfMap = new Map<string, Row | null>(); let pausedOk = pausedKnown;
  for (const part of pausedParts) { if (!part) { pausedOk = false; continue; } for (const a of (((part as Row).ads ?? []) as Row[])) pausedPerfMap.set(String(a.ad_id), (a.period ?? null) as Row | null); }
  const productPerf = (no: number, dates: string[]): Perf | null => { if (!metaKnown) return null; const list = dailyBy.get(no) ?? []; return perfOf(list.flatMap((a) => rangeOf(a, dates)), list.filter((a) => rangeOf(a, dates).some((x) => x.spend > 0)).length); };
  const products = candidates.map((p) => {
    const no = Number(p.product_no);
    const act = adsKnown ? (activeBy.get(no) ?? []) : null, pau = pausedKnown ? (pausedBy.get(no) ?? []) : null;
    const perf7 = productPerf(no, days14.slice(-7)), perf14 = productPerf(no, days14);
    let pausedPerf: Perf | null = null;
    if (pau && pausedOk) { let sp = 0, pu = 0, v = 0; for (const a of pau) { const x = pausedPerfMap.get(String(a.ad_id)); if (!x) continue; sp += num(x.spend); pu += num(x.purchases); v += num(x.purchase_value); } pausedPerf = { spend: Math.round(sp), purchases: pu, value: Math.round(v), roas: roasOf(sp, v), ads: pau.length }; }
    const ret = (p.returns ?? null) as Row | null, cn = (p.cancel ?? null) as Row | null, codiShare = (p.codi as Row | null)?.share ?? null;
    let hint = "유지", why = "";
    const roas7 = perf7?.roas ?? null, spend7 = perf7?.spend ?? 0, verdict = String(p.verdict ?? "");
    if (ret && String(ret.level) === "위험") { hint = "증액 보류"; why = `반품 ${ret.rate_14d}%(위험)`; }
    else if (cn && num(cn.rate) >= 10) { hint = "증액 보류"; why = `취소율 ${cn.rate}%`; }
    else if (codiShare != null && num(codiShare) >= 40) { hint = "증액 보류"; why = `코디 구매 ${codiShare}% — 부모 상품 따라감`; }
    else if (verdict === "보류" || verdict === "점검") { hint = "증액 보류"; why = `전략 담당 '${verdict}' — ${p.verdict_reason ?? ""}`; }
    else if (roas7 != null && roas7 < 1 && spend7 >= 100000) { hint = "줄이기"; why = `7일 ROAS ${roas7} · 광고비 ${Math.round(spend7 / 10000)}만`; }
    else if ((verdict === "밀기" || p.surge || /^(판매 확대|노출 부족)/.test(String(p.quadrant ?? ""))) && act && act.length === 0 && pau && pau.length > 0) { hint = "다시 켜기"; why = `ON 광고 0개, 꺼진 광고 ${pau.length}개${pausedPerf?.roas != null ? ` (30일 ROAS ${pausedPerf.roas})` : ""}`; }
    else if ((verdict === "밀기" || p.surge) && act && act.length === 0) { hint = "힘주기"; why = "광고가 없음 — 광고 착수"; }
    else if (verdict === "밀기" && (roas7 == null || roas7 >= 2)) { hint = "힘주기"; why = `전략 '밀기'${roas7 != null ? ` · 7일 ROAS ${roas7}` : " · 7일 지출 없음(test)"}`; }
    else if (roas7 != null && roas7 >= 3 && spend7 >= 50000 && !(ret && String(ret.level) === "주의")) { hint = "힘주기"; why = `7일 ROAS ${roas7} · 광고비 ${Math.round(spend7 / 10000)}만`; }
    const topAds = (dailyBy.get(no) ?? []).map((a) => ({ a, p: adPerf(a, days14.slice(-7)) })).sort((x, y) => y.p.spend - x.p.spend).slice(0, 3).map(({ a, p: pp }) => { const y = dayOf(a, D); return { name: a.name, spend_7d: pp.spend, purchases_7d: pp.purchases, roas_7d: pp.roas, frequency_y: y ? r2(y.frequency) : null }; });
    return {
      product_no: no > 0 ? no : null, name: String(p.name ?? ""), category: p.category ?? "", src: p.src, is_new: !!p.is_new, sold_out: !!p.sold_out,
      views_14d: p.views_14d ?? null, qty_14d: p.qty_14d ?? null, rate_14d: p.rate_14d ?? null, margin_rate: p.margin_rate ?? null, promos: p.promos ?? [], quadrant: p.quadrant ?? null,
      surge: p.surge ?? null, rank14: p.rank14 ?? null, codi_share: codiShare, returns: ret, cancel: cn,
      strategy: { verdict: p.verdict ?? null, verdict_reason: p.verdict_reason ?? null, matrix_strategy: p.strategy_line ?? null, focus_status: p.focus_status ?? null, focus_grow: p.focus_grow ?? null, focus_why: p.focus_why ?? null },
      active_ads: act ? act.length : null, paused_ads: pau ? pau.length : null,
      ad_7d: perf7, ad_14d: perf14, paused_30d: pausedPerf, top_ads_7d: topAds,
      paused_list: pau ? pau.slice(0, 5).map((a) => ({ name: String(a.ad_name ?? ""), status: a.effective_status, updated: a.updated })) : [],
      hint, hint_why: why,
    };
  });

  // ── 주의 후보 (코드) ──
  const cautionCands: Row[] = [];
  for (const p of products) {
    const sp7 = p.ad_7d?.spend ?? 0, ret = p.returns as Row | null, cn = p.cancel as Row | null;
    if (ret && sp7 >= 100000 && (String(ret.level) === "위험" || String(ret.level) === "주의")) cautionCands.push({ kind: "반품", target: p.name, why: `7일 광고비 ${Math.round(sp7 / 10000)}만·ROAS ${p.ad_7d?.roas ?? "—"}인데 순반품률 ${ret.rate_14d}%(${ret.level})${ret.cause ? ` — ${ret.cause}` : ""}` });
    if (cn && sp7 >= 100000 && num(cn.rate) >= 8) cautionCands.push({ kind: "취소", target: p.name, why: `7일 광고비 ${Math.round(sp7 / 10000)}만인데 14일 취소율 ${cn.rate}%(결제 ${cn.paid}개 중 ${cn.cancel}개)` });
    if (p.sold_out && (p.active_ads ?? 0) > 0) cautionCands.push({ kind: "품절", target: p.name, why: `품절인데 ON 광고 ${p.active_ads}개` });
  }
  for (const a of yAds) {
    if (a.spend >= 50000 && a.purchases === 0) cautionCands.push({ kind: "구매 0", target: a.name, product: a.product, why: `어제 ${Math.round(a.spend / 10000)}만 쓰고 구매 0건` });
  }
  for (const a of ads.values()) { const y = dayOf(a, D); if (y && y.spend >= 50000 && y.frequency >= 3) cautionCands.push({ kind: "소재 피로", target: a.name, product: nameOf(productOfAd(a.name)), why: `어제 빈도 ${r2(y.frequency)}·지출 ${Math.round(y.spend / 10000)}만 — 같은 사람에게 반복 노출` }); }

  return {
    base_date: D, base_dow: dow(D), generated_at: new Date().toISOString(),
    periods: { last14: cur14, last7: cur7, prev7_avg: w7, paused_window: cur30 },
    meta_known: metaKnown, cafe24_known: !!rev, ads_known: adsKnown, paused_known: pausedKnown,
    kpi, flow,
    top5: { sales: sales_top5, spend: spend_top5, conversions: conv_top5, basis: `어제(${D}) 기준. 판매 = 카페24 결제수량, 광고비·전환 = Meta 소재별` },
    tests, rising: risingCands, falling: fallingCands, caution_cands: cautionCands.slice(0, 12),
    counts: { ads_with_spend_14d: ads.size, ads_with_spend_y: yAds.length, active_total: num((active as Row | null)?.count), paused_total: num((paused as Row | null)?.count), candidates: products.length, tests: tests.length },
    strategy_report: st ? { created_at: st.created_at, headline: sr.headline, verdicts: sr.verdicts ?? [] } : null,
    returns_report: rt ? { created_at: rt.created_at, headline: rr.headline, risk_count: riskRows.length } : null,
    products,
    rules: {
      kpi: "kpi.yesterday·day_before·avg_7d(직전 7일 하루 평균): spend·value(Meta 전환값)·purchases·clicks·roas·cpa·cpc + cafe24(카페24 결제 매출)·cafe24_orders·cafe24_roas(= 카페24 매출 ÷ 광고비). 친구 대시보드 요약 카드와 같은 구성",
      flow: "flow = 최근 14일 일별: spend, meta_roas, cafe24_roas, organic_share(%) = (카페24 매출 − Meta 전환값) ÷ 카페24 매출. 자연 매출 비율이 오르면 광고 없이도 팔리는 힘이 커진 것, 떨어지면 광고 의존이 커진 것",
      tests: "tests = 테스트 소재(세트·광고명에 test/테스트) 중 첫 지출이 3일 안인 것을 상품별로 묶음. day = n일차. per_ad·by_day로 소재·날짜별 흐름",
      rising: "rising = 어제 지출 3만↑·구매 3건↑·ROAS 3↑이면서 직전 3일 평균 대비 구매 1.5배↑ 또는 ROAS 1.3배↑ (테스트 제외). series = 최근 4일",
      falling: "falling = 직전 7일 지출 상위 15 또는 7일 구매 20↑인 주축 소재 중 최근 2일 평균이 앞선 5일 평균보다 ROAS 30%↓ 또는 구매 40%↓",
      cautions: "caution_cands = 코드가 모은 주의 후보(반품·취소·품절·구매 0·소재 피로). 이 밖에 데이터에서 보이는 주의점이 있으면 더한다",
      kinds: "decisions.kind는 5가지만: 힘주기 / 증액 보류 / 다시 켜기 / 줄이기 / 유지. products[].hint·hint_why = 코드 규칙의 기본 판단",
      perf: "products[].ad_7d·ad_14d = 그 상품 광고 전부의 최근 7일·14일 Meta 합(일별 자료), paused_30d = 꺼진 광고 30일 합. null = 광고 정보 모름",
    },
    errors,
  };
}

function forLLM(data: Row) {
  const slimAd = (a: Row) => { const { ad_id: _i, adset: _s, score: _c, ...rest } = a; return rest; };
  const products = ((data.products ?? []) as Row[]).map((p) => ({
    name: p.name, category: p.category || undefined, src: p.src, is_new: p.is_new || undefined, sold_out: p.sold_out || undefined,
    views_14d: p.views_14d, qty_14d: p.qty_14d, rate_14d: p.rate_14d, margin_rate: p.margin_rate, promos: ((p.promos ?? []) as unknown[]).length ? p.promos : undefined,
    surge: p.surge ?? undefined, codi_share: p.codi_share ?? undefined, returns: p.returns ?? undefined, cancel: p.cancel ?? undefined,
    strategy: p.strategy, active_ads: p.active_ads, paused_ads: p.paused_ads, ad_7d: p.ad_7d, ad_14d: p.ad_14d, paused_30d: p.paused_30d ?? undefined,
    top_ads_7d: p.top_ads_7d, paused_list: ((p.paused_list ?? []) as unknown[]).length ? p.paused_list : undefined, hint: p.hint, hint_why: p.hint_why,
  }));
  const flow = ((data.flow ?? []) as Row[]).map((f) => ({ d: String(f.date).slice(5), spend: f.spend, meta_roas: f.meta_roas, cafe24_roas: f.cafe24_roas, organic: f.organic_share }));
  return {
    base_date: data.base_date, base_dow: data.base_dow, meta_known: data.meta_known, cafe24_known: data.cafe24_known, ads_known: data.ads_known,
    kpi: data.kpi, flow, top5: data.top5,
    tests: ((data.tests ?? []) as Row[]).map((t) => ({ ...t, product_no: undefined, per_ad: ((t.per_ad ?? []) as Row[]).slice(0, 5) })),
    rising: ((data.rising ?? []) as Row[]).map(slimAd), falling: ((data.falling ?? []) as Row[]).map(slimAd), caution_cands: data.caution_cands,
    counts: data.counts, strategy_report: data.strategy_report, returns_report: data.returns_report, products, rules: data.rules, errors: data.errors,
  };
}

function postProcess(report: Row, data: Row): Row {
  const products = (data.products ?? []) as Row[];
  const seen = new Set<string>();
  const decisions = ((report.decisions ?? []) as Row[]).map((d) => {
    const kind = KINDS.find((k) => String(d.kind ?? "").replace(/\s+/g, "").includes(k.replace(/\s+/g, ""))) ?? "유지";
    const p = findByName(products, String(d.product ?? ""));
    const name = p ? String(p.name) : String(d.product ?? "").trim();
    if (!name || seen.has(name)) return null; seen.add(name);
    return { kind, product: name, product_no: p?.product_no ?? null, reason: String(d.reason ?? "").trim(), active_ads: p?.active_ads ?? null, paused_ads: p?.paused_ads ?? null, ad_7d: p?.ad_7d ?? null, ad_14d: p?.ad_14d ?? null, paused_30d: p?.paused_30d ?? null, returns: p?.returns ?? null, cancel: p?.cancel ?? null, margin_rate: p?.margin_rate ?? null, rate_14d: p?.rate_14d ?? null, qty_14d: p?.qty_14d ?? null, codi_share: p?.codi_share ?? null, promos: p?.promos ?? [], strategy_verdict: (p?.strategy as Row | undefined)?.verdict ?? null, hint: p?.hint ?? null };
  }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 12);
  const tests = ((report.tests ?? []) as Row[]).map((t) => { const g = findByName((data.tests ?? []) as Row[], String(t.product ?? ""), "product"); return g ? { ...g, verdict: String(t.verdict ?? "").trim(), note: String(t.note ?? "").trim() } : null; }).filter((x): x is NonNullable<typeof x> => !!x);
  const byAd = (src: Row[], arr: Row[], fields: string[]) => arr.map((x) => { const a = findByName(src, String(x.ad ?? ""), "name"); if (!a) return null; const o: Row = { ...a }; for (const f of fields) o[f] = String(x[f] ?? "").trim(); return o; }).filter((x): x is NonNullable<typeof x> => !!x);
  const rising = byAd((data.rising ?? []) as Row[], (report.rising ?? []) as Row[], ["why"]);
  const falling = byAd((data.falling ?? []) as Row[], (report.falling ?? []) as Row[], ["why", "action"]);
  const cautions = ((report.cautions ?? []) as Row[]).map((c) => ({ target: String(c.target ?? "").trim(), why: String(c.why ?? "").trim(), action: String(c.action ?? "").trim() })).filter((c) => c.target && c.why).slice(0, 8);
  return { ...report, decisions, tests, rising, falling, cautions, flow_note: String(report.flow_note ?? "").trim() };
}

const SYSTEM = `당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 광고 운영 담당자입니다. 매일 아침 광고를 실제로 운영하는 사람(광고팀)에게 어제 Meta 광고 성과를 우리 데이터로 직접 정리해 보고합니다. 숫자·후보는 코드가 이미 만들었습니다 — 당신은 **날카로운 해석 한 줄씩**만 씁니다. 예산을 바꾸거나 광고를 켜고 끄는 것은 사람이 합니다.

1) 전체 흐름 (flow_note, 2줄 이내): kpi(어제 vs 그제 vs 7일 평균)와 flow(14일 광고비·메타 ROAS·카페24 ROAS·자연 매출 비율)에서 **방향**을 짚습니다 — 광고비를 늘렸는데 ROAS가 유지됐는지, 자연 매출 비율이 오르는지(광고 의존이 줄면 좋은 신호), 카페24 ROAS와 메타 ROAS의 차이가 벌어지는지. 숫자 2~3개로.
2) 신규 테스트 (tests — data.tests 상품마다 1개, product는 그대로): day(n일차)·소재 수·지출·구매·ROAS·CTR·by_day 흐름으로 verdict(확대 / 계속 / 지켜보기 / 중단)와 note(45자 이내, 숫자 근거). 1일차는 지출·CTR만으로 성급히 결론 내지 말고 '지켜보기', 3일차는 결론을 냅니다. 마진(margin_rate)이 낮으면 ROAS 기준을 높입니다.
3) 치고 올라오는 소재 (rising — data.rising 중 진짜 의미 있는 것만 최대 5, ad는 name 그대로): why에 어제 구매·ROAS가 직전 3일 평균 대비 얼마나 뛰었는지와 이유 추정(새 소재의 초반 반응인지, 빈도가 낮아 확장 여지가 있는지, 상품 자체가 급증인지). "좋아졌다"가 아니라 **무엇을 해야 하는지**가 드러나게(예: "구매 3→9건·ROAS 7.1, 빈도 1.4 — 예산 2배 여지").
4) 하락하는 소재 (falling — data.falling 중 최대 5): 주축 소재가 꺾이기 시작한 것. why에 앞선 5일 평균 대비 최근 2일 ROAS·구매 하락 폭과 원인 추정(빈도 3↑ = 소재 피로, CPA 상승, 상품 재고·가격·반품 문제인지), action에 할 일(소재 교체 요청·예산 축소·며칠 더 관찰).
5) 주의할 상품·소재 (cautions, 최대 6): caution_cands(반품·취소·품절·구매 0·소재 피로)에서 중요한 것 + 데이터에서 보이는 다른 주의점(코디 구매 비율 높은 상품의 광고 확대, 이벤트 종료 직전, 전략 담당 '보류' 상품에 광고비 집중 등). target(상품명 또는 소재명 그대로)·why(숫자)·action.
6) 상품별 광고 운영 판단 (decisions, 중요한 순 최대 10 — 광고팀이 오늘 손댈 것만): kind는 5가지만 — 힘주기(7일 ROAS 2↑·반품 낮음·마진 좋음·전략 '밀기'·광고 없는 급증 상품의 착수) / 증액 보류(반품 위험·취소율 높음·코디 구매 40%↑·주문율 하락·전략 '점검'·'보류') / 다시 켜기(ON 광고 0개인데 꺼진 광고가 있고 팔리는 상품 — paused_list의 광고 이름, "켜기 전 왜 껐는지 확인") / 줄이기(7일 ROAS 1 미만이 지출 10만↑) / 유지. product는 products[].name 그대로, reason 45자 이내·숫자 하나 이상. ad_7d가 null인 상품은 '광고 없음'이라 쓰지 말고 '광고 연결 확인 필요'. 반품 위험 상품은 힘주기 금지.

공통: headline = 오늘 광고 운영 한 줄 결론(숫자 1개). summary 2줄(계정 흐름 + 오늘 할 일 요약). highlights/warnings 각 3개 이내(치고 올라오는·하락·주의와 겹치지 않게 계정 단위 신호 위주). actions = 광고팀 오늘 할 일 3개(예산 변경은 '대표 확인 후'). 소재 제작이 필요한 상품은 광고 소재 담당에게 handoff, 상세 문제는 상세페이지 점검 담당에게 handoff.`;

const SCHEMA = reportSchema({
  lean: true,
  highlights: "계정 단위 좋은 신호(ROAS 개선·자연 매출 비율 상승·CPA 하락 등). 최대 3개",
  warnings: "계정 단위 나쁜 신호(광고비 늘었는데 ROAS 하락·CPC 상승·전환 급감 등). 최대 3개",
  actions: "광고팀이 오늘 할 일 3개. 예산 변경은 '대표 확인 후'를 붙인다",
  extra: {
    flow_note: { type: "string", description: "최근 14일 흐름 해석 2줄 이내(광고비·ROAS·자연 매출 비율 방향, 숫자 2~3개)" },
    tests: { type: "array", description: "신규 테스트 상품별 판정. data.tests 상품마다 1개", items: { type: "object", properties: { product: { type: "string", description: "tests[].product 그대로" }, verdict: { type: "string", description: "다음 중 하나 그대로: 확대, 계속, 지켜보기, 중단" }, note: { type: "string", description: "45자 이내, 숫자 근거" } }, required: ["product", "verdict", "note"], additionalProperties: false } },
    rising: { type: "array", description: "치고 올라오는 소재 최대 5", items: { type: "object", properties: { ad: { type: "string", description: "rising[].name 그대로" }, why: { type: "string", description: "60자 이내, 숫자 + 할 일" } }, required: ["ad", "why"], additionalProperties: false } },
    falling: { type: "array", description: "하락하는 소재 최대 5", items: { type: "object", properties: { ad: { type: "string", description: "falling[].name 그대로" }, why: { type: "string", description: "60자 이내, 하락 폭 + 원인 추정" }, action: { type: "string", description: "할 일 40자 이내" } }, required: ["ad", "why", "action"], additionalProperties: false } },
    cautions: { type: "array", description: "주의할 상품·소재 최대 6", items: { type: "object", properties: { target: { type: "string", description: "상품명 또는 소재명 그대로" }, why: { type: "string", description: "60자 이내, 숫자" }, action: { type: "string", description: "40자 이내" } }, required: ["target", "why", "action"], additionalProperties: false } },
    decisions: { type: "array", description: "상품별 광고 운영 판단, 중요한 순 최대 10개", items: { type: "object", properties: { product: { type: "string", description: "products[].name 그대로" }, kind: { type: "string", description: "다음 중 하나 그대로: 힘주기, 증액 보류, 다시 켜기, 줄이기, 유지" }, reason: { type: "string", description: "근거 45자 이내, 숫자 하나 이상" } }, required: ["product", "kind", "reason"], additionalProperties: false } },
  },
});

const COLLEAGUE_RULES = `- 상품 전략 담당(오늘)의 결론 칩·집중 상품 status·grow는 data.products에 합쳐져 있습니다. 전략이 '밀기'라도 광고 숫자(ROAS·구매 0건·소재 피로)가 반대면 광고 관점의 판단을 쓰고 colleague_notes에 적습니다.
- 취소·반품 감시 담당(오늘)의 위험 상품·Best30 취소율 TOP5는 '주의할 상품'과 판단에 반영(힘주기 금지).
- 소재가 필요한 상품(하락 소재의 교체, 광고 없는 급증 상품)은 광고 소재 담당에게 handoff. 상세 문제(주문율 하락)는 상세페이지 점검 담당에게 handoff.`;

export const DEF: AgentDef = { agent: AGENT, label: "광고 운영 담당", system: SYSTEM, schema: SCHEMA, collect, forLLM, postProcess, effort: "low", colleagueRules: COLLEAGUE_RULES, notify: "warn" };

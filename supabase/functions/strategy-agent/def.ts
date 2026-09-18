// ═══════════════════════════════════════════════
// 상품 전략 담당 (에이전트 3호, 2026-09-12) — 공통 뼈대는 ../_shared/agent.ts
//   매일 08:30 KST (pg_cron `strategy-agent-morning`) 또는 앱의 [지금 실행].
//   사용자 요구(2026-09-12):
//     1) 신상품 = 카페24 NEW ARRIVALS 카테고리(상품 관리 시스템 아님, 세일 카테고리 제외). 조회수×주문율 4분면으로
//        어디에 집중할지 판정 — 주문율↑조회↓=노출 부족 / 둘 다↑=판매 확대 / 둘 다↓=집중도 낮춤 / 조회↑주문율↓=상세·가격 점검.
//        마진율·적용 중인 혜택(1+1·기간할인)·등록일·품절을 함께 고려.
//     2) 급상승 상품과 판매 TOP10은 Meta 광고관리자 데이터를 소재 단위로 분석: 어떤 소재가 견인하는지, 같은 카테고리
//        우수 상품의 소재 특성(썸네일을 Claude가 직접 봄)을 바탕으로 추가 소재 컨셉·릴스 첫 훅 멘트·상세 강조점 제안.
//   수집(워크스페이스 함수, x-agent-secret): categorymap · category_products(33) · summary(14일/7일/직전7일) ·
//     productinfo(+with_discount 후보만 — 91개 전부는 62초) · benefits(by_product) · activeads · adcards
//   광고↔상품 매칭 = 워크스페이스 판매 성과 'ON 광고' 규칙(pa*)을 그대로 이식(핵심명·ver 토큰·자모 비교).
// ═══════════════════════════════════════════════
import { addDays, callFn, COMMON_RULES, dow, LLMImage, num, reportSchema, rest, Row, safeCollector, AgentDef } from "../_shared/agent.ts";
import { matchKeyword, NAVER_CATS, naverCategoryRanks, risingKeywords, seoulWeather } from "../_shared/trends.ts";

const AGENT = "strategy";
const NEW_CAT = 33;                 // NEW ARRIVALS
const MIN_AGE_DAYS = 3, MIN_VIEWS = 30;
const FOCUS_MAX = 5, REF_IMG_MAX = 5;   // 6→5 (2026-09-13): 작성 단계 150초 벽시계 한도 — 출력 토큰을 줄여 생성 시간 단축
const SPECIAL_CATS = /new arrivals|best|sale|세일|size pick|autumn|summer|winter|spring|🍁|🌞|⌛|🔎/i;

// ── 광고명 ↔ 상품명 매칭 (워크스페이스 index.html의 pa* 이식) ──
const PA_VER = /(?<![a-z])ver/i;
export function paKey(name: string): string {
  let s = String(name || "").trim();
  for (;;) { const m = s.match(/^\s*(?:\([^)]*\)|\[[^\]]*\])\s*(.*)$/); if (m) s = m[1]; else break; }
  for (;;) { const m = s.match(/^(.*?)\s*(?:\([^)]*\)|\[[^\]]*\])\s*$/); if (m) s = m[1]; else break; }
  return s.trim();
}
export function paVerTok(name: string): string | null {
  const m = String(name || "").match(/([가-힣]+|(?<![a-z]))ver\.?\d*/i);
  return m && PA_VER.test(m[0]) ? m[0] : null;
}
const PA_CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ", PA_JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const PA_JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
function paJamo(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xAC00 && c <= 0xD7A3) { const i = c - 0xAC00; out += PA_CHO[Math.floor(i / 588)] + PA_JUNG[Math.floor((i % 588) / 28)] + PA_JONG[i % 28]; }
    else out += ch;
  }
  return out;
}
export const paNorm = (t: string) => paJamo(String(t || "").normalize("NFC")).replace(/\s+/g, "").replace(/ver\./gi, "ver").toLowerCase();
export type PaProd = { no: number; name: string; key: string; ver: string | null; qty: number; dominant?: boolean };
export function paGroups(prods: PaProd[]) {
  const g: Record<string, { n: number; vers: string[]; noVer: number }> = {};
  for (const p of prods) { const e = (g[p.key] = g[p.key] || { n: 0, vers: [], noVer: 0 }); e.n++; if (p.ver) e.vers.push(p.ver); else e.noVer++; }
  // 기본판(ver 없음)이 여럿인 핵심명: 최근 판매량이 압도적(70%↑)인 상품을 '우세'로 표시 — 옛 상품(2 colors, 판매 0)과
  // 현행 상품(3 colors, 판매 638)이 같은 이름으로 공존해 광고가 어디에도 안 붙던 사례(세러데이 나그랑, 2026-09-12)
  for (const [key, e] of Object.entries(g)) {
    if (e.noVer < 2) continue;
    const cands = prods.filter((p) => p.key === key && !p.ver);
    const total = cands.reduce((t, p) => t + p.qty, 0);
    const top = [...cands].sort((a, b) => b.qty - a.qty)[0];
    if (top && top.qty > 0 && top.qty / total >= 0.7) top.dominant = true;
  }
  return g;
}
export function paPickBest(an: string, prods: PaProd[], groups: ReturnType<typeof paGroups>): PaProd | null {
  let best: PaProd | null = null;
  for (const p of prods) {
    if (!an.includes(p.key)) continue;
    const g = groups[p.key];
    if (g.n > 1) {
      if (p.ver) { if (!an.includes(p.ver)) continue; }
      else { if (g.noVer > 1 && !p.dominant) continue; if (g.vers.some((v) => an.includes(v))) continue; }
    }
    if (!best || p.key.length > best.key.length || (p.key === best.key && p.ver && an.includes(p.ver))) best = p;
  }
  return best;
}

const median = (arr: number[]) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const marginRate = (price: number, supply: number) => price > 0 && supply > 0 ? +(((price - supply * 1.1) / price) * 100).toFixed(1) : null;   // 워크스페이스 판매 성과와 같은 식(공급가 VAT 별도)

async function collect(D: string) {
  const { errors, safe } = safeCollector();
  const cur14 = [addDays(D, -13), D], cur7 = [addDays(D, -6), D], prev7 = [addDays(D, -13), addDays(D, -7)];
  const todayKst = addDays(D, 1);

  // 첫 호출(가벼움)로 카페24 토큰 확보 후 병렬
  const cm = await safe("카테고리 지도", () => callFn("cafe24-analytics", { action: "categorymap" }));
  const [newCat, s14, s7, sPrev, ben, active] = await Promise.all([
    safe("신상품 목록", () => callFn("cafe24-analytics", { action: "category_products", category_no: String(NEW_CAT) })),
    safe("상품 조회·주문(14일)", () => callFn("cafe24-analytics", { action: "summary", start_date: cur14[0], end_date: cur14[1] })),
    safe("상품 조회·주문(7일)", () => callFn("cafe24-analytics", { action: "summary", start_date: cur7[0], end_date: cur7[1] })),
    safe("상품 조회·주문(직전 7일)", () => callFn("cafe24-analytics", { action: "summary", start_date: prev7[0], end_date: prev7[1] })),
    safe("혜택(프로모션)", () => callFn("cafe24-analytics", { action: "benefits" })),
    safe("Meta 활성 광고", () => callFn("meta-ads", { action: "activeads" })),
  ]);
  const newNos: number[] = ((newCat?.product_nos ?? []) as unknown[]).map(Number).filter((n) => n > 0);
  // Meta 활성 광고 수집이 실패하면(2026-09-15 실사례 'Meta API 400: Invalid parameter') 광고 수는 0이 아니라 '모름'(null)으로 남긴다 —
  // 0으로 두면 보고서가 "광고 전면 공백"처럼 오판한다(실제로는 광고가 돌고 있었음).
  const adsKnown = !!active;
  const cats = (cm?.categories ?? {}) as Record<string, { name: string; depth: number; parent: number }>;
  const prodCats = (cm?.products ?? {}) as Record<string, number[]>;
  const leafCat = (no: number): string => {
    const list = (prodCats[String(no)] ?? []).map((c) => ({ no: c, ...(cats[String(c)] ?? { name: "", depth: 0, parent: 0 }) })).filter((c) => c.name && !SPECIAL_CATS.test(c.name));
    list.sort((a, b) => b.depth - a.depth);
    return list[0]?.name ?? "";
  };
  const rows14 = ((s14?.rows ?? []) as Row[]), rows7 = ((s7?.rows ?? []) as Row[]), rowsPrev = ((sPrev?.rows ?? []) as Row[]);
  const m14 = new Map(rows14.map((r) => [Number(r.product_no), r]));
  const m7 = new Map(rows7.map((r) => [Number(r.product_no), r]));
  const mPrev = new Map(rowsPrev.map((r) => [Number(r.product_no), r]));
  const nameOf = (no: number) => String(m14.get(no)?.product_name ?? m7.get(no)?.product_name ?? "");

  // ── 판매 TOP10(14일 결제수량) · 급상승(7일 vs 직전 7일, 매출 담당과 같은 규칙) ──
  const top10 = [...rows14].sort((a, b) => num(b.order_qty) - num(a.order_qty)).slice(0, 10).map((r, i) => ({ no: Number(r.product_no), rank: i + 1 }));
  const trending = rows7.filter((r) => num(r.order_qty) >= 10).map((r) => {
    const p = mPrev.get(Number(r.product_no)); const prevQty = p ? num(p.order_qty) : 0;
    return { no: Number(r.product_no), qty7: num(r.order_qty), prevQty, score: (num(r.order_qty) + 5) / (prevQty + 5) };
  }).filter((r) => r.qty7 > r.prevQty).sort((a, b) => b.score - a.score).slice(0, 6);
  const focusSet = new Map<number, { rank10: number; trending: boolean; qty7?: number; prevQty?: number }>();
  for (const t of top10) focusSet.set(t.no, { rank10: t.rank, trending: false });
  for (const t of trending) { const e = focusSet.get(t.no); if (e) { e.trending = true; e.qty7 = t.qty7; e.prevQty = t.prevQty; } else focusSet.set(t.no, { rank10: 0, trending: true, qty7: t.qty7, prevQty: t.prevQty }); }
  // 집중 상품 = 급상승 3개 + TOP10 3개 (보고서 시간 제한 때문에 하루 6개). TOP10은 **순환**: 최근 보고서에서 다룬 상품은 뒤로 미뤄
  // 며칠에 걸쳐 10개 전부를 돌아가며 다룬다 (사용자 요구: TOP10 전부에 대해 소재·상세 제안).
  const recentRes = await rest(`agent_reports?agent=eq.${AGENT}&status=eq.ok&select=report_date,report&order=created_at.desc&limit=4`);
  const recent: Row[] = recentRes.ok ? await recentRes.json() : [];
  const lastCovered = new Map<string, string>();   // 상품명 → 마지막으로 다룬 기준일
  for (const r of recent) for (const f of (((r.report ?? {}) as Row).focus ?? []) as Row[]) if (!lastCovered.has(String(f.name))) lastCovered.set(String(f.name), String(r.report_date));
  const trendPick = trending.slice(0, 3).map((t) => t.no);
  const topPick = top10.filter((t) => !trendPick.includes(t.no))
    .sort((a, b) => (lastCovered.get(nameOf(a.no)) ?? "0000").localeCompare(lastCovered.get(nameOf(b.no)) ?? "0000") || a.rank - b.rank)
    .slice(0, FOCUS_MAX - trendPick.length).map((t) => t.no);
  const focusNos = [...trendPick, ...topPick];

  // ── 상품 정보: 신상품 전체(할인 없이 1회) + 후보(신상품 중 조회 상위 24 + 집중 상품)는 할인가 포함 ──
  const info = await safe("신상품 상품정보", () => callFn("cafe24-analytics", { action: "productinfo", product_nos: newNos.join(",") }));
  const infoMap = new Map(((info?.products ?? []) as Row[]).map((p) => [Number(p.product_no), p]));
  const newTopNos = [...newNos].sort((a, b) => num(m14.get(b)?.views) - num(m14.get(a)?.views)).slice(0, 24);
  const discNos = [...new Set([...newTopNos, ...focusNos])];
  const disc = await safe("할인가(후보 상품)", () => callFn("cafe24-analytics", { action: "productinfo", with_discount: "1", product_nos: discNos.join(",") }));
  for (const p of ((disc?.products ?? []) as Row[])) infoMap.set(Number(p.product_no), { ...(infoMap.get(Number(p.product_no)) ?? {}), ...p });
  const byProduct = (ben?.by_product ?? {}) as Record<string, Row[]>;
  const promosOf = (no: number) => (byProduct[String(no)] ?? []).map((b) => `${b.name}: ${b.desc}${b.end ? ` (~${String(b.end).slice(5)})` : ""}`);

  // ── 광고 매칭 (활성 광고 전체 → 상품) ──
  const allProds: PaProd[] = [...new Map([...rows14, ...rows7].map((r) => [Number(r.product_no), String(r.product_name ?? "")])).entries()]
    .map(([no, name]) => ({ no, name, key: paNorm(paKey(name)), ver: paVerTok(name) ? paNorm(paVerTok(name)!) : null, qty: num(m14.get(no)?.order_qty) }))
    .filter((p) => p.key.length >= 3);
  const groups = paGroups(allProds);
  const adsByProduct = new Map<number, Row[]>();
  for (const ad of ((active?.ads ?? []) as Row[])) {
    const best = paPickBest(paNorm(String(ad.ad_name ?? "")), allProds, groups);
    if (!best) continue;
    (adsByProduct.get(best.no) ?? adsByProduct.set(best.no, []).get(best.no)!).push(ad);
  }
  for (const list of adsByProduct.values()) list.sort((a, b) => num(b.spend) - num(a.spend));

  // ── 신상품 4분면 ──
  const ageOf = (no: number) => { const c = String(infoMap.get(no)?.created_date ?? "").slice(0, 10); return c ? Math.round((new Date(`${todayKst}T12:00:00Z`).getTime() - new Date(`${c}T12:00:00Z`).getTime()) / 86400000) : null; };
  const newProducts = newNos.map((no) => {
    const r = m14.get(no), r7 = m7.get(no), p = infoMap.get(no) ?? {};
    const price = num(p.price), supply = num(p.supply_price), dprice = p.discount_price != null ? num(p.discount_price) : null;
    const ads = adsByProduct.get(no) ?? [];
    return {
      product_no: no, name: String(p.product_name ?? r?.product_name ?? ""), category: leafCat(no),
      created: String(p.created_date ?? "").slice(0, 10) || null, age_days: ageOf(no), sold_out: String(p.sold_out ?? "") === "T",
      price, discount_price: dprice && dprice < price ? dprice : null, margin_rate: marginRate(price, supply), promos: promosOf(no),
      views_14d: num(r?.views), orders_14d: num(r?.order_count), qty_14d: num(r?.order_qty), rate_14d: num(r?.rate), qty_7d: num(r7?.order_qty), views_7d: num(r7?.views),
      active_ads: adsKnown ? ads.length : null, ad_spend_total: adsKnown ? Math.round(ads.reduce((t, a) => t + num(a.spend), 0)) : null,
    };
  });
  const eligible = newProducts.filter((p) => (p.age_days ?? 99) >= MIN_AGE_DAYS && p.views_14d >= MIN_VIEWS);
  const medViews = median(eligible.map((p) => p.views_14d)), medRate = median(eligible.map((p) => p.rate_14d));
  const quadrantOf = (p: typeof newProducts[number]) => {
    if ((p.age_days ?? 99) < MIN_AGE_DAYS) return "데이터 부족(등록 3일 미만)";
    if (p.views_14d < MIN_VIEWS) return p.active_ads !== 0 ? "노출 거의 없음" : "노출 거의 없음(광고 없음)";
    const hv = p.views_14d >= medViews, hr = p.rate_14d >= medRate;
    if (hr && !hv) return "노출 부족";
    if (hr && hv) return "판매 확대";
    if (!hr && hv) return "상세·가격 점검";
    return p.active_ads !== 0 ? "집중도 낮춤" : "집중도 낮춤(광고 미테스트)";   // null(수집 실패)이면 꼬리표 없이
  };
  const matrix = newProducts.map((p) => ({ ...p, quadrant: quadrantOf(p) }))
    .sort((a, b) => (b.rate_14d * Math.log1p(b.views_14d)) - (a.rate_14d * Math.log1p(a.views_14d)));

  // ── 집중 상품: 자기 광고 + 같은 카테고리 우수 상품의 참고 소재 ──
  const catOf = new Map<number, string>();
  for (const r of rows14) catOf.set(Number(r.product_no), leafCat(Number(r.product_no)));
  const adIds = new Set<string>();
  const focusDraft = focusNos.map((no) => {
    const own = (adsByProduct.get(no) ?? []).slice(0, 4);
    own.forEach((a) => adIds.add(String(a.ad_id)));
    const cat = catOf.get(no) ?? leafCat(no);
    const peers = rows14.filter((r) => Number(r.product_no) !== no && catOf.get(Number(r.product_no)) === cat && num(r.order_qty) >= 10)
      .sort((a, b) => num(b.order_qty) - num(a.order_qty)).slice(0, 3).map((r) => Number(r.product_no));
    const refAds: Row[] = [];
    for (const pn of peers) {
      const best = (adsByProduct.get(pn) ?? []).filter((a) => num(a.spend) >= 100000).sort((a, b) => num(b.roas) - num(a.roas)).slice(0, 2);
      best.forEach((a) => { adIds.add(String(a.ad_id)); refAds.push({ ...a, product_no: pn, product_name: nameOf(pn) }); });
    }
    return { no, cat, own, peers, refAds };
  });
  // ── 트렌드(네이버 데이터랩 순위표: 어제 vs 7일 전) — ⚠ 다른 요청과 겹치면 데이터랩 응답이 멈춰(엣지 실측) **혼자 먼저** 순차로 받는다 (약 5초) ──
  const prevDay = addDays(D, -7);
  const rankPairs: ({ cid: string; cur: Map<string, number>; prev: Map<string, number> } | null)[] = [];
  for (const cid of Object.keys(NAVER_CATS)) {
    rankPairs.push(await safe(`네이버 데이터랩(${NAVER_CATS[cid]})`, async () => ({ cid, cur: await naverCategoryRanks(cid, D), prev: await naverCategoryRanks(cid, prevDay) })));
  }
  // 광고 카드 + 날씨는 병렬
  const [cards, weather] = await Promise.all([
    adIds.size ? safe("광고 소재 카드", () => callFn("meta-ads", { action: "adcards", ad_ids: [...adIds].slice(0, 60).join(","), start_date: cur14[0], end_date: cur14[1] })) : Promise.resolve(null),
    safe("날씨(서울)", () => seoulWeather()),
  ]);
  const matchPool = [...new Map([...rows14, ...rows7].map((r) => [Number(r.product_no), { no: Number(r.product_no), name: String(r.product_name ?? ""), category: leafCat(Number(r.product_no)) }])).values()];
  const qtyOf = (no: number) => num(m14.get(no)?.order_qty);
  const trendCats = rankPairs.filter((x): x is { cid: string; cur: Map<string, number>; prev: Map<string, number> } => !!x).map((x) => {
    const rising = risingKeywords(x.cur, x.prev).slice(0, 25).map((r) => {
      const ours = matchKeyword(r.keyword, matchPool).map((p) => ({ ...p, qty_14d: qtyOf(p.no), is_new: newNos.includes(p.no) })).sort((a, b) => b.qty_14d - a.qty_14d).slice(0, 4);
      return { ...r, our_products: ours };
    });
    return { category: NAVER_CATS[x.cid], top10: [...x.cur.entries()].sort((a, b) => a[1] - b[1]).slice(0, 10).map(([k]) => k), rising };
  });
  const cardMap = new Map(((cards?.ads ?? []) as Row[]).map((a) => [String(a.ad_id), a]));
  const adView = (a: Row) => {
    const c = cardMap.get(String(a.ad_id)) ?? {};
    const p = (c.period ?? null) as Row | null;
    return {
      ad_id: String(a.ad_id), name: String(c.name ?? a.ad_name ?? ""), adset: String(c.adset_name ?? ""), is_video: !!c.is_video, created: c.created_time ?? null,
      thumb: String(c.thumb ?? ""), body: String(c.body ?? "").slice(0, 160), title: String(c.title ?? ""),
      since_start: { spend: Math.round(num(a.spend)), purchases: num(a.purchases), roas: +num(a.roas).toFixed(2), frequency: +num(a.frequency).toFixed(2) },
      last14: p ? { spend: Math.round(num(p.spend)), purchases: num(p.purchases), roas: +num(p.roas).toFixed(2), ctr: +num(p.ctr).toFixed(2), frequency: +num(p.frequency).toFixed(2), impressions: num(p.impressions) } : null,
    };
  };
  const focus = focusDraft.map((f) => {
    const p = infoMap.get(f.no) ?? {}, r = m14.get(f.no), meta = focusSet.get(f.no)!;
    const price = num(p.price), supply = num(p.supply_price), dprice = p.discount_price != null ? num(p.discount_price) : null;
    return {
      product_no: f.no, name: nameOf(f.no) || String(p.product_name ?? ""), category: f.cat,
      why: [meta.trending ? `급상승(7일 ${meta.prevQty}→${meta.qty7}개)` : "", meta.rank10 ? `14일 판매 ${meta.rank10}위` : ""].filter(Boolean).join(" · "),
      views_14d: num(r?.views), qty_14d: num(r?.order_qty), rate_14d: num(r?.rate),
      price, discount_price: dprice && dprice < price ? dprice : null, margin_rate: marginRate(price, supply), promos: promosOf(f.no), sold_out: String(p.sold_out ?? "") === "T",
      is_new: newNos.includes(f.no),
      own_ads: f.own.map(adView),
      reference_ads: f.refAds.map((a) => ({ product_name: String(a.product_name), ...adView(a) })),
    };
  });

  return {
    base_date: D, base_dow: dow(D), generated_at: new Date().toISOString(),
    periods: { last14: cur14, last7: cur7, prev7 },
    rules: {
      matrix: `신상품(NEW ARRIVALS ${newNos.length}개) 중 등록 ${MIN_AGE_DAYS}일↑·14일 조회 ${MIN_VIEWS}↑인 ${eligible.length}개의 중앙값(조회 ${Math.round(medViews)}, 주문율 ${medRate}%) 기준 4분면`,
      margin: "마진율 = (판매가 − 공급가×1.1) ÷ 판매가. 낮으면 밀어도 남는 게 적음",
      ads: "since_start = 광고 시작~어제 누적, last14 = 최근 14일. 빈도(frequency) 3 이상이면 같은 사람에게 반복 노출 = 소재 피로",
      ads_status: adsKnown ? "정상" : "⚠ Meta 활성 광고 수집 실패 — 모든 상품의 active_ads·own_ads가 비어 있는 것은 '광고 없음'이 아니라 '모름'. 광고 개수·소재·광고 착수 여부를 판단하지 말고 필요하면 '광고 정보 확인 불가'라고만 쓸 것",
    },
    ads_known: adsKnown,
    new_arrivals: { count: newNos.length, eligible: eligible.length, median_views_14d: Math.round(medViews), median_rate_14d: medRate, matrix },
    focus,
    top10: top10.map((t) => ({ rank: t.rank, product_no: t.no, name: nameOf(t.no), qty_14d: num(m14.get(t.no)?.order_qty), rate_14d: num(m14.get(t.no)?.rate), active_ads: adsKnown ? (adsByProduct.get(t.no) ?? []).length : null })),
    trending: trending.map((t) => ({ product_no: t.no, name: nameOf(t.no), qty_7d: t.qty7, qty_prev7d: t.prevQty })),
    benefits_active: num(ben?.active_count),
    trends: {
      basis: `네이버 데이터랩 쇼핑인사이트 '분야별 인기 검색어'(여성) — 기준일 ${D} 상위 100 vs 7일 전(${prevDay}). new = 100위 안 새 진입, up = 15계단 이상 상승. our_products = 이름·카테고리로 찾은 우리 상품(14일 판매량 순)`,
      naver: trendCats,
      weather: weather ?? null,
      not_available: ["우리 몰 내부 검색어(카페24 통로 없음)", "무신사·지그재그·에이블리(공개 통로 없음)"],
    },
    errors,
  };
}

// Claude에는 4분면 표를 줄이고(판정 가능 상품 + 핵심 열), 광고는 필요한 열만
function forLLM(data: Row) {
  const na = data.new_arrivals as Row;
  const matrix = ((na.matrix ?? []) as Row[]).map((p) => ({
    name: p.name, category: p.category, quadrant: p.quadrant, age_days: p.age_days, sold_out: p.sold_out || undefined,
    views_14d: p.views_14d, rate_14d: p.rate_14d, qty_14d: p.qty_14d, margin_rate: p.margin_rate, discount_price: p.discount_price ?? undefined, price: p.price,
    promos: (p.promos as string[]).length ? p.promos : undefined, active_ads: p.active_ads,
  }));
  const slimAd = (a: Row) => ({ name: a.name, is_video: a.is_video, created: a.created, body: a.body, since_start: a.since_start, last14: a.last14 });
  const focus = ((data.focus ?? []) as Row[]).map((f) => ({
    ...f, product_no: undefined,
    own_ads: ((f.own_ads ?? []) as Row[]).map(slimAd),
    reference_ads: ((f.reference_ads ?? []) as Row[]).map((a) => ({ product_name: a.product_name, ...slimAd(a) })),
  }));
  const tr = (data.trends ?? {}) as Row;
  const w = (tr.weather ?? null) as Row | null;
  const trends = { ...tr, weather: w ? { summary: w.summary, next_7d: w.next_7d } : null };
  return { ...data, new_arrivals: { ...na, matrix }, focus, trends };
}

// Claude가 봐야 할 이미지: 집중 상품별 자기 최상위 소재 1장 + 참고 소재 (총 12장 이내)
function images(data: Row): LLMImage[] {
  const out: LLMImage[] = [];
  const fmtPerf = (a: Row) => { const l = (a.last14 ?? a.since_start) as Row | null; return l ? `14일 지출 ${Math.round(num(l.spend) / 10000)}만·구매 ${l.purchases}·ROAS ${l.roas}${l.ctr != null ? `·CTR ${l.ctr}%` : ""}` : ""; };
  const focus = (data.focus ?? []) as Row[];
  for (const f of focus) {
    const own = ((f.own_ads ?? []) as Row[]).find((a) => a.thumb);
    if (own) out.push({ url: String(own.thumb), label: `[집중 상품 소재] ${f.name} — 광고 '${own.name}' (${own.is_video ? "영상" : "이미지"}, ${fmtPerf(own)})` });
  }
  let refs = 0;
  for (const f of focus) {
    for (const a of ((f.reference_ads ?? []) as Row[])) {
      if (refs >= REF_IMG_MAX || out.length >= 12) break;
      if (!a.thumb) continue;
      out.push({ url: String(a.thumb), label: `[같은 카테고리 우수 소재] ${a.product_name} — 광고 '${a.name}' (${a.is_video ? "영상" : "이미지"}, ${fmtPerf(a)}) ← ${f.name}의 참고용` });
      refs++;
    }
  }
  return out.slice(0, 12);
}

// Claude 판단에 숫자·판정을 코드가 붙인다
function postProcess(report: Row, data: Row): Row {
  const matrix = (((data.new_arrivals ?? {}) as Row).matrix ?? []) as Row[];
  const byName = new Map(matrix.map((p) => [String(p.name), p]));
  const mt = ((report.matrix ?? []) as Row[]).map((x) => {
    const p = byName.get(String(x.name)) ?? {};
    return { name: x.name, strategy: x.strategy, quadrant: p.quadrant ?? "", views_14d: num(p.views_14d), rate_14d: p.rate_14d ?? null, qty_14d: num(p.qty_14d), margin_rate: p.margin_rate ?? null, discount_price: p.discount_price ?? null, price: num(p.price), promos: p.promos ?? [], age_days: p.age_days ?? null, active_ads: p.active_ads ?? null, sold_out: !!p.sold_out, product_no: p.product_no ?? null };
  });
  const focus = (data.focus ?? []) as Row[];
  const fByName = new Map(focus.map((f) => [String(f.name), f]));
  const fc = ((report.focus ?? []) as Row[]).map((x) => {
    const f = fByName.get(String(x.name)) ?? {};
    return { ...x, product_no: f.product_no ?? null, why: f.why ?? "", category: f.category ?? "", views_14d: num(f.views_14d), qty_14d: num(f.qty_14d), rate_14d: f.rate_14d ?? null, margin_rate: f.margin_rate ?? null, promos: f.promos ?? [], own_ads: ((f.own_ads ?? []) as Row[]).slice(0, 4), reference_ads: ((f.reference_ads ?? []) as Row[]).slice(0, 4) };
  });
  return { ...report, matrix: mt, focus: fc };
}

const SYSTEM = `당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 상품 전략 담당자입니다. 매일 아침 대표에게 "어떤 상품에 힘을 실을지, 광고 소재와 상세를 어떻게 바꿀지"를 보고합니다.

1) 신상품 4분면 (new_arrivals.matrix — quadrant는 코드가 이미 판정했습니다. 그 판정을 바꾸지 말고 전략만 씁니다):
- '노출 부족'(주문율↑ 조회↓): 조회수를 올릴 방법 — 진열 순서 상향, 광고 테스트 착수(active_ads가 0이면 특히), 메인·기획전 노출, 인스타 게시.
- '판매 확대'(둘 다↑): 판매를 키울 방법 — 광고 예산 확대, 색상·사이즈 재고 확보, 1+1·세트 구성, 후속 소재.
- '상세·가격 점검'(조회↑ 주문율↓): 상세페이지·가격·옵션 점검. 할인 중인데도 낮으면 상품 자체 문제일 수 있음.
- '집중도 낮춤'(둘 다↓): 대표의 판단대로 집중도를 낮추되, '(광고 미테스트)'가 붙은 상품은 노출 부족 탓일 수 있어 "한 번 테스트 후 판단"으로 씁니다.
- '데이터 부족'·'노출 거의 없음'은 판단을 보류하고 필요하면 한 줄만.
- rules.ads_status가 '정상'이 아니면(광고 수집 실패) active_ads가 null이고 own_ads가 비어 있습니다. 이때는 "광고 0개"·"광고 공백"·"광고 착수" 같은 광고 유무 판단을 절대 하지 말고, headline·summary에도 광고 얘기를 넣지 않으며, 소재 분석 칸에는 '광고 정보 확인 불가(수집 실패)'라고만 씁니다.
- 마진율이 낮은 상품(예: 35% 미만)은 밀어도 남는 게 적으니 우선순위를 낮추고, 마진 좋은 '판매 확대' 상품이 최우선입니다. 적용 중인 혜택(promos: 1+1·기간할인)과 할인가를 전략에 반영합니다.
- matrix에는 '판매 확대'·'노출 부족'·'상세·가격 점검' 중 중요한 순으로 최대 15개만 넣고, strategy는 30자 이내 한 줄. (보고서 생성 시간 제한이 있어 짧게)

2) 집중 상품 (focus — 급상승 상품과 판매 TOP10, 최대 ${FOCUS_MAX}개):
- own_ads(그 상품에 붙은 소재)의 since_start(누적)·last14(최근 14일) 성과를 소재 단위로 비교해 어떤 소재가 판매를 견인하는지 짚습니다. CTR은 첫 3초의 힘, ROAS는 판매력, 빈도 3 이상은 소재 피로입니다. 영상/이미지, 광고 문구(body)의 소구점을 근거로 씁니다.
- reference_ads(같은 카테고리에서 이미 잘 되는 상품의 우수 소재)와 첨부한 썸네일 이미지를 직접 보고, 그 소재들의 공통 특성(착용컷/디테일컷, 모델 포즈, 색감, 문구 위치, 영상 구성)을 뽑아 이 상품에 추가할 소재 컨셉을 제안합니다.
- reels_hooks: 릴스 첫 3초에 말할 훅 멘트 3개, 각 25자 이내, 상품의 실제 특징(핏·소재·활용)과 광고 문구에 나온 소구점에 근거. 과장·허위 금지.
- detail_focus: 상세페이지에서 앞쪽에 내세우거나 강조할 것 한 줄(반품 사유·주문율·광고 반응을 근거로).
- plan: 마진·혜택·재고(sold_out)를 고려한 판매 계획 한 줄 (예산 확대는 '대표 확인 후').
- 광고가 하나도 없는 집중 상품은 "광고 착수" 제안이 첫 번째입니다(rules.ads_status가 '정상'일 때만).

3) 트렌드·날씨 (trends):
- trends.naver[].rising = 네이버에서 새로 뜨거나 크게 오른 검색어(정해 둔 목록이 아니라 순위표에서 자동 발견). 브랜드명(에고이스트·시슬리·자라 등)은 무시하고 **품목·소재·스타일 키워드**만 봅니다.
- our_products가 있는 키워드 → 그 상품을 앞세우는 제안(진열 상향, 광고 문구·상품명에 키워드 반영, 기획전). 없는 키워드 중 우리 스타일(여성 데일리·편안한 핏)에 맞는 것 → "소싱 검토" 한 줄.
- weather.summary: 앞으로 7일 최저기온이 15도 아래로 처음 내려가는 날, 지난주 대비 기온 변화, 비 오는 날을 보고 카테고리 타이밍을 제안합니다(예: 기온 하강 → 가디건·니트·자켓 앞당기기, 비 → 배송·아우터). 날씨는 유행보다 매출을 빨리 움직입니다.
- trend_actions에 키워드 기반 제안을 최대 6개, weather_plan에 날씨 기반 한 줄.

4) actions는 오늘 실행할 구체적인 것 3개(광고팀·상품팀 위주). 트렌드·날씨에서 나온 것도 포함될 수 있습니다.
${COMMON_RULES}`;

const SCHEMA = reportSchema({
  highlights: "밀어줄 상품·잘 되는 소재 등 좋은 신호. 최대 5개",
  warnings: "조회는 많은데 안 팔리는 상품, 소재 피로, 마진 낮은 상품에 광고 집중 등 나쁜 신호. 최대 5개",
  actions: "오늘 실행할 구체적 액션 정확히 3개",
  extra: {
    matrix: {
      type: "array",
      items: { type: "object", properties: { name: { type: "string", description: "new_arrivals.matrix[].name 그대로" }, strategy: { type: "string", description: "40자 이내 한 줄 전략" } }, required: ["name", "strategy"], additionalProperties: false },
      description: "신상품 전략 표. 판매 확대·노출 부족·상세·가격 점검 중 중요한 순 최대 15개. 판정·숫자는 코드가 채움",
    },
    focus: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "focus[].name 그대로" },
          driver: { type: "string", description: "어떤 소재가 판매를 견인하는지, 근거 포함 80자 이내" },
          creative_plan: { type: "string", description: "추가할 소재 컨셉 (참고 소재 특성 근거) 100자 이내" },
          reels_hooks: { type: "array", items: { type: "string" }, description: "릴스 첫 3초 훅 멘트 3개, 각 25자 이내" },
          detail_focus: { type: "string", description: "상세페이지에서 강조할 것 80자 이내" },
          plan: { type: "string", description: "마진·혜택·재고 고려한 판매 계획 80자 이내" },
        },
        required: ["name", "driver", "creative_plan", "reels_hooks", "detail_focus", "plan"], additionalProperties: false,
      },
      description: "집중 상품 카드. focus 전부",
    },
    trend_actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "trends.naver[].rising[].keyword 그대로" },
          signal: { type: "string", description: "무엇이 올랐는지 20자 이내 (예: '40위→2위', '새 진입 38위')" },
          our_products: { type: "string", description: "관련 우리 상품명 (없으면 '해당 상품 없음')" },
          suggestion: { type: "string", description: "제안 60자 이내" },
        },
        required: ["keyword", "signal", "our_products", "suggestion"], additionalProperties: false,
      },
      description: "급상승 키워드 기반 제안. 품목·소재·스타일 키워드만(브랜드 제외), 최대 5개",
    },
    weather_plan: { type: "string", description: "날씨 기반 카테고리 타이밍 한 줄, 80자 이내" },
  },
});

// effort low (2026-09-13): 생각 토큰을 줄여 생성 시간 단축 — 작성 단계는 벽시계 150초 안에 끝나야 함(546 실사례). 판단 규칙은 프롬프트에 다 있어 low로 충분.
export const DEF: AgentDef = { agent: AGENT, label: "상품 전략 담당", system: SYSTEM, schema: SCHEMA, collect, forLLM, postProcess, images, effort: "low" };

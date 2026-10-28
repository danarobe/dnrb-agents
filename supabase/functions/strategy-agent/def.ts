// ═══════════════════════════════════════════════
// 상품 전략 담당 (에이전트 3호, 2026-09-12) — 공통 뼈대는 ../_shared/agent.ts
//   매일 08:30 KST (pg_cron `strategy-agent-morning`) 또는 앱의 [지금 실행].
//   사용자 요구(2026-09-12):
//     1) 신상품 = 카페24 NEW ARRIVALS 카테고리(상품 관리 시스템 아님, 세일 카테고리 제외). 조회수×주문율 4분면으로
//        어디에 집중할지 판정 — 주문율↑조회↓=노출 부족 / 둘 다↑=판매 확대 / 둘 다↓=집중도 낮춤 / 조회↑주문율↓=상세·가격 점검.
//        마진율·적용 중인 혜택(1+1·기간할인)·등록일·품절을 함께 고려.
//     2) 급상승 상품과 판매 TOP10 = 집중 상품: (2026-10-27 개편) 소재 단위 분석·참고 소재·견인 소재·릴스 훅은 전부 뺌(광고 소재 담당 몫).
//        대신 조회·주문율·판매·마진·ON 광고 수·14일 광고비·14일 ROAS·진행 중 이벤트를 숫자로 주고, Claude는 '현재 상태 한 줄 + 판매 확대 액션 2~3개'만 쓴다.
//   수집(워크스페이스 함수, x-agent-secret): categorymap · category_products(33) · summary(14일/7일/직전7일) ·
//     productinfo(+with_discount 후보만 — 91개 전부는 62초) · benefits(by_product) · activeads · adcards
//   광고↔상품 매칭 = 워크스페이스 판매 성과 'ON 광고' 규칙(pa*)을 그대로 이식(핵심명·ver 토큰·자모 비교).
// ═══════════════════════════════════════════════
import { addDays, callFn, findByName, COMMON_RULES, dow, num, reportSchema, rest, Row, safeCollector, AgentDef } from "../_shared/agent.ts";
import { matchKeyword, NAVER_CATS, naverCategoryRanks, risingKeywords, seoulWeather } from "../_shared/trends.ts";
import { json } from "../_shared/util.ts";

const AGENT = "strategy";
const NEW_CAT = 33;                 // NEW ARRIVALS
const MIN_AGE_DAYS = 3, MIN_VIEWS = 30;
const FOCUS_MAX = 5;   // 6→5 (2026-09-13): 작성 단계 150초 벽시계 한도 — 출력 토큰을 줄여 생성 시간 단축
const SPECIAL_CATS = /new arrivals|best|sale|세일|size pick|autumn|summer|winter|spring|🍁|🌞|⌛|🔎/i;

// ── 광고명 ↔ 상품명 매칭 (워크스페이스 index.html의 pa* 이식) ──
const PA_VER = /(?<![a-z])ver/i;
// ⚠ 2026-09-23: 카페24 상품명 끝에 ' - Danarobe' 같은 브랜드 접미사가 붙기 시작해(SEO) 핵심명이 '클레르 블라우스 (5 colors) - Danarobe'가 되며
//   광고가 하나도 안 붙던 사례(클레르·세러데이·플랫슈즈 '광고 0개' 오판) → 접미사를 먼저 떼고 괄호를 벗긴다. 워크스페이스 index.html paKey도 동일하게.
const BRAND_SUFFIX = /\s*[-–—|]\s*(danarobe|dana|다나로브|다나)\s*$/i;
export function paKey(name: string): string {
  let s = String(name || "").trim().replace(BRAND_SUFFIX, "").trim();
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
// 광고명 줄임말 → 상품명 표기 (2026-09-30, 워크스페이스 index.html PA_ALIASES와 동일): '하울 브이 니트 ops' = 원피스 — 광고 0개 오판 방지
const PA_ALIASES: [RegExp, string][] = [[/(?<![a-z])ops(?![a-z])/gi, "원피스"]];
const paAlias = (t: string) => PA_ALIASES.reduce((s, [re, to]) => s.replace(re, to), t);
export const paNorm = (t: string) => paJamo(paAlias(String(t || "").normalize("NFC"))).replace(/\s+/g, "").replace(/ver\./gi, "ver").toLowerCase();
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

// ── 매칭 자기 점검 (2026-09-23): "광고 0개"를 조용히 쓰지 않기 위한 장치 ──
//   상품 핵심명의 앞 두 어절(예: '클레르 블라우스')이 어떤 광고명에라도 들어 있는데 정식 매칭(paPickBest)이 0개면 → 규칙이 깨진 것으로 의심.
//   (접미사·표기 규칙이 바뀌어 매칭이 깨진 9/23 사례처럼, 원인을 몰라도 '의심'은 잡힌다.)
export function paLooseHits(name: string, adNames: string[]): number {
  const words = paKey(name).split(/\s+/).filter((w) => w.length >= 2).slice(0, 2);
  if (!words.length) return 0;
  const needle = paNorm(words.join(" "));
  return needle.length >= 4 ? adNames.filter((n) => n.includes(needle)).length : 0;
}
// 매칭 결과 전체를 점검한다. unmatchedAdNames = 어떤 상품에도 안 붙은 광고명(정규화) — 형제 상품(브이넥/라운드)에 정상으로 붙은 광고는 후보에서 빠진다.
//   suspects = 정식 매칭 0개인데 미매칭 광고명에 상품명 앞 두 어절이 들어 있는 상품(예: 광고명이 '하울 브이 니트 ops'처럼 줄임말인 경우 — 실제 누락).
//   status: ok | suspect — 'suspect'는 체계적으로 깨진 것(매칭 비율 35% 미만 또는 의심 상품 5개 이상, 접미사 규칙 변경 같은 경우)일 때만.
//   개별 suspects는 상태와 무관하게 그 상품의 광고 수를 null(모름)로 두고 rules에 '확인 필요'로 적는다.
export function paMatchAudit(products: { no: number; name: string; qty: number }[], adsByProduct: Map<number, unknown[]>, totalAds: number, unmatchedAdNames: string[]) {
  const suspects: { no: number; name: string; loose_hits: number }[] = [];
  for (const p of products) {
    if ((adsByProduct.get(p.no) ?? []).length) continue;
    const hits = paLooseHits(p.name, unmatchedAdNames);
    if (hits >= 1) suspects.push({ no: p.no, name: p.name, loose_hits: hits });
  }
  const matched = [...adsByProduct.values()].reduce((t, l) => t + l.length, 0);
  const share = totalAds ? matched / totalAds : 0;
  const status = suspects.length >= 5 || (totalAds >= 30 && share < 0.35) ? "suspect" : "ok";
  return { status, matched_ads: matched, total_ads: totalAds, matched_share: Math.round(share * 100), suspects: suspects.slice(0, 10) };
}

const median = (arr: number[]) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// 워크스페이스 판매 성과와 같은 식: (판매가 − 마진 원가) ÷ 판매가. 마진 원가 = 공급가 × 1.1(VAT 별도),
//   **중국 사입 상품은 워크스페이스 productinfo의 cost_vat**(= 실질 단가 + 실제 수입 부가세 몫 — 2026-10-22 사용자 요청 "에이전트 마진율에도 똑같이").
export const marginRate = (price: number, supply: number, costVat?: number | null) => {
  const cost = costVat != null && costVat > 0 ? costVat : supply * 1.1;
  return price > 0 && cost > 0 ? +(((price - cost) / price) * 100).toFixed(1) : null;
};

// ── 데이터랩 순위표 저장본 (trend_ranks) ──
type RankMap = Map<string, number>;
const rankRow = (m: RankMap) => Object.fromEntries([...m.entries()]);
const rowRank = (o: unknown): RankMap => new Map(Object.entries((o ?? {}) as Record<string, number>).map(([k, v]) => [k, Number(v)]));
async function readRanks(days: string[]): Promise<Map<string, Map<string, RankMap>>> {   // day → cid → ranks
  const out = new Map<string, Map<string, RankMap>>();
  if (!days.length) return out;
  const r = await rest(`trend_ranks?day=in.(${days.join(",")})&gender=eq.f&n=gt.0&select=day,cid,ranks`);
  for (const x of (r.ok ? (await r.json()) as Row[] : [])) {
    const d = String(x.day); if (!out.has(d)) out.set(d, new Map());
    out.get(d)!.set(String(x.cid), rowRank(x.ranks));
  }
  return out;
}
async function saveRanks(day: string, cid: string, m: RankMap) {
  await rest("trend_ranks?on_conflict=day,cid,gender", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ day, cid, gender: "f", ranks: rankRow(m), n: m.size, fetched_at: new Date().toISOString() }) });
}
// 하루치를 실시간으로 받아 저장. 네이버가 아직 공개 전이면(빈 목록) 저장하지 않고 pending
async function fetchAndStoreDay(day: string): Promise<{ day: string; stored: string[]; pending: boolean; errors: string[] }> {
  const stored: string[] = [], errors: string[] = []; let pending = false;
  for (const cid of Object.keys(NAVER_CATS)) {
    try {
      const m = await naverCategoryRanks(cid, day);
      if (!m.size) { pending = true; continue; }
      await saveRanks(day, cid, m); stored.push(NAVER_CATS[cid]);
    } catch (e) { errors.push(`${NAVER_CATS[cid]}: ${String((e as Error)?.message ?? e).slice(0, 80)}`); }
  }
  return { day, stored, pending, errors };
}
// 보고서용: 저장본에서 가장 최근 날(D → D-1 → D-2)과 그 7일 전을 고른다. 저장본이 없으면 실시간(빈 목록이면 하루 전으로).
async function loadTrendRanks(D: string, safe: <T>(label: string, f: () => Promise<T>) => Promise<T | null>) {
  const cids = Object.keys(NAVER_CATS);
  const want = [0, 1, 2].map((i) => addDays(D, -i));
  const stored = await readRanks([...want, ...want.map((d) => addDays(d, -7))]).catch(() => new Map<string, Map<string, RankMap>>());
  const complete = (d: string) => cids.every((c) => (stored.get(d)?.get(c)?.size ?? 0) > 0);
  let curDay = want.find(complete) ?? "";
  if (!curDay) {
    // 저장본 없음 → 실시간 (D가 비어 있으면 D-1)
    for (const d of want.slice(0, 2)) {
      const got = await fetchAndStoreDay(d).catch(() => null);
      if (got && got.stored.length === cids.length) { curDay = d; break; }
    }
    if (curDay) Object.assign(stored, await readRanks([curDay, addDays(curDay, -7)]));
  }
  const prevDay = curDay ? addDays(curDay, -7) : addDays(D, -7);
  if (curDay && !complete(prevDay)) {   // 7일 전 저장본이 없으면 그날만 실시간으로 채운다(오래된 날은 공개돼 있음)
    await safe("네이버 데이터랩(7일 전 보충)", () => fetchAndStoreDay(prevDay));
    const again = await readRanks([prevDay]).catch(() => new Map()); for (const [k, v] of again) stored.set(k, v);
  }
  const pairs: ({ cid: string; cur: RankMap; prev: RankMap } | null)[] = [];
  for (const cid of cids) {
    const cur = stored.get(curDay)?.get(cid), prev = stored.get(prevDay)?.get(cid);
    pairs.push(await safe(`네이버 데이터랩(${NAVER_CATS[cid]})`, async () => {
      if (!cur || !cur.size) throw new Error(curDay ? "저장본 없음" : "아직 공개 전(빈 목록) — 낮 수집 후 다음 보고서에 반영");
      return { cid, cur, prev: prev ?? new Map<string, number>() };
    }));
  }
  return { curDay: curDay || D, prevDay, pairs };
}
// 액션 trends: 낮에 cron(12:30·15:30·19:30 KST)이 호출 — 어제(또는 ?day=) 순위표를 받아 저장. 이미 있으면 건너뜀(idempotent).
async function trendsAction(url: URL): Promise<Response> {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("day") ?? "") ? url.searchParams.get("day")! : addDays(seoulTodayKst(), -1);
  const have = await readRanks([day]);
  if (!url.searchParams.get("force") && Object.keys(NAVER_CATS).every((c) => (have.get(day)?.get(c)?.size ?? 0) > 0)) return json({ ok: true, day, skipped: "이미 저장됨" });
  const r = await fetchAndStoreDay(day);
  return json({ ok: !r.errors.length, ...r });
}
const seoulTodayKst = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

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
  // 급증 TOP10 = 워크스페이스 홈 '판매량 급증 TOP 10'과 같은 규칙(이번 주 10개↑, (이번주+5)/(지난주+5) 순, 지난주 0 = NEW). 2026-10-27 화면 상단 표.
  const surge10 = rows7.filter((r) => num(r.order_qty) >= 10).map((r) => {
    const p = mPrev.get(Number(r.product_no)); const prevQty = p ? num(p.order_qty) : 0;
    return { no: Number(r.product_no), qty7: num(r.order_qty), prevQty, views7: num(r.views), rate7: num(r.rate), score: (num(r.order_qty) + 5) / (prevQty + 5) };
  }).filter((r) => r.qty7 > r.prevQty).sort((a, b) => b.score - a.score).slice(0, 10);
  const trending = surge10.slice(0, 6);
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
  const sold7Nos = rows7.filter((r) => num(r.order_qty) > 0).map((r) => Number(r.product_no));
  const infoNos = [...new Set([...newNos, ...sold7Nos])];
  const info = await safe("상품정보(신상품+최근 7일 판매 상품)", () => callFn("cafe24-analytics", { action: "productinfo", product_nos: infoNos.join(",") }));
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
  const unmatchedAdNames: string[] = [];
  for (const ad of ((active?.ads ?? []) as Row[])) {
    const an = paNorm(String(ad.ad_name ?? ""));
    const best = paPickBest(an, allProds, groups);
    if (!best) { unmatchedAdNames.push(an); continue; }
    (adsByProduct.get(best.no) ?? adsByProduct.set(best.no, []).get(best.no)!).push(ad);
  }
  for (const list of adsByProduct.values()) list.sort((a, b) => num(b.spend) - num(a.spend));
  // 매칭 자기 점검 — 판매 상위 30개 기준. 의심이면 이 상품들의 광고 수를 '모름'으로 두고 보고서에 경고(2026-09-23 재발 방지)
  const top30 = [...rows14].sort((a, b) => num(b.order_qty) - num(a.order_qty)).slice(0, 30).map((r) => ({ no: Number(r.product_no), name: String(r.product_name ?? ""), qty: num(r.order_qty) }));
  const matchAudit = adsKnown ? paMatchAudit(top30, adsByProduct, ((active?.ads ?? []) as unknown[]).length, unmatchedAdNames) : { status: "unknown", matched_ads: 0, total_ads: 0, matched_share: 0, suspects: [] };
  const suspectNos = new Set(matchAudit.suspects.map((s) => s.no));
  const adCountOf = (no: number): number | null => !adsKnown ? null : suspectNos.has(no) ? null : (adsByProduct.get(no) ?? []).length;

  // ── 신상품 4분면 ──
  const ageOf = (no: number) => { const c = String(infoMap.get(no)?.created_date ?? "").slice(0, 10); return c ? Math.round((new Date(`${todayKst}T12:00:00Z`).getTime() - new Date(`${c}T12:00:00Z`).getTime()) / 86400000) : null; };
  const newProducts = newNos.map((no) => {
    const r = m14.get(no), r7 = m7.get(no), p = infoMap.get(no) ?? {};
    const price = num(p.price), supply = num(p.supply_price), dprice = p.discount_price != null ? num(p.discount_price) : null;
    const ads = adsByProduct.get(no) ?? [];
    return {
      product_no: no, name: String(p.product_name ?? r?.product_name ?? ""), category: leafCat(no),
      created: String(p.created_date ?? "").slice(0, 10) || null, age_days: ageOf(no), sold_out: String(p.sold_out ?? "") === "T",
      price, discount_price: dprice && dprice < price ? dprice : null, margin_rate: marginRate(price, supply, p.cost_vat != null ? num(p.cost_vat) : null), promos: promosOf(no),
      views_14d: num(r?.views), orders_14d: num(r?.order_count), qty_14d: num(r?.order_qty), rate_14d: num(r?.rate), qty_7d: num(r7?.order_qty), views_7d: num(r7?.views),
      active_ads: adCountOf(no), ad_spend_total: adsKnown && !suspectNos.has(no) ? Math.round(ads.reduce((t, a) => t + num(a.spend), 0)) : null,
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
    const own = suspectNos.has(no) ? [] : (adsByProduct.get(no) ?? []);   // ON 광고 전부(14일 지출·ROAS 합산용). 매칭 의심 상품은 비워 두고 active_ads=null('모름')
    own.forEach((a) => adIds.add(String(a.ad_id)));
    return { no, cat: catOf.get(no) ?? leafCat(no), own };
  });
  // ── 트렌드(네이버 데이터랩 순위표: 어제 vs 7일 전) — ⚠ 다른 요청과 겹치면 데이터랩 응답이 멈춰(엣지 실측) **혼자 먼저** 순차로 받는다 (약 5초) ──
  // ⚠ 2026-10-11: 네이버는 '어제' 순위표를 아침 08:30에는 아직 공개하지 않는다(빈 목록 → 0건, 이어지는 요청은 시간 초과; 실측 24회 중 22회 실패,
  //   낮·저녁 실행은 성공). → 낮에 cron이 `trends` 액션으로 받아 trend_ranks에 저장해 두고, 여기서는 **저장본 중 가장 최근 날(D, 없으면 D-1·D-2)**을 쓴다.
  //   저장본이 전혀 없을 때만 실시간으로 받되, 빈 목록이면 하루 전으로 물러난다. 비교 기준(cur·prev 날짜)은 trends.basis에 그대로 적는다.
  const tr = await loadTrendRanks(D, safe);
  const prevDay = tr.prevDay;
  const rankPairs = tr.pairs;
  // 광고 카드 + 날씨는 병렬
  // 급증 TOP10에 붙은 광고 **전부**의 최근 7일 성과(지출·구매·구매액 → ROAS). adcards는 한 번에 60개라 60개씩 나눠 병렬.
  //   7일 인사이트 행이 없는 광고 = 그 기간 지출 0(테스트 단계 등) — '모름'이 아니라 0원으로 센다(2026-10-27 실측: 클린 소프트 니트 광고 8개 지출 0).
  const surgeAdIds: string[] = [];
  for (const t of surge10) for (const a of (suspectNos.has(t.no) ? [] : (adsByProduct.get(t.no) ?? []))) surgeAdIds.push(String(a.ad_id));
  const surgeChunks: string[][] = []; for (let i = 0; i < surgeAdIds.length; i += 60) surgeChunks.push(surgeAdIds.slice(i, i + 60));
  // 코디 상품 점검(2026-10-27 대표: "잘 팔리는 상품의 코디 아이템이라 주문율이 높을 수 있다"): 부모 = 14일 판매 상위 40, 자식 = 4분면 판정 대상 중 주문율이 중앙값 이상 + 급증 + 집중 상품.
  //   codi.share = 그 상품 14일 주문 중 부모(코디 상품으로 걸어 둔 잘 팔리는 상품)와 같은 주문에 담긴 비율. 높으면 주문율이 부모 덕.
  const codiParents = [...rows14].sort((a, b) => num(b.order_qty) - num(a.order_qty)).slice(0, 40).map((r) => Number(r.product_no));
  const codiChildren = [...new Set([...eligible.filter((p) => p.rate_14d >= medRate).map((p) => p.product_no), ...surge10.map((x) => x.no), ...focusNos])].slice(0, 60);
  const focusAdIds = [...adIds]; const cardChunks: string[][] = []; for (let i = 0; i < focusAdIds.length; i += 60) cardChunks.push(focusAdIds.slice(i, i + 60));
  const [weather, codiRes, ...restArr] = await Promise.all([
    safe("날씨(서울)", () => seoulWeather()),
    codiChildren.length ? safe("코디 상품(추가구성) 점검", () => callFn("cafe24-analytics", { action: "codi", parents: codiParents.join(","), children: codiChildren.join(","), start_date: cur14[0], end_date: cur14[1] })) : Promise.resolve(null),
    ...cardChunks.map((ids, i) => safe(`집중 상품 광고 14일 성과(${i + 1})`, () => callFn("meta-ads", { action: "adcards", ad_ids: ids.join(","), start_date: cur14[0], end_date: cur14[1] }))),
    ...surgeChunks.map((ids, i) => safe(`급증 상품 광고 7일 성과(${i + 1})`, () => callFn("meta-ads", { action: "adcards", ad_ids: ids.join(","), start_date: cur7[0], end_date: cur7[1] }))),
  ]);
  const cardsArr = restArr.slice(0, cardChunks.length), surgeCardsArr = restArr.slice(cardChunks.length);
  const cardsKnown = adsKnown && cardsArr.every((x) => !!x);
  const codiKnown = !!codiRes;
  const codiMap = ((codiRes as Row | null)?.children ?? {}) as Record<string, Row>;
  const codiOf = (no: number) => {
    const c = codiMap[String(no)]; if (!c) return null;
    const ps = ((c.parents ?? []) as unknown[]).map(Number);
    const byP = (c.by_parent ?? {}) as Record<string, number>;
    return { parents: ps.map((p) => ({ product_no: p, name: nameOf(p), qty_14d: num(m14.get(p)?.order_qty), orders_together: num(byP[String(p)]) })).sort((a, b) => b.orders_together - a.orders_together), orders_14d: num(c.orders), with_parent: num(c.with_parent), share: c.share == null ? null : num(c.share) };
  };
  const surgePerf = new Map<string, Row | null>();
  for (const sc of surgeCardsArr) for (const a of (((sc as Row | null)?.ads ?? []) as Row[])) surgePerf.set(String(a.ad_id), (a.period ?? null) as Row | null);
  const surgeKnown = adsKnown && surgeCardsArr.every((x) => !!x);
  const surge_top10 = surge10.map((t, i) => {
    const ads = suspectNos.has(t.no) ? [] : (adsByProduct.get(t.no) ?? []);
    let spend = 0, value = 0, purchases = 0;
    for (const a of ads) { const p = surgePerf.get(String(a.ad_id)); if (!p) continue; spend += num(p.spend); value += num(p.purchase_value); purchases += num(p.purchases); }
    const perfOk = surgeKnown && adCountOf(t.no) != null;
    return {
      rank: i + 1, product_no: t.no, name: nameOf(t.no), category: leafCat(t.no),
      qty_7d: t.qty7, qty_prev7d: t.prevQty, change_pct: t.prevQty > 0 ? Math.round((t.qty7 - t.prevQty) / t.prevQty * 100) : null,
      views_7d: t.views7, rate_7d: t.rate7, is_new: newNos.includes(t.no),
      active_ads: adCountOf(t.no),
      ad_spend_7d: perfOk ? Math.round(spend) : null, ad_purchases_7d: perfOk ? purchases : null,
      ad_roas_7d: perfOk ? (spend > 0 ? +(value / spend).toFixed(2) : null) : null,
      codi: codiOf(t.no),
    };
  });
  // 최근 7일 판매된 상품 전체: 평균 마진율(판매수량 가중, 워크스페이스 홈 타일과 같은 식) · 구매 전환율(주문 ÷ 조회)
  let mW = 0, mQ = 0, mN = 0, sViews = 0, sOrders = 0, sQty = 0;
  for (const r of rows7) {
    if (num(r.order_qty) <= 0) continue;
    const no = Number(r.product_no), p = infoMap.get(no) ?? {};
    sViews += num(r.views); sOrders += num(r.order_count); sQty += num(r.order_qty);
    const mr = marginRate(num(p.price), num(p.supply_price), p.cost_vat != null ? num(p.cost_vat) : null);
    if (mr != null) { mW += mr * num(r.order_qty); mQ += num(r.order_qty); mN++; }
  }
  const t7 = (s7?.totals ?? {}) as Row;
  const sold_7d = {
    period: cur7, products: sold7Nos.length, qty: sQty, orders: sOrders,
    margin_avg: mQ > 0 ? +(mW / mQ).toFixed(1) : null, margin_products: mN,
    conversion: sViews > 0 ? +(sOrders / sViews * 100).toFixed(2) : null, views: sViews,
    conversion_all: num(t7.views) > 0 ? +(num(t7.order_count) / num(t7.views) * 100).toFixed(2) : (t7.rate != null ? num(t7.rate) : null),
    note: "margin_avg = 판매수량 가중 평균 마진율(마진 원가 = 공급가×1.1, 중국 사입은 실질 단가+부가세). conversion = 판매된 상품의 주문 ÷ 조회, conversion_all = 조회된 상품 전체 기준",
  };
  const matchPool = [...new Map([...rows14, ...rows7].map((r) => [Number(r.product_no), { no: Number(r.product_no), name: String(r.product_name ?? ""), category: leafCat(Number(r.product_no)) }])).values()];
  const qtyOf = (no: number) => num(m14.get(no)?.order_qty);
  const trendCats = rankPairs.filter((x): x is { cid: string; cur: Map<string, number>; prev: Map<string, number> } => !!x).map((x) => {
    const rising = risingKeywords(x.cur, x.prev).slice(0, 25).map((r) => {
      const ours = matchKeyword(r.keyword, matchPool).map((p) => ({ ...p, qty_14d: qtyOf(p.no), is_new: newNos.includes(p.no) })).sort((a, b) => b.qty_14d - a.qty_14d).slice(0, 4);
      return { ...r, our_products: ours };
    });
    return { category: NAVER_CATS[x.cid], top10: [...x.cur.entries()].sort((a, b) => a[1] - b[1]).slice(0, 10).map(([k]) => k), rising };
  });
  const cardMap = new Map(cardsArr.flatMap((c) => (((c as Row | null)?.ads ?? []) as Row[])).map((a) => [String(a.ad_id), a]));
  // 상품에 붙은 ON 광고 전부의 14일 합(지출·구매·구매액 → ROAS). 14일 행이 없는 광고 = 그 기간 지출 0
  const adTotals = (no: number, ads: Row[]) => {
    if (!cardsKnown || adCountOf(no) == null) return { ad_spend_14d: null as number | null, ad_purchases_14d: null as number | null, ad_roas_14d: null as number | null };
    let sp = 0, v = 0, pu = 0;
    for (const a of ads) { const p = (cardMap.get(String(a.ad_id))?.period ?? null) as Row | null; if (!p) continue; sp += num(p.spend); v += num(p.purchase_value); pu += num(p.purchases); }
    return { ad_spend_14d: Math.round(sp), ad_purchases_14d: pu, ad_roas_14d: sp > 0 ? +(v / sp).toFixed(2) : null };
  };
  const adView = (a: Row) => {
    const c = cardMap.get(String(a.ad_id)) ?? {};
    const p = (c.period ?? null) as Row | null;
    return {
      ad_id: String(a.ad_id), name: String(c.name ?? a.ad_name ?? ""), adset: String(c.adset_name ?? ""), is_video: !!c.is_video, created: c.created_time ?? null,
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
      price, discount_price: dprice && dprice < price ? dprice : null, margin_rate: marginRate(price, supply, p.cost_vat != null ? num(p.cost_vat) : null), promos: promosOf(f.no), sold_out: String(p.sold_out ?? "") === "T",
      is_new: newNos.includes(f.no),
      codi: codiOf(f.no),
      active_ads: adCountOf(f.no),
      ...adTotals(f.no, f.own),
      own_ads: f.own.map(adView).sort((a, b) => num(b.last14?.spend) - num(a.last14?.spend)).slice(0, 6),   // 14일 지출 상위 6개만(수집 숫자·질문 답변용)
    };
  });

  return {
    base_date: D, base_dow: dow(D), generated_at: new Date().toISOString(),
    periods: { last14: cur14, last7: cur7, prev7 },
    rules: {
      matrix: `신상품(NEW ARRIVALS ${newNos.length}개) 중 등록 ${MIN_AGE_DAYS}일↑·14일 조회 ${MIN_VIEWS}↑인 ${eligible.length}개의 중앙값(조회 ${Math.round(medViews)}, 주문율 ${medRate}%) 기준 4분면`,
      margin: "마진율 = (판매가 − 공급가×1.1) ÷ 판매가. 낮으면 밀어도 남는 게 적음",
      surge: "surge_top10 = 판매량 급증 TOP10(최근 7일 vs 직전 7일, 이번 주 10개↑). ad_spend_7d·ad_roas_7d = 그 상품에 붙은 광고의 최근 7일 Meta 지출·ROAS(null = 광고 정보 없음/모름). sold_7d = 최근 7일 판매 상품 전체의 평균 마진율·구매 전환율",
      codi: codiKnown ? "codi = 코디 상품 점검. 그 상품이 잘 팔리는 상품(codi.parents)의 상품 페이지에 '코디 상품(추가구성)'으로 걸려 있으면 부모 페이지에서 함께 담긴 주문이 섞여 조회 대비 주문율이 높게 나온다. codi.share = 이 상품의 14일 주문 중 부모와 같은 주문에 들어간 비율(%). codi가 null이면 상위 40 판매 상품의 코디 상품이 아님" : "⚠ 코디 상품 점검 수집 실패 — 주문율이 높은 상품은 코디 구매가 섞였을 수 있다고만 쓸 것",
      ads: "focus의 active_ads = 지금 ON인 광고 수, ad_spend_14d·ad_purchases_14d·ad_roas_14d = 그 광고 전부의 최근 14일 합(null = 광고 정보 모름). top_ads = 14일 지출 상위 3개(since_start 누적, last14 14일). 빈도(frequency) 3 이상이면 같은 사람에게 반복 노출 = 소재 피로",
      ads_status: adsKnown && matchAudit.status === "suspect" ? `⚠ 광고↔상품 매칭이 체계적으로 깨진 것으로 의심(매칭 ${matchAudit.matched_share}%, 의심 상품 ${matchAudit.suspects.length}개). 광고 개수·광고 착수 여부를 판단하지 말고 '광고 정보 확인 필요'로만 쓸 것`
        : adsKnown && matchAudit.suspects.length ? `정상. 단 active_ads가 null인 상품(${matchAudit.suspects.map((s) => s.name).join(", ")})은 광고명이 줄임말 등으로 달라 자동 연결이 안 된 것 — '광고 0개'가 아니라 '광고 연결 확인 필요'로 쓸 것`
        : adsKnown ? "정상" : "⚠ Meta 활성 광고 수집 실패 — 모든 상품의 active_ads·own_ads가 비어 있는 것은 '광고 없음'이 아니라 '모름'. 광고 개수·소재·광고 착수 여부를 판단하지 말고 필요하면 '광고 정보 확인 불가'라고만 쓸 것",
    },
    ads_known: adsKnown,
    match_audit: matchAudit,
    new_arrivals: { count: newNos.length, eligible: eligible.length, median_views_14d: Math.round(medViews), median_rate_14d: medRate, matrix: matrix.map((p) => ({ ...p, codi: codiOf(p.product_no) })) },
    codi_known: codiKnown,
    focus,
    surge_top10, sold_7d,
    top10: top10.map((t) => ({ rank: t.rank, product_no: t.no, name: nameOf(t.no), qty_14d: num(m14.get(t.no)?.order_qty), rate_14d: num(m14.get(t.no)?.rate), active_ads: adCountOf(t.no) })),
    trending: trending.map((t) => ({ product_no: t.no, name: nameOf(t.no), qty_7d: t.qty7, qty_prev7d: t.prevQty })),
    benefits_active: num(ben?.active_count),
    trends: {
      basis: `네이버 데이터랩 쇼핑인사이트 '분야별 인기 검색어'(여성) — ${tr.curDay} 상위 100 vs 7일 전(${prevDay})${tr.curDay !== D ? ` (네이버 공개 지연으로 ${D} 대신 ${tr.curDay} 기준)` : ""}. new = 100위 안 새 진입, up = 15계단 이상 상승. our_products = 이름·카테고리로 찾은 우리 상품(14일 판매량 순)`,
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
    codi: p.codi ? { share: (p.codi as Row).share, orders_14d: (p.codi as Row).orders_14d, parents: ((p.codi as Row).parents as Row[]).map((x) => `${x.name}(함께 ${x.orders_together}건)`).join(", ") } : undefined,
  }));
  const focus = ((data.focus ?? []) as Row[]).map((f) => ({
    name: f.name, why: f.why, category: f.category, is_new: f.is_new || undefined, sold_out: f.sold_out || undefined,
    views_14d: f.views_14d, qty_14d: f.qty_14d, rate_14d: f.rate_14d, price: f.price, discount_price: f.discount_price ?? undefined, margin_rate: f.margin_rate,
    promos: f.promos, codi: f.codi ?? undefined,
    active_ads: f.active_ads, ad_spend_14d: f.ad_spend_14d, ad_purchases_14d: f.ad_purchases_14d, ad_roas_14d: f.ad_roas_14d,
    top_ads: ((f.own_ads ?? []) as Row[]).slice(0, 3).map((a) => ({ name: a.name, is_video: a.is_video, created: a.created, since_start: a.since_start, last14: a.last14 })),
  }));
  const tr = (data.trends ?? {}) as Row;
  const w = (tr.weather ?? null) as Row | null;
  const trends = { ...tr, weather: w ? { summary: w.summary, next_7d: w.next_7d } : null };
  const surge = ((data.surge_top10 ?? []) as Row[]).map(({ product_no: _n, ...x }) => x);
  return { ...data, new_arrivals: { ...na, matrix }, focus, trends, surge_top10: surge };
}

// Claude 판단에 숫자·판정을 코드가 붙인다
function postProcess(report: Row, data: Row): Row {
  const matrix = (((data.new_arrivals ?? {}) as Row).matrix ?? []) as Row[];
  // 이름이 조금 달라도 같은 상품을 찾고(findByName), 끝내 못 찾은 행은 0으로 채우지 않고 뺀다 — 표시 이름은 데이터의 정식 이름
  const mt = ((report.matrix ?? []) as Row[]).map((x) => {
    const p = findByName(matrix, x.name);
    if (!p) return null;
    return { name: p.name, strategy: x.strategy, quadrant: p.quadrant ?? "", views_14d: num(p.views_14d), rate_14d: p.rate_14d ?? null, qty_14d: num(p.qty_14d), margin_rate: p.margin_rate ?? null, discount_price: p.discount_price ?? null, price: num(p.price), promos: p.promos ?? [], age_days: p.age_days ?? null, active_ads: p.active_ads ?? null, sold_out: !!p.sold_out, product_no: p.product_no ?? null, codi: p.codi ?? null };
  }).filter((x): x is NonNullable<typeof x> => !!x);
  const focus = (data.focus ?? []) as Row[];
  const fc = ((report.focus ?? []) as Row[]).map((x) => {
    const f = findByName(focus, x.name);
    if (!f) return null;
    const grow = (Array.isArray(x.grow) ? (x.grow as unknown[]).map(String) : String(x.grow ?? "").split(/\s*[|｜\n]\s*/)).map((g) => g.trim()).filter(Boolean).slice(0, 4);
    return { name: f.name, status: String(x.status ?? "").trim(), grow, product_no: f.product_no ?? null, why: f.why ?? "", category: f.category ?? "", is_new: !!f.is_new, sold_out: !!f.sold_out,
      views_14d: num(f.views_14d), qty_14d: num(f.qty_14d), rate_14d: f.rate_14d ?? null, margin_rate: f.margin_rate ?? null, price: num(f.price), discount_price: f.discount_price ?? null, promos: f.promos ?? [], codi: f.codi ?? null,
      active_ads: f.active_ads ?? null, ad_spend_14d: f.ad_spend_14d ?? null, ad_purchases_14d: f.ad_purchases_14d ?? null, ad_roas_14d: f.ad_roas_14d ?? null };
  }).filter((x): x is NonNullable<typeof x> => !!x);
  // 오늘의 결론 칩(2026-10-27): 종류는 정해진 5가지만, 상품명은 데이터의 정식 이름으로(못 찾으면 쓴 그대로), 최대 5개
  const pool = [...matrix, ...focus, ...((data.surge_top10 ?? []) as Row[])] as Row[];
  const vd = ((report.verdicts ?? []) as Row[]).map((v) => {
    const kind = VERDICT_KINDS.find((k) => String(v.kind ?? "").includes(k)) ?? "점검";
    const p = v.product ? findByName(pool, String(v.product)) : null;
    return { kind, product: p ? String(p.name) : String(v.product ?? "").trim(), product_no: p?.product_no ?? null, reason: String(v.reason ?? "").trim() };
  }).filter((v) => v.reason).slice(0, 5);
  return { ...report, matrix: mt, focus: fc, verdicts: vd };
}
const VERDICT_KINDS = ["밀기", "보류", "점검", "시즌", "소싱"];

const SYSTEM = `당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 상품 전략 담당자입니다. 매일 아침 대표에게 "어떤 상품에 힘을 실을지, 광고 소재와 상세를 어떻게 바꿀지"를 보고합니다.

1) 신상품 4분면 (new_arrivals.matrix — quadrant는 코드가 이미 판정했습니다. 그 판정을 바꾸지 말고 전략만 씁니다):
- '노출 부족'(주문율↑ 조회↓): 조회수를 올릴 방법 — 진열 순서 상향, 광고 테스트 착수(active_ads가 0이면 특히), 메인·기획전 노출, 인스타 게시.
- '판매 확대'(둘 다↑): 판매를 키울 방법 — 광고 예산 확대, 색상·사이즈 재고 확보, 1+1·세트 구성, 후속 소재.
- '상세·가격 점검'(조회↑ 주문율↓): 상세페이지·가격·옵션 점검. 할인 중인데도 낮으면 상품 자체 문제일 수 있음.
- '집중도 낮춤'(둘 다↓): 대표의 판단대로 집중도를 낮추되, '(광고 미테스트)'가 붙은 상품은 노출 부족 탓일 수 있어 "한 번 테스트 후 판단"으로 씁니다.
- '데이터 부족'·'노출 거의 없음'은 판단을 보류하고 필요하면 한 줄만.
- 어떤 상품의 광고 개수는 **오늘 data(top10·matrix·focus의 active_ads·own_ads)만** 근거로 씁니다. this_week.prior_days의 문장에 적힌 광고 수를 다시 쓰지 않습니다(어제 0개였어도 오늘 5개면 5개).
- rules.ads_status가 '정상'이 아니면(광고 수집 실패) active_ads가 null이고 own_ads가 비어 있습니다. 이때는 "광고 0개"·"광고 공백"·"광고 착수" 같은 광고 유무 판단을 절대 하지 말고, headline·summary에도 광고 얘기를 넣지 않으며, 소재 분석 칸에는 '광고 정보 확인 불가(수집 실패)'라고만 씁니다.
- **코디 상품 점검(codi, 2026-10-27 대표 지시)**: codi가 있는 상품은 잘 팔리는 상품(codi.parents)의 페이지에 '코디 상품'으로 걸려 있어 그 페이지에서 함께 담긴 주문이 섞입니다. codi.share(이 상품 주문 중 부모와 같은 주문 비율)가 **40% 이상이면 높은 주문율은 자기 힘이 아니라 부모 덕** — '노출 부족'이라고 광고·진열 상향을 권하거나 '밀기' 결론의 근거로 주문율을 쓰지 말고, "○○ 코디 구매 n% — 부모 따라가는 상품, 단독 확대 보류"처럼 씁니다(부모 상품이 꺾이면 같이 꺾임). 40% 미만이면 단독 수요가 있는 것이니 평소대로 판단하되 strategy·reason에 비율을 적을 수 있습니다. codi가 없는 상품은 평소대로.
- 반품 수치를 쓸 때는 항상 **'순반품률'**(배송완료 대비 반품, 취소 제외 — 반품 담당 기준)이라고 씁니다. '반품 15%'처럼 줄이지 않습니다.
- 마진율이 낮은 상품(예: 35% 미만)은 밀어도 남는 게 적으니 우선순위를 낮추고, 마진 좋은 '판매 확대' 상품이 최우선입니다. 적용 중인 혜택(promos: 1+1·기간할인)과 할인가를 전략에 반영합니다.
- matrix에는 '판매 확대'·'노출 부족'·'상세·가격 점검' 중 중요한 순으로 최대 15개만 넣고, strategy는 30자 이내 한 줄. (보고서 생성 시간 제한이 있어 짧게)

2) 집중 상품 (focus — 급상승 상품과 판매 TOP10, 최대 ${FOCUS_MAX}개):
- (2026-10-27 대표 지시) 소재 분석은 하지 않습니다 — 광고 소재 담당이 따로 합니다. 소재 이름·견인 소재·소재 컨셉·릴스 훅을 쓰지 마세요.
- status: 이 상품의 **현재 상태를 데이터로** 한 줄 — views_14d·rate_14d·qty_14d·margin_rate·active_ads·ad_spend_14d·ad_roas_14d·promos(진행 중 이벤트)·codi·동료 보고서의 반품률을 근거 숫자와 함께. sold_7d의 평균 마진(%)·전환율과 비교하면 좋습니다.
- grow: **판매를 더 키우려면 무엇을 추가하거나 고칠지** 2~3개 — 예산·광고 착수(ad_spend_14d 0이면 착수, ROAS 높고 빈도 낮으면 확대 '대표 확인 후'), 이벤트(1+1·세트·기간할인, 지금 promos와 겹치지 않게), 진열·기획전·메인 노출, 상세페이지(주문율이 낮거나 떨어지면 사이즈·소재 결론을 앞에), 가격, 색상·사이즈 재고, 반품 사유 해결. 각 항목에 왜 그런지 숫자를 붙입니다. 뻔한 말("마케팅 강화") 금지.
- top_ads(14일 지출 상위 3개)의 빈도 3 이상은 소재 피로 → grow에 '소재 교체 요청(광고 소재 담당)' 한 줄로만 씁니다.
- 광고가 하나도 없는 집중 상품은 "광고 착수" 제안이 첫 번째입니다(rules.ads_status가 '정상'일 때만). codi.share 40% 이상이면 단독 확대보다 부모 상품과 세트·동반 노출을 제안합니다.

3) 트렌드·날씨 (trends):
- trends.naver[].rising = 네이버에서 새로 뜨거나 크게 오른 검색어(정해 둔 목록이 아니라 순위표에서 자동 발견). 브랜드명(에고이스트·시슬리·자라 등)은 무시하고 **품목·소재·스타일 키워드**만 봅니다.
- our_products가 있는 키워드 → 그 상품을 앞세우는 제안(진열 상향, 광고 문구·상품명에 키워드 반영, 기획전). 없는 키워드 중 우리 스타일(여성 데일리·편안한 핏)에 맞는 것 → "소싱 검토" 한 줄.
- weather.summary: 앞으로 7일 최저기온이 15도 아래로 처음 내려가는 날, 지난주 대비 기온 변화, 비 오는 날을 보고 카테고리 타이밍을 제안합니다(예: 기온 하강 → 가디건·니트·자켓 앞당기기, 비 → 배송·아우터). 날씨는 유행보다 매출을 빨리 움직입니다.
- trend_actions에 키워드 기반 제안을 최대 6개, weather_plan에 날씨 기반 한 줄.

4) actions는 오늘 실행할 구체적인 것 3개(광고팀·상품팀 위주). 트렌드·날씨에서 나온 것도 포함될 수 있습니다.

5) 맨 위 요약은 글이 아니라 **결론 칩**입니다 (2026-10-27 대표 요청 "줄글 말고 직관적으로"):
- verdicts: 오늘의 결론 3~5개. 각각 kind(밀기 = 힘을 실을 상품 / 보류 = 확대를 멈추거나 미룰 상품 / 점검 = 상세·가격·소재를 손볼 상품 / 시즌 = 날씨·시즌에 따른 카테고리 배치 / 소싱 = 없는 상품의 소싱 검토) + product(상품명은 데이터 그대로, 카테고리면 '니트·가디건'처럼 짧게) + reason(근거 숫자 하나를 넣어 25자 이내. 예: "마진 67.6% · 광고 8개 test 중", "반품 15.4% · 차콜 28%").
- summary는 **딱 1줄**(45자 이내) — 오늘 전체 흐름 한 문장. 상품 나열 금지.
- 급증 상품을 나열하는 문장은 쓰지 않습니다 — 화면 맨 위에 surge_top10 표(판매량 변화·광고 수·7일 광고비·ROAS·주문율)가 그대로 보입니다. 대신 surge_top10의 광고비·ROAS·주문율을 근거로 '밀기/보류/점검' 결론을 냅니다(예: 급증인데 광고 0개 → 밀기·광고 착수, 급증인데 ROAS 1 미만 → 점검).
- sold_7d(최근 7일 판매 상품 전체의 평균 마진율·구매 전환율)는 화면 타일에 보입니다. 결론에서 "평균 마진(n%)보다 높은/낮은 상품"처럼 비교 기준으로 씁니다.
${COMMON_RULES}`;

// lean: 담당자 전용 표(matrix·focus·trend_actions)가 많아 협업 칸이 더해진 뒤 '문법이 너무 크다'(400)에 걸림(2026-10-18) — 공통 칸의 enum·중첩 배열을 줄인 모양
const SCHEMA = reportSchema({
  lean: true,
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
          status: { type: "string", description: "데이터로 본 현재 상태 한 줄, 70자 이내, 숫자 근거 포함 (예: '14일 1,226개 1위, ROAS 8.3·마진 57.8%·반품 9.9% — 효율 좋고 안전')" },
          // 배열 안의 배열은 구조화 출력 문법을 크게 키운다(2026-10-18 '문법이 너무 크다' 400) → 한 줄로 받고 postProcess가 배열로 나눈다
          grow: { type: "string", description: "판매를 더 키우기 위해 추가할 활동 또는 개선할 점 2~3개를 ' | '로 이어 한 줄. 각 45자 이내, 왜 그런지 숫자 근거 포함. 예: '광고 예산 확대(ROAS 8.3, 빈도 1.2 여유) | 상세 상단 사이즈 결론 배치(주문율 2.8%로 하락)'" },
        },
        required: ["name", "status", "grow"], additionalProperties: false,
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
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", description: "다음 중 하나 그대로: 밀기, 보류, 점검, 시즌, 소싱" },
          product: { type: "string", description: "상품명(데이터 그대로) 또는 카테고리 짧게. 전체 흐름이면 빈 문자열" },
          reason: { type: "string", description: "근거 숫자 하나 포함 25자 이내" },
        },
        required: ["kind", "product", "reason"], additionalProperties: false,
      },
      description: "오늘의 결론 칩 3~5개 (맨 위 요약 자리에 글 대신 표시됨). 중요한 순",
    },
  },
});

// effort low (2026-09-13): 생각 토큰을 줄여 생성 시간 단축 — 작성 단계는 벽시계 150초 안에 끝나야 함(546 실사례). 판단 규칙은 프롬프트에 다 있어 low로 충분.
// 동료 보고서 활용 규칙 (2026-10-17) — 전략 담당은 아침 마지막(08:30)이라 오늘 매출·반품 보고서를 모두 본다
const COLLEAGUE_RULES = `- '오늘 숫자판'(colleagues 첫 항목 — 코드가 모은 매출 집계)의 급등(surge_7d)·하락(rate_drops_7d)·조회 많고 안 팔림(high_view_low_rate_7d) 상품과 취소·반품 감시 담당(오늘)의 위험·주의 상품을 집중 상품(focus.plan)과 4분면 전략(matrix.strategy)에 반영합니다: 반품 위험·주의 상품은 "광고 확대" 대신 "원인 해결 후 확대"(반품 담당 기준 n%), 반품 낮고 매출 급증인 상품은 최우선 확대.
- 숫자판의 '조회 많고 안 팔림' 상품이 4분면에 있으면 '상세·가격 점검' 전략에 그 근거를 더하고, 상세페이지 점검 담당에게 handoff.
- 밀어줄 상품(판매 확대·집중 상품) 중 광고 소재가 부족하거나 소재 피로(빈도 3↑)인 것은 광고 소재 담당에게 제작안 handoff(상품명 그대로).
- 어제 광고 소재 담당 제작안이 있는 상품은 그 제작안의 1순위 훅과 내 소재 분석이 같은 방향인지 확인하고, 다르면 이유를 씁니다.`;
export const DEF: AgentDef = { agent: AGENT, label: "상품 전략 담당", system: SYSTEM, schema: SCHEMA, collect, forLLM, postProcess, effort: "low", actions: { trends: trendsAction }, colleagueRules: COLLEAGUE_RULES, notify: "warn" };

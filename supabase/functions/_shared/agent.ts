// ═══════════════════════════════════════════════
// 에이전트 공통 뼈대 (2026-09-11 — 2호 담당을 만들며 sales-agent에서 뽑아냄)
//   각 담당자 함수는 { agent, label, collect(D), system, schema } 만 넘기면
//   status / collect / run 액션, 주간 문맥, Claude 호출, 저장, 알림을 여기서 처리한다.
//
//   공통 규약
//   - 기준일 D = 실행일 전날(KST). ?date= 또는 body.date로 과거 날짜 지정 가능.
//   - 인증: 관리자 로그인(x-auth-token) 또는 x-cron-secret(CRON_SECRET).
//   - 다른 함수 호출은 x-agent-secret(AGENT_SECRET) — 워크스페이스 함수들이 admin으로 인정.
//   - 리포트 JSON 공통 필드: headline/mood/summary/highlights/warnings/actions/note + week_highlights/week_warnings/week_actions
//     (담당자별 추가 필드는 schema에 더한다). 저장 시 report.week / report.last_week 를 덧붙인다.
//   - 할 일 완료 체크: agent_actions(agent, action_id=week_actions[].id, done) — done=true는 다음 보고서에서 제외.
// ═══════════════════════════════════════════════
import Anthropic from "npm:@anthropic-ai/sdk";
import webpush from "npm:web-push@3.6.7";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { handleOptions, json, verifyAuthToken } from "./util.ts";

export const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const AGENT_SECRET = Deno.env.get("AGENT_SECRET") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
export const MODEL = "claude-opus-5";
export const AGENTS_URL = "https://danarobe.github.io/dnrb-agents/";

export type Row = Record<string, unknown>;

// ── 날짜 (KST) ──
export const seoulToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
export function addDays(ymd: string, d: number): string {
  const t = new Date(`${ymd}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
}
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
export const dow = (ymd: string) => DOW[new Date(`${ymd}T12:00:00Z`).getUTCDay()] + "요일";
export function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return addDays(ymd, -((d + 6) % 7));
}
export const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const pct = (a: number, b: number) => b > 0 ? Math.round((a - b) / b * 1000) / 10 : null;

// ── 이름으로 행 찾기 (2026-09-28): Claude가 상품명을 쓸 때 끝의 '(3 colors)'를 빼거나 띄어쓰기를 바꾸는 경우가 있어
//   '글자까지 같은 이름'으로만 찾으면 숫자가 0으로 채워졌다(전략 보고서 4분면 표 9행 실사례). 단계적으로 느슨하게 찾는다:
//   ① 완전 일치 ② 공백·대소문자·브랜드 접미사 무시 ③ 한쪽이 다른 쪽의 앞부분 ④ 앞뒤 괄호를 벗긴 핵심명 일치(후보가 하나일 때만).
const nameNorm = (s: unknown) => String(s ?? "").normalize("NFC").replace(/\s*[-–—|]\s*(danarobe|dana|다나로브|다나)\s*$/i, "").replace(/\s+/g, "").toLowerCase();
const nameCore = (s: unknown) => {
  let t = String(s ?? "").normalize("NFC").replace(/\s*[-–—|]\s*(danarobe|dana|다나로브|다나)\s*$/i, "").trim();
  for (;;) { const m = t.match(/^\s*(?:\([^)]*\)|\[[^\]]*\])\s*(.*)$/); if (m) t = m[1]; else break; }
  for (;;) { const m = t.match(/^(.*?)\s*(?:\([^)]*\)|\[[^\]]*\])\s*$/); if (m) t = m[1]; else break; }
  return t.replace(/\s+/g, "").toLowerCase();
};
export function findByName<T extends Row>(rows: T[], name: unknown, field = "name"): T | null {
  const raw = String(name ?? "");
  const exact = rows.find((r) => String(r[field]) === raw); if (exact) return exact;
  const n = nameNorm(raw); if (!n) return null;
  const same = rows.filter((r) => nameNorm(r[field]) === n); if (same.length) return same[0];
  const pre = rows.filter((r) => { const x = nameNorm(r[field]); return x.startsWith(n) || n.startsWith(x); }); if (pre.length === 1) return pre[0];
  const c = nameCore(raw); if (c.length < 3) return null;
  const core = rows.filter((r) => nameCore(r[field]) === c); if (core.length === 1) return core[0];
  return pre.length ? pre.sort((a, b) => Math.abs(nameNorm(a[field]).length - n.length) - Math.abs(nameNorm(b[field]).length - n.length))[0] : null;
}

// ── Supabase PostgREST (service_role) ──
export const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

// ── 다른 Edge Function 호출 (x-agent-secret → 그쪽에서 admin으로 인정) ──
export async function callFn(name: string, params: Record<string, string>): Promise<Row> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SB_URL}/functions/v1/${name}?${qs}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "x-agent-secret": AGENT_SECRET },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) throw new Error(`${name}(${params.action ?? ""}) ${res.status}: ${body?.error ?? ""}`);
  return body as Row;
}

// 항목별 실패를 삼키고 errors[]에 남기는 도우미 — 한 소스가 죽어도 나머지로 보고서를 쓴다
export function safeCollector() {
  const errors: string[] = [];
  const safe = async <T>(label: string, f: () => Promise<T>): Promise<T | null> => {
    try { return await f(); } catch (e) { errors.push(`${label}: ${String((e as Error)?.message ?? e).slice(0, 160)}`); return null; }
  };
  return { errors, safe };
}

// ── 주간 문맥: 이번 주 앞선 날들의 주목·주의·할 일 + 완료 체크 + 저번 주 할 일 ──
// ── 동료 보고서 문맥 (2026-10-17, 사용자 요청 "에이전트끼리 유기적으로") ──
//   각 담당자는 보고서를 쓰기 전에 다른 담당자들의 최근 보고서 요약(colleagues)과 자기에게 온 요청(handoffs_to_me)을 받는다.
//   아침 순서가 매출(08:00) → 반품(08:15) → 전략(08:30)이라 반품은 오늘 매출 보고서를, 전략은 오늘 매출·반품 보고서를, 매출은 어제 전략·반품을 본다.
//   보고서에는 colleague_notes(동료 것을 어떻게 반영했나)와 handoffs(동료에게 넘기는 요청)가 생기고, 다음 보고서가 그 요청에 답한다.
export const AGENT_LABELS: Record<string, string> = { sales: "매출 분석 담당", returns: "취소·반품 감시 담당", strategy: "상품 전략 담당", creative: "광고 소재 담당", detail: "상세페이지 점검 담당" };
export const COLLEAGUE_TARGETS = Object.values(AGENT_LABELS);
// 담당자 이름을 정확한 표시 이름으로 맞춘다 (2026-10-18) — 스키마의 enum을 뺐기 때문.
//   이유: 상품 전략 담당 스키마에 협업 칸(colleague_notes·handoffs)의 담당자 enum이 더해지자 Claude API가
//   400 "The compiled grammar is too large"로 거절(10-18 08:30 정기·20:55 수동 둘 다 실패, 매출·반품은 정상). enum(한글 이름 5개 × 2칸)이
//   구조화 출력 문법을 크게 키운다 → 그냥 문자열로 받고 여기서 맞춘다. 화면(TEAM_KEY[h.to])·받은 요청(h.to === 내 이름)이 정확한 이름을 쓰므로 꼭 거친다.
export function matchColleague(v: unknown): string | null {
  const s = String(v ?? "").normalize("NFC").replace(/\s+/g, "");
  if (!s) return null;
  for (const l of COLLEAGUE_TARGETS) if (l.replace(/\s+/g, "") === s) return l;
  const keys: [RegExp, string][] = [[/상세/, AGENT_LABELS.detail], [/소재|광고/, AGENT_LABELS.creative], [/반품|취소/, AGENT_LABELS.returns], [/전략/, AGENT_LABELS.strategy], [/매출/, AGENT_LABELS.sales]];
  for (const [re, l] of keys) if (re.test(s)) return l;
  return null;
}
const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);
// 담당자별로 다른 담당이 알아야 할 핵심만 줄인다 (입력 토큰 절약 — 보고서 전체는 수천 토큰)
function colleagueDigest(agent: string, rp: Row): Row {
  const titles = (arr: unknown, n: number) => ((arr ?? []) as Row[]).slice(0, n).map((x) => ({ title: clip(x.title, 60), detail: clip(x.detail, 90) }));
  const base: Row = {
    headline: rp.headline, summary: ((rp.summary ?? []) as unknown[]).slice(0, 4),
    highlights: titles(rp.highlights, 5), warnings: titles(rp.warnings, 5),
    actions: ((rp.actions ?? []) as Row[]).slice(0, 4).map((a) => `${a.owner ?? ""}: ${clip(a.title, 60)}`),
  };
  if (agent === "returns") {
    base.cohort = ((rp.cohort_table ?? []) as Row[]).slice(0, 3).map((w) => ({ week: w.week, maturity: w.maturity, cancel_rate: w.cancel_rate, return_rate: w.return_rate, verdict: w.verdict }));
    base.risk_products = ((rp.risk_products ?? []) as Row[]).slice(0, 8).map((p) => ({ name: p.name, level: p.level, rate_14d: p.rate_14d, delivered_14d: p.delivered_14d, cause: clip(p.cause, 50) }));
    base.watch_review = ((rp.watch_review ?? []) as Row[]).slice(0, 8).map((w) => `${w.name}: ${w.verdict}`);
  }
  if (agent === "strategy") {
    base.matrix = ((rp.matrix ?? []) as Row[]).slice(0, 8).map((m) => ({ name: m.name, quadrant: m.quadrant, rate_14d: m.rate_14d, views_14d: m.views_14d, active_ads: m.active_ads }));
    base.focus = ((rp.focus ?? []) as Row[]).slice(0, 6).map((f) => ({ name: f.name, why: clip(f.why, 40), plan: clip(f.plan, 70), detail_focus: clip(f.detail_focus, 60) }));
    base.trend_actions = ((rp.trend_actions ?? []) as Row[]).slice(0, 3).map((t) => ({ keyword: t.keyword, our_products: t.our_products, suggestion: clip(t.suggestion, 50) }));
    base.weather_plan = clip(rp.weather_plan, 100);
  }
  if (agent === "creative") {
    base.briefs = ((rp.briefs ?? []) as Row[]).filter((b) => b.status === "ok" && b.brief).slice(0, 8).map((b) => {
      const br = b.brief as Row; const p = (((br.plans ?? []) as Row[])[0] ?? null) as Row | null; const h = (((br.hooks ?? []) as Row[])[0] ?? null) as Row | null;
      return { name: b.product_name, kind: b.kind, top_plan: p ? `${(p.hook as Row)?.headline ?? ""} → ${(p.convert as Row)?.point ?? ""}` : (h?.hook_text ?? ""), landing_match: clip(br.landing_match, 90), avoid: ((br.avoid ?? []) as unknown[]).slice(0, 2).map((a) => clip(a, 50)) };
    });
  }
  if (agent === "detail") {
    base.reviews = ((rp.reviews ?? []) as Row[]).filter((x) => x.status === "ok").slice(0, 8).map((x) => { const rv = (x.review ?? {}) as Row; return { name: x.product_name, score: rv.score, verdict: clip(rv.verdict, 80), top_priority: clip((rv.top_priority as Row)?.what, 80) }; });
  }
  return base;
}
export async function colleagueContext(me: string, D: string) {
  const r = await rest(`agent_reports?agent=neq.${me}&status=eq.ok&report_date=gte.${addDays(D, -7)}&select=agent,report_date,report,created_at&order=created_at.desc&limit=40`);
  const rows: Row[] = r.ok ? await r.json() : [];
  const latest = new Map<string, Row>();
  const seenDay = new Set<string>();
  const handoffsToMe: Row[] = [];
  const myLabel = AGENT_LABELS[me] ?? me;
  for (const row of rows) {
    const agent = String(row.agent), date = String(row.report_date), rp = (row.report ?? {}) as Row;
    if (!latest.has(agent)) latest.set(agent, row);
    const k = `${agent}|${date}`;
    if (seenDay.has(k)) continue;   // 같은 날 재실행은 최신 것만
    seenDay.add(k);
    if (date >= addDays(D, -3)) for (const h of ((rp.handoffs ?? []) as Row[])) if (String(h.to) === myLabel) handoffsToMe.push({ from: AGENT_LABELS[agent] ?? agent, report_date: date, product: h.product ?? "", ask: h.ask, why: h.why });
  }
  const colleagues = [...latest.entries()].map(([agent, row]) => {
    const date = String(row.report_date);
    const age = Math.round((new Date(`${D}T00:00:00Z`).getTime() - new Date(`${date}T00:00:00Z`).getTime()) / 86400000);
    return { agent: AGENT_LABELS[agent] ?? agent, report_date: date, is_today: date === D, age_days: age, ...colleagueDigest(agent, (row.report ?? {}) as Row) };
  });
  return { colleagues, handoffs_to_me: handoffsToMe.slice(0, 6), seen: colleagues.map((c) => ({ agent: c.agent, report_date: c.report_date })) };
}
// lean 스키마로 받은 값을 원래 모양으로(모든 담당자에 걸어도 무해 — 이미 원래 모양이면 그대로)
export function leanFix(report: Row): Row {
  const one = (v: unknown, vals: string[], dflt: string) => { const s = String(v ?? "").trim(); return vals.find((x) => x === s) ?? vals.find((x) => s.includes(x)) ?? dflt; };
  const dates = (v: unknown) => Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[,\s]+/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const st = (v: unknown) => one(v, ["ongoing", "new"], "new");
  const ow = (v: unknown) => one(v, OWNERS, "대표");
  const wk = (l: unknown) => ((l ?? []) as Row[]).map((x) => ({ ...x, dates: dates(x.dates), status: st(x.status) }));
  const isWarn = (x: Row) => /주의|warn/i.test(String(x.kind ?? ""));
  const strip = (l: Row[]) => l.map(({ kind: _k, ...rest }) => rest);
  const r0: Row = { ...report };
  if (Array.isArray(r0.signals)) { const l = r0.signals as Row[]; r0.highlights = strip(l.filter((x) => !isWarn(x))); r0.warnings = strip(l.filter(isWarn)); delete r0.signals; }
  if (Array.isArray(r0.week_signals)) { const l = r0.week_signals as Row[]; r0.week_highlights = strip(l.filter((x) => !isWarn(x))); r0.week_warnings = strip(l.filter(isWarn)); delete r0.week_signals; }
  if (typeof r0.summary === "string") r0.summary = r0.summary.split(/\n+/).map((x) => x.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "").trim()).filter(Boolean);
  report = r0;
  return {
    ...report,
    mood: one(report.mood, ["good", "neutral", "bad"], "neutral"),
    actions: ((report.actions ?? []) as Row[]).map((a) => ({ ...a, owner: ow(a.owner) })),
    week_highlights: wk(report.week_highlights), week_warnings: wk(report.week_warnings),
    week_actions: ((report.week_actions ?? []) as Row[]).map((a) => ({ ...a, owner: ow(a.owner), status: st(a.status) })),
  };
}

// handoffs의 상품명을 수집 데이터 안의 상품 번호로 맞춘다 (화면의 '지금 점검·분석' 버튼용) — 데이터 어디든 {name, product_no|no} 쌍을 모아 findByName
export function resolveProductNos(report: Row, data: Row): Row {
  const pairs: Row[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 5 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const o = v as Row;
    const no = o.product_no ?? o.no, nm = o.name ?? o.product_name;
    if (nm && Number(no) > 0) pairs.push({ name: String(nm), no: Number(no) });
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(data, 0);
  // 마지막 수단: Claude가 상품명의 한 어절을 빼고 쓴 경우('새틴 블라썸 스트링 스커트' → '새틴 블라썸 스커트', 실사례) — 핵심명 2글자 조각의 겹침 비율 75%↑, 후보가 하나일 때만
  const bigrams = (t: string) => { const c = t.replace(/\s+/g, ""); const out = new Set<string>(); for (let i = 0; i + 1 < c.length; i++) out.add(c.slice(i, i + 2)); return out; };
  const strip = (t: unknown) => String(t ?? "").normalize("NFC").replace(/\([^)]*\)|\[[^\]]*\]/g, " ").toLowerCase();
  const loose = (name: string): Row | null => {
    const q = bigrams(strip(name)); if (q.size < 4) return null;
    const scored = pairs.map((p) => { const c = bigrams(strip(p.name)); let hit = 0; for (const g of q) if (c.has(g)) hit++; return { p, score: hit / q.size }; }).filter((x) => x.score >= 0.75).sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    const top = scored[0]; const sameNo = scored.filter((x) => x.score === top.score).every((x) => x.p.no === top.p.no);
    return sameNo ? top.p : null;
  };
  // 담당자 이름 맞추기(matchColleague) — 못 알아보는 이름의 요청은 받을 사람이 없어 뺀다
  const notes = ((report.colleague_notes ?? []) as Row[]).map((n) => ({ ...n, from: matchColleague(n.from) ?? String(n.from ?? "") }));
  const handoffs = ((report.handoffs ?? []) as Row[]).map((h) => ({ ...h, to: matchColleague(h.to) })).filter((h) => h.to).map((h) => {
    if (!h.product) return h;
    const hit = findByName(pairs, h.product) ?? loose(String(h.product));
    return hit ? { ...h, product_no: hit.no } : h;
  });
  return { ...report, colleague_notes: notes, handoffs };
}

export async function weekContext(agent: string, D: string) {
  const wStart = mondayOf(D);
  const lwStart = addDays(wStart, -7), lwEnd = addDays(wStart, -1);
  const q = async (filter: string): Promise<Row[]> => {
    const r = await rest(`agent_reports?agent=eq.${agent}&status=eq.ok&${filter}&select=report_date,report,created_at&order=report_date.asc,created_at.desc`);
    return r.ok ? (await r.json()) as Row[] : [];
  };
  const latestPerDate = (rows: Row[]) => {
    const m = new Map<string, Row>();
    for (const r of rows) if (!m.has(String(r.report_date))) m.set(String(r.report_date), r);
    return [...m.values()];
  };
  const prior = latestPerDate(await q(`report_date=gte.${wStart}&report_date=lt.${D}`));
  const priorDays = prior.map((r) => {
    const rp = (r.report ?? {}) as Row;
    return { date: String(r.report_date), dow: dow(String(r.report_date)), highlights: rp.highlights ?? [], warnings: rp.warnings ?? [], actions: rp.actions ?? [] };
  });
  const lw = latestPerDate(await q(`report_date=gte.${lwStart}&report_date=lte.${lwEnd}`));
  const lwLast = lw.length ? lw[lw.length - 1] : null;
  const lwRp = (lwLast?.report ?? null) as Row | null;
  const lastWeekActions = lwRp
    ? (Array.isArray(lwRp.week_actions) && lwRp.week_actions.length ? lwRp.week_actions : (lwRp.actions ?? []))
    : [];
  const doneRes = await rest(`agent_actions?agent=eq.${agent}&done=eq.true&select=action_id`);
  const doneIds = new Set<string>(doneRes.ok ? ((await doneRes.json()) as Row[]).map((r) => String(r.action_id)) : []);
  const latestPrior = prior.length ? prior[prior.length - 1] : null;
  const soFarRaw = ((latestPrior?.report as Row | undefined)?.week_actions ?? []) as Row[];
  const weekActionsSoFar = soFarRaw.map((a) => ({ ...a, done: a.id ? doneIds.has(String(a.id)) : false }));
  return {
    week: { start: wStart, end: D },
    prior_days: priorDays,
    week_actions_so_far: weekActionsSoFar,
    last_week: { start: lwStart, end: lwEnd, from_report_date: lwLast ? String(lwLast.report_date) : null, actions: lastWeekActions },
  };
}

// ── 리포트 JSON 공통 스키마 (담당자별 추가 필드는 extra로) ──
const item = (extra: Record<string, unknown> = {}, req: string[] = []) => ({
  type: "object",
  properties: { title: { type: "string" }, detail: { type: "string" }, ...extra },
  required: ["title", "detail", ...req], additionalProperties: false,
});
// lean(2026-10-18): 구조화 출력 문법을 줄인 모양 — 상품 전략 담당처럼 담당자 전용 표가 많아 '문법이 너무 크다'(400)에 걸리는 담당자용.
//   enum(mood·owner·status)은 문자열로, 주간 항목의 dates(배열 안의 배열)는 쉼표로 이은 문자열로 받는다 → leanFix가 원래 모양으로 되돌려서 화면·다음 날 문맥은 그대로.
const OWNERS = ["광고팀", "상품팀", "CS팀", "대표"];
export function reportSchema(opts: { highlights: string; warnings: string; actions: string; extra?: Record<string, unknown>; lean?: boolean }) {
  const extraProps = opts.extra ?? {};
  const lean = !!opts.lean;
  const pick = (vals: string[], desc = "") => lean ? { type: "string", description: `${desc ? desc + " — " : ""}다음 중 하나 그대로: ${vals.join(", ")}` } : { type: "string", enum: vals, ...(desc ? { description: desc } : {}) };
  const datesProp = (desc?: string) => lean ? { type: "string", description: (desc ?? "등장한 기준일") + " — YYYY-MM-DD를 쉼표로 이어서, 오래된 순" } : { type: "array", items: { type: "string" }, ...(desc ? { description: desc + " YYYY-MM-DD, 오래된 순" } : {}) };
  const sch: Row = {
    type: "object",
    properties: {
      headline: { type: "string", description: "한 문장 제목, 40자 이내. 핵심 한 줄" },
      mood: pick(["good", "neutral", "bad"], "전반 톤"),
      summary: { type: "array", items: { type: "string" }, description: "핵심 요약 3~5줄. 각 줄에 숫자 근거 포함" },
      highlights: { type: "array", items: item(), description: opts.highlights },
      warnings: { type: "array", items: item(), description: opts.warnings },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "할 일 한 줄" }, why: { type: "string", description: "왜 (데이터 근거)" },
            owner: pick(OWNERS),
          },
          required: ["title", "why", "owner"], additionalProperties: false,
        },
        description: opts.actions,
      },
      note: { type: "string", description: "데이터 한계나 주의점. 없으면 빈 문자열" },
      week_highlights: {
        type: "array",
        items: item({
          dates: datesProp("등장한 기준일 목록"),
          status: pick(["new", "ongoing"], "new = 오늘 처음, ongoing = 이번 주 앞선 날에도 있었음"),
        }, ["dates", "status"]),
        description: "이번 주(월~기준일) 누적 주목 항목. 앞선 날들의 highlights와 오늘 것을 합쳐 같은 상품·같은 신호는 하나로. 최대 8개",
      },
      week_warnings: {
        type: "array",
        items: item({ dates: datesProp(), status: pick(["new", "ongoing"]) }, ["dates", "status"]),
        description: "이번 주 누적 주의 항목. 이미 해소된 것은 뺀다. 최대 8개",
      },
      week_actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "할 일 고유 id. 이전 항목을 유지하면 그 id 그대로, 새 항목은 '기준일YYYYMMDD-순번' (예: 20260911-1)" },
            title: { type: "string" }, why: { type: "string" },
            owner: pick(OWNERS),
            since: { type: "string", description: "처음 제안한 기준일 YYYY-MM-DD" },
            status: pick(["new", "ongoing"]),
          },
          required: ["id", "title", "why", "owner", "since", "status"], additionalProperties: false,
        },
        description: "이번 주 할 일. this_week.week_actions_so_far 중 done=false인 것을 유지(id·since 그대로)하고 오늘 새 제안을 더한다. done=true는 뺀다. 중요한 순, 최대 6개",
      },
      colleague_notes: {
        type: "array",
        items: { type: "object", properties: { from: { type: "string", description: `어느 담당의 보고서인지 — 다음 이름 중 하나 그대로: ${COLLEAGUE_TARGETS.join(", ")}` }, took: { type: "string", description: "그 담당 보고서의 무엇을 내 판단에 어떻게 반영했나 (70자 이내, 숫자 포함)" } }, required: ["from", "took"], additionalProperties: false },
        description: "동료 보고서(colleagues)에서 가져와 판단에 반영한 것. 반영할 게 없으면 빈 배열(억지로 만들지 않음). 나에게 온 요청(handoffs_to_me)에 답했으면 여기에 '요청에 답함: …'으로 적는다. 최대 4개",
      },
      handoffs: {
        type: "array",
        items: { type: "object", properties: {
          to: { type: "string", description: `받을 담당자 (자기 자신 제외) — 다음 이름 중 하나 그대로: ${COLLEAGUE_TARGETS.join(", ")}` },
          product: { type: "string", description: "관련 상품명 — 데이터에 있는 그대로. 특정 상품이 아니면 빈 문자열" },
          ask: { type: "string", description: "확인·실행을 요청하는 한 줄 (40자 이내)" },
          why: { type: "string", description: "왜 필요한지 — 내 데이터의 숫자 근거 (70자 이내)" },
        }, required: ["to", "product", "ask", "why"], additionalProperties: false },
        description: "내 데이터로는 알 수 없지만 동료가 확인·실행해야 할 것. 최대 3개, 없으면 빈 배열",
      },
      ...extraProps,
    },
    required: ["headline", "mood", "summary", "highlights", "warnings", "actions", "note", "week_highlights", "week_warnings", "week_actions", "colleague_notes", "handoffs", ...Object.keys(extraProps)],
    additionalProperties: false,
  };
  if (!lean) return sch;
  // lean: 같은 모양의 짝(주목·주의, 이번 주 주목·주의)을 한 목록(kind로 구분)으로, 요약은 한 칸 글로 — 목록(배열) 하나하나가 문법을 크게 키우기 때문.
  //   2026-10-18 실측(임시 점검 함수): 상품 전략 담당 스키마는 칸 하나만 빼도 통과하는 한계선 바로 위였고, 이 두 짝을 합치면 표 1개를 더 넣을 여유가 생김.
  const P = sch.properties as Row, req = sch.required as string[];
  const merged = (a: string, b: string, desc: string) => {
    const it = JSON.parse(JSON.stringify((P[a] as Row).items)) as Row;
    it.properties = { kind: { type: "string", description: "'주목'(좋은 신호) 또는 '주의'(나쁜 신호)" }, ...(it.properties as Row) };
    it.required = ["kind", ...(it.required as string[])];
    return { type: "array", items: it, description: desc };
  };
  const props: Row = {};
  for (const [key, v] of Object.entries(P)) {
    if (key === "summary") props.summary = { type: "string", description: "핵심 요약 3~5줄을 줄바꿈으로 구분해 한 칸에. 각 줄에 숫자 근거 포함" };
    else if (key === "highlights") props.signals = merged("highlights", "warnings", `오늘의 주목(= highlights, kind '주목'): ${opts.highlights} / 주의(= warnings, kind '주의'): ${opts.warnings}`);
    else if (key === "week_highlights") props.week_signals = merged("week_highlights", "week_warnings", `이번 주 누적(= week_highlights·week_warnings). kind '주목' = ${String((P.week_highlights as Row).description ?? "")} / kind '주의' = ${String((P.week_warnings as Row).description ?? "")}`);
    else if (key === "warnings" || key === "week_warnings") continue;
    else props[key] = v;
  }
  const rq = req.flatMap((x) => x === "highlights" ? ["signals"] : x === "week_highlights" ? ["week_signals"] : x === "warnings" || x === "week_warnings" ? [] : [x]);
  return { ...sch, properties: props, required: rq };
}

// 모든 담당자에게 공통으로 붙는 글쓰기 원칙 + 주간 항목 규칙
export const COMMON_RULES = `
독자: 개발자가 아닌 경영자. 쉬운 한국어로, 짧고 분명하게 씁니다.
원칙:
- 모든 판단에는 숫자 근거를 붙입니다.
- 금액은 '만 원' 단위로 반올림해 읽기 쉽게 씁니다 (12,345,678원 → 1,235만 원). 억 단위면 '1.2억 원'.
- 확실하지 않은 원인은 "~로 보입니다", "확인 필요"처럼 추측임을 밝힙니다.
- 액션은 당장 할 수 있는 구체적인 것. 담당(광고팀/상품팀/CS팀/대표)을 정합니다. 예산·가격·판매 중단 같은 큰 결정은 '대표 확인 후'로 표현합니다.
- 데이터가 비어 있거나(null) 수집 오류(errors)가 있으면 그 부분은 모른다고 쓰고, 있는 데이터로만 판단합니다.
- 상품명은 데이터에 있는 그대로 씁니다. 없는 상품이나 숫자를 만들어내지 않습니다.
- 응답은 지정된 JSON 형식으로만 씁니다.

주간 항목(week_highlights / week_warnings / week_actions) — 대표가 그날 보고서를 못 봐도 놓치지 않게 하는 용도:
- this_week.prior_days(이번 주 앞선 날들의 주목·주의·할 일)와 오늘 것을 합쳐 씁니다. 같은 상품·같은 문제는 하나로 합치고 dates에 등장한 날짜를 전부 적습니다.
- 오늘 처음 나온 항목은 status "new", 앞선 날에도 있었으면 "ongoing". 여러 날 이어진 항목은 detail에 흐름(나아지는지, 나빠지는지)을 씁니다.
- 주의 항목 중 이미 해소된 것은 week_warnings에서 뺍니다.
- week_actions는 this_week.week_actions_so_far(이번 주 지금까지의 할 일, done = 사람이 완료 체크한 것)에서 done=false인 항목을 id·since 그대로 유지하고 오늘의 새 제안을 더합니다. **done=true인 항목은 완료된 것이니 반드시 뺍니다.** 지난 일이거나 의미가 없어진 것도 뺍니다. 새 항목의 id는 '기준일YYYYMMDD-순번'. 중요한 순으로 최대 6개.
- prior_days가 비어 있으면(주 첫날) 주간 항목은 오늘 것과 같고 status는 전부 "new".
- actions(오늘 새로 제안하는 것)는 주간 항목과 별개로 그대로 씁니다.

동료와 함께 일하기 (colleagues = 다른 담당자들의 최근 보고서 요약, is_today=true면 오늘 아침 같은 기준일 것 / handoffs_to_me = 동료가 나에게 넘긴 요청):
- 보고서를 쓰기 전에 colleagues를 읽고 내 판단과 맞물리는 것을 찾습니다. 같은 상품을 동료가 다르게 봤으면(예: 매출 담당은 급상승, 반품 담당은 위험) 두 신호를 **합쳐서** 판단하고 그 사실을 문장에 씁니다 ("매출은 늘지만 반품 담당 기준 반품률 18%라 소재 확대 전 사이즈 안내부터").
- colleague_notes에 동료 보고서의 무엇을 어떻게 반영했는지 적습니다. 반영할 게 없으면 빈 배열 — 억지로 만들지 않습니다.
- handoffs_to_me에 요청이 있으면 **반드시 답합니다**: 확인 결과를 highlights·warnings·summary 중 알맞은 곳에 넣고 colleague_notes에 "요청에 답함: …"을 적습니다. 내 데이터에 없으면 "확인 불가(이유)"라고 답합니다.
- handoffs로 동료에게 넘깁니다(최대 3개): 급상승·주목 상품의 반품률 확인 → 취소·반품 감시 담당 / 조회 많고 주문율 낮은 상품의 상세 점검 → 상세페이지 점검 담당 / 밀어줄 상품의 소재 제작안 → 광고 소재 담당 / 반품 위험·광고 효율이 좋은 상품을 전략에 반영 → 상품 전략 담당 / 매출 흐름 확인 → 매출 분석 담당. 상품명은 데이터에 있는 그대로.
- 동료의 숫자를 내 숫자처럼 다시 쓰지 않습니다. 인용할 때는 "반품 담당 보고서 기준"처럼 출처를 밝힙니다.`;

// ── Claude 호출 ──
export type LLMImage = { url: string; label: string };
// 출력 잘림(2026-10-13): 반품 담당 보고서가 한 달에 3번(9/20·10/4·10/11) max_tokens 8000에 걸려 JSON이 끊김("Unterminated string in JSON").
//   평소 출력이 5.3~7.9K 토큰이라 상한에 가깝다. 상한을 올리면 생성 시간이 벽시계 150초를 넘기므로(약 70토큰/초) 대신
//   ① stop_reason이 max_tokens면 OutputTruncated로 명확히 던지고 ② writeStage가 같은 수집 데이터로 **한 번 자동 재시도**(새 worker, effort low + 짧게 쓰라는 지시).
export class OutputTruncated extends Error {}
export const isTruncationError = (e: unknown) =>
  e instanceof OutputTruncated || /Unterminated string in JSON|Unexpected end of JSON|max_tokens/.test(String((e as Error)?.message ?? e));
const COMPACT_HINT = `\n\n[중요] 앞선 시도에서 출력이 너무 길어 중간에 잘렸습니다. 이번에는 반드시 짧게 씁니다: detail·why·cause·fix는 모두 한 문장(40자 이내), summary 3줄, highlights·warnings 각 4개 이내, week_highlights·week_warnings 각 5개 이내, week_actions 5개 이내. 표 항목은 꼭 필요한 것만.`;
export const DEFAULT_MAX_TOKENS = 8000;
export async function writeReport(system: string, schema: unknown, data: unknown, week: unknown, effort: "low" | "medium" | "high" = "medium", images: LLMImage[] = [],
  opts: { maxTokens?: number; compact?: boolean } = {})
  : Promise<{ report: Row; usage: unknown; model: string }> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY 미설정 — Supabase secrets에 Claude API 키를 넣고 함수를 재배포하세요");
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  // 이미지(광고 소재 썸네일 등)는 **함수가 내려받아 base64로** 넘긴다 — Meta CDN은 robots.txt로 외부 수집을 막아
  // URL 블록을 쓰면 Anthropic 쪽에서 "disallowed by robots.txt"로 거부됨(2026-09-12 실사례). 최대 10장, 장당 400KB 상한, 실패는 건너뜀.
  // ⚠ 함수 자원 한도(WORKER_RESOURCE_LIMIT) 실사례: 600px 썸네일 12장 + 문자열 base64 변환으로 초과 → 320px 썸네일 + std encodeBase64.
  const content: unknown[] = [];
  const fetched = await Promise.all(images.slice(0, 10).map(async (im) => {
    try {
      const res = await fetch(im.url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const type = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
      if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > 400 * 1024) return null;
      return { label: im.label, media_type: type, data: encodeBase64(buf) };
    } catch { return null; }
  }));
  for (const im of fetched) {
    if (!im) continue;
    content.push({ type: "text", text: `[이미지] ${im.label}` });
    content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } });
  }
  content.push({
    type: "text",
    text: `아래는 기준일(어제)까지의 수집 데이터, 이번 주 앞선 날들의 보고 항목(this_week), 동료 담당자들의 최근 보고서 요약(colleagues)과 나에게 온 요청(handoffs_to_me)입니다. 아침 리포트를 작성하세요.\n\n[수집 데이터]\n${JSON.stringify(data)}\n\n[this_week · colleagues]\n${JSON.stringify(week)}${opts.compact ? COMPACT_HINT : ""}`,
  });
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content }],
  } as Parameters<typeof client.messages.create>[0]);
  if (res.stop_reason === "refusal") throw new Error("Claude가 응답을 거부했습니다");
  if (res.stop_reason === "max_tokens") throw new OutputTruncated(`출력이 너무 길어 잘림 (상한 ${maxTokens} 토큰, 출력 ${(res.usage as Row | undefined)?.output_tokens ?? "?"} 토큰)`);
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  return { report: JSON.parse(text), usage: res.usage, model: res.model };
}

// ── 저장 + 알림 ──
export async function saveRow(row: Row): Promise<Row> {
  const res = await rest("agent_reports", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`리포트 저장 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json())[0];
}

// 에이전트 앱 사용 권한 (2026-09-28 사용자 요청): 관리자 + 허용 목록(agent_users — 워크스페이스 직원 관리에서 지정).
export async function canUseAgents(me: { id: string; role: string } | null): Promise<boolean> {
  if (!me) return false;
  if (me.role === "admin") return true;
  const r = await rest(`agent_users?user_id=eq.${encodeURIComponent(me.id)}&select=user_id`);
  return r.ok && ((await r.json()) as unknown[]).length > 0;
}

export async function notifyAdmins(label: string, D: string, headline: string): Promise<{ saved: number; pushed: number }> {
  // 수신자 = 관리자 전원 + 허용 목록 중 알림을 켠 직원 (2026-09-28)
  const ures = await rest("app_users?role=eq.admin&select=id");
  const admins: string[] = ures.ok ? ((await ures.json()) as { id: string }[]).map((u) => u.id) : [];
  const ares = await rest("agent_users?notify=eq.true&select=user_id");
  const extra: string[] = ares.ok ? ((await ares.json()) as { user_id: string }[]).map((u) => u.user_id) : [];
  const ids: string[] = [...new Set([...admins, ...extra])];
  if (!ids.length) return { saved: 0, pushed: 0 };
  const msg = `[${D.slice(5).replace("-", "/")} ${label} 리포트] ${headline}`.slice(0, 200);
  await rest("notifications", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify(ids.map((user_id) => ({ user_id, actor_name: label, message: msg, link_menu: "agents" }))),
  });
  let pushed = 0;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY") ?? "", priv = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
  if (pub && priv) {
    webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com", pub, priv);
    const sres = await rest(`push_subscriptions?user_id=in.(${ids.map((i) => `"${i}"`).join(",")})`);
    const subs = sres.ok ? await sres.json() : [];
    const payload = JSON.stringify({ title: `${label} 리포트가 도착했어요`, body: headline, url: `${AGENTS_URL}#reports` });
    await Promise.all(subs.map(async (s: { endpoint: string; p256dh: string; auth: string }) => {
      try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); pushed++; }
      catch (e) {
        const code = (e as { statusCode?: number }).statusCode ?? 0;
        if (code === 404 || code === 410) await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      }
    }));
  }
  return { saved: ids.length, pushed };
}

// ── 공통 핸들러: status / collect / run ──
export interface AgentDef {
  agent: string;                                   // agent_reports.agent
  label: string;                                   // 알림에 쓰는 이름 (예: '매출 분석 담당')
  system: string;                                  // Claude 시스템 프롬프트
  schema: unknown;                                 // reportSchema(...)
  collect: (D: string) => Promise<Row & { errors: string[] }>;
  // 선택: Claude에 보낼 데이터만 줄이기(표시용 원자료는 data에 그대로 저장) — 입력 토큰·시간 절약
  forLLM?: (data: Row) => unknown;
  // 선택: Claude 응답에 숫자 채워 넣기(Claude가 숫자를 다시 쓰지 않게 해 출력 토큰·시간 절약)
  postProcess?: (report: Row, data: Row) => Row;
  effort?: "low" | "medium" | "high";   // 기본 medium
  colleagueRules?: string;               // 선택: 동료 보고서를 어떻게 쓸지 담당자별 규칙 (2026-10-17) — system 끝에 붙는다
  images?: (data: Row) => LLMImage[];    // 선택: Claude가 봐야 할 이미지(광고 소재 썸네일 등, 최대 12장)
  // 선택: 담당자 전용 추가 액션(관리자 또는 x-cron-secret). 예: strategy-agent의 'trends'(데이터랩 순위표를 낮에 받아 저장, 2026-10-11)
  actions?: Record<string, (url: URL, req: Request) => Promise<Response>>;
}
export function serveAgent(def: AgentDef) {
  Deno.serve(async (req) => {
    const opt = handleOptions(req);
    if (opt) return opt;
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "status";
    const viaCron = !!CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;
    const me = viaCron ? null : await verifyAuthToken(req);
    if (!viaCron && !(await canUseAgents(me))) return json({ error: "접근 권한이 없습니다" }, 403);

    try {
      if (action === "status") {
        const r = await rest(`agent_reports?agent=eq.${def.agent}&select=id,report_date,status,trigger,created_at,error&order=created_at.desc&limit=1`);
        const last = r.ok ? ((await r.json())[0] ?? null) : null;
        return json({ agent: def.agent, configured: !!ANTHROPIC_API_KEY, secret_ready: !!AGENT_SECRET, model: MODEL, last });
      }
      let D = url.searchParams.get("date") ?? "";
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (body?.date) D = String(body.date);
      }
      const yesterday = addDays(seoulToday(), -1);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(D) || D > yesterday) D = yesterday;
      if (!AGENT_SECRET) return json({ error: "AGENT_SECRET 미설정" }, 500);

      if (action === "collect") {
        const t0 = Date.now();
        const data = await def.collect(D);
        return json({ ...data, took_ms: Date.now() - t0 });
      }
      // ── run = 2단계 (2026-09-13): ① 이 isolate에서 수집해 api_cache에 저장 → ② 자기 자신을 write로 호출(새 isolate)해 Claude·저장·알림.
      //    Supabase 무료 요금제의 요청당 CPU 한도(WORKER_RESOURCE_LIMIT 546) 때문 — 수집(JSON 대량·TLS)과 이미지 base64·Claude 응답 파싱을
      //    한 요청에 몰면 한도를 넘는다(상품 전략 담당 실사례). 벽시계는 1단계가 2단계 응답을 기다리므로 합산되지만 대기는 CPU가 아니다.
      if (action === "run") {
        const trigger = viaCron ? "cron" : "manual";
        const t0 = Date.now();
        let data: Row | null = null;
        try {
          data = await def.collect(D);
          const key = `agentrun:${def.agent}:${D}:${crypto.randomUUID()}`;
          // 작성 단계가 중간에 죽어(546 등) 못 지운 옛 수집 데이터 정리 — 하루 지난 것만 (재시도 중인 것은 몇 분 안에 끝남)
          await rest(`api_cache?cache_key=like.agentrun:*&created_at=lt.${encodeURIComponent(new Date(Date.now() - 86400000).toISOString())}`,
            { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});
          const put = await rest(`api_cache?on_conflict=cache_key`, {
            method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({ cache_key: key, payload: { data, trigger, created_by: me?.id ?? null }, created_at: new Date().toISOString() }),
          });
          if (!put.ok) throw new Error(`수집 데이터 임시 저장 실패 ${put.status}`);
          // 작성 단계는 **별도 함수 agent-write**(다른 worker) — 같은 함수를 다시 부르면 같은 worker가 받아 CPU 한도가 합산됨(실측 546).
          // 호출은 **DB의 pg_net**(rpc agent_dispatch_write)이 한다: 이 함수가 202로 끝나며 연결이 끊겨도 agent-write는 계속 돈다.
          // (직접 fetch + waitUntil 방식은 호출자 종료와 함께 agent-write도 죽어 보고서가 안 남는 실사례, 2026-09-13)
          const dispatch = await rest("rpc/agent_dispatch_write", { method: "POST", body: JSON.stringify({ p_agent: def.agent, p_date: D, p_key: key }) });
          if (!dispatch.ok) throw new Error(`작성 단계 예약 실패 ${dispatch.status}: ${(await dispatch.text()).slice(0, 160)}`);
          return json({ queued: true, report_date: D, key, collect_ms: Date.now() - t0, message: "수집 완료 — 보고서 작성 중(1~2분). 새 보고서가 생기면 목록에 나타납니다." }, 202);
        } catch (e) {
          const msg = String((e as Error)?.message ?? e).slice(0, 500);
          await saveRow({ agent: def.agent, report_date: D, trigger, status: "error", data, error: msg, created_by: me?.id ?? null }).catch(() => {});
          return json({ error: msg, report_date: D, took_ms: Date.now() - t0 }, 500);
        }
      }

      if (def.actions && def.actions[action]) return await def.actions[action](url, req);
      return json({ error: "알 수 없는 action" }, 400);
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
    }
  });
}

// ── 2단계 작성 (agent-write 함수가 호출): api_cache에 저장된 수집 데이터로 Claude 리포트 작성·저장·알림 ──
//   출력 잘림이면 **한 번 자동 재시도**(2026-10-13): 수집 데이터를 지우지 않고 payload.retry를 1로 올린 뒤 agent_dispatch_write를 다시 불러
//   새 worker가 effort low + 짧게 쓰라는 지시로 다시 쓴다. 사용자가 확인·재실행해야 하는 설계를 피하기 위함(원칙). 두 번째도 실패하면 error 행.
//   opts.maxTokens는 점검용(agent-write의 x-test-max-tokens 헤더) — 일부러 잘리게 해 재시도 경로를 확인할 때만.
export async function writeStage(def: AgentDef, D: string, key: string, opts: { maxTokens?: number } = {}): Promise<Response> {
  const keyQ = `api_cache?cache_key=eq.${encodeURIComponent(key)}`;
  const got = await rest(`${keyQ}&select=payload`);
  const row = got.ok ? ((await got.json())[0] ?? null) : null;
  if (!row) return json({ error: "수집 데이터를 찾을 수 없습니다 (key)" }, 400);
  const dropCache = () => rest(keyQ, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});
  const payload = row.payload as { data: Row; trigger: string; created_by: string | null; retry?: number };
  const trigger = payload.trigger, data = payload.data, createdBy = payload.created_by, retry = num(payload.retry);
  const t0 = Date.now();
  try {
    const [wc, cc] = await Promise.all([weekContext(def.agent, D), colleagueContext(def.agent, D)]);
    const llmData = def.forLLM ? def.forLLM(data) : data;
    const system = def.colleagueRules ? `${def.system}\n\n이 담당자의 협업 규칙:\n${def.colleagueRules}` : def.system;
    const { report: written0, usage, model } = await writeReport(system, def.schema, llmData,
      { week: wc.week, prior_days: wc.prior_days, week_actions_so_far: wc.week_actions_so_far, colleagues: cc.colleagues, handoffs_to_me: cc.handoffs_to_me }, retry > 0 ? "low" : (def.effort ?? "medium"),
      def.images ? def.images(data) : [], { maxTokens: opts.maxTokens, compact: retry > 0 });
    const lean0 = leanFix(written0);
    const written = resolveProductNos(def.postProcess ? def.postProcess(lean0, data) : lean0, data);
    const report = { ...written, week: wc.week, last_week: wc.last_week, colleagues_seen: cc.seen, handoffs_received: cc.handoffs_to_me };
    const saved = await saveRow({ agent: def.agent, report_date: D, trigger, status: "ok", data, report, model, usage: { ...(usage as Row), retry }, created_by: createdBy });
    await dropCache();
    const notified = await notifyAdmins(def.label, D, String(report.headline ?? "")).catch(() => ({ saved: 0, pushed: 0 }));
    return json({ ok: true, id: saved.id, report_date: D, report, notified, retry, write_ms: Date.now() - t0 });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    if (isTruncationError(e) && retry < 1) {
      const upd = await rest(keyQ, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ payload: { ...payload, retry: retry + 1 } }) });
      const re = upd.ok ? await rest("rpc/agent_dispatch_write", { method: "POST", body: JSON.stringify({ p_agent: def.agent, p_date: D, p_key: key }) }) : upd;
      if (re.ok) return json({ retrying: true, retry: retry + 1, error: msg, report_date: D, write_ms: Date.now() - t0 }, 202);
    }
    await dropCache();
    const finalMsg = (retry > 0 ? `(짧게 다시 쓰기 ${retry}회 재시도 후에도 실패) ` : "") + msg;
    await saveRow({ agent: def.agent, report_date: D, trigger, status: "error", data, error: finalMsg, created_by: createdBy }).catch(() => {});
    return json({ error: finalMsg, report_date: D, write_ms: Date.now() - t0 }, 500);
  }
}
export const isCronRequest = (req: Request) => !!CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;

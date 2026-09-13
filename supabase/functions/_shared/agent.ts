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
export function reportSchema(opts: { highlights: string; warnings: string; actions: string; extra?: Record<string, unknown> }) {
  const extraProps = opts.extra ?? {};
  return {
    type: "object",
    properties: {
      headline: { type: "string", description: "한 문장 제목, 40자 이내. 핵심 한 줄" },
      mood: { type: "string", enum: ["good", "neutral", "bad"], description: "전반 톤" },
      summary: { type: "array", items: { type: "string" }, description: "핵심 요약 3~5줄. 각 줄에 숫자 근거 포함" },
      highlights: { type: "array", items: item(), description: opts.highlights },
      warnings: { type: "array", items: item(), description: opts.warnings },
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "할 일 한 줄" }, why: { type: "string", description: "왜 (데이터 근거)" },
            owner: { type: "string", enum: ["광고팀", "상품팀", "CS팀", "대표"] },
          },
          required: ["title", "why", "owner"], additionalProperties: false,
        },
        description: opts.actions,
      },
      note: { type: "string", description: "데이터 한계나 주의점. 없으면 빈 문자열" },
      week_highlights: {
        type: "array",
        items: item({
          dates: { type: "array", items: { type: "string" }, description: "등장한 기준일 목록 YYYY-MM-DD, 오래된 순" },
          status: { type: "string", enum: ["new", "ongoing"], description: "new = 오늘 처음, ongoing = 이번 주 앞선 날에도 있었음" },
        }, ["dates", "status"]),
        description: "이번 주(월~기준일) 누적 주목 항목. 앞선 날들의 highlights와 오늘 것을 합쳐 같은 상품·같은 신호는 하나로. 최대 8개",
      },
      week_warnings: {
        type: "array",
        items: item({ dates: { type: "array", items: { type: "string" } }, status: { type: "string", enum: ["new", "ongoing"] } }, ["dates", "status"]),
        description: "이번 주 누적 주의 항목. 이미 해소된 것은 뺀다. 최대 8개",
      },
      week_actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "할 일 고유 id. 이전 항목을 유지하면 그 id 그대로, 새 항목은 '기준일YYYYMMDD-순번' (예: 20260911-1)" },
            title: { type: "string" }, why: { type: "string" },
            owner: { type: "string", enum: ["광고팀", "상품팀", "CS팀", "대표"] },
            since: { type: "string", description: "처음 제안한 기준일 YYYY-MM-DD" },
            status: { type: "string", enum: ["new", "ongoing"] },
          },
          required: ["id", "title", "why", "owner", "since", "status"], additionalProperties: false,
        },
        description: "이번 주 할 일. this_week.week_actions_so_far 중 done=false인 것을 유지(id·since 그대로)하고 오늘 새 제안을 더한다. done=true는 뺀다. 중요한 순, 최대 6개",
      },
      ...extraProps,
    },
    required: ["headline", "mood", "summary", "highlights", "warnings", "actions", "note", "week_highlights", "week_warnings", "week_actions", ...Object.keys(extraProps)],
    additionalProperties: false,
  };
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
- actions(오늘 새로 제안하는 것)는 주간 항목과 별개로 그대로 씁니다.`;

// ── Claude 호출 ──
export type LLMImage = { url: string; label: string };
export async function writeReport(system: string, schema: unknown, data: unknown, week: unknown, effort: "low" | "medium" | "high" = "medium", images: LLMImage[] = [])
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
    text: `아래는 기준일(어제)까지의 수집 데이터와 이번 주 앞선 날들의 보고 항목입니다. 아침 리포트를 작성하세요.\n\n[수집 데이터]\n${JSON.stringify(data)}\n\n[this_week]\n${JSON.stringify(week)}`,
  });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    system,
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content }],
  } as Parameters<typeof client.messages.create>[0]);
  if (res.stop_reason === "refusal") throw new Error("Claude가 응답을 거부했습니다");
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  return { report: JSON.parse(text), usage: res.usage, model: res.model };
}

// ── 저장 + 알림 ──
export async function saveRow(row: Row): Promise<Row> {
  const res = await rest("agent_reports", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`리포트 저장 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json())[0];
}

export async function notifyAdmins(label: string, D: string, headline: string): Promise<{ saved: number; pushed: number }> {
  const ures = await rest("app_users?role=eq.admin&select=id");
  const ids: string[] = ures.ok ? ((await ures.json()) as { id: string }[]).map((u) => u.id) : [];
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
  images?: (data: Row) => LLMImage[];    // 선택: Claude가 봐야 할 이미지(광고 소재 썸네일 등, 최대 12장)
}
export function serveAgent(def: AgentDef) {
  Deno.serve(async (req) => {
    const opt = handleOptions(req);
    if (opt) return opt;
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "status";
    const viaCron = !!CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;
    const me = viaCron ? null : await verifyAuthToken(req);
    if (!viaCron && (!me || me.role !== "admin")) return json({ error: "접근 권한이 없습니다" }, 403);

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

      return json({ error: "알 수 없는 action" }, 400);
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
    }
  });
}

// ── 2단계 작성 (agent-write 함수가 호출): api_cache에 저장된 수집 데이터로 Claude 리포트 작성·저장·알림 ──
export async function writeStage(def: AgentDef, D: string, key: string): Promise<Response> {
  const got = await rest(`api_cache?cache_key=eq.${encodeURIComponent(key)}&select=payload`);
  const row = got.ok ? ((await got.json())[0] ?? null) : null;
  if (!row) return json({ error: "수집 데이터를 찾을 수 없습니다 (key)" }, 400);
  await rest(`api_cache?cache_key=eq.${encodeURIComponent(key)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  const payload = row.payload as { data: Row; trigger: string; created_by: string | null };
  const trigger = payload.trigger, data = payload.data, createdBy = payload.created_by;
  const t0 = Date.now();
  try {
    const wc = await weekContext(def.agent, D);
    const llmData = def.forLLM ? def.forLLM(data) : data;
    const { report: written0, usage, model } = await writeReport(def.system, def.schema, llmData,
      { week: wc.week, prior_days: wc.prior_days, week_actions_so_far: wc.week_actions_so_far }, def.effort ?? "medium",
      def.images ? def.images(data) : []);
    const written = def.postProcess ? def.postProcess(written0, data) : written0;
    const report = { ...written, week: wc.week, last_week: wc.last_week };
    const saved = await saveRow({ agent: def.agent, report_date: D, trigger, status: "ok", data, report, model, usage, created_by: createdBy });
    const notified = await notifyAdmins(def.label, D, String(report.headline ?? "")).catch(() => ({ saved: 0, pushed: 0 }));
    return json({ ok: true, id: saved.id, report_date: D, report, notified, write_ms: Date.now() - t0 });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    await saveRow({ agent: def.agent, report_date: D, trigger, status: "error", data, error: msg, created_by: createdBy }).catch(() => {});
    return json({ error: msg, report_date: D, write_ms: Date.now() - t0 }, 500);
  }
}
export const isCronRequest = (req: Request) => !!CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET;

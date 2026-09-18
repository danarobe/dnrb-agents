// ═══════════════════════════════════════════════
// agent-ask — 담당자에게 질문하기 (2026-09-15)
//   보고서 화면 아래에서 대표가 그 보고서의 담당자에게 묻는다. 담당자는 ① 그 보고서(report) ② 그날 수집 데이터(data)
//   ③ 같은 보고서의 앞선 문답을 맥락으로 답하고, 부족하면 **워크스페이스 데이터 함수를 다시 조회**한다(툴 사용, 최대 4회).
//   - 인증: 관리자 로그인만(x-auth-token). cron 없음(요청형).
//   - 한 요청 안에서 동기로 끝낸다(게이트웨이 100초 한계 → 75초가 넘으면 더 조회하지 않고 지금까지 정보로 답하게 함).
//   - 비용: 보고서·데이터를 system 블록에 넣고 cache_control → 같은 보고서에 이어 묻는 질문은 입력의 대부분이 캐시 읽기(1/10 가격).
//   - 기록: agent_questions(질문·답·다시 조회한 데이터 목록). 답변은 사람이 읽는 문장(JSON 아님).
//   POST ?action=ask  body {report_id, question}  → {id, answer, tools_used, took_ms}
//   GET  ?action=list&report_id=…               → {rows:[…]}
// ═══════════════════════════════════════════════
import Anthropic from "npm:@anthropic-ai/sdk";
import { handleOptions, json, verifyAuthToken } from "../_shared/util.ts";
import { addDays, AgentDef, callFn, COMMON_RULES, MODEL, num, rest, Row, seoulToday } from "../_shared/agent.ts";
import { DEF as SALES } from "../sales-agent/def.ts";
import { DEF as RETURNS } from "../returns-agent/def.ts";
import { DEF as STRATEGY } from "../strategy-agent/def.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const DEFS: Record<string, AgentDef> = { sales: SALES, returns: RETURNS, strategy: STRATEGY };
const LABELS: Record<string, string> = { sales: "매출 분석 담당", returns: "취소·반품 감시 담당", strategy: "상품 전략 담당", detail: "상세페이지 점검 담당", creative: "광고 소재 담당" };
const MAX_TOOL_ROUNDS = 4, TIME_BUDGET_MS = 75_000, MAX_QUESTION = 500, PRIOR_QA = 6;

// ── 담당자 페르소나: def.system에서 담당자 고유 규칙만(COMMON_RULES 앞부분) 떼어 쓴다 ──
function persona(agent: string): string {
  const def = DEFS[agent];
  if (def) return def.system.split(COMMON_RULES)[0].trim();
  if (agent === "detail") return "당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 상세페이지 점검 담당자입니다. 상세 이미지를 읽어 실측표·사이즈 가이드·소재·컷 구성·첫 화면을 점검하고 개선안을 냅니다.";
  if (agent === "creative") return "당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 광고 소재 담당자입니다. 상품의 상세페이지·리뷰·기존 광고 성과를 근거로 Meta 광고 소재의 후킹 포인트와 제작안을 씁니다. 목표는 CPC·구매당 비용은 낮게, ROAS·전환은 높게. 없는 사실·수치·리뷰 인용을 만들지 않고, 반품 사유와 충돌하는 소구는 피합니다.";
  return `당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 ${LABELS[agent] ?? agent}입니다.`;
}

const ASK_RULES = `
[질문 답변 모드]
대표가 위 보고서를 읽고 묻는 질문에 답합니다. 독자는 개발자가 아닌 경영자입니다.
- 먼저 보고서와 수집 데이터에서 근거를 찾고, 거기에 없는 기간·상품·숫자가 필요하면 도구로 다시 조회합니다. 도구는 꼭 필요할 때만, 한 번에 여러 개를 병렬로 부릅니다(최대 4회).
- 답은 짧고 분명하게: 결론 먼저 한 줄, 그다음 근거 숫자 2~4줄, 필요하면 제안 1~2줄. 전체 8줄 이내. 줄마다 숫자 근거.
- 금액은 '만 원' 단위(억 단위면 '1.2억 원'). 요일 효과를 고려해 전날 대비보다 '지난주 같은 요일'·'7일 vs 직전 7일' 비교를 우선합니다.
- 확실하지 않은 원인은 "~로 보입니다"처럼 추측임을 밝히고, 데이터에 없는 상품·숫자는 만들지 않습니다. 모르면 모른다고 씁니다.
- 예산·가격·판매 중단 같은 큰 결정은 '대표 확인 후'로 표현합니다. 당신은 제안만 하고 실행하지 않습니다.
- 일반 문장으로 답합니다(JSON·마크다운 표 금지, 필요하면 '- ' 글머리 줄만). 상품명은 데이터에 있는 그대로.`;

// ── 다시 조회할 수 있는 데이터(툴) — 워크스페이스 함수를 x-agent-secret으로 admin 호출 ──
const DATE = { type: "string", description: "YYYY-MM-DD" };
const TOOLS: Anthropic.Tool[] = [
  {
    name: "revenue", description: "카페24 결제 매출·주문 수 (기간 합계). 어제·지난주·특정 기간 매출을 다시 볼 때.",
    input_schema: { type: "object", properties: { start_date: DATE, end_date: DATE }, required: ["start_date", "end_date"], additionalProperties: false }, strict: true,
  },
  {
    name: "products", description: "기간별 상품 조회수·주문 수량·주문율·주문 금액 (카페24 애널리틱스). 상품명 일부(query)로 찾거나 조회수/판매 상위를 볼 때. 최대 15개.",
    input_schema: {
      type: "object",
      properties: { start_date: DATE, end_date: DATE, query: { type: "string", description: "상품명에 포함될 글자 (비우면 전체)" }, sort: { type: "string", enum: ["qty", "views", "rate"], description: "정렬: 판매수량·조회수·주문율" }, limit: { type: "integer", description: "1~15" } },
      required: ["start_date", "end_date", "query", "sort", "limit"], additionalProperties: false,
    }, strict: true,
  },
  {
    name: "claims", description: "기간(주문일 기준) 주문의 지금까지 취소·반품 건수·금액·사유 TOP5 (카페24 자사몰). 최근 주문은 미성숙이라 추세 비교에는 쓰지 말 것.",
    input_schema: { type: "object", properties: { start_date: DATE, end_date: DATE }, required: ["start_date", "end_date"], additionalProperties: false }, strict: true,
  },
  {
    name: "cohort_weeks", description: "결제 주차(월~일) 코호트 취소율·반품률 — 그 주에 결제된 주문 중 지금까지 취소·반품된 비율, 경과일·성숙 여부 포함. 취소·반품 추세 질문에 사용.",
    input_schema: { type: "object", properties: { end_date: DATE, weeks: { type: "integer", description: "몇 주, 1~12 (보통 6)" } }, required: ["end_date", "weeks"], additionalProperties: false }, strict: true,
  },
  {
    name: "return_watch", description: "기준일 기준 7/14/30일 창 상품별 순반품률(배송완료 수량 대비 반품 수량, 결제수량 상위 30) — 특정 상품의 반품률 질문에 사용. 상품명 일부(query)로 좁힐 수 있음.",
    input_schema: { type: "object", properties: { end_date: DATE, query: { type: "string", description: "상품명에 포함될 글자 (비우면 상위 12개)" } }, required: ["end_date", "query"], additionalProperties: false }, strict: true,
  },
  {
    name: "meta_ads", description: "Meta 광고 기간 합계(광고비·구매·구매금액·Meta ROAS)와 지출 상위 소재 10개(소재명·지출·구매·ROAS·빈도).",
    input_schema: { type: "object", properties: { start_date: DATE, end_date: DATE }, required: ["start_date", "end_date"], additionalProperties: false }, strict: true,
  },
  {
    name: "product_info", description: "상품 번호로 카페24 상품 정보(판매가·공급가·등록일·품절·진열 여부). 상품 번호는 products 결과의 product_no.",
    input_schema: { type: "object", properties: { product_nos: { type: "array", items: { type: "integer" }, description: "최대 20개" } }, required: ["product_nos"], additionalProperties: false }, strict: true,
  },
];

const ymd = (v: unknown, fallback: string) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : fallback;
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
async function runTool(name: string, input: Row, yesterday: string): Promise<{ label: string; result: unknown }> {
  const s = ymd(input.start_date, addDays(yesterday, -6)), e = ymd(input.end_date, yesterday);
  const period = (a: string, b: string) => a === b ? a.slice(5).replace("-", "/") : `${a.slice(5).replace("-", "/")}~${b.slice(5).replace("-", "/")}`;
  if (name === "revenue") {
    const b = await callFn("cafe24-analytics", { action: "revenue", start_date: s, end_date: e });
    return { label: `매출 ${period(s, e)}`, result: { period: [s, e], revenue: num(b.revenue), orders: num(b.order_count), note: "카페24 결제완료 기준 합계(원)" } };
  }
  if (name === "products") {
    const b = await callFn("cafe24-analytics", { action: "summary", start_date: s, end_date: e }) as { rows?: Row[]; totals?: Row };
    const q = norm(String(input.query ?? ""));
    const sortKey = { qty: "order_qty", views: "views", rate: "rate" }[String(input.sort)] ?? "order_qty";
    const limit = Math.max(1, Math.min(15, num(input.limit) || 10));
    const rows = (b.rows ?? []).filter((r) => !q || norm(String(r.product_name ?? "")).includes(q))
      .sort((a, c) => num(c[sortKey]) - num(a[sortKey])).slice(0, limit)
      .map((r) => ({ product_no: Number(r.product_no), name: r.product_name, views: num(r.views), order_qty: num(r.order_qty), rate: num(r.rate), order_amount: num(r.order_amount) }));
    return { label: `상품 ${period(s, e)}${q ? ` '${String(input.query).trim()}'` : ""}`, result: { period: [s, e], matched: rows.length, rows, totals: b.totals ? { views: num(b.totals.views), order_qty: num(b.totals.order_qty), rate: num(b.totals.rate) } : null } };
  }
  if (name === "claims") {
    const b = await callFn("cafe24-claims", { start_date: s, end_date: e }) as Record<string, Row>;
    const top = (arr: unknown) => Array.isArray(arr) ? (arr as Row[]).slice(0, 5).map((x) => ({ reason: x.reason, count: x.cnt })) : [];
    return { label: `취소·반품 ${period(s, e)}`, result: { period: [s, e], cancel: { count: num(b.cancel?.count), amount: num(b.cancel?.amount), reasons: top(b.cancel?.reasons) }, return: { count: num(b.return?.count), amount: num(b.return?.amount), reasons: top(b.return?.reasons) }, note: "주문일 기준, 지금까지 들어온 취소·반품 (최근 주문은 더 늘어남)" } };
  }
  if (name === "cohort_weeks") {
    const end = ymd(input.end_date, yesterday), weeks = String(Math.max(1, Math.min(12, num(input.weeks) || 6)));
    const b = await callFn("cafe24-analytics", { action: "cohortweeks", end_date: end, weeks, days: "0" }) as { weeks?: Row[] };
    const rows = (b.weeks ?? []).map((w) => ({ week: `${w.start}~${w.end}`, paid: num(w.paid), cancel: num(w.cancel), cancel_rate: w.cancel_rate ?? null, ret: num(w.ret), return_rate: w.return_rate ?? null, age_days: w.age_days ?? null, maturity: w.maturity ?? (w.partial ? "진행 중" : null) }));
    return { label: `결제 주차 코호트 ${weeks}주`, result: { end_date: end, weeks: rows, note: "성숙 = 경과 14일 이상. 미성숙 주는 아직 늘어날 수 있음" } };
  }
  if (name === "return_watch") {
    const end = ymd(input.end_date, addDays(yesterday, -3));
    const b = await callFn("cafe24-analytics", { action: "returnwatch", end_date: end, top: "30", risk: "20", min_qty: "10" }) as { products?: Row[] };
    const q = norm(String(input.query ?? ""));
    const win = (p: Row, d: number) => { const w = ((p.windows ?? {}) as Record<string, Row>)[String(d)] ?? {}; return { delivered: num(w.del), returned: num(w.ret), rate: w.rate ?? null }; };
    const rows = (b.products ?? []).filter((p) => !q || norm(String(p.product_name ?? "")).includes(q)).slice(0, q ? 15 : 12)
      .map((p) => ({ product_no: Number(p.product_no), name: p.product_name, rank14: p.rank14, win7: win(p, 7), win14: win(p, 14), win30: win(p, 30), risk_options: ((p.risk_options ?? []) as unknown[]).slice(0, 3) }));
    return { label: `순반품률 ${end.slice(5).replace("-", "/")} 기준${q ? ` '${String(input.query).trim()}'` : ""}`, result: { end_date: end, rows, note: "배송완료 수량 대비 반품 수량. 배송 10개 미만은 판정 보류" } };
  }
  if (name === "meta_ads") {
    const [sum, top] = await Promise.all([
      callFn("meta-ads", { action: "summary", start_date: s, end_date: e }),
      callFn("meta-ads", { action: "topads", start_date: s, end_date: e }).catch(() => ({ ads: [] })),
    ]);
    if (sum.error === "not_connected") return { label: `광고 ${period(s, e)}`, result: { error: "Meta 광고 미연동" } };
    const ads = ((top.ads ?? []) as Row[]).slice(0, 10).map((a) => ({ name: a.ad_name, spend: num(a.spend), purchases: num(a.purchases), roas: Math.round(num(a.roas) * 100) / 100, frequency: Math.round(num(a.frequency) * 10) / 10 }));
    return { label: `광고 ${period(s, e)}`, result: { period: [s, e], spend: num(sum.spend), purchases: num(sum.purchases), purchase_value: num(sum.purchase_value), meta_roas: Math.round(num(sum.meta_roas) * 100) / 100, top_ads: ads } };
  }
  if (name === "product_info") {
    const nos = (Array.isArray(input.product_nos) ? input.product_nos : []).map((n) => num(n)).filter((n) => n > 0).slice(0, 20);
    if (!nos.length) return { label: "상품 정보", result: { error: "product_nos 비어 있음" } };
    const b = await callFn("cafe24-analytics", { action: "productinfo", product_nos: nos.join(",") }) as { products?: Row[] };
    const rows = (b.products ?? []).map((p) => {
      const price = num(p.price), supply = num(p.supply_price);
      return { product_no: Number(p.product_no), name: p.product_name, price, supply_price: supply, margin_rate: price > 0 ? Math.round((price - supply * 1.1) / price * 1000) / 10 : null, created: String(p.created_date ?? "").slice(0, 10), sold_out: String(p.sold_out) === "T", display: String(p.display) === "T", selling: String(p.selling) === "T" };
    });
    return { label: `상품 정보 ${rows.length}개`, result: { rows, note: "마진율 = (판매가 − 공급가×1.1) ÷ 판매가" } };
  }
  return { label: name, result: { error: "알 수 없는 도구" } };
}

// ── 보고서 맥락: 보고서 본문 + 수집 데이터(담당자 forLLM으로 줄인 것) ──
function contextText(row: Row): string {
  const agent = String(row.agent);
  const def = DEFS[agent];
  const data = (row.data ?? {}) as Row;
  const llmData = def?.forLLM ? def.forLLM(data) : data;
  const report = { ...(row.report as Row ?? {}) };
  // 상세 점검 보고서는 reviews 안의 context·usage가 크다 — 판단 결과만
  if (agent === "detail" && Array.isArray(report.reviews)) {
    report.reviews = (report.reviews as Row[]).map((x) => ({ product_name: x.product_name, status: x.status, review: x.review ? { ...(x.review as Row), usage: undefined, context: undefined } : null }));
  }
  return `[보고서 — ${LABELS[agent] ?? agent}, 기준일 ${row.report_date}, 작성 ${String(row.created_at).slice(0, 16)}]\n${JSON.stringify(report)}\n\n[그날 수집 데이터]\n${JSON.stringify(llmData)}`;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  const me = await verifyAuthToken(req);
  if (!me || me.role !== "admin") return json({ error: "접근 권한이 없습니다" }, 403);
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "list";
  try {
    if (action === "list") {
      const rid = url.searchParams.get("report_id") ?? "";
      if (!/^[0-9a-f-]{36}$/.test(rid)) return json({ error: "report_id 필수" }, 400);
      const r = await rest(`agent_questions?report_id=eq.${rid}&select=id,question,answer,tools_used,status,error,asked_by_name,took_ms,created_at&order=created_at.asc&limit=50`);
      return json({ rows: r.ok ? await r.json() : [] });
    }
    if (action !== "ask" || req.method !== "POST") return json({ error: "알 수 없는 action" }, 400);
    if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY 미설정" }, 500);
    const body = await req.json().catch(() => ({}));
    const rid = String(body.report_id ?? ""), question = String(body.question ?? "").trim().slice(0, MAX_QUESTION);
    if (!/^[0-9a-f-]{36}$/.test(rid) || !question) return json({ error: "report_id와 question이 필요합니다" }, 400);
    const rr = await rest(`agent_reports?id=eq.${rid}&select=id,agent,report_date,status,report,data,created_at`);
    const row = rr.ok ? ((await rr.json())[0] ?? null) as Row | null : null;
    if (!row || row.status !== "ok" || !row.report) return json({ error: "보고서를 찾을 수 없거나 실패한 보고서입니다" }, 404);
    const agent = String(row.agent);
    const t0 = Date.now();
    const yesterday = addDays(seoulToday(), -1);

    // 같은 보고서의 앞선 문답 → 대화 맥락
    const pr = await rest(`agent_questions?report_id=eq.${rid}&status=eq.ok&select=question,answer&order=created_at.desc&limit=${PRIOR_QA}`);
    const prior = (pr.ok ? ((await pr.json()) as Row[]) : []).reverse();
    const messages: Anthropic.MessageParam[] = [];
    for (const p of prior) { messages.push({ role: "user", content: String(p.question) }); messages.push({ role: "assistant", content: String(p.answer) }); }
    messages.push({ role: "user", content: `${question}\n\n(오늘 ${seoulToday()}, 어제 ${yesterday}. 도구 기간은 어제까지만 유효)` });

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: `${persona(agent)}\n${ASK_RULES}` },
      { type: "text", text: contextText(row), cache_control: { type: "ephemeral" } },
    ];
    const toolsUsed: { tool: string; label: string }[] = [];
    let answer = "", usage: Row = {}, model = MODEL;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const overBudget = Date.now() - t0 > TIME_BUDGET_MS || round === MAX_TOOL_ROUNDS;
      const res = await client.messages.create({
        model: MODEL, max_tokens: 2000, system, tools: TOOLS,
        tool_choice: overBudget ? { type: "none" } : { type: "auto" },
        output_config: { effort: "low" },
        messages,
      } as Parameters<typeof client.messages.create>[0]) as Anthropic.Message;
      model = res.model;
      const u = res.usage as unknown as Row;
      usage = { input_tokens: num(usage.input_tokens) + num(u.input_tokens), output_tokens: num(usage.output_tokens) + num(u.output_tokens), cache_read_input_tokens: num(usage.cache_read_input_tokens) + num(u.cache_read_input_tokens), cache_creation_input_tokens: num(usage.cache_creation_input_tokens) + num(u.cache_creation_input_tokens), rounds: round + 1 };
      if (res.stop_reason === "refusal") throw new Error("Claude가 응답을 거부했습니다");
      const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
      if (!toolUses.length) { answer = text; break; }
      messages.push({ role: "assistant", content: res.content });
      const results = await Promise.all(toolUses.map(async (tu): Promise<Anthropic.ToolResultBlockParam> => {
        try {
          const { label, result } = await runTool(tu.name, (tu.input ?? {}) as Row, yesterday);
          toolsUsed.push({ tool: tu.name, label });
          return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) };
        } catch (e) {
          toolsUsed.push({ tool: tu.name, label: `${tu.name} 실패` });
          return { type: "tool_result", tool_use_id: tu.id, content: `조회 실패: ${String((e as Error)?.message ?? e).slice(0, 200)}`, is_error: true };
        }
      }));
      messages.push({ role: "user", content: results });
    }
    if (!answer) answer = "답을 만들지 못했어요. 질문을 조금 바꿔서 다시 물어봐 주세요.";
    const saved = await rest("agent_questions", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ report_id: rid, agent, question, answer, tools_used: toolsUsed, status: "ok", model, usage, asked_by: me.id, asked_by_name: me.name, took_ms: Date.now() - t0 }),
    });
    const srow = saved.ok ? (await saved.json())[0] : null;
    return json({ id: srow?.id ?? null, answer, tools_used: toolsUsed, usage, took_ms: Date.now() - t0 });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 400);
    return json({ error: msg }, 500);
  }
});

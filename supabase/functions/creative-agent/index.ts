// ═══════════════════════════════════════════════
// 광고 소재 담당 (2026-09-18, 사용자 기획) — 판매 급상승 5 + 최근 베스트 5 상품의 **상세페이지·리뷰·기존 광고 성과**를 읽어
//   "어떤 후킹 포인트로 Meta 광고 소재를 만들면 좋을지" 제작안을 낸다. 목표: CPC·구매당 비용은 낮게, ROAS·전환은 높게.
//   (광고 예산·계정 운영 리포트는 사용자가 따로 보므로 다루지 않는다 — 기존 광고 성과는 '어떤 훅이 먹혔나'의 근거로만 쓴다.)
//
//   근거 우선순위(프롬프트에 강제): ① 이 상품 광고에서 이미 검증된 앵글(CTR·CPC·ROAS) ② 리뷰에서 반복되는 고객 언어
//     ③ 상세페이지의 차별점 ④ 혜택(1+1·할인) ⑤ 급상승 검색 키워드(상품과 맞을 때만). 반품 사유·부정 리뷰와 충돌하는 소구는 금지.
//
//   흐름 (모든 단계는 DB pg_net `agent_call`이 호출 — 무료 요금제 150초/CPU 한도 회피, detail-agent와 같은 방식):
//     run(관리자|cron, ?product_no= 로 1개만) ─ 상품 선정(급상승 5 + 베스트 5, 품절 제외, 최근 28일에 다룬 상품은 뒤로) + 소재 유형별 효율 계산
//                                            → creative_briefs 행(seq) 생성 → 첫 상품 prepare
//     prepare ─ 상세 이미지 URL·해시 → 같은 해시의 읽기 결과(detail_reviews·creative_briefs, READ_VERSION 일치) 재사용 → 없으면 조각 계획 → read(장마다)
//     read(i) ─ Gemini 읽기 → creative_page_done → 마지막 장이면 brief
//     brief ─ 리뷰(카페24 후기 게시판) + 광고 문구(adcards) + 반품 사유 + 급상승 키워드 → Claude 제작안 → 다음 상품 prepare(순차) → 다 끝나면 agent_reports(creative) 1건 + 알림
//   한 상품씩 순차로 도는 이유: 10개를 동시에 읽으면 Gemini·wsrv 호출이 120개 몰린다. 상품당 1~2분, 묶음 10~20분.
// ═══════════════════════════════════════════════
import Anthropic from "npm:@anthropic-ai/sdk";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { handleOptions, json, verifyAuthToken } from "../_shared/util.ts";
import { addDays, callFn, isCronRequest, MODEL, notifyAdmins, num, rest, Row, seoulToday } from "../_shared/agent.ts";
import { GEMINI_KEY, GEMINI_MODEL, geminiRead, imageMeta, MAX_IMAGES, READ_VERSION, tilePlan, TILE_W, wsrv } from "../_shared/detailread.ts";
import { marginRate, paGroups, paKey, paNorm, PaProd, paPickBest, paVerTok } from "../strategy-agent/def.ts";

const AGENT = "creative";
const LABEL = "광고 소재 담당";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const N_SURGE = 5, N_BEST = 5, ROTATE_DAYS = 28, MAX_REVIEWS_LLM = 60;

const dispatch = async (qs: string) => {
  const r = await rest("rpc/agent_call", { method: "POST", body: JSON.stringify({ p_fn: "creative-agent", p_qs: qs }) });
  if (!r.ok) throw new Error(`디스패치 실패 ${r.status}: ${(await r.text()).slice(0, 120)}`);
};
const loadRow = async (id: string): Promise<Row | null> => {
  const r = await rest(`creative_briefs?id=eq.${encodeURIComponent(id)}&select=*`);
  return r.ok ? ((await r.json())[0] ?? null) : null;
};
const patchRow = async (id: string, body: Row) => {
  await rest(`creative_briefs?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }) });
};

// ── 소재 유형별 효율: 광고명 규칙(…_P7_다나대표_…, …_R1_할인강조_…, …릴스1, …스토리_7)에서 유형을 읽어 CTR·CPC·구매당 비용·ROAS를 가중 집계 ──
const STYLES: [string, RegExp][] = [
  ["릴스(영상)", /릴스|(?:^|[_\s])R\d+(?:[_\s]|$)/i],
  ["사진(P)", /(?:^|[_\s])P\d+(?:[_\s]|$)/],
  ["인스타 게시물형", /인스타|(?:^|[_\s])i\d+(?:[_\s]|$)/i],
  ["스토리", /스토리/],
  ["다나대표 등장", /다나/],
  ["할인강조", /할인/],
  ["착용컷", /착용/],
  ["상세컷", /상세컷/],
];
type AdRow = { ad_id: string; ad_name: string; spend: number; impressions: number; clicks: number; ctr: number; cpc: number; purchases: number; purchase_value: number; roas: number; cost_per_purchase: number };
function agg(list: AdRow[]) {
  const spend = list.reduce((t, a) => t + a.spend, 0), imp = list.reduce((t, a) => t + a.impressions, 0), clk = list.reduce((t, a) => t + a.clicks, 0);
  const pur = list.reduce((t, a) => t + a.purchases, 0), val = list.reduce((t, a) => t + a.purchase_value, 0);
  return { ads: list.length, spend, ctr: imp > 0 ? +(clk / imp * 100).toFixed(2) : null, cpc: clk > 0 ? Math.round(spend / clk) : null, cost_per_purchase: pur > 0 ? Math.round(spend / pur) : null, roas: spend > 0 ? +(val / spend).toFixed(2) : null, purchases: pur };
}
function formatStats(ads: AdRow[]) {
  const account = agg(ads);
  const styles = STYLES.map(([label, re]) => ({ style: label, ...agg(ads.filter((a) => re.test(a.ad_name))) }))
    .filter((s) => s.ads >= 5 && s.spend >= 300000);
  return { account, styles, note: "최근 30일, 지출이 있었던 광고 전체(꺼진 것 포함). 광고명 규칙으로 유형을 읽은 것이라 한 광고가 여러 유형에 걸칠 수 있음" };
}

// ── Claude 제작안 ──
const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    one_liner: { type: "string", description: "이 상품을 한 문장으로: 누가·언제·왜 사는지 (50자 이내)" },
    target: { type: "string", description: "핵심 고객과 구매 상황 (리뷰·상세 근거, 60자 이내)" },
    hooks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          angle: { type: "string", enum: ["문제 해결", "고객 후기·사회적 증거", "혜택·가성비", "디테일·품질", "상황·코디", "비교·반전"] },
          goal: { type: "string", enum: ["클릭형", "전환형"], description: "클릭형 = 스크롤을 멈추게 해 CPC를 낮추는 훅 / 전환형 = 살 이유를 분명히 해 구매당 비용을 낮추는 훅" },
          hook_text: { type: "string", description: "첫 3초 자막 또는 이미지 첫 줄. 20자 이내, 메시지 하나, 고객이 쓰는 말" },
          why: { type: "string", description: "이 훅을 고른 근거 — 숫자 포함(리뷰 n건 중 m건 언급, 기존 소재 CTR·ROAS, 상세 문구 등)" },
          evidence: { type: "array", items: { type: "string", enum: ["기존 광고 성과", "리뷰", "상세페이지", "혜택", "검색 트렌드"] } },
          format: { type: "string", description: "추천 형식 — 릴스/사진/캐러셀/스토리 + 컷 종류. shared.format_stats 근거가 있으면 반영" },
          first_scene: { type: "string", description: "첫 장면 연출 한 줄 (무엇을 어떻게 보여줄지)" },
          primary_text: { type: "string", description: "광고 본문 2~3줄. 첫 줄에 훅, 마지막 줄에 혜택·행동 유도" },
          headline: { type: "string", description: "헤드라인 25자 이내" },
        },
        required: ["angle", "goal", "hook_text", "why", "evidence", "format", "first_scene", "primary_text", "headline"], additionalProperties: false,
      },
      description: "후킹 포인트 3~5개, 기대 효과가 큰 순. 전환형을 최소 1개, 클릭형을 최소 1개 포함",
    },
    proof_quotes: { type: "array", items: { type: "string" }, description: "소재 자막·이미지에 그대로 쓸 수 있는 리뷰 원문 인용(40자 이내, 원문 그대로). 리뷰가 없으면 빈 배열" },
    used_angles: { type: "array", items: { type: "object", properties: { angle: { type: "string", description: "이미 돌린 소재의 소구(광고 문구·이름에서 읽은 것)" }, verdict: { type: "string", enum: ["변주해서 확대", "유지", "폐기"] }, reason: { type: "string" } }, required: ["angle", "verdict", "reason"], additionalProperties: false }, description: "이 상품에 이미 쓴 앵글 평가(ads가 없으면 빈 배열). 최대 4개" },
    avoid: { type: "array", items: { type: "string" }, description: "피해야 할 소구와 이유 — 반품 사유·부정 리뷰와 충돌, 상세에 근거 없음, Meta 정책 위험. 최대 4개" },
    landing_match: { type: "string", description: "광고 훅이 약속한 것을 상세 첫 화면이 바로 증명하는지, 맞추려면 상세에서 무엇을 앞으로 올려야 하는지 (전환율에 직결)" },
    test_plan: { type: "string", description: "먼저 테스트할 훅 2~3개와 3일 뒤 판단 기준(CTR·CPC·구매당 비용을 shared.format_stats.account 평균과 비교)" },
    confidence: { type: "string", enum: ["상", "중", "하"], description: "근거 양에 따른 신뢰도" },
    confidence_reason: { type: "string" },
  },
  required: ["one_liner", "target", "hooks", "proof_quotes", "used_angles", "avoid", "landing_match", "test_plan", "confidence", "confidence_reason"], additionalProperties: false,
};
const BRIEF_SYSTEM = `당신은 온라인 여성 패션 쇼핑몰 '다나로브(DNRB)'의 광고 소재 담당자입니다. 상품 하나의 상세페이지(pages)·리뷰(reviews)·기존 광고 성과(ads)·판매 지표(metrics)를 읽고, Meta(인스타·페이스북) 광고 소재를 어떤 후킹 포인트로 만들지 제작안을 씁니다.
목표는 분명합니다: **CPC와 구매당 비용은 낮게, ROAS와 전환은 높게.** 독자는 광고 소재를 직접 만드는 팀(비개발자). 쉬운 한국어로 짧고 구체적으로.

성과를 좌우하는 원칙:
1. CPC는 첫 3초(릴스)·첫 줄(이미지)이 정합니다. 훅 하나에 메시지 하나, 구체적인 상황·숫자, 고객이 실제로 쓰는 말(리뷰 표현)을 씁니다. "예쁜 가을 신상" 같은 누구나 쓰는 말은 금지.
2. 근거 우선순위: ① 이 상품 광고에서 이미 검증된 앵글(ads의 CTR·CPC·ROAS가 shared.format_stats.account 평균보다 좋은 소재의 문구) → 버리지 말고 변주 ② 리뷰에서 여러 번 반복되는 표현(몇 건인지 셉니다) ③ 상세페이지에만 있는 차별점 ④ 혜택(1+1·할인 — metrics.promos에 있을 때만) ⑤ 급상승 검색 키워드(rising_keywords) — 그 키워드를 정의하는 특징이 pages의 features·texts에 실제로 있을 때만.
3. 구매당 비용과 ROAS는 '광고가 약속한 것 = 상세 첫 화면이 증명하는 것'일 때 좋아집니다. 훅이 상세에 없는 내용을 약속하면 클릭만 사고 전환은 안 됩니다 → landing_match에 씁니다.
4. 반품·부정 신호와 충돌하는 소구는 금지: return_reasons나 낮은 별점 리뷰에 '크다/길다/비친다'가 많으면 '딱 맞는 핏' 같은 훅을 쓰지 않습니다. 오히려 기대치를 맞추는 문구(예: "넉넉한 루즈핏")가 반품을 줄여 실질 ROAS를 올립니다 → avoid에 씁니다.
5. 이미 쓴 앵글(ads의 문구·이름)과 똑같은 제안은 하지 않습니다. 잘 된 앵글은 '변주해서 확대', 성과 나쁜 앵글은 '폐기'로 used_angles에 평가합니다.
6. 형식 추천은 shared.format_stats(소재 유형별 CTR·CPC·구매당 비용·ROAS)에 근거를 둡니다. 근거가 없으면 없다고 씁니다.
7. hooks는 클릭형(스크롤 멈춤)과 전환형(살 이유)을 섞습니다. 전환형 최소 1개.

절대 규칙:
- 없는 사실을 만들지 않습니다. 소재·기능·수치·리뷰 인용은 pages·reviews·metrics에 있는 것만. 리뷰 인용(proof_quotes)은 원문 그대로이며 reviews가 없으면 빈 배열입니다.
- reviews.status가 'ok'가 아니면(권한 대기·없음) 리뷰 근거를 지어내지 말고 confidence를 낮추며 confidence_reason에 "리뷰 미반영"을 밝힙니다.
- ads가 비어 있으면 '기존 광고 성과' 근거를 쓰지 않습니다(광고가 없다는 뜻일 수도, 수집이 안 된 것일 수도 있음).
- Meta 광고 정책: 개인 속성을 단정하는 문구("살찐 당신", "나이 들어 보이는 당신") 금지, 과장된 전후 비교·의학적 효능·"최저가/1위" 같은 검증 불가 표현 금지.
- 가격·혜택 숫자는 metrics에 있는 것만 씁니다.
응답은 지정 JSON만.`;

async function claudeBrief(context: Row): Promise<{ brief: Row; usage: unknown }> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY 미설정");
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: MODEL, max_tokens: 6000, system: BRIEF_SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: BRIEF_SCHEMA } },
    messages: [{ role: "user", content: `광고 소재 제작안을 쓸 상품 자료입니다.\n${JSON.stringify(context)}` }],
  } as Parameters<typeof client.messages.create>[0]);
  if (res.stop_reason === "refusal") throw new Error("Claude가 응답을 거부했습니다");
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  return { brief: JSON.parse(text), usage: res.usage };
}

// ── 다른 담당자 보고서에서 이 상품의 반품 사유·급상승 키워드 ──
async function sideContext(no: number): Promise<Row> {
  const out: Row = {};
  const latest = async (agent: string) => { const r = await rest(`agent_reports?agent=eq.${agent}&status=eq.ok&select=data&order=created_at.desc&limit=1`); return r.ok ? ((await r.json())[0] ?? null) : null; };
  const rt = await latest("returns");
  if (rt) {
    const risk = ((((rt.data as Row).top_sellers_return ?? {}) as Row).risk_products ?? []) as Row[];
    const hit = risk.find((p) => Number(p.product_no) === no);
    if (hit) out.return_reasons = { level: (hit.win14 as Row)?.level, rate_14d: (hit.win14 as Row)?.rate, reasons_top3: hit.reasons_top3, risk_options: ((hit.risk_options ?? []) as unknown[]).slice(0, 3) };
  }
  const st = await latest("strategy");
  if (st) {
    const rising: string[] = [];
    for (const c of (((((st.data as Row).trends ?? {}) as Row).naver ?? []) as Row[])) for (const r of ((c.rising ?? []) as Row[])) if (((r.our_products ?? []) as Row[]).some((p) => Number(p.no) === no)) rising.push(String(r.keyword));
    if (rising.length) out.rising_keywords = rising.slice(0, 5);
  }
  return out;
}

// ── 묶음 진행: 다음 대기 상품을 시작하거나, 다 끝났으면 보고서로 묶는다 ──
async function advance(batch: string) {
  const r = await rest(`creative_briefs?batch_id=eq.${encodeURIComponent(batch)}&select=id,seq,status&order=seq.asc`);
  const rows: Row[] = r.ok ? await r.json() : [];
  if (rows.some((x) => ["reading", "briefing"].includes(String(x.status)))) return;   // 아직 도는 상품이 있음
  const next = rows.find((x) => x.status === "queued");
  if (next) { await patchRow(String(next.id), { status: "reading" }); await dispatch(`action=prepare&id=${next.id}`); return; }
  await summarize(batch);
}
const fail = async (row: Row, msg: string) => { await patchRow(String(row.id), { status: "error", error: msg.slice(0, 500) }); await advance(String(row.batch_id)); };

async function summarize(batch: string) {
  const r = await rest(`creative_briefs?batch_id=eq.${encodeURIComponent(batch)}&select=id,seq,product_no,product_name,report_date,kind,metrics,ads,shared,reviews,status,brief,error,images&order=seq.asc`);
  const rows: Row[] = r.ok ? await r.json() : [];
  if (!rows.length) return;
  const exists = await rest(`agent_reports?agent=eq.${AGENT}&select=id&data->>batch_id=eq.${encodeURIComponent(batch)}&limit=1`);
  if (exists.ok && ((await exists.json()) as unknown[]).length) return;
  const oks = rows.filter((x) => x.status === "ok" && x.brief);
  const short = (n: unknown) => String(n ?? "").replace(/^\s*(?:\([^)]*\)|\[[^\]]*\])\s*/g, "").replace(/\s*\([^)]*\)\s*$/, "").slice(0, 14);
  const reviewOk = oks.filter((x) => (x.reviews as Row)?.status === "ok").length;
  const scopeMissing = rows.some((x) => (x.reviews as Row)?.status === "scope_missing");
  const surge = oks.filter((x) => x.kind === "surge").length, best = oks.filter((x) => x.kind === "best").length;
  const headline = oks.length
    ? (rows.length === 1 ? `소재 제작안: ${short(oks[0].product_name)} 훅 ${(((oks[0].brief as Row).hooks ?? []) as unknown[]).length}개` : `소재 제작안 ${oks.length}개 상품 (급상승 ${surge} · 베스트 ${best})`)
    : `소재 제작안 실패 ${rows.length}건`;
  const shared = (rows[0].shared ?? {}) as Row;
  const report = {
    headline, mood: "neutral",
    summary: [
      ...oks.slice(0, 5).map((x) => { const h = ((((x.brief as Row).hooks ?? []) as Row[])[0] ?? {}) as Row; return `${short(x.product_name)} — 1순위 훅 "${h.hook_text ?? ""}" (${h.angle ?? ""}·${h.goal ?? ""})`; }),
      scopeMissing ? "리뷰는 아직 반영되지 않았습니다 (카페24 게시판 읽기 권한 재연동 대기) — 상세페이지·광고 성과·반품 사유만으로 작성" : `리뷰 반영 ${reviewOk}/${oks.length}개 상품`,
    ],
    briefs: rows.map((x) => ({
      brief_id: x.id, product_no: x.product_no, product_name: x.product_name, kind: x.kind, status: x.status, error: x.error,
      metrics: x.metrics, ads: x.ads, review_status: (x.reviews as Row)?.status ?? "none", review_count: (x.reviews as Row)?.count ?? 0, rating_avg: (x.reviews as Row)?.rating_avg ?? null,
      image_count: Array.isArray(x.images) ? (x.images as unknown[]).length : 0, brief: x.brief,
    })),
  };
  await rest("agent_reports", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ agent: AGENT, report_date: String(rows[0].report_date), trigger: "cron", status: oks.length ? "ok" : "error", error: oks.length ? null : String(rows[0].error ?? "전부 실패"), data: { batch_id: batch, count: rows.length, format_stats: shared.format_stats ?? null, review_scope_missing: scopeMissing }, report, model: MODEL }) });
  await notifyAdmins(LABEL, String(rows[0].report_date), headline).catch(() => {});
}

Deno.serve(async (req) => {
  const opt = handleOptions(req); if (opt) return opt;
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "status";
  const viaCron = isCronRequest(req);
  const me = viaCron ? null : await verifyAuthToken(req);
  if (!viaCron && (!me || me.role !== "admin")) return json({ error: "접근 권한이 없습니다" }, 403);

  try {
    if (action === "status") {
      const r = await rest(`agent_reports?agent=eq.${AGENT}&select=id,report_date,status,trigger,created_at,error&order=created_at.desc&limit=1`);
      const run = await rest(`creative_briefs?status=in.(queued,reading,briefing)&select=batch_id,status&limit=50`);
      const running: Row[] = run.ok ? await run.json() : [];
      return json({ agent: AGENT, configured: !!ANTHROPIC_API_KEY && !!GEMINI_KEY, model: MODEL, last: r.ok ? ((await r.json())[0] ?? null) : null, running: running.length });
    }

    // ── 1) 상품 선정 + 행 생성 + 첫 상품 시작 ──
    if (action === "run") {
      const D = addDays(seoulToday(), -1);
      const forced = Number(url.searchParams.get("product_no") || 0);
      const busy = await rest(`creative_briefs?status=in.(queued,reading,briefing)&created_at=gte.${new Date(Date.now() - 40 * 60000).toISOString()}&select=id&limit=1`);
      if (busy.ok && ((await busy.json()) as unknown[]).length) return json({ error: "앞선 분석이 아직 도는 중이에요. 끝나면 다시 요청해 주세요 (보통 10~20분)" }, 409);

      const cur14 = [addDays(D, -13), D], cur7 = [addDays(D, -6), D], prev7 = [addDays(D, -13), addDays(D, -7)];
      const sum = async (s: string, e: string) => ((await callFn("cafe24-analytics", { action: "summary", start_date: s, end_date: e })).rows ?? []) as Row[];
      const rows14 = await sum(cur14[0], cur14[1]);
      const [rows7, rowsPrev, ben, perf] = await Promise.all([
        sum(cur7[0], cur7[1]), sum(prev7[0], prev7[1]),
        callFn("cafe24-analytics", { action: "benefits" }).catch(() => null),
        callFn("meta-ads", { action: "adperf" }).catch(() => null),
      ]);
      const m14 = new Map(rows14.map((r) => [Number(r.product_no), r])), m7 = new Map(rows7.map((r) => [Number(r.product_no), r])), mPrev = new Map(rowsPrev.map((r) => [Number(r.product_no), r]));
      const nameOf = (no: number) => String(m14.get(no)?.product_name ?? m7.get(no)?.product_name ?? "");

      // 후보: 급상승(7일 10개↑, (cur+5)/(prev+5) 큰 순 — 매출·전략 담당과 같은 규칙) / 베스트(14일 결제수량 순)
      const surgeRank = rows7.filter((r) => num(r.order_qty) >= 10).map((r) => { const no = Number(r.product_no), prev = num(mPrev.get(no)?.order_qty); return { no, qty7: num(r.order_qty), prev, score: (num(r.order_qty) + 5) / (prev + 5) }; })
        .filter((x) => x.qty7 > x.prev).sort((a, b) => b.score - a.score).slice(0, 15);
      const bestRank = [...rows14].sort((a, b) => num(b.order_qty) - num(a.order_qty)).slice(0, 15).map((r, i) => ({ no: Number(r.product_no), rank: i + 1 }));
      const candNos = forced ? [forced] : [...new Set([...surgeRank.map((x) => x.no), ...bestRank.map((x) => x.no)])];
      const info = await callFn("cafe24-analytics", { action: "productinfo", product_nos: candNos.join(",") }).catch(() => null);
      const infoMap = new Map((((info?.products ?? []) as Row[])).map((p) => [Number(p.product_no), p]));
      const soldOut = (no: number) => String(infoMap.get(no)?.sold_out ?? "") === "T" || String(infoMap.get(no)?.selling ?? "T") === "F";
      // 최근 28일 안에 제작안을 쓴 상품은 뒤로(베스트가 매주 같은 5개로 굳는 것 방지) — 후보가 모자라면 다시 씀
      //   단, 리뷰 없이(권한 대기·오류) 쓴 제작안은 '다룬 것'으로 치지 않는다 — 권한이 생기면 리뷰를 넣어 다시 쓰게.
      const recent = await rest(`creative_briefs?status=eq.ok&reviews->>status=in.(ok,none)&created_at=gte.${addDays(D, -ROTATE_DAYS)}T00:00:00Z&select=product_no`);
      const seen = new Set<number>(recent.ok ? ((await recent.json()) as Row[]).map((x) => Number(x.product_no)) : []);
      const pick = (list: { no: number }[], n: number, taken: Set<number>) => {
        const ok = list.filter((x) => !soldOut(x.no) && !taken.has(x.no));
        const fresh = ok.filter((x) => !seen.has(x.no)), again = ok.filter((x) => seen.has(x.no));
        const out = [...fresh, ...again].slice(0, n); out.forEach((x) => taken.add(x.no)); return out;
      };
      const taken = new Set<number>();
      const surge = forced ? [] : pick(surgeRank, N_SURGE, taken) as typeof surgeRank;
      const best = forced ? [] : pick(bestRank, N_BEST, taken) as typeof bestRank;
      const chosen: { no: number; kind: string }[] = forced ? [{ no: forced, kind: "manual" }] : [...surge.map((x) => ({ no: x.no, kind: "surge" })), ...best.map((x) => ({ no: x.no, kind: "best" }))];
      if (!chosen.length) return json({ ok: true, queued: [], message: "분석할 상품이 없습니다" });

      // 광고 ↔ 상품 매칭(전략 담당과 같은 규칙) + 소재 유형별 효율
      const adsAll = ((perf?.ads ?? []) as AdRow[]);
      const allProds: PaProd[] = [...new Map([...rows14, ...rows7].map((r) => [Number(r.product_no), String(r.product_name ?? "")])).entries()]
        .map(([no, name]) => ({ no, name, key: paNorm(paKey(name)), ver: paVerTok(name) ? paNorm(paVerTok(name)!) : null, qty: num(m14.get(no)?.order_qty) })).filter((p) => p.key.length >= 3);
      const groups = paGroups(allProds);
      const adsByProduct = new Map<number, AdRow[]>();
      for (const ad of adsAll) { const b = paPickBest(paNorm(ad.ad_name), allProds, groups); if (b) (adsByProduct.get(b.no) ?? adsByProduct.set(b.no, []).get(b.no)!).push(ad); }
      const shared = { ads_known: !!perf, format_stats: perf ? formatStats(adsAll) : null, period: perf?.period ?? null };
      const promosOf = (no: number): string[] => { const bp = ((ben?.by_product ?? {}) as Record<string, Row[]>)[String(no)] ?? []; return bp.map((b) => `${b.name}: ${b.desc}${b.end ? ` (~${String(b.end).slice(5)})` : ""}`).slice(0, 3); };

      const batch = `${D}-${crypto.randomUUID().slice(0, 8)}`;
      const ids: string[] = [];
      for (let i = 0; i < chosen.length; i++) {
        const { no, kind } = chosen[i];
        const r14 = m14.get(no), r7 = m7.get(no), p = infoMap.get(no) ?? {};
        const price = num(p.price), supply = num(p.supply_price);
        const sr = surgeRank.find((x) => x.no === no), br = bestRank.find((x) => x.no === no);
        const metrics = {
          why: kind === "surge" ? `급상승 (7일 ${sr?.prev ?? 0}→${sr?.qty7 ?? 0}개)` : kind === "best" ? `베스트 ${br?.rank ?? "-"}위 (14일 ${num(r14?.order_qty)}개)` : "직접 고름",
          qty_7d: num(r7?.order_qty), qty_prev7d: num(mPrev.get(no)?.order_qty), qty_14d: num(r14?.order_qty), views_14d: num(r14?.views), rate_14d: num(r14?.rate),
          price: price || null, margin_rate: marginRate(price, supply), promos: promosOf(no), best_rank_14d: br?.rank ?? null,
        };
        const own = (adsByProduct.get(no) ?? []).sort((a, b) => b.spend - a.spend).slice(0, 8);
        const ins = await rest("creative_briefs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ batch_id: batch, seq: i, product_no: no, product_name: nameOf(no) || String(p.product_name ?? ""), report_date: D, kind, metrics, ads: shared.ads_known ? own : null, shared, status: "queued" }) });
        if (!ins.ok) throw new Error(`행 생성 실패 ${ins.status}: ${(await ins.text()).slice(0, 160)}`);
        ids.push(String(((await ins.json())[0] as Row).id));
      }
      await advance(batch);
      return json({ ok: true, batch, queued: chosen.map((c, i) => ({ id: ids[i], product_no: c.no, kind: c.kind, name: nameOf(c.no) })), message: chosen.length === 1 ? "상세·리뷰를 읽는 중이에요 (2~4분)" : `상품 ${chosen.length}개를 차례로 분석해요 (10~20분, 끝나면 알림)` }, 202);
    }

    if (!viaCron) return json({ error: "서버 간 전용 액션" }, 403);
    const id = url.searchParams.get("id") ?? "";
    const row = await loadRow(id);
    if (!row) return json({ error: "행 없음" }, 400);

    // ── 2) 준비: 이미지 URL·해시 → 읽기 재사용 또는 조각 계획 ──
    if (action === "prepare") {
      try {
        const pd = await callFn("cafe24-analytics", { action: "productdesc", product_no: String(row.product_no) });
        const urls = ((pd.image_urls ?? []) as string[]).slice(0, MAX_IMAGES);
        const name = String(pd.product_name ?? row.product_name ?? "");
        if (!urls.length) { await fail(row, "상세 이미지가 없습니다"); return json({ ok: false }); }
        // 같은 해시로 이미 읽은 결과(상세 점검 담당 것 포함) 재사용 — 읽기 버전이 맞을 때만
        const fresh = (pages: unknown) => { const v = Object.values((pages ?? {}) as Record<string, Row>); return v.length > 0 && v.every((p) => num(p._v) >= READ_VERSION || p.error); };
        let reuse: Row | null = null;
        for (const table of ["creative_briefs", "detail_reviews"]) {
          const prev = await rest(`${table}?product_no=eq.${row.product_no}&desc_hash=eq.${pd.desc_hash}&status=eq.ok&id=neq.${id}&select=pages,images&order=created_at.desc&limit=1`);
          const hit = prev.ok ? ((await prev.json())[0] ?? null) : null;
          if (hit && fresh(hit.pages)) { reuse = hit; break; }
        }
        if (reuse) {
          await patchRow(id, { product_name: name, desc_hash: pd.desc_hash, image_urls: urls, images: reuse.images, pages: reuse.pages, pages_done: Object.keys(reuse.pages as Row).length, status: "briefing", model: `${GEMINI_MODEL}(재사용)+${MODEL}` });
          await dispatch(`action=brief&id=${id}`);
          return json({ ok: true, reused: true });
        }
        const metas = await Promise.all(urls.map((u) => imageMeta(u)));
        const images = urls.map((u, i) => ({ idx: i, url: u, w: metas[i]?.w ?? 0, h: metas[i]?.h ?? 0, tiles: metas[i] ? tilePlan(metas[i]!.w, metas[i]!.h) : [] })).filter((im) => im.tiles.length);
        if (!images.length) { await fail(row, "이미지 크기를 읽지 못했습니다"); return json({ ok: false }); }
        await patchRow(id, { product_name: name, desc_hash: pd.desc_hash, image_urls: urls, images, pages: {}, pages_done: 0, status: "reading", model: `${GEMINI_MODEL}+${MODEL}` });
        for (const im of images) await dispatch(`action=read&id=${id}&i=${im.idx}`);
        return json({ ok: true, images: images.length });
      } catch (e) { await fail(row, `준비 실패: ${String((e as Error)?.message ?? e)}`); return json({ ok: false, error: String(e) }); }
    }

    // ── 3) 한 장 읽기 ──
    if (action === "read") {
      const i = Number(url.searchParams.get("i"));
      const images = (row.images ?? []) as Row[];
      const im = images.find((x) => Number(x.idx) === i);
      if (!im) return json({ error: "이미지 없음" }, 400);
      let page: Row;
      try {
        const tiles = await Promise.all(((im.tiles ?? []) as { cy: number; ch: number }[]).map(async (t) => {
          const r = await fetch(wsrv(String(im.url), `&w=${TILE_W}&cx=0&cy=${t.cy}&cw=${TILE_W}&ch=${t.ch}&output=jpg&q=70`), { signal: AbortSignal.timeout(30000) });
          if (!r.ok) throw new Error(`조각 다운로드 ${r.status}`);
          return { mime: "image/jpeg", data: encodeBase64(new Uint8Array(await r.arrayBuffer())) };
        }));
        page = await geminiRead(tiles);
      } catch (e) { page = { error: String((e as Error)?.message ?? e).slice(0, 200) }; }
      const done = await rest("rpc/creative_page_done", { method: "POST", body: JSON.stringify({ p_id: id, p_idx: i, p_page: page, p_total: images.length }) });
      const remaining = done.ok ? Number(await done.text()) : -1;
      if (remaining === 0) { await patchRow(id, { status: "briefing" }); await dispatch(`action=brief&id=${id}`); }
      return json({ ok: true, idx: i, remaining, error: page.error ?? null });
    }

    // ── 4) 제작안 작성 ──
    if (action === "brief") {
      try {
        const no = Number(row.product_no);
        const pages = (row.pages ?? {}) as Record<string, Row>;
        const ordered = Object.keys(pages).map(Number).sort((a, b) => a - b).map((k) => ({ image: k + 1, ...pages[String(k)], _usage: undefined, _v: undefined }));
        // 리뷰 (카페24 후기 게시판 — 권한 없으면 scope_missing)
        let reviews: Row;
        try {
          const rv = await callFn("cafe24-analytics", { action: "reviews", product_no: String(no), limit: "100" });
          reviews = rv.error === "scope_missing" ? { status: "scope_missing", count: 0 } : { status: num(rv.count) > 0 ? "ok" : "none", count: num(rv.count), rating_avg: rv.rating_avg ?? null, reviews: rv.reviews ?? [] };
        } catch (e) { const m = String((e as Error)?.message ?? e); reviews = { status: /scope_missing/.test(m) ? "scope_missing" : "error", count: 0, error: m.slice(0, 160) }; }
        // 기존 광고 문구 (지출 상위 6개)
        const own = ((row.ads ?? []) as Row[]);
        let adsWithCopy: Row[] = own;
        if (own.length) {
          const period = (((row.shared ?? {}) as Row).period ?? {}) as Row;
          const cards = await callFn("meta-ads", { action: "adcards", ad_ids: own.slice(0, 6).map((a) => String(a.ad_id)).join(","), start_date: String(period.start ?? addDays(String(row.report_date), -29)), end_date: String(period.end ?? row.report_date) }).catch(() => null);
          const cmap = new Map((((cards?.ads ?? []) as Row[])).map((c) => [String(c.ad_id), c]));
          adsWithCopy = own.map((a) => { const c = cmap.get(String(a.ad_id)); return { name: a.ad_name, is_video: c ? !!c.is_video : undefined, body: c ? String(c.body ?? "").slice(0, 200) : undefined, title: c ? String(c.title ?? "").slice(0, 80) : undefined, spend: a.spend, ctr: a.ctr, cpc: a.cpc, purchases: a.purchases, cost_per_purchase: a.cost_per_purchase, roas: a.roas }; });
        }
        const side = await sideContext(no);
        // Claude에 보내는 리뷰: 긴 것·낮은 별점을 고루 (최대 60개, 각 300자)
        const rvList = ((reviews.reviews ?? []) as Row[]);
        const low = rvList.filter((r) => num(r.rating) > 0 && num(r.rating) <= 3).slice(0, 15);
        const rest_ = rvList.filter((r) => !low.includes(r)).sort((a, b) => String(b.text).length - String(a.text).length).slice(0, MAX_REVIEWS_LLM - low.length);
        const context = {
          product_name: row.product_name, selected_because: (row.metrics as Row)?.why, metrics: row.metrics,
          pages: ordered,
          reviews: { status: reviews.status, count: reviews.count, rating_avg: reviews.rating_avg ?? null, low_rating: low.map((r) => ({ rating: r.rating, text: String(r.text).slice(0, 300) })), others: rest_.map((r) => ({ rating: r.rating, text: String(r.text).slice(0, 300) })) },
          ads: (row.ads === null) ? null : adsWithCopy,
          shared: row.shared, ...side,
        };
        const { brief, usage } = await claudeBrief(context);
        await patchRow(id, { status: "ok", brief, usage, error: null, ads: row.ads === null ? null : adsWithCopy, reviews: { status: reviews.status, count: reviews.count, rating_avg: reviews.rating_avg ?? null } });
        await advance(String(row.batch_id));
        return json({ ok: true, hooks: ((brief.hooks ?? []) as unknown[]).length });
      } catch (e) { await fail(row, `작성 실패: ${String((e as Error)?.message ?? e)}`); return json({ ok: false, error: String(e) }); }
    }

    return json({ error: "알 수 없는 action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});

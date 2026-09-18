// ═══════════════════════════════════════════════
// 상세페이지 점검 담당 (상품 전략 담당 2단계, 2026-09-13)
//   다나로브 상세는 글자가 전부 세로 1만px 이미지 안에 있다 → 이미지를 조각내 Gemini(flash-lite, 장당 10~20원)로 읽고(pages),
//   Claude(opus)가 판단(review)한다. 같은 상세(desc_hash)는 다시 읽지 않는다(비용 0). 사용자 결정 2026-09-13: 읽기는 Gemini.
//
//   흐름 (모든 단계는 DB pg_net이 부른다 — agent_call(fn, qs) — 무료 요금제 150초/CPU 한도 회피):
//     run(관리자|cron) ─ 대상 상품 고르기(하루 2개) → detail_reviews 행 생성 → prepare 디스패치
//     prepare ─ 카페24 description → 이미지 URL·해시 → 같은 해시의 이전 읽기 있으면 재사용 → 없으면 wsrv.nl로 크기 재고 조각 계획 → read 디스패치(장마다)
//     read(i) ─ 조각 내려받아 Gemini JSON 읽기 → detail_page_done(원자) → 마지막 장이면 judge 디스패치
//     judge ─ 전 페이지 + 상품 맥락(전략·반품 보고서) → Claude 판단 → 저장 → 묶음이 전부 끝나면 agent_reports(agent=detail) 요약 1건 + 알림
//   ⚠ 2026-09-13 사용자 결정: **자동 실행 없음(cron 제거)** — 사람이 상품을 골라 요청할 때만(`?product_no=`, 앱 카드의 상품 검색 또는 전략 보고서의 '상세 점검' 버튼).
//     product_no 없이 run하면 예전 자동 선정(전략 보고서 집중 상품 + '상세·가격 점검' 판정, 14일 제외, 2개)이 남아 있어 필요하면 쓸 수 있다.
// ═══════════════════════════════════════════════
import { handleOptions, json, verifyAuthToken } from "../_shared/util.ts";
import { addDays, callFn, isCronRequest, MODEL, notifyAdmins, rest, Row, seoulToday } from "../_shared/agent.ts";
import Anthropic from "npm:@anthropic-ai/sdk";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { GEMINI_KEY, GEMINI_MODEL, geminiRead, imageMeta, MAX_IMAGES, tilePlan, TILE_W, wsrv } from "../_shared/detailread.ts";

const AGENT = "detail";
const LABEL = "상세페이지 점검 담당";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const PER_DAY = 2, REVISIT_DAYS = 14;

const dispatch = async (qs: string) => {
  const r = await rest("rpc/agent_call", { method: "POST", body: JSON.stringify({ p_fn: "detail-agent", p_qs: qs }) });
  if (!r.ok) throw new Error(`디스패치 실패 ${r.status}: ${(await r.text()).slice(0, 120)}`);
};
const loadRow = async (id: string): Promise<Row | null> => {
  const r = await rest(`detail_reviews?id=eq.${encodeURIComponent(id)}&select=*`);
  return r.ok ? ((await r.json())[0] ?? null) : null;
};
const patchRow = async (id: string, body: Row) => {
  await rest(`detail_reviews?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }) });
};
const fail = async (id: string, msg: string) => { await patchRow(id, { status: "error", error: msg.slice(0, 500) }); await maybeSummarize(id); };

// ── 상품 종류 판별 (2026-09-15 — 신발에 의류 체크리스트를 들이대던 오판 방지) ──
type ProductType = "shoes" | "bag" | "acc" | "apparel";
function productTypeOf(name: string, cats: string[]): ProductType {
  const t = `${name} ${cats.join(" ")}`.toLowerCase();
  if (/슈즈|플랫|로퍼|샌들|부츠|슬리퍼|뮬|힐|스니커즈|운동화|shoes|boots|sandal|loafer|sneaker/.test(t)) return "shoes";
  if (/가방|백|백팩|토트|숄더|크로스|파우치|클러치|bag/.test(t)) return "bag";
  if (/목걸이|귀걸이|팔찌|반지|모자|캡|비니|벨트|양말|스카프|머플러|헤어|acc|jewel|hat|belt|socks/.test(t)) return "acc";
  return "apparel";
}
const CHECKLIST: Record<ProductType, string> = {
  shoes: "신발 체크리스트: ① 사이즈 추천(정사이즈/반업, 발볼 넓은 분·발등 높은 분 안내) ② 실측(굽높이·발볼 너비·안창 길이·무게) ③ 소재·관리(가죽/스웨이드 관리법) ④ 착화감 근거(쿠션·뒤꿈치·유연성) ⑤ 컬러별 소재 차이 ⑥ 착용컷·디테일컷. **모델 착용 사이즈·키는 신발에서는 부차적 — 없다고 지적하지 말 것.**",
  bag: "가방 체크리스트: ① 실측(가로·세로·폭·끈 길이·무게) ② 수납(휴대폰·지갑·태블릿 들어가는지 비교컷) ③ 소재·관리 ④ 내부 구성(포켓·지퍼) ⑤ 착용컷(크기 감) ⑥ 컬러. 모델 키·의류 실측표는 해당 없음.",
  acc: "액세서리 체크리스트: ① 크기·길이·무게 ② 소재(알러지·변색 안내) ③ 착용컷(크기 감) ④ 관리법 ⑤ 세트·옵션 구성. 의류 실측표·모델 사이즈는 해당 없음.",
  apparel: "의류 체크리스트: ① 실측표(어깨·가슴·소매·총장, 사이즈별) ② 사이즈 추천·모델 키/착용 사이즈 ③ 소재·혼용률·세탁 ④ 핏 설명(오버핏/슬림, 비침·신축) ⑤ 색상별 착용컷·디테일컷 ⑥ 코디 제안.",
};

// ── Claude 판단 ──
const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", description: "상세페이지 완성도 0~100 (실측표·사이즈 가이드·소재·색상별 컷·착용컷·첫 화면 소구 기준)" },
    verdict: { type: "string", description: "한 줄 총평 40자 이내" },
    top_priority: { type: "object", properties: { what: { type: "string", description: "지금 당장 고칠 딱 한 가지 (30자 이내)" }, why: { type: "string", description: "왜 이것이 1순위인지 — 주문율·반품 사유·조회수 같은 숫자 근거" } }, required: ["what", "why"], additionalProperties: false, description: "가장 먼저 고칠 한 가지" },
    missing: { type: "array", items: { type: "string" }, description: "빠졌거나 약한 요소 — 중요한 순, '요소 — 왜 중요한지' 형식. 상품 종류 체크리스트에 해당하는 것만(신발에 모델 사이즈 같은 의류 항목 금지). 최대 5개" },
    keyword_review: { type: "array", items: { type: "object", properties: { keyword: { type: "string" }, fits: { type: "string", enum: ["맞음", "부분", "안 맞음"] }, reason: { type: "string", description: "그 키워드를 정의하는 특징(예: 메리제인 = 발등 스트랩)이 pages의 features·texts에 있는지로 판단" } }, required: ["keyword", "fits", "reason"], additionalProperties: false }, description: "context.rising_keywords 각각이 이 상품에 실제로 맞는지 검증. 키워드가 없으면 빈 배열" },
    first_screen: { type: "array", items: { type: "object", properties: { what: { type: "string" }, why: { type: "string" } }, required: ["what", "why"], additionalProperties: false }, description: "첫 화면(맨 위 1~2조각)에 내세울 것 2~3개와 근거(반품 사유·광고 반응·급상승 키워드·주문율)" },
    reorder: { type: "array", items: { type: "string" }, description: "구성 순서·강조 변경 제안. 최대 4개, 각 40자 이내" },
    copy_snippets: { type: "array", items: { type: "object", properties: { where: { type: "string", description: "넣을 위치" }, text: { type: "string", description: "붙여 넣을 문장(1~2문장). 실측 수치는 절대 지어내지 말고 '굽높이 ○cm'처럼 ○ 자리표시" } }, required: ["where", "text"], additionalProperties: false }, description: "바로 붙여 넣을 문장 2~4개 (사이즈 추천, 실측 틀, 소재·관리, 소구 문구 등 빠진 것 위주). 숫자는 pages에 있는 것만" },
    keep: { type: "array", items: { type: "string" }, description: "잘 되어 있는 점 1~3개" },
  },
  required: ["score", "verdict", "top_priority", "missing", "keyword_review", "first_screen", "reorder", "copy_snippets", "keep"], additionalProperties: false,
};
const JUDGE_SYSTEM = `당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 상세페이지 점검 담당자입니다. Gemini가 이미지 조각을 읽어 정리한 pages(위에서 아래 순서)와 상품 맥락(상품 종류·가격·판매·주문율·반품 사유·광고 반응·급상승 키워드)을 보고 상세페이지를 점검합니다.
독자는 비개발자 경영자. 쉬운 한국어로 짧고 날카롭게 — 두루뭉술한 칭찬·지적 대신 "무엇이 빠져서 어떤 손해(주문율·반품·문의)가 나는지"를 씁니다.

절대 규칙:
1. product_type과 checklist에 맞는 항목만 점검합니다. 신발·가방·액세서리에 '모델 착용 사이즈', '의류 실측표' 같은 의류 항목을 요구하지 않습니다.
2. 있는 것을 없다고 하지 않습니다. pages의 texts·size_guide_text·fabric_text·features에 근거가 있는 것만 씁니다. 첫 장(image 1)에 parse_error가 있으면 그 장은 모른다고 전제합니다.
3. **숫자를 지어내지 않습니다.** 실측·무게·굽높이 등 수치는 pages에 있을 때만 쓰고, 없으면 copy_snippets에 '굽높이 ○cm / 발볼 ○cm'처럼 ○ 자리표시로 틀만 줍니다. 지어낸 수치는 고객에게 그대로 나가 반품으로 돌아옵니다.
4. 급상승 키워드는 keyword_review에서 먼저 검증합니다: 그 키워드를 정의하는 특징(메리제인 = 발등 스트랩, 로퍼 = 발등 덮는 슬립온, 골지 = 세로 골 짜임, 크롭 = 짧은 기장 …)이 features·texts·상품명에 실제로 있는지. '맞음'일 때만 상품명·상단 문구 반영을 제안하고, '안 맞음'이면 반영 제안을 절대 하지 않습니다(키워드로 유입된 고객이 실물과 달라 반품·CS로 돌아옴). '부분'이면 정확한 표현(예: '리본 플랫')으로 바꿔 제안합니다.
5. 우선순위: 반품 사유·주문율(context.new_arrival.rate_14d가 중앙값보다 낮으면 상세·가격 문제)·조회수를 근거로 **효과가 큰 것 하나**를 top_priority로 고릅니다. 반품 사유가 사이즈면 사이즈 안내가 1순위, 조회는 많은데 주문율이 낮으면 첫 화면 소구·가격 근거가 1순위.
6. 광고 문구(ad_bodies)에서 반응 좋은 소구점은 첫 화면에 올리라고 제안합니다. 전략 담당의 detail_focus가 있으면 참고하되 pages 근거로 검증합니다.
7. score는 checklist 항목 충족도(60%) + 첫 화면 소구·구성 순서(25%) + 데이터 문제 대응(반품 사유·주문율, 15%)로 매깁니다. 상품 종류에 해당 없는 항목은 감점하지 않습니다.
응답은 지정 JSON만.`;
async function claudeJudge(context: Row): Promise<{ review: Row; usage: unknown }> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY 미설정");
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: MODEL, max_tokens: 4000, system: JUDGE_SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: JUDGE_SCHEMA } },   // low→medium (2026-09-15): 키워드 검증·우선순위 판단이 늘어 생각 여유를 줌(건당 +20원 안팎)
    messages: [{ role: "user", content: `상세페이지 점검 자료입니다.\n${JSON.stringify(context)}` }],
  } as Parameters<typeof client.messages.create>[0]);
  if (res.stop_reason === "refusal") throw new Error("Claude가 응답을 거부했습니다");
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  return { review: JSON.parse(text), usage: res.usage };
}

// ── 상품 맥락: 최신 전략·반품 보고서에서 이 상품 관련 정보 ──
async function productContext(no: number, name: string, price?: number): Promise<Row> {
  const ctx: Row = {};
  // 상품 종류(카페24 카테고리 이름 + 상품명) → 체크리스트 (2026-09-15)
  try {
    const cm = await callFn("cafe24-analytics", { action: "categorymap" }) as { categories?: Record<string, { name: string }>; products?: Record<string, number[]> };
    const cats = ((cm.products ?? {})[String(no)] ?? []).map((c) => cm.categories?.[String(c)]?.name ?? "").filter(Boolean);
    ctx.categories = cats;
    ctx.product_type = productTypeOf(name, cats);
  } catch { ctx.product_type = productTypeOf(name, []); }
  ctx.checklist = CHECKLIST[ctx.product_type as ProductType];
  if (price) ctx.price = price;
  const latest = async (agent: string) => { const r = await rest(`agent_reports?agent=eq.${agent}&status=eq.ok&select=report,data&order=created_at.desc&limit=1`); return r.ok ? ((await r.json())[0] ?? null) : null; };
  const st = await latest("strategy");
  if (st) {
    const d = st.data as Row, rp = st.report as Row;
    const mx = ((((d.new_arrivals ?? {}) as Row).matrix ?? []) as Row[]).find((p) => Number(p.product_no) === no);
    if (mx) ctx.new_arrival = { quadrant: mx.quadrant, views_14d: mx.views_14d, rate_14d: mx.rate_14d, qty_14d: mx.qty_14d, margin_rate: mx.margin_rate, promos: mx.promos };
    const fc = ((d.focus ?? []) as Row[]).find((f) => Number(f.product_no) === no);
    if (fc) ctx.focus = { why: fc.why, views_14d: fc.views_14d, qty_14d: fc.qty_14d, rate_14d: fc.rate_14d, ad_bodies: ((fc.own_ads ?? []) as Row[]).map((a) => a.body).filter(Boolean).slice(0, 4) };
    const fr = ((rp.focus ?? []) as Row[]).find((f) => String(f.name) === name);
    if (fr) ctx.strategy_suggestion = { driver: fr.driver, detail_focus: fr.detail_focus, reels_hooks: fr.reels_hooks };
    const rising: string[] = [];
    for (const c of ((((d.trends ?? {}) as Row).naver ?? []) as Row[])) for (const r of ((c.rising ?? []) as Row[])) if (((r.our_products ?? []) as Row[]).some((p) => Number(p.no) === no)) rising.push(String(r.keyword));
    if (rising.length) ctx.rising_keywords = rising.slice(0, 5);
  }
  const rt = await latest("returns");
  if (rt) {
    const d = rt.data as Row;
    const risk = ((((d.top_sellers_return ?? {}) as Row).risk_products ?? []) as Row[]).find((p) => Number(p.product_no) === no);
    if (risk) ctx.returns = { rate_14d: (risk.win14 as Row)?.rate, level: (risk.win14 as Row)?.level, reasons_top3: risk.reasons_top3, risk_options: risk.risk_options };
  }
  return ctx;
}

// ── 묶음이 다 끝났으면 agent_reports(detail) 요약 1건 + 알림 ──
async function maybeSummarize(id: string) {
  const row = await loadRow(id); if (!row?.batch_id) return;
  const r = await rest(`detail_reviews?batch_id=eq.${encodeURIComponent(String(row.batch_id))}&select=id,product_no,product_name,report_date,reason,status,review,error,images,pages_done&order=created_at.asc`);
  const rows: Row[] = r.ok ? await r.json() : [];
  if (!rows.length || rows.some((x) => !["ok", "error"].includes(String(x.status)))) return;
  const exists = await rest(`agent_reports?agent=eq.${AGENT}&select=id&data->>batch_id=eq.${encodeURIComponent(String(row.batch_id))}&limit=1`);
  if (exists.ok && ((await exists.json()) as unknown[]).length) return;   // 이미 요약함 (동시 완료 경쟁)
  const oks = rows.filter((x) => x.status === "ok");
  const headline = oks.length
    ? `상세 점검 ${oks.length}건: ` + oks.map((x) => `${String(x.product_name).replace(/^\s*(?:\([^)]*\)|\[[^\]]*\])\s*/g, "").replace(/\s*\([^)]*\)\s*$/, "").slice(0, 16)} ${(x.review as Row)?.score ?? "-"}점`).join(", ")
    : `상세 점검 실패 ${rows.length}건`;
  const report = {
    headline, mood: oks.some((x) => Number((x.review as Row)?.score) < 60) ? "bad" : "neutral",
    summary: rows.map((x) => x.status === "ok" ? `${x.product_name}: ${(x.review as Row)?.verdict ?? ""} (${(x.review as Row)?.score ?? "-"}점)` : `${x.product_name}: 점검 실패 — ${String(x.error ?? "").slice(0, 60)}`),
    reviews: rows.map((x) => ({ review_id: x.id, product_no: x.product_no, product_name: x.product_name, reason: x.reason, status: x.status, error: x.error, image_count: Array.isArray(x.images) ? (x.images as unknown[]).length : 0, review: x.review })),
  };
  await rest("agent_reports", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ agent: AGENT, report_date: String(row.report_date), trigger: "cron", status: "ok", data: { batch_id: row.batch_id, count: rows.length }, report, model: MODEL }) });
  await notifyAdmins(LABEL, String(row.report_date), headline).catch(() => {});
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
      return json({ agent: AGENT, configured: !!ANTHROPIC_API_KEY && !!GEMINI_KEY, gemini: !!GEMINI_KEY, model: MODEL, last: r.ok ? ((await r.json())[0] ?? null) : null });
    }

    // ── 1) 대상 선정 + 행 생성 + prepare 디스패치 ──
    if (action === "run") {
      const D = addDays(seoulToday(), -1);
      const forced = Number(url.searchParams.get("product_no") || 0);
      const picks: { no: number; name: string; reason: string }[] = [];
      if (forced) picks.push({ no: forced, name: "", reason: "수동 지정" });
      else {
        const r = await rest(`agent_reports?agent=eq.strategy&status=eq.ok&select=data&order=created_at.desc&limit=1`);
        const st = r.ok ? ((await r.json())[0] ?? null) : null;
        if (!st) return json({ error: "상품 전략 보고서가 아직 없어 대상을 고를 수 없습니다" }, 400);
        const d = st.data as Row;
        for (const f of ((d.focus ?? []) as Row[])) picks.push({ no: Number(f.product_no), name: String(f.name), reason: String(f.why || "집중 상품") });
        for (const m of ((((d.new_arrivals ?? {}) as Row).matrix ?? []) as Row[])) if (String(m.quadrant).startsWith("상세·가격")) picks.push({ no: Number(m.product_no), name: String(m.name), reason: "상세·가격 점검 판정" });
      }
      const since = addDays(D, -REVISIT_DAYS);
      const recent = await rest(`detail_reviews?status=in.(ok,reading,judging)&created_at=gte.${since}T00:00:00Z&select=product_no`);
      const seen = new Set<number>(recent.ok ? ((await recent.json()) as Row[]).map((x) => Number(x.product_no)) : []);
      const chosen: typeof picks = [];
      // 수동 지정(forced)은 14일 제외 규칙을 적용하지 않는다 — 사람이 고른 상품은 언제든 다시 점검(2026-09-15: 재점검 요청이 "없음"으로 무시되던 문제)
      for (const p of picks) { if (!p.no || (!forced && seen.has(p.no)) || chosen.some((c) => c.no === p.no)) continue; chosen.push(p); if (chosen.length >= (forced ? 1 : PER_DAY)) break; }
      if (!chosen.length) return json({ ok: true, queued: [], message: "오늘 점검할 상품이 없습니다 (최근 14일 안에 다 봤거나 후보 없음)" });
      const batch = `${D}-${crypto.randomUUID().slice(0, 8)}`;
      const ids: string[] = [];
      for (const p of chosen) {
        const ins = await rest("detail_reviews", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ batch_id: batch, product_no: p.no, product_name: p.name, report_date: D, reason: p.reason, status: "reading" }) });
        if (!ins.ok) throw new Error(`행 생성 실패 ${ins.status}`);
        const id = String(((await ins.json())[0] as Row).id);
        ids.push(id);
        await dispatch(`action=prepare&id=${id}${url.searchParams.get("reread") === "1" ? "&reread=1" : ""}`);
      }
      return json({ ok: true, queued: chosen.map((c, i) => ({ id: ids[i], product_no: c.no, name: c.name, reason: c.reason })), message: "상세 이미지 읽기를 시작했어요 (상품당 2~4분)" }, 202);
    }

    if (!viaCron) return json({ error: "서버 간 전용 액션" }, 403);
    const id = url.searchParams.get("id") ?? "";
    const row = await loadRow(id);
    if (!row) return json({ error: "행 없음" }, 400);

    // ── 2) 준비: 이미지 URL·해시 → 재사용 또는 조각 계획 → read 디스패치 ──
    if (action === "prepare") {
      try {
        const pd = await callFn("cafe24-analytics", { action: "productdesc", product_no: String(row.product_no) });
        const urls = ((pd.image_urls ?? []) as string[]).slice(0, MAX_IMAGES);
        const name = String(pd.product_name ?? row.product_name ?? "");
        if (!urls.length) { await fail(id, "상세 이미지가 없습니다"); return json({ ok: false, error: "no images" }); }
        // 같은 해시 + 읽기 완료된 이전 행 → pages 재사용 (비용 0)
        const prev = await rest(`detail_reviews?product_no=eq.${row.product_no}&desc_hash=eq.${pd.desc_hash}&status=eq.ok&id=neq.${id}&select=pages,images&order=created_at.desc&limit=1`);
        const reuse = url.searchParams.get("reread") === "1" ? null : (prev.ok ? ((await prev.json())[0] ?? null) : null);   // reread=1: 읽기 프롬프트가 바뀌었을 때 강제 재읽기
        if (reuse && reuse.pages && Object.keys(reuse.pages).length) {
          await patchRow(id, { product_name: name, desc_hash: pd.desc_hash, image_urls: urls, images: reuse.images, pages: reuse.pages, pages_done: Object.keys(reuse.pages).length, status: "judging", model: `${GEMINI_MODEL}(재사용)+${MODEL}` });
          await dispatch(`action=judge&id=${id}`);
          return json({ ok: true, reused: true });
        }
        const metas = await Promise.all(urls.map((u) => imageMeta(u)));
        const images = urls.map((u, i) => ({ idx: i, url: u, w: metas[i]?.w ?? 0, h: metas[i]?.h ?? 0, tiles: metas[i] ? tilePlan(metas[i]!.w, metas[i]!.h) : [] })).filter((im) => im.tiles.length);
        if (!images.length) { await fail(id, "이미지 크기를 읽지 못했습니다"); return json({ ok: false }); }
        await patchRow(id, { product_name: name, desc_hash: pd.desc_hash, image_urls: urls, images, pages: {}, pages_done: 0, status: "reading", model: `${GEMINI_MODEL}+${MODEL}` });
        for (const im of images) await dispatch(`action=read&id=${id}&i=${im.idx}`);
        return json({ ok: true, images: images.length, tiles: images.reduce((t, im) => t + im.tiles.length, 0) });
      } catch (e) { await fail(id, `준비 실패: ${String((e as Error)?.message ?? e)}`); return json({ ok: false, error: String(e) }); }
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
      const done = await rest("rpc/detail_page_done", { method: "POST", body: JSON.stringify({ p_id: id, p_idx: i, p_page: page, p_total: images.length }) });
      const remaining = done.ok ? Number(await done.text()) : -1;
      if (remaining === 0) { await patchRow(id, { status: "judging" }); await dispatch(`action=judge&id=${id}`); }
      return json({ ok: true, idx: i, remaining, error: page.error ?? null });
    }

    // ── 4) 판단 ──
    if (action === "judge") {
      try {
        const pages = (row.pages ?? {}) as Record<string, Row>;
        const ordered = Object.keys(pages).map(Number).sort((a, b) => a - b).map((k) => ({ image: k + 1, ...pages[String(k)], _usage: undefined }));
        const name = String(row.product_name ?? "");
        const ctx = await productContext(Number(row.product_no), name, Number(row.price ?? 0) || undefined);
        const { review, usage } = await claudeJudge({ product_name: name, product_type: ctx.product_type, checklist: ctx.checklist, reason: row.reason, image_count: ordered.length, pages: ordered, context: ctx });
        await patchRow(id, { status: "ok", review: { ...review, context: ctx }, error: null });
        await rest(`detail_reviews?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ review: { ...review, context: ctx, usage } }) });
        await maybeSummarize(id);
        return json({ ok: true, score: review.score });
      } catch (e) { await fail(id, `판단 실패: ${String((e as Error)?.message ?? e)}`); return json({ ok: false, error: String(e) }); }
    }

    return json({ error: "알 수 없는 action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});

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
//   대상: 최신 상품 전략 보고서의 집중 상품 + '상세·가격 점검' 판정 상품, 14일 안에 본 상품 제외. ?product_no= 로 수동 지정 가능.
// ═══════════════════════════════════════════════
import { handleOptions, json, verifyAuthToken } from "../_shared/util.ts";
import { addDays, callFn, isCronRequest, MODEL, notifyAdmins, rest, Row, seoulToday } from "../_shared/agent.ts";
import Anthropic from "npm:@anthropic-ai/sdk";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const AGENT = "detail";
const LABEL = "상세페이지 점검 담당";
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = "gemini-flash-lite-latest";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const PER_DAY = 2, MAX_IMAGES = 12, TILE_W = 900, TILE_H = 1500, MAX_TILES = 8, REVISIT_DAYS = 14;

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

// ── wsrv.nl 조각: 폭 900으로 줄인 뒤 세로 1500씩 (리사이즈 후 크롭 순서 — 실측) ──
const wsrv = (u: string, extra: string) => `https://wsrv.nl/?url=${encodeURIComponent(u)}${extra}`;
async function imageMeta(u: string): Promise<{ w: number; h: number } | null> {
  try {
    const r = await fetch(wsrv(u, "&output=json"), { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const m = await r.json();
    return { w: Number(m.width), h: Number(m.height) };
  } catch { return null; }
}
function tilePlan(w: number, h: number): { cy: number; ch: number }[] {
  const sh = Math.round(h * TILE_W / Math.max(1, w));   // 폭 900 기준 세로
  const n = Math.min(MAX_TILES, Math.max(1, Math.ceil(sh / TILE_H)));
  const step = n === MAX_TILES ? Math.ceil(sh / MAX_TILES) : TILE_H;   // 너무 길면 조각을 키워 8개로
  return Array.from({ length: n }, (_, i) => ({ cy: i * step, ch: Math.min(step, sh - i * step) }));
}

// ── Gemini 읽기 ──
const READ_PROMPT = `이것은 여성 의류 쇼핑몰(다나로브) 상세페이지 이미지 한 장을 위에서 아래로 자른 조각들입니다. 조각에서 보이는 내용을 JSON으로 정리하세요.
{"texts":["눈에 띄는 문구·설명 (최대 10개, 원문 그대로 짧게)"],"has_size_table":false,"size_table_text":"실측표가 있으면 항목과 수치를 한 줄로 (없으면 빈 문자열)","has_size_guide":false,"size_guide_text":"사이즈 추천·모델 키/사이즈 안내 (없으면 빈 문자열)","has_fabric_care":false,"fabric_text":"소재·혼용률·세탁 안내 (없으면 빈 문자열)","colors_shown":["보이는 색상 이름"],"wear_shots":0,"detail_shots":0,"has_model_info":false,"has_benefit_notice":false,"benefit_text":"할인·1+1·쿠폰 등 혜택 문구 (없으면 빈 문자열)","layout_notes":"구성 특징 한 줄 (예: 첫 조각이 착용컷, 글자 작음, 여백 많음)"}
규칙: 보이는 것만 적고 추측하지 않습니다. 착용컷(사람이 입은 사진)과 디테일컷(옷 부분 확대)을 세어 주세요.`;
async function geminiRead(tiles: { mime: string; data: string }[]): Promise<Row> {
  const parts: unknown[] = [{ text: READ_PROMPT }];
  for (const t of tiles) parts.push({ inline_data: { mime_type: t.mime, data: t.data } });
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
    signal: AbortSignal.timeout(90000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const usage = body?.usageMetadata ?? {};
  let parsed: Row = {};
  try { parsed = JSON.parse(text); } catch { parsed = { texts: [String(text).slice(0, 500)] }; }
  return { ...parsed, _usage: { in: usage.promptTokenCount, out: usage.candidatesTokenCount } };
}

// ── Claude 판단 ──
const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", description: "상세페이지 완성도 0~100 (실측표·사이즈 가이드·소재·색상별 컷·착용컷·첫 화면 소구 기준)" },
    verdict: { type: "string", description: "한 줄 총평 40자 이내" },
    missing: { type: "array", items: { type: "string" }, description: "빠졌거나 약한 요소 (예: '실측표 없음', '소재·세탁 안내 없음'). 최대 6개" },
    first_screen: { type: "array", items: { type: "object", properties: { what: { type: "string" }, why: { type: "string" } }, required: ["what", "why"], additionalProperties: false }, description: "첫 화면(맨 위 1~2조각)에 내세울 것 2~3개와 근거(반품 사유·광고 반응·급상승 키워드·주문율)" },
    reorder: { type: "array", items: { type: "string" }, description: "구성 순서·강조 변경 제안. 최대 4개, 각 40자 이내" },
    copy_snippets: { type: "array", items: { type: "object", properties: { where: { type: "string", description: "넣을 위치" }, text: { type: "string", description: "붙여 넣을 문장(1~2문장)" } }, required: ["where", "text"], additionalProperties: false }, description: "바로 붙여 넣을 문장 2~4개 (실측 안내, 사이즈 추천, 소재, 혜택 등 빠진 것 위주)" },
    keep: { type: "array", items: { type: "string" }, description: "잘 되어 있는 점 1~3개" },
  },
  required: ["score", "verdict", "missing", "first_screen", "reorder", "copy_snippets", "keep"], additionalProperties: false,
};
const JUDGE_SYSTEM = `당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 상세페이지 점검 담당자입니다. Gemini가 이미지 조각을 읽어 정리한 pages(위에서 아래 순서)와 상품 맥락(판매·주문율·반품 사유·광고 반응·급상승 키워드)을 보고 상세페이지를 점검합니다.
원칙: 독자는 비개발자 경영자, 쉬운 한국어, 짧게. 있는 것을 없다고 하지 말고, pages에 근거가 있는 것만 씁니다. 반품 사유가 '사이즈'면 실측표·사이즈 추천을 최우선으로, 광고 문구에서 반응 좋은 소구점은 첫 화면에 올리라고 제안합니다. 급상승 키워드가 상품과 맞으면 상품명·상단 문구에 반영을 제안합니다. 응답은 지정 JSON만.`;
async function claudeJudge(context: Row): Promise<{ review: Row; usage: unknown }> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY 미설정");
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: MODEL, max_tokens: 4000, system: JUDGE_SYSTEM,
    output_config: { effort: "low", format: { type: "json_schema", schema: JUDGE_SCHEMA } },
    messages: [{ role: "user", content: `상세페이지 점검 자료입니다.\n${JSON.stringify(context)}` }],
  } as Parameters<typeof client.messages.create>[0]);
  if (res.stop_reason === "refusal") throw new Error("Claude가 응답을 거부했습니다");
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  return { review: JSON.parse(text), usage: res.usage };
}

// ── 상품 맥락: 최신 전략·반품 보고서에서 이 상품 관련 정보 ──
async function productContext(no: number, name: string): Promise<Row> {
  const ctx: Row = {};
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
      for (const p of picks) { if (!p.no || seen.has(p.no) || chosen.some((c) => c.no === p.no)) continue; chosen.push(p); if (chosen.length >= (forced ? 1 : PER_DAY)) break; }
      if (!chosen.length) return json({ ok: true, queued: [], message: "오늘 점검할 상품이 없습니다 (최근 14일 안에 다 봤거나 후보 없음)" });
      const batch = `${D}-${crypto.randomUUID().slice(0, 8)}`;
      const ids: string[] = [];
      for (const p of chosen) {
        const ins = await rest("detail_reviews", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ batch_id: batch, product_no: p.no, product_name: p.name, report_date: D, reason: p.reason, status: "reading" }) });
        if (!ins.ok) throw new Error(`행 생성 실패 ${ins.status}`);
        const id = String(((await ins.json())[0] as Row).id);
        ids.push(id);
        await dispatch(`action=prepare&id=${id}`);
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
        const reuse = prev.ok ? ((await prev.json())[0] ?? null) : null;
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
        const ctx = await productContext(Number(row.product_no), name);
        const { review, usage } = await claudeJudge({ product_name: name, reason: row.reason, image_count: ordered.length, pages: ordered, context: ctx });
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

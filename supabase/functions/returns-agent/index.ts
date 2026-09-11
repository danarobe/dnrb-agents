// ═══════════════════════════════════════════════
// 취소·반품 감시 담당 (에이전트 2호, 2026-09-11) — 공통 뼈대는 ../_shared/agent.ts
//   매일 08:15 KST (pg_cron `returns-agent-morning`) 또는 앱의 [지금 실행].
//   수집(워크스페이스 함수, x-agent-secret):
//     cohortweeks          결제 주차(월~일)별 코호트 취소·반품률 6주 + 일별 14일, 경과일 — 취소가 다음 주에 나도 결제 주에 귀속
//                          (2026-09-11 사용자 지적: 주문일 기준 '최근 7일 vs 직전 7일' 비교는 최근 주가 미성숙해 늘 좋아 보이는 착시)
//     cafe24-claims        최근 7일 주문의 취소·반품 사유 분포만 (건수 추세 비교에는 쓰지 않는다)
//     returnwatch          기준일 E(=D−3, 즉 오늘−4일)의 7/14/30일 창 순반품률 — 결제수량 상위 30 + 관리 상품
//     returnreasons        E−13~E 배송완료 품목의 반품 사유 원문 → 상품별 사유 TOP
//     return_watch 테이블  관리 상품 명단(지정 사유·판매 중단)
//   기준일을 3일 더 물리는 이유: 반품 신청은 배송완료 후 0~5일에 걸쳐 들어와서(당일 51%·3일 90%),
//   어제 기준으로 보면 실제의 절반 이하로 나온다 (워크스페이스 반품 관리 메뉴의 '오늘−4일' 규칙과 동일).
// ═══════════════════════════════════════════════
import { addDays, callFn, COMMON_RULES, dow, num, reportSchema, rest, Row, safeCollector, serveAgent } from "../_shared/agent.ts";

const AGENT = "returns";
const RISK_AT = 20, WARN_AT = 10, MIN_QTY = 10;

async function collect(D: string) {
  const { errors, safe } = safeCollector();
  const E = addDays(D, -3);                       // 반품 판정 기준일 (배송완료일 기준)
  const cur7 = [addDays(D, -6), D];
  const reasonWin = [addDays(E, -13), E];

  // 관리 상품 명단 (워크스페이스 반품 관리 메뉴에서 사람이 지정)
  const watchRes = await rest("return_watch?select=product_no,product_name,reason,discontinued,created_at&order=created_at.desc");
  const watch: Row[] = watchRes.ok ? await watchRes.json() : [];
  const watchNos = watch.map((w) => Number(w.product_no)).filter(Boolean);
  const watchMap = new Map<number, Row>(watch.map((w) => [Number(w.product_no), w]));

  // 카페24 토큰 경쟁 방지: 가장 짧은 호출(사유 7일)로 토큰을 확보한 뒤 무거운 셋(코호트 ~30초·순반품률 ~40초·사유)을 병렬로
  // (전부 합쳐 150초 함수 제한 안에 들어야 해서 직렬은 안 됨 — 실측: 직렬이면 수집만 80초+Claude 60초)
  const cCur = await safe("취소반품 사유(최근 7일)", () => callFn("cafe24-claims", { start_date: cur7[0], end_date: cur7[1] }));
  const [cohort, rw, rr] = await Promise.all([
    safe("결제 주차별 취소반품률", () => callFn("cafe24-analytics", { action: "cohortweeks", end_date: D, weeks: "6", days: "14" })),
    safe("순반품률(7/14/30일 창)", () => callFn("cafe24-analytics", {
      action: "returnwatch", end_date: E, top: "30", risk: String(RISK_AT), min_qty: String(MIN_QTY),
      ...(watchNos.length ? { extra: watchNos.join(",") } : {}),
    })),
    safe("반품 사유(14일)", () => callFn("cafe24-analytics", { action: "returnreasons", start_date: reasonWin[0], end_date: reasonWin[1] })),
  ]);

  // ── 취소·반품 규모: 이번 주 vs 지난주 ──
  const bucket = (c: Row | null, k: string) => {
    const b = (c?.[k] ?? null) as Row | null;
    return b ? { count: num(b.count), amount: num(b.amount), reasons: (Array.isArray(b.reasons) ? b.reasons as Row[] : []).slice(0, 6).map((x) => ({ reason: String(x.reason), cnt: num(x.cnt) })) } : null;
  };
  const cancelCur = bucket(cCur, "cancel"), returnCur = bucket(cCur, "return");
  // 코호트 표: 경과 14일 이상이면 '성숙'(비교 가능), 미만이면 '집계 중'
  type CRow = Row & { age_days: number; partial: boolean };
  const weeksRaw = ((cohort?.weeks ?? []) as CRow[]);
  const cohortWeeks = weeksRaw.map((w) => ({
    week: `${String(w.start)}~${String(w.end)}`, start: w.start, end: w.end, partial: !!w.partial, age_days: w.age_days,
    maturity: w.partial ? "진행 중" : w.age_days >= 14 ? "성숙" : "집계 중",
    paid: num(w.paid), cancel: num(w.cancel), cancel_rate: w.cancel_rate, ret: num(w.ret), return_rate: w.return_rate, claim_rate: w.claim_rate,
  }));
  const matureWeeks = cohortWeeks.filter((w) => w.maturity === "성숙");
  const cohortDays = ((cohort?.days ?? []) as CRow[]).map((d) => ({ date: d.start, age_days: d.age_days, paid: num(d.paid), cancel: num(d.cancel), cancel_rate: d.cancel_rate, ret: num(d.ret), return_rate: d.return_rate }));

  // ── 상품별 반품 사유 TOP (14일, 배송완료일 기준) ──
  const reasonsByProduct = new Map<number, Map<string, number>>();
  for (const it of ((rr?.items ?? []) as Row[])) {
    const no = Number(it.product_no); if (!no) continue;
    // 고객이 쓴 긴 문장(리뷰 수준)은 앞 40자만 — 토큰 절약 + 같은 뜻의 사유가 흩어지는 것 완화
    const reason = (String(it.request || it.accept || "사유 미기재").replace(/\s+/g, " ").trim() || "사유 미기재").slice(0, 40);
    let m = reasonsByProduct.get(no);
    if (!m) { m = new Map(); reasonsByProduct.set(no, m); }
    m.set(reason, (m.get(reason) ?? 0) + num(it.qty));
  }
  const topReasons = (no: number, n = 3) => [...(reasonsByProduct.get(no) ?? new Map()).entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([reason, qty]) => `${reason} ${qty}개`);

  // ── 위험·주의 상품 (returnwatch) ──
  type Win = { del: number; ret: number; rate: number; risk: boolean };
  const products = ((rw?.products ?? []) as Row[]);
  const level = (w: Win) => w.del < MIN_QTY ? "보류" : w.rate >= RISK_AT ? "위험" : w.rate >= WARN_AT ? "주의" : "양호";
  const shaped = products.map((p) => {
    const win = p.windows as Record<string, Win>;
    const w7 = win["7"], w14 = win["14"], w30 = win["30"];
    const wrow = watchMap.get(Number(p.product_no));
    const riskOpts = ((p.options ?? []) as Row[])
      .map((o) => { const ow = (o.windows as Record<string, Win>)["14"]; return { option: String(o.option), delivered_14d: ow.del, returned_14d: ow.ret, rate_14d: ow.rate }; })
      .filter((o) => o.delivered_14d >= 5 && o.rate_14d >= RISK_AT)
      .sort((a, b) => b.rate_14d - a.rate_14d).slice(0, 4);
    return {
      product_no: Number(p.product_no), name: String(p.product_name ?? ""),
      rank7: num(p.rank7), rank14: num(p.rank14), paid_14d: num(p.paid14),
      win7: { delivered: w7.del, returned: w7.ret, rate: w7.rate, level: level(w7) },
      win14: { delivered: w14.del, returned: w14.ret, rate: w14.rate, level: level(w14) },
      win30: { delivered: w30.del, returned: w30.ret, rate: w30.rate, level: level(w30) },
      flagged: !!p.flagged,
      risk_options: riskOpts,
      reasons_top3: topReasons(Number(p.product_no)),
      watched: wrow ? { reason: String(wrow.reason ?? ""), discontinued: !!wrow.discontinued, since: String(wrow.created_at ?? "").slice(0, 10) } : null,
    };
  });
  const ranked = shaped.filter((p) => p.rank7 || p.rank14);
  const riskList = ranked.filter((p) => p.flagged || p.win14.level === "위험" || p.win14.level === "주의")
    .sort((a, b) => b.win14.rate - a.win14.rate).slice(0, 12);
  const goodSellers = ranked.filter((p) => p.win14.level === "양호" && p.rank14 > 0 && p.rank14 <= 10)
    .sort((a, b) => a.rank14 - b.rank14).slice(0, 5)
    .map((p) => ({ name: p.name, rank14: p.rank14, rate_14d: p.win14.rate, delivered_14d: p.win14.delivered }));
  const watchedStatus = shaped.filter((p) => p.watched).map((p) => ({
    name: p.name, watch_reason: p.watched!.reason, discontinued: p.watched!.discontinued, watched_since: p.watched!.since,
    rate_7d: p.win7.rate, rate_14d: p.win14.rate, rate_30d: p.win30.rate, delivered_14d: p.win14.delivered, reasons_top3: p.reasons_top3,
  }));

  const totalDel14 = ranked.reduce((t, p) => t + p.win14.delivered, 0);
  const totalRet14 = ranked.reduce((t, p) => t + p.win14.returned, 0);

  return {
    base_date: D, base_dow: dow(D), judge_date: E, generated_at: new Date().toISOString(),
    policy: { risk_at_pct: RISK_AT, warn_at_pct: WARN_AT, min_delivered: MIN_QTY, basis: "배송완료일 기준 순반품률 = 반품수량(신청~완료) ÷ 배송완료 수량. 배송완료 10개 미만은 판정 보류", judge_note: "반품은 배송완료 후 며칠 뒤 들어오므로 기준일을 3일 물림" },
    periods: { reason_window_orders: cur7, reason_window_delivered: reasonWin, windows_end: E },
    cohorts: {
      basis: "결제일(pay_date) 주차(월~일) 코호트. 그 주에 결제된 주문 중 지금까지 취소(C40)·반품(R00~R40)된 비율. 취소가 다음 주에 나도 결제 주에 귀속",
      maturity_rule: "경과 14일 이상 = 성숙(비교 가능). 미만 = 집계 중(취소·반품이 더 들어올 수 있어 낮게 보임). partial = 이번 주 진행 중",
      weeks: cohortWeeks,
      mature_weeks_summary: matureWeeks.length ? {
        latest_mature: matureWeeks[0],
        avg_cancel_rate: +(matureWeeks.reduce((t, w) => t + num(w.cancel_rate), 0) / matureWeeks.length).toFixed(2),
        avg_return_rate: +(matureWeeks.reduce((t, w) => t + num(w.return_rate), 0) / matureWeeks.length).toFixed(2),
      } : null,
      days_last14: cohortDays,
      note: "네이버페이 주문 포함(분자·분모 모두). 혼합 주문(취소+반품)은 양쪽에 세어짐",
    },
    claim_reasons_last7: {
      basis: "최근 7일 주문(주문일 기준) 중 지금까지 들어온 취소·반품의 사유 분포 — 어떤 사유가 많은지만 보고, 건수 증감 판단에는 쓰지 말 것(미성숙)",
      cancel: cancelCur ? { count_so_far: cancelCur.count, reasons: cancelCur.reasons } : null,
      return: returnCur ? { count_so_far: returnCur.count, reasons: returnCur.reasons } : null,
      note: "카페24 자사몰 기준(네이버페이 주문 제외)",
    },
    top_sellers_return: {
      scope: "결제수량 상위 30 상품(7일·14일 합집합)",
      delivered_14d: totalDel14, returned_14d: totalRet14, rate_14d: totalDel14 > 0 ? +(totalRet14 / totalDel14 * 100).toFixed(2) : null,
      risk_products: riskList,
      good_sellers_low_return: goodSellers,
    },
    watched_products: watchedStatus,
    watched_count: watch.length,
    errors,
  };
}

const SYSTEM = `당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 취소·반품 감시 담당자입니다. 매일 아침 대표에게 취소·반품 상황을 보고합니다.

취소·반품률을 보는 원칙 (대표가 정한 기준 — 반드시 지킬 것):
- 취소·반품률은 **결제 주차 코호트**로 봅니다: "그 주에 결제된 주문 중 몇 %가 취소·반품됐나". 취소가 다음 주에 일어나도 결제 주에 귀속됩니다. cohorts.weeks가 그 표입니다.
- 최근 주는 취소·반품이 아직 다 들어오지 않아 낮게 보입니다(미성숙). **maturity가 '성숙'인 주끼리만 추세를 비교**하고, '집계 중'·'진행 중' 주는 "아직 늘어날 수 있음"이라고 반드시 밝힙니다. 미성숙 주를 근거로 "취소·반품이 줄었다"고 쓰면 안 됩니다.
- 성숙 주 평균(mature_weeks_summary)과 가장 최근 성숙 주를 비교해 좋아지는지 나빠지는지 말합니다. 집계 중인 주가 같은 경과일의 과거 주보다 이미 높으면 경고할 수 있습니다(days_last14의 age_days 참고).
- claim_reasons_last7은 사유 분포만 보는 용도입니다(어떤 사유가 많은가). 건수 증감 판단에 쓰지 않습니다.

할 일:
- 성숙한 결제 주차의 취소율·반품률 흐름을 보고하고, 이번 주·지난주는 진행 상황으로만 언급합니다.
- 잘 팔리는데 반품이 많은 상품을 찾아 원인을 추정하고 대응을 제안합니다. 판정 기준: 순반품률 20% 이상이면 '위험', 10~20%는 '주의', 배송완료 10개 미만은 '보류'(요행일 수 있음).
- 옵션(사이즈·컬러) 하나에 반품이 몰리면 그 옵션 문제(사이즈 안내, 실물 색상 차이)로 봅니다. 사유가 '사이즈'면 상세페이지 실측·사이즈 안내 보완, '색상·소재·상품불만족'이면 상세 사진·설명 보완, '상품불량'이면 제작처·검수 확인, 배송지연 취소면 출고 점검을 제안합니다.
- 관리 상품(사람이 워크스페이스 반품 관리 메뉴에서 지정한 것)은 지정 이후 나아졌는지 나빠졌는지 판정합니다. 새로 관리 상품으로 지정할 만한 것은 제안만 합니다(지정은 사람이 합니다). 판매 중단은 '대표 확인 후'.
- risk_products(구조화 표)에는 위험·주의 상품을 순반품률 높은 순으로 넣고, 각각 원인 추정(사유·옵션 근거)과 한 줄 대응을 씁니다. 보류 상품은 넣지 않습니다.
- watch_review에는 관리 상품 전부를 넣고 개선/유지/악화를 판정합니다 (7일·14일·30일 창의 흐름으로).
- cohort_table에는 cohorts.weeks를 최신 주부터 그대로 옮기고(숫자 변형 금지) 한 줄 판단을 붙입니다.
- highlights는 좋은 신호(반품 줄어든 상품, 잘 팔리면서 반품 낮은 상품, 개선된 관리 상품), warnings는 나쁜 신호입니다.
- actions는 오늘 실행할 구체적인 것 2~3개.
${COMMON_RULES}`;

const SCHEMA = reportSchema({
  highlights: "좋은 신호: 반품 줄어든 상품, 잘 팔리면서 반품 낮은 상품, 개선된 관리 상품. 최대 5개",
  warnings: "나쁜 신호: 반품률 위험 상품, 늘어난 사유, 악화된 관리 상품. 최대 6개",
  actions: "오늘 실행할 구체적 액션 2~3개",
  extra: {
    cohort_table: {
      type: "array",
      items: {
        type: "object",
        properties: {
          week: { type: "string", description: "결제 주차 'YYYY-MM-DD~YYYY-MM-DD'" },
          maturity: { type: "string", enum: ["성숙", "집계 중", "진행 중"] },
          paid: { type: "integer" }, cancel_rate: { type: "number" }, return_rate: { type: "number" },
          verdict: { type: "string", description: "한 줄 판단 (성숙 주 평균 대비 높음/낮음, 집계 중이면 '아직 늘어날 수 있음')" },
        },
        required: ["week", "maturity", "paid", "cancel_rate", "return_rate", "verdict"], additionalProperties: false,
      },
      description: "결제 주차별 취소·반품률 표 (최신 주부터, cohorts.weeks 그대로 + 판단)",
    },
    risk_products: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "상품명 (데이터 그대로)" },
          level: { type: "string", enum: ["위험", "주의"] },
          rate_14d: { type: "number", description: "14일 순반품률 %" },
          delivered_14d: { type: "integer", description: "14일 배송완료 수량" },
          cause: { type: "string", description: "원인 추정 — 사유·옵션 근거 포함" },
          fix: { type: "string", description: "한 줄 대응" },
        },
        required: ["name", "level", "rate_14d", "delivered_14d", "cause", "fix"], additionalProperties: false,
      },
      description: "위험·주의 상품 표. 순반품률 높은 순, 최대 10개",
    },
    watch_review: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          verdict: { type: "string", enum: ["개선", "유지", "악화"] },
          detail: { type: "string", description: "7/14/30일 흐름과 판단 근거 한두 문장" },
        },
        required: ["name", "verdict", "detail"], additionalProperties: false,
      },
      description: "관리 상품 점검. 관리 상품 전부",
    },
  },
});

serveAgent({ agent: AGENT, label: "취소·반품 감시 담당", system: SYSTEM, schema: SCHEMA, collect });

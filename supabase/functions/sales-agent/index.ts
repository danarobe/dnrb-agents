// ═══════════════════════════════════════════════
// 매출 분석 담당 (에이전트 1호, 2026-09-10) — 공통 뼈대는 ../_shared/agent.ts
//   매일 08:00 KST (pg_cron `sales-agent-morning`) 또는 앱의 [지금 실행].
//   수집: 카페24 매출 8구간·상품 조회/주문율 3구간·취소반품 최근 7일·Meta 광고 3구간 → Claude → agent_reports
//   ⚠ 이 함수는 ~/dnrb-agents 소속. 호출하는 cafe24-analytics/cafe24-claims/meta-ads는 ~/dnrb-dashboard 소속(x-agent-secret 인정 코드가 거기 있음).
// ═══════════════════════════════════════════════
import { addDays, callFn, COMMON_RULES, dow, num, pct, reportSchema, Row, safeCollector, serveAgent } from "../_shared/agent.ts";

const AGENT = "sales";

async function collect(D: string) {
  const { errors, safe } = safeCollector();
  const d1 = addDays(D, -1), d7 = addDays(D, -7);
  const cur7 = [addDays(D, -6), D], prev7 = [addDays(D, -13), d7];
  const mStart = D.slice(0, 8) + "01";
  const lmEnd = addDays(mStart, -1);
  const lmStart = lmEnd.slice(0, 8) + "01";
  const lmSameDay = Math.min(Number(D.slice(8, 10)), Number(lmEnd.slice(8, 10)));
  const lmSame = [lmStart, lmStart.slice(0, 8) + String(lmSameDay).padStart(2, "0")];

  const rev = async (s: string, e: string) => {
    const b = await callFn("cafe24-analytics", { action: "revenue", start_date: s, end_date: e });
    return { revenue: num(b.revenue), orders: num(b.order_count) };
  };
  // 카페24 토큰 동시 갱신 경쟁 방지 — 첫 호출로 토큰을 확보한 뒤 나머지를 병렬로
  const rD = await safe("매출(어제)", () => rev(D, D));
  const [rD1, rD7, rCur7, rPrev7, rMtd, rLmSame, rLm] = await Promise.all([
    safe("매출(그저께)", () => rev(d1, d1)),
    safe("매출(지난주 같은 요일)", () => rev(d7, d7)),
    safe("매출(최근 7일)", () => rev(cur7[0], cur7[1])),
    safe("매출(직전 7일)", () => rev(prev7[0], prev7[1])),
    safe("매출(이달 누적)", () => rev(mStart, D)),
    safe("매출(지난달 같은 기간)", () => rev(lmSame[0], lmSame[1])),
    safe("매출(지난달 전체)", () => rev(lmStart, lmEnd)),
  ]);

  const sum = async (s: string, e: string) =>
    (await callFn("cafe24-analytics", { action: "summary", start_date: s, end_date: e })) as { rows: Row[]; totals: Row };
  const [sD, sCur, sPrev] = await Promise.all([
    safe("상품(어제)", () => sum(D, D)),
    safe("상품(최근 7일)", () => sum(cur7[0], cur7[1])),
    safe("상품(직전 7일)", () => sum(prev7[0], prev7[1])),
  ]);

  const claims = await safe("취소반품(최근 7일)", () => callFn("cafe24-claims", { start_date: cur7[0], end_date: cur7[1] }));

  const meta = async (s: string, e: string) => {
    const b = await callFn("meta-ads", { action: "summary", start_date: s, end_date: e });
    if (b.error === "not_connected") return null;
    return { spend: num(b.spend), purchases: num(b.purchases), purchase_value: num(b.purchase_value), meta_roas: num(b.meta_roas) };
  };
  const [mD, mCur7, mPrev7] = await Promise.all([
    safe("광고(어제)", () => meta(D, D)),
    safe("광고(최근 7일)", () => meta(cur7[0], cur7[1])),
    safe("광고(직전 7일)", () => meta(prev7[0], prev7[1])),
  ]);

  // ── 파생 지표 ──
  const prevMap = new Map<number, Row>((sPrev?.rows ?? []).map((r) => [Number(r.product_no), r]));
  const K = 5, MIN_QTY = 10;
  const trending = (sCur?.rows ?? [])
    .filter((r) => num(r.order_qty) >= MIN_QTY)
    .map((r) => {
      const p = prevMap.get(Number(r.product_no));
      const prevQty = p ? num(p.order_qty) : 0;
      return {
        product_no: Number(r.product_no), name: String(r.product_name ?? ""),
        qty_7d: num(r.order_qty), qty_prev7d: prevQty, views_7d: num(r.views), rate_7d: num(r.rate),
        score: (num(r.order_qty) + K) / (prevQty + K),
      };
    })
    .filter((r) => r.qty_7d > r.qty_prev7d)
    .sort((a, b) => b.score - a.score).slice(0, 8)
    .map(({ score: _s, ...r }) => r);

  const rateDrops = (sCur?.rows ?? [])
    .map((r) => {
      const p = prevMap.get(Number(r.product_no));
      if (!p) return null;
      const v = num(r.views), pv = num(p.views), rt = num(r.rate), prt = num(p.rate);
      if (v < 300 || pv < 300 || prt < 1 || rt > prt * 0.6) return null;
      return { product_no: Number(r.product_no), name: String(r.product_name ?? ""), views_7d: v, rate_7d: rt, rate_prev7d: prt, qty_7d: num(r.order_qty), qty_prev7d: num(p.order_qty) };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.views_7d - a.views_7d).slice(0, 6);

  const highViewLowRate = (sCur?.rows ?? [])
    .filter((r) => num(r.views) >= 500 && num(r.rate) < 0.5)
    .sort((a, b) => num(b.views) - num(a.views)).slice(0, 5)
    .map((r) => ({ product_no: Number(r.product_no), name: String(r.product_name ?? ""), views_7d: num(r.views), rate_7d: num(r.rate), qty_7d: num(r.order_qty) }));

  const topYesterday = (sD?.rows ?? [])
    .filter((r) => num(r.order_qty) > 0)
    .sort((a, b) => num(b.order_qty) - num(a.order_qty)).slice(0, 8)
    .map((r) => ({ product_no: Number(r.product_no), name: String(r.product_name ?? ""), qty: num(r.order_qty), amount: num(r.order_amount), views: num(r.views), rate: num(r.rate) }));

  const totals = (s: { totals: Row } | null) => s ? { views: num(s.totals.views), orders: num(s.totals.order_count), qty: num(s.totals.order_qty), rate: num(s.totals.rate) } : null;
  const roas = (r: { revenue: number } | null, m: { spend: number } | null) => r && m && m.spend > 0 ? Math.round(r.revenue / m.spend * 100) / 100 : null;
  const c = claims as Record<string, Row> | null;
  const top3 = (arr: unknown) => Array.isArray(arr) ? (arr as Row[]).slice(0, 3).map((x) => `${x.reason} ${x.cnt}건`) : [];

  return {
    base_date: D, base_dow: dow(D), generated_at: new Date().toISOString(),
    periods: { yesterday: D, day_before: d1, same_dow_last_week: d7, last7: cur7, prev7, mtd: [mStart, D], last_month_same: lmSame, last_month: [lmStart, lmEnd] },
    revenue: {
      yesterday: rD, day_before: rD1, same_dow_last_week: rD7,
      last7: rCur7, prev7: rPrev7, mtd: rMtd, last_month_same: rLmSame, last_month: rLm,
      change_pct: {
        vs_day_before: rD && rD1 ? pct(rD.revenue, rD1.revenue) : null,
        vs_same_dow_last_week: rD && rD7 ? pct(rD.revenue, rD7.revenue) : null,
        last7_vs_prev7: rCur7 && rPrev7 ? pct(rCur7.revenue, rPrev7.revenue) : null,
        mtd_vs_last_month_same: rMtd && rLmSame ? pct(rMtd.revenue, rLmSame.revenue) : null,
      },
      avg_order_value_yesterday: rD && rD.orders > 0 ? Math.round(rD.revenue / rD.orders) : null,
    },
    traffic: { yesterday: totals(sD), last7: totals(sCur), prev7: totals(sPrev) },
    products: { top_yesterday: topYesterday, trending_7d: trending, rate_drops_7d: rateDrops, high_view_low_rate_7d: highViewLowRate },
    claims_last7: c ? {
      cancel_count: num(c.cancel?.count), cancel_amount: num(c.cancel?.amount), cancel_reasons_top3: top3(c.cancel?.reasons),
      return_count: num(c.return?.count), return_amount: num(c.return?.amount), return_reasons_top3: top3(c.return?.reasons),
      note: "카페24 자사몰 기준(네이버페이 주문 제외), 최근 7일 주문 중 지금까지 들어온 취소·반품. 최근 주문은 아직 취소·반품이 더 들어오므로 증감 비교에 쓰지 말 것 (정확한 취소·반품률은 반품 감시 담당의 결제 주차 코호트 표)",
    } : null,
    ads: mCur7 === null && mD === null ? null : {
      yesterday: mD, last7: mCur7, prev7: mPrev7,
      roas_cafe24: { yesterday: roas(rD, mD), last7: roas(rCur7, mCur7), prev7: roas(rPrev7, mPrev7) },
      note: "ROAS(카페24) = 카페24 결제매출 ÷ Meta 광고비. Meta ROAS는 Meta가 잡은 전환 기준",
    },
    errors,
  };
}

const SYSTEM = `당신은 온라인 쇼핑몰 '다나로브(DNRB)'의 매출 분석 담당자입니다. 매일 아침 대표에게 어제 실적을 보고합니다.
- 요일 효과를 항상 고려합니다. 전날 대비보다 '지난주 같은 요일 대비'와 '최근 7일 vs 직전 7일'을 더 신뢰합니다.
- actions는 오늘 당장 실행할 구체적인 것 정확히 3개.
${COMMON_RULES}`;

const SCHEMA = reportSchema({
  highlights: "주목할 상품·신호 (밀어줄 만한 것). 최대 5개",
  warnings: "걱정되는 신호 (하락·반품·광고 효율 악화). 없으면 빈 배열",
  actions: "오늘 당장 실행할 구체적 액션 정확히 3개",
});

serveAgent({ agent: AGENT, label: "매출 분석 담당", system: SYSTEM, schema: SCHEMA, collect });

// ═══════════════════════════════════════════════
// agent-routine (2026-11-01) — claude.ai 예약 루틴(클라우드 Claude Code 세션, 계정 사용량·API 비용 0)이 아침 보고서를 쓰는 창구.
//   사용자 결정: 매일 자동 보고서(반품·전략·광고 운영·요약)는 루틴이 쓰고, 앱의 '지금 실행' 버튼은 API 크레딧을 쓴다.
//   POST ?action=prepare {agent, date?}  (x-routine-secret) → { key, system, schema, user_text, … } 또는 { wait:true, reason } (선행 보고서 아직) / { done:true } (이미 오늘 보고서 있음)
//   POST ?action=submit  {agent, date, key, report, usage?, model?} (x-routine-secret) → 검사·후처리·저장·알림 → { ok, id } / 400 { error, missing }
//   안전장치: pg_cron이 각 담당 run을 +25~30분 뒤 only_if_missing=1로 불러, 루틴이 못 썼으면 API로 쓴다(사용자가 확인·재실행할 일 없게).
// ═══════════════════════════════════════════════
import { handleOptions, json } from "../_shared/util.ts";
// 길이가 같을 때만 상수 시간 비교(타이밍 공격 완화)
const safeEqual = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
import { AgentDef, addDays, rest, routinePrepare, routineSubmit, Row } from "../_shared/agent.ts";
import { DEF as SALES } from "../sales-agent/def.ts";
import { DEF as RETURNS } from "../returns-agent/def.ts";
import { DEF as STRATEGY } from "../strategy-agent/def.ts";
import { DEF as ADS } from "../ads-agent/def.ts";

const DEFS: Record<string, AgentDef> = { sales: SALES, returns: RETURNS, strategy: STRATEGY, ads: ADS };
// 선행 조건: 아침 순서(숫자판 08:00 → 반품 08:15 → 전략 08:30 → 광고 운영 08:35 → 요약 08:45). 없으면 wait → 루틴이 2분 뒤 다시 prepare
const PREREQ: Record<string, { agent: string; status: string; label: string }[]> = {
  returns: [{ agent: "sales", status: "collected", label: "오늘 숫자판(08:00)" }],
  strategy: [{ agent: "returns", status: "ok", label: "오늘 반품 보고서" }],
  ads: [{ agent: "strategy", status: "ok", label: "오늘 전략 보고서" }],
  sales: [{ agent: "returns", status: "ok", label: "오늘 반품 보고서" }, { agent: "strategy", status: "ok", label: "오늘 전략 보고서" }, { agent: "ads", status: "ok", label: "오늘 광고 운영 보고서" }],
};
const seoulToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  const secret = Deno.env.get("ROUTINE_SECRET") ?? "";
  if (!secret || !safeEqual(req.headers.get("x-routine-secret") ?? "", secret)) return json({ error: "접근 권한이 없습니다" }, 403);
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) as Row : {};
  const def = DEFS[String(body.agent ?? url.searchParams.get("agent") ?? "")];
  if (!def) return json({ error: "agent는 sales·returns·strategy·ads 중 하나" }, 400);
  const yesterday = addDays(seoulToday(), -1);
  let D = String(body.date ?? url.searchParams.get("date") ?? yesterday);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(D) || D > yesterday) D = yesterday;
  try {
    if (action === "prepare") {
      const ex = await rest(`agent_reports?agent=eq.${def.agent}&report_date=eq.${D}&status=eq.ok&select=id&limit=1`);
      if (ex.ok && (((await ex.json()) as Row[]).length)) return json({ done: true, reason: "이미 오늘 보고서가 있음", report_date: D });
      for (const pre of (PREREQ[def.agent] ?? [])) {
        const r = await rest(`agent_reports?agent=eq.${pre.agent}&report_date=eq.${D}&status=eq.${pre.status}&select=id&limit=1`);
        if (!(r.ok && (((await r.json()) as Row[]).length))) return json({ wait: true, reason: `${pre.label}가 아직 없음 — 2분 뒤 다시`, report_date: D });
      }
      return json(await routinePrepare(def, D));
    }
    if (action === "submit") {
      const key = String(body.key ?? "");
      if (!key.startsWith("agentrun:")) return json({ error: "key 필요(prepare 응답의 key)" }, 400);
      return await routineSubmit(def, D, key, body.report, (body.usage ?? null) as Row | null, String(body.model ?? "routine"));
    }
    return json({ error: "action은 prepare 또는 submit" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e).slice(0, 400) }, 500);
  }
});

// ═══════════════════════════════════════════════
// agent-write — 모든 담당자의 2단계(보고서 작성) 전용 함수 (2026-09-13)
//   run(1단계, 각 담당자 함수)이 수집 데이터를 api_cache에 넣고 이 함수를 부른다. 별도 함수 = 별도 worker라
//   수집 단계의 CPU 사용량과 합산되지 않는다(같은 함수를 다시 부르면 같은 worker가 받아 WORKER_RESOURCE_LIMIT 546, 실측).
//   POST ?agent=sales|returns|strategy&date=YYYY-MM-DD&key=agentrun:…  (x-cron-secret 전용)
//   담당자 정의는 각 함수의 def.ts를 그대로 가져온다 — 새 담당자를 만들면 여기 한 줄 추가.
// ═══════════════════════════════════════════════
import { handleOptions, json } from "../_shared/util.ts";
import { AgentDef, isCronRequest, writeStage } from "../_shared/agent.ts";
import { DEF as SALES } from "../sales-agent/def.ts";
import { DEF as RETURNS } from "../returns-agent/def.ts";
import { DEF as STRATEGY } from "../strategy-agent/def.ts";

const DEFS: Record<string, AgentDef> = { sales: SALES, returns: RETURNS, strategy: STRATEGY };

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;
  if (!isCronRequest(req)) return json({ error: "접근 권한이 없습니다" }, 403);
  const url = new URL(req.url);
  const def = DEFS[url.searchParams.get("agent") ?? ""];
  const D = url.searchParams.get("date") ?? "", key = url.searchParams.get("key") ?? "";
  if (!def || !/^\d{4}-\d{2}-\d{2}$/.test(D) || !key.startsWith("agentrun:")) return json({ error: "agent, date, key 필수" }, 400);
  try { return await writeStage(def, D, key); }
  catch (e) { return json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 500); }
});

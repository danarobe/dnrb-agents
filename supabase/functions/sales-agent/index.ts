// sales-agent 진입점 — 정의는 ./def.ts (agent-write 함수가 같은 정의를 가져다 2단계 작성에 씀)
import { serveAgent } from "../_shared/agent.ts";
import { DEF } from "./def.ts";
serveAgent(DEF);

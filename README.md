# DNRB 에이전트

다나로브 쇼핑몰의 매출 성장을 돕는 AI 담당자(에이전트)들의 보고서를 보는 앱입니다.

- 주소: https://danarobe.github.io/dnrb-agents/
- 계정: DNRB 워크스페이스와 같은 계정 (워크스페이스 메뉴 "AI 에이전트"에서 자동 로그인)
- 1호 담당: 매출 분석 담당 — 매일 아침 8시, 어제 실적과 오늘 할 일 3가지

## 구조
- `index.html`, `css/app.css`, `js/` — 화면 (프레임워크 없음, 정적 페이지)
- `supabase/functions/sales-agent` — 매출 분석 담당 (Supabase Edge Function, Claude API)
- `supabase/migrations` — `agent_reports` 테이블

자세한 운영 규칙은 `CLAUDE.md`에 있습니다.

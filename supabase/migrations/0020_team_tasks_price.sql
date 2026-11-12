-- 2026-11-12 팀 작업보드: 상품 판매가·공급가·마진(사용자 "공급가·판매가·마진 금액·마진율도 — 더 명확한 판단")
--   {price, supply, cn, cost, real_cost, margin_won, margin_rate, at} — agent-tasks sync의 fillPrice가 채움
alter table public.team_tasks add column if not exists price_info jsonb;

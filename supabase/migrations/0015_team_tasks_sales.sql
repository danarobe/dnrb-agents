-- 2026-11-11 사용자 요청 "각 상품의 최근 7일 일평균 판매량도 — 광고 착수 결정에 도움": sync가 카페24 상품별 판매(summary)로 채움
alter table team_tasks add column if not exists sales_7d jsonb;   -- {qty_7d, qty_prev7d, views_7d, through}

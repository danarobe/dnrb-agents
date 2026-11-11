-- 2026-11-11 사용자 요청 "광고 착수 상품 중 기존에 5일 이상 ON됐던 광고가 몇 개고, 지금 활성 광고가 몇 개인지 — 새로 만들지 기존 소재를 켤지 판단":
--   sync가 Meta(meta-ads activeads·pausedads·adhistory)로 채움
alter table team_tasks add column if not exists ad_hist jsonb;   -- {active, proven, proven_on, proven_off, proven_off_roas, short, list[], through, days}

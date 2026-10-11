-- 네이버 데이터랩 인기 검색어 순위표 저장 (2026-10-11)
-- 네이버는 '어제' 순위표를 아침 08:30에는 아직 공개하지 않는다(빈 목록) → 낮에 따로 받아 저장해 두고 아침 보고서는 저장본을 쓴다.
-- 하루 = 카테고리(cid)당 1행, ranks = {"키워드": 순위}. service_role 전용(strategy-agent만 읽고 씀).
create table if not exists trend_ranks (
  day date not null,
  cid text not null,                 -- 50000000 패션의류 / 50000001 패션잡화
  gender text not null default 'f',
  ranks jsonb not null,              -- {"트위드자켓": 1, ...} 상위 100
  n int not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (day, cid, gender)
);
alter table trend_ranks enable row level security;

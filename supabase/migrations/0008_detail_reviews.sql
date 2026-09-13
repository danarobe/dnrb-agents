-- 상세페이지 점검 (2026-09-13, 상품 전략 담당 2단계)
-- 이미지를 조각내 Gemini(flash-lite)로 읽고(pages), Claude가 판단(review). desc_hash가 같으면 읽기 결과를 재사용(비용 0).
create table if not exists detail_reviews (
  id uuid primary key default gen_random_uuid(),
  batch_id text,                              -- 같은 날 함께 돌린 묶음 (모두 끝나면 agent_reports 요약 1건 생성)
  product_no bigint not null,
  product_name text,
  report_date date not null,
  reason text,                                -- 왜 골랐는지 (급상승/TOP10/상세·가격 점검)
  desc_hash text,                             -- description HTML 해시 — 같으면 pages 재사용
  image_urls jsonb,                           -- 상세 이미지 URL 목록
  images jsonb,                               -- [{idx, url, w, h, tiles}] 메타
  pages jsonb not null default '{}'::jsonb,   -- {"0": {...gemini 읽기 결과}, ...}
  pages_done int not null default 0,
  status text not null default 'reading',     -- reading | judging | ok | error
  review jsonb,                               -- Claude 판단 결과
  model text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists detail_reviews_product_idx on detail_reviews (product_no, created_at desc);
alter table detail_reviews enable row level security;

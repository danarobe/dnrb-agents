-- 광고 소재 담당 (2026-09-18) — 급상승 5 + 베스트 5 상품의 상세페이지·리뷰·광고 성과를 읽어 후킹 포인트·소재 제작안을 만든다.
-- 상품 1개 = 1행. 묶음(batch_id)은 seq 순서대로 한 상품씩 처리(읽기 → 작성)하고, 다 끝나면 agent_reports(agent=creative) 1건으로 묶는다.
create table if not exists creative_briefs (
  id uuid primary key default gen_random_uuid(),
  batch_id text not null,
  seq int not null default 0,
  product_no bigint not null,
  product_name text,
  report_date date not null,
  kind text not null default 'manual',          -- surge(급상승) | best(베스트) | manual(직접 고름)
  metrics jsonb,                                -- 판매·조회·주문율·가격·마진·혜택
  ads jsonb,                                    -- 이 상품에 붙은 광고의 최근 30일 성과(CTR·CPC·구매당 비용·ROAS) + 문구
  shared jsonb,                                 -- 묶음 공통: 소재 유형별 효율(format_stats)·계정 평균
  desc_hash text,
  image_urls jsonb,
  images jsonb,
  pages jsonb not null default '{}'::jsonb,     -- Gemini 읽기 결과(장별) — detail_reviews와 같은 형식, 같은 해시면 서로 재사용
  pages_done int not null default 0,
  reviews jsonb,                                -- {status: ok|scope_missing|none|error, count, rating_avg, reviews:[…]}
  status text not null default 'queued',        -- queued | reading | briefing | ok | error
  brief jsonb,                                  -- Claude 소재 제작안
  model text,
  usage jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists creative_briefs_batch_idx on creative_briefs (batch_id, seq);
create index if not exists creative_briefs_product_idx on creative_briefs (product_no, created_at desc);
alter table creative_briefs enable row level security;

create or replace function public.creative_page_done(p_id uuid, p_idx integer, p_page jsonb, p_total integer)
returns integer language plpgsql security definer set search_path to 'public' as $$
declare done int;
begin
  update creative_briefs set pages = pages || jsonb_build_object(p_idx::text, p_page), pages_done = pages_done + 1, updated_at = now()
    where id = p_id returning pages_done into done;
  return p_total - coalesce(done, 0);
end $$;
revoke all on function public.creative_page_done(uuid, integer, jsonb, integer) from public, anon, authenticated;

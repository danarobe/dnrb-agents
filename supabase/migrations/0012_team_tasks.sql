-- 팀별 '오늘 할 일' 보드 + 대표 결정함 (2026-11-07, 사용자 승인 "추천하는 순서대로 해줘")
-- 매일 보고서 4개(반품·전략·광고 운영·요약)의 week_actions를 상품 1개 × 할 일 1개로 쪼개고, 같은 일(종류+상품)은 하나로 합친다.
-- agent-tasks 함수(service_role)만 읽고 쓴다 — 화면도 그 함수를 거친다(대표 결정은 관리자만, 완료 체크는 에이전트 사용자 전원).
create table if not exists team_tasks (
  id uuid primary key default gen_random_uuid(),
  task_key text not null,                 -- 종류|상품번호 (상품이 없으면 종류|t:제목 앞부분)
  kind text not null,                     -- 광고 착수 / 광고 증액 / 광고 줄이기 / 상세 보강 / 노출·기획전 / CS·출고 / 재고·소싱 / 가격·혜택 / 지킬 원칙 / 기타
  title text not null,                    -- 할 일(상품명 제외)
  product_no int,
  product_name text,
  owner text not null,                    -- 광고팀 / 상품팀 / CS팀 / 대표
  why text,
  done_when text,                         -- 완료 기준 한 줄
  due date,
  needs_ceo boolean not null default false,
  decision text,                          -- null / approve / hold
  decision_note text,
  decided_by text,
  decided_at timestamptz,
  status text not null default 'open',    -- open / done / held / dropped
  done_how text,                          -- auto / manual
  done_by text,
  done_at timestamptz,
  done_evidence text,
  baseline jsonb not null default '{}'::jsonb,   -- 자동 판정 기준값(처음 본 날의 ON 광고 수·상세 해시)
  sources jsonb not null default '[]'::jsonb,    -- [{agent, report_date, action_id, why}]
  first_seen date not null,
  last_seen date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists team_tasks_live_key on team_tasks (task_key) where status in ('open', 'held');
create index if not exists team_tasks_status on team_tasks (status, last_seen);
alter table team_tasks enable row level security;

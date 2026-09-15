-- 담당자에게 질문하기 (2026-09-15) — 보고서마다 질문·답변 기록
-- 읽기·쓰기 모두 agent-ask 함수(service_role)만 한다. RLS on·정책 없음 → anon 접근 불가.
create table if not exists agent_questions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references agent_reports (id) on delete cascade,
  agent text not null,
  question text not null,
  answer text,
  tools_used jsonb not null default '[]'::jsonb,   -- [{tool, label}] 답하려고 다시 조회한 데이터
  status text not null default 'ok',               -- ok | error
  error text,
  model text,
  usage jsonb,
  asked_by text,                                   -- app_users.id
  asked_by_name text,
  took_ms int,
  created_at timestamptz not null default now()
);
create index if not exists agent_questions_report_idx on agent_questions (report_id, created_at);
alter table agent_questions enable row level security;

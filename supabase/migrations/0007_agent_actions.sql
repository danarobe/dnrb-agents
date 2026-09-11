-- 할 일 완료 체크 (2026-09-11 사용자 요청)
-- 보고서의 주간 할 일(week_actions[].id)에 대한 완료 표시. 읽기·쓰기는 워크스페이스 db 프록시(admin), 에이전트 함수는 service_role로 읽어 완료된 일을 다음 보고서에서 뺀다.
create table if not exists agent_actions (
  id uuid primary key default gen_random_uuid(),
  agent text not null default 'sales',
  action_id text not null,                 -- 에이전트가 부여한 할 일 id (주 안에서 유지)
  week_start date,                         -- 그 할 일이 속한 주(월요일)
  title text,                              -- 표시용 스냅숏
  owner text,
  done boolean not null default false,
  done_by text,                            -- 체크한 사람 이름
  done_at timestamptz,
  created_at timestamptz not null default now(),
  unique (agent, action_id)
);
alter table agent_actions enable row level security;

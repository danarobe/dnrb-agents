-- 2026-11-11 사용자 "팀 작업보드 + 진행 중 단계": 할 일 → 진행 중(직원이 '시작') → 완료. status는 open 그대로 두고 started_at으로 진행 중을 표시(기존 open 기준 로직 유지)
alter table team_tasks add column if not exists started_at timestamptz;
alter table team_tasks add column if not exists started_by text;

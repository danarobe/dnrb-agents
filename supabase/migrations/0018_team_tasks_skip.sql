-- 2026-11-11 사용자 "팀 작업보드 할 일에 '미진행' 버튼 + 이유 기입": status='closed' · done_how='skip' · skip_reason(직원이 쓴 이유)
alter table team_tasks add column if not exists skip_reason text;

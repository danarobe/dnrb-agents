-- 오늘 할 일 2차 (2026-11-07, 사용자 "주말엔 직원만 쉬고 대표는 대부분 본다 — 휴가는 빼고 나머지 먼저")
-- stale_since: 에이전트가 더는 제안하지 않게 된 날. 예전엔 바로 내렸지만(dropped) 이제는 사람이 완료·닫기 전까지 남긴다.
-- due_source: agent(에이전트가 정한 실제 기한) / default(기한이 없어 출근일 기준으로 코드가 정함) / ceo(대표가 '월요일로' 미룸)
-- status에 closed 추가(사람이 '필요 없음'으로 닫음).
alter table team_tasks add column if not exists stale_since date;
alter table team_tasks add column if not exists due_source text not null default 'agent';

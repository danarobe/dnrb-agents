-- 2026-11-11 사용자 "시즌 지남으로 미진행했는데 몇 주·몇 달 지나거나 판매가 급등하면 다시 제안해 주는 거지?"
--   skip_until = 이 날부터 다시 제안될 수 있음(이유별 기간), skip_qty7 = 미진행할 때 최근 7일 판매(급등 판정 기준), reopen_note = 다시 올라온 일의 사연
alter table team_tasks add column if not exists skip_until date;
alter table team_tasks add column if not exists skip_qty7 numeric;
alter table team_tasks add column if not exists reopen_note text;
update team_tasks set skip_until = (done_at at time zone 'Asia/Seoul')::date + 30 where done_how = 'skip' and skip_until is null;

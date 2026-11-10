-- 2026-11-10 (사용자 "개선 제안 4개 다 해줘"): 대표 승인 → 담당 팀 바로 알림 · 승인할 때 방식·하루 예산 · 기존 예산 안 다시 켜기는 승인 없이
alter table team_tasks add column if not exists decision_detail jsonb;          -- {method, daily_won} — 승인할 때 대표가 정한 방식·하루 예산(원)
alter table team_tasks add column if not exists notified_at timestamptz;        -- 승인 알림을 담당 팀에 보낸 때(묶어 보내기용)
alter table team_tasks add column if not exists reenable boolean not null default false;   -- 꺼진 광고를 기존 예산 안에서 다시 켜는 일(대표 승인 없이 바로)

-- 승인 알림 묶어 보내기: 10분마다(근무 시간·출근일에만 실제 발송)
select cron.alter_job((select jobid from cron.job where jobname = 'agent-sweep'),
  command := $$select agent_call('creative-agent','action=sweep'); select agent_call('detail-agent','action=sweep'); select agent_call('agent-tasks','action=flush');$$);

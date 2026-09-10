# DNRB 에이전트 — 프로젝트 지침 (CLAUDE.md)

> 다나로브(danarobe) 쇼핑몰의 **매출 성장을 돕는 AI 담당자(에이전트) 그룹** 앱. 비개발자인 사용자에게는 쉬운 한국어로 설명한다.
> 2026-09-10 사용자 결정: 워크스페이스(~/dnrb-dashboard, 1만 2천 줄 단일 파일)가 너무 무거워져 **화면은 이 저장소로 분리**, 데이터 연결·계정은 워크스페이스와 **같은 Supabase 프로젝트를 공유**한다.

## 0. 한눈에 보기
- **소스**: `~/dnrb-agents` — `index.html` 뼈대 + `css/app.css` + `js/`(config·api·agents·reports·app, 기능별 분리) + `supabase/functions/sales-agent`.
- **배포**: GitHub Pages `https://danarobe.github.io/dnrb-agents/` (공개 레포 `danarobe/dnrb-agents`, main 브랜치 루트). **git push하면 자동 배포**(30~60초).
- **Supabase**: 워크스페이스와 같은 프로젝트 `eeffmbusaqaadeojjlnc`(서울). anon key·URL은 `js/config.js`(공개돼도 되는 값 — 서버가 로그인 토큰을 검증).
- **로컬 프리뷰**: `.claude/launch.json`의 dnrb-agents, 포트 8735.
- **이 문서는 공개 레포에 올라간다** — 개인정보·매출 절대액·API 키를 적지 않는다. 검증 기록은 "일치함"처럼 결과만.

## 1. 워크스페이스와의 관계 (반드시 이해할 것)
- **계정·로그인 = 워크스페이스 `auth` 함수.** 이 앱의 로그인 화면은 `auth` `login`을 그대로 호출한다(비밀번호 동일). 워크스페이스 메뉴 "AI 에이전트"는 현재 세션을 `#sso=base64url({token,id,name,role,exp})` 해시로 넘기고, `js/api.js loadSession()`이 받아 `localStorage dnrb_agents_session`에 저장한 뒤 해시를 지운다. 토큰은 함수 호출마다 서버가 다시 검증하므로 안전.
- **데이터 읽기 = 워크스페이스 `db` 프록시 함수.** `agent_reports` 테이블은 그쪽 화이트리스트에 `admin`으로 등록돼 있다(2026-09-10). 새 테이블을 만들면 **워크스페이스 저장소의 `supabase/functions/db/index.ts` TABLE_ROLES에 추가하고 db 함수를 재배포**해야 한다.
- **에이전트가 쓰는 데이터 함수(cafe24-analytics / cafe24-claims / meta-ads)는 워크스페이스 저장소 소속.** 세 함수는 `x-agent-secret`(secret `AGENT_SECRET`) 헤더를 admin으로 인정한다. 다른 액션을 열어야 하면 그쪽 코드를 고친다.
- **`_shared/util.ts`는 워크스페이스 것의 복사본.** 그쪽이 바뀌면 여기도 맞춰 복사(특히 verifyAuthToken 역할 정규화).
- 워크스페이스 종 알림: sales-agent가 `notifications`에 `link_menu: 'agents'`로 넣고, 워크스페이스 `notifOpen()`이 그 값을 보면 `agentsOpen()`으로 이 앱을 연다.

## 2. 화면 (js/)
- `config.js` — Supabase URL/anon key, 워크스페이스 URL.
- `api.js` — 세션(loadSession/authLogin/logout), `callFn`(함수 호출, `x-auth-token` 자동), `dbProxy`, 포맷(fmtMan = 만 원/억 원, fmtDelta, dateLabel), toast, btnBusy/btnIdle.
- `agents.js` — **담당자 등록부 `AGENTS`**(key = `agent_reports.agent`, status active/planned, fn = 실행 함수). 홈 카드 렌더(`renderHome`), API 키 안내(`renderSetupNotice` — sales-agent `status.configured`), `agentRun(key)`(action=run POST → 완료 시 `#reports/<id>`).
- `reports.js` — 보고서 피드. `reportsLoad()`(60건 캐시) → 좌측 목록 + 우측 상세(`reportHtml`): 헤드라인(mood 색)+요약 → KPI 4타일(어제/7일/이달/광고비·ROAS, 증감은 지난주 같은 요일·직전 7일·지난달 같은 기간) → 주목/주의 2열 → 오늘 할 일 3(담당 칩) → note·수집 오류 → `수집한 숫자 보기`(rawTable, 근거 확인용). 실패 행은 빨간 상자로 원인 표시. 관리자가 아니면 목록 대신 안내.
- `app.js` — 해시 라우터 `#home | #reports | #reports/<id>`, 로그인 화면 전환.
- 모든 사용자 데이터·보고서 문자열은 `escHtml`을 거쳐 innerHTML에 넣는다(보고서는 Claude 출력이라 신뢰하지 않음).

## 3. 매출 분석 담당 (`supabase/functions/sales-agent`, 에이전트 1호)
- **흐름**: run → ① `collect(D)` — 워크스페이스 함수를 `x-agent-secret`으로 admin 호출(실측 약 10초) → ② Claude `claude-opus-5`(effort medium, `output_config.format` json_schema 구조화 응답, `npm:@anthropic-ai/sdk`) → ③ `agent_reports` 저장 + 관리자 전원 `notifications`(link_menu agents) + 웹 푸시(VAPID) → 응답 `{id, report, notified}`.
- **기준일 D** = 실행일 전날(KST). `?date=` / body.date로 과거 날짜 지정 가능(오늘 이후는 어제로 보정).
- **수집 항목**: 매출 8구간(어제/그저께/지난주 같은 요일/최근 7/직전 7/이달 누적/지난달 같은 기간/지난달 전체 — `revenue`. **첫 호출 후 나머지 병렬**: 카페24 토큰 동시 갱신 경쟁 방지), 상품 조회·주문율 3구간(`summary`), 취소반품 최근 7일(`cafe24-claims`), Meta `summary` 3구간. 파생: 급증 TOP8(워크스페이스 홈과 같은 규칙: 이번 주 10개↑·(cur+5)/(prev+5)), 주문율 하락(두 주 조회 300↑·직전 1%↑·60% 이하), 조회 많고 안 팔림(500↑·0.5%↓), 어제 TOP8, ROAS(카페24)=카페24 매출÷Meta 광고비. 항목별 try/catch → `data.errors[]`에 남기고 나머지로 진행.
- **리포트 JSON**(REPORT_SCHEMA): headline(40자)/mood(good·neutral·bad)/summary[3~5]/highlights[]/warnings[]/actions[정확히 3, owner=광고팀·상품팀·CS팀·대표]/note. 시스템 프롬프트 원칙: 숫자 근거, 요일 효과(전날보다 지난주 같은 요일·7일 비교 우선), 만 원 단위, 추측은 추측으로, 큰 결정은 '대표 확인 후', 없는 상품·숫자 금지.
- **실패도 행으로 남긴다**(status error + error + 수집 data). API 키가 없으면 `status.configured=false` → 화면 상단 안내 박스.
- **액션**: `run`(POST, 관리자 또는 x-cron-secret) / `collect`(GET, 수집 숫자만 — 점검용) / `status`(GET, 관리자).
- **자동 실행**: pg_cron 잡 `sales-agent-morning`(jobid 2, `0 23 * * *` UTC = **08:00 KST**) → `net.http_post(sales-agent?action=run, Authorization Bearer anon, x-cron-secret, timeout 180s)`. 워크스페이스 meta-budget의 `budget-midnight-kst`와 같은 방식. 잡 수정은 Supabase 관리 API SQL(`cron.unschedule` 후 `cron.schedule`; 관리 토큰은 macOS 키체인 `security find-generic-password -s "Supabase CLI" -w`, python urllib은 403이라 curl).
- **배포**: `supabase functions deploy sales-agent --project-ref eeffmbusaqaadeojjlnc` (secrets 변경 후에도 재배포).
- **필요 secrets**: `ANTHROPIC_API_KEY`(**사용자가 console.anthropic.com에서 발급해 넣어야 함** — 2026-09-10 현재 미설정), `AGENT_SECRET`(설정 완료), `CRON_SECRET`(워크스페이스와 공유), `SUPABASE_ANON_KEY`·`SUPABASE_URL`·`SUPABASE_SERVICE_ROLE_KEY`(자동), `VAPID_*`(선택).
- **검증(2026-09-10)**: collect 실측 오류 0건·10.4초, 키 미설정 run → error 행 저장 확인, 화면은 node 스텁 DOM으로 홈·보고서(정상/실패)·비관리자 차단 확인.

## 4. DB
- `agent_reports`(마이그레이션 `supabase/migrations/0006_agent_reports.sql`, 적용 완료): agent/report_date/trigger(cron|manual)/status(ok|error)/data/report/model/usage/error/created_by/created_at. RLS on·anon 정책 없음 → 읽기는 db 프록시(admin), 쓰기는 sales-agent(service_role).

## 5. 다음 담당자 만드는 법
1. `js/agents.js`의 `AGENTS`에 한 줄 추가(key·name·fn·schedule, status active).
2. `supabase/functions/<key>-agent/index.ts`를 sales-agent를 틀로 복제 — collect/REPORT_SCHEMA/SYSTEM만 바꾸고 `AGENT` 상수를 key로. 저장·알림·인증 코드는 그대로.
3. 필요한 데이터 액션이 워크스페이스 함수에 없거나 admin 전용이면 그쪽에서 `viaAgent` 허용 범위를 넓힌다.
4. pg_cron 잡 추가. 화면은 `reportHtml`이 agent별로 다르게 그려야 하면 `reports.js`에서 분기.
- **원칙(사용자 결정)**: 에이전트는 **제안만** 한다. 광고 게재·가격 변경·고객 발송 같은 바깥 행동은 자동화하지 않는다.

## 6. 남은 일
- ANTHROPIC_API_KEY 입력(사용자) → 첫 보고서 확인 → 프롬프트·액션 품질 다듬기.
- 오늘 할 일 체크(제안 → 담당 배정 → 완료 기록, `agent_actions` 테이블 예정), 에이전트에게 질문하기(보고서 맥락 + 데이터 재조회).
- 2호 담당 = 취소·반품 감시(워크스페이스 `returnwatch`/`returnreasons` 액션 재사용 가능).

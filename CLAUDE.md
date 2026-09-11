# DNRB 에이전트 — 프로젝트 지침 (CLAUDE.md)

> 다나로브(danarobe) 쇼핑몰의 **매출 성장을 돕는 AI 담당자(에이전트) 그룹** 앱. 비개발자인 사용자에게는 쉬운 한국어로 설명한다.
> 2026-09-10 사용자 결정: 워크스페이스(~/dnrb-dashboard, 1만 2천 줄 단일 파일)가 너무 무거워져 **화면은 이 저장소로 분리**, 데이터 연결·계정은 워크스페이스와 **같은 Supabase 프로젝트를 공유**한다.

## 0. 한눈에 보기
- **소스**: `~/dnrb-agents` — `index.html` 뼈대 + `css/app.css` + `js/`(config·api·agents·reports·app, 기능별 분리) + `supabase/functions/`(**`_shared/agent.ts` 공통 뼈대** + `sales-agent` + `returns-agent`).
- **배포**: GitHub Pages `https://danarobe.github.io/dnrb-agents/` (공개 레포 `danarobe/dnrb-agents`, main 브랜치 루트). **git push하면 자동 배포**(30~60초).
- **Supabase**: 워크스페이스와 같은 프로젝트 `eeffmbusaqaadeojjlnc`(서울). anon key·URL은 `js/config.js`(공개돼도 되는 값 — 서버가 로그인 토큰을 검증).
- **로컬 프리뷰**: `.claude/launch.json`의 dnrb-agents, 포트 8735.
- **이 문서는 공개 레포에 올라간다** — 개인정보·매출 절대액·API 키를 적지 않는다. 검증 기록은 "일치함"처럼 결과만.

## 1. 워크스페이스와의 관계 (반드시 이해할 것)
- **계정·로그인 = 워크스페이스 `auth` 함수.** 이 앱의 로그인 화면은 `auth` `login`을 그대로 호출한다(비밀번호 동일). 워크스페이스 메뉴 "AI 에이전트"는 `auth sso_issue`로 받은 **60초 일회용 코드**를 `#sso=코드` 해시로 넘기고, `js/api.js loadSession()`이 해시를 지운 뒤 `auth sso_redeem`으로 정식 토큰(7일)과 바꿔 `localStorage dnrb_agents_session`에 저장한다. **토큰 자체를 주소에 싣지 않는다**(2026-09-10 보안 검토: 공용 PC 브라우저 기록 노출) — 코드는 api_cache(`sso:<code>`)에 있다가 교환 즉시 삭제.
- **데이터 읽기 = 워크스페이스 `db` 프록시 함수.** `agent_reports` 테이블은 그쪽 화이트리스트에 `admin`으로 등록돼 있다(2026-09-10). 새 테이블을 만들면 **워크스페이스 저장소의 `supabase/functions/db/index.ts` TABLE_ROLES에 추가하고 db 함수를 재배포**해야 한다.
- **에이전트가 쓰는 데이터 함수(cafe24-analytics / cafe24-claims / meta-ads)는 워크스페이스 저장소 소속.** 세 함수는 `x-agent-secret`(secret `AGENT_SECRET`) 헤더를 admin으로 인정한다. 다른 액션을 열어야 하면 그쪽 코드를 고친다.
- **`_shared/util.ts`는 워크스페이스 것의 복사본.** 그쪽이 바뀌면 여기도 맞춰 복사(특히 verifyAuthToken 역할 정규화).
- 워크스페이스 종 알림: sales-agent가 `notifications`에 `link_menu: 'agents'`로 넣고, 워크스페이스 `notifOpen()`이 그 값을 보면 `agentsOpen()`으로 이 앱을 연다.

## 2. 화면 (js/)
- `config.js` — Supabase URL/anon key, 워크스페이스 URL.
- `api.js` — 세션(loadSession/authLogin/logout), `callFn`(함수 호출, `x-auth-token` 자동), `dbProxy`, 포맷(fmtMan = 만 원/억 원, fmtDelta, dateLabel), toast, btnBusy/btnIdle.
- `agents.js` — **담당자 등록부 `AGENTS`**(key = `agent_reports.agent`, status active/planned, fn = 실행 함수). 홈 카드 렌더(`renderHome`), API 키 안내(`renderSetupNotice` — sales-agent `status.configured`), `agentRun(key)`(action=run POST → 완료 시 `#reports/<id>`).
- `reports.js` — 보고서 피드. `reportsLoad()`(60건, **같은 날 재실행은 최신 1건만 표시**, 담당자 필터 칩 `reportsFilter`) + `actionsLoad()`/`actionToggle()`(완료 체크, change 이벤트 위임 `.act-chk`, **키 = agent|action_id** — 두 담당자가 같은 id를 쓸 수 있음). `reportHtml`은 `r.agent`로 타일·추가 표를 분기(sales/returns), 나머지(헤드라인·주간·할 일)는 공통 → 좌측 목록 + 우측 상세(`reportHtml`): 헤드라인(mood 색)+요약 → KPI 4타일(어제/7일/이달/광고비·ROAS, 증감은 지난주 같은 요일·직전 7일·지난달 같은 기간) → 오늘의 주목/주의 2열 → **이번 주 누적: P 주목 / N 주의 2열(등장일 칩·NEW) → 이번 주 할 일(since 칩) → 저번 주 해야 했을 일(회색 점선 상자)** → note·수집 오류. 주간 필드가 없는 옛 보고서는 actions를 '이번 주 할 일'로 표시 → `수집한 숫자 보기`(rawTable, 근거 확인용). 실패 행은 빨간 상자로 원인 표시. 관리자가 아니면 목록 대신 안내.
- `app.js` — 해시 라우터 `#home | #reports | #reports/<id>`, 로그인 화면 전환.
- 모든 사용자 데이터·보고서 문자열은 `escHtml`을 거쳐 innerHTML에 넣는다(보고서는 Claude 출력이라 신뢰하지 않음).

## 3-0. 공통 뼈대 `_shared/agent.ts` (2026-09-11, 2호를 만들며 분리)
담당자 함수는 `serveAgent({ agent, label, system, schema, collect })` 한 줄로 끝난다. 뼈대가 하는 일: 인증(관리자 또는 x-cron-secret) → `status`/`collect`/`run` → 기준일 D 보정 → `collect(D)`와 `weekContext(agent, D)` 병렬 → `writeReport`(claude-opus-5, effort medium, json_schema) → `agent_reports` 저장(report에 week/last_week 덧붙임) → `notifyAdmins(label)`(종 알림 link_menu agents + 웹 푸시). 실패는 error 행. 공용 도우미: `callFn`(x-agent-secret), `rest`(service_role), `safeCollector`(항목별 try/catch → errors[]), `reportSchema({highlights, warnings, actions, extra})`(공통 필드 + 주간 3종 + 담당자별 extra), `COMMON_RULES`(글쓰기 원칙 + 주간 항목 규칙 — 각 SYSTEM 끝에 붙임). **뼈대를 고치면 모든 담당자 함수를 재배포**(배포 시 번들 복사).

## 3. 매출 분석 담당 (`supabase/functions/sales-agent`, 에이전트 1호)
- **흐름**: run → ① `collect(D)` — 워크스페이스 함수를 `x-agent-secret`으로 admin 호출(실측 약 10초) → ② Claude `claude-opus-5`(effort medium, `output_config.format` json_schema 구조화 응답, `npm:@anthropic-ai/sdk`) → ③ `agent_reports` 저장 + 관리자 전원 `notifications`(link_menu agents) + 웹 푸시(VAPID) → 응답 `{id, report, notified}`.
- **기준일 D** = 실행일 전날(KST). `?date=` / body.date로 과거 날짜 지정 가능(오늘 이후는 어제로 보정).
- **수집 항목**: 매출 8구간(어제/그저께/지난주 같은 요일/최근 7/직전 7/이달 누적/지난달 같은 기간/지난달 전체 — `revenue`. **첫 호출 후 나머지 병렬**: 카페24 토큰 동시 갱신 경쟁 방지), 상품 조회·주문율 3구간(`summary`), 취소반품 최근 7일(`cafe24-claims`), Meta `summary` 3구간. 파생: 급증 TOP8(워크스페이스 홈과 같은 규칙: 이번 주 10개↑·(cur+5)/(prev+5)), 주문율 하락(두 주 조회 300↑·직전 1%↑·60% 이하), 조회 많고 안 팔림(500↑·0.5%↓), 어제 TOP8, ROAS(카페24)=카페24 매출÷Meta 광고비. 항목별 try/catch → `data.errors[]`에 남기고 나머지로 진행.
- **리포트 JSON**(REPORT_SCHEMA): headline(40자)/mood(good·neutral·bad)/summary[3~5]/highlights[]/warnings[]/actions[정확히 3, owner=광고팀·상품팀·CS팀·대표]/note + **주간 누적 3종(2026-09-11 사용자 요청 — "그날 못 보면 잊힌다")**: `week_highlights`/`week_warnings`[{title,detail,dates[],status new|ongoing}, 최대 8]·`week_actions`[{**id**,title,why,owner,since,status}, 최대 6]. 함수의 `weekContext(D)`가 이번 주(월~D-1, 날짜별 최신 1건)의 highlights/warnings/actions를 `this_week.prior_days`로 프롬프트에 넣고 Claude가 합친다(같은 상품=하나, 해소된 주의는 제외, 유효한 할 일 유지). **저번 주 할 일은 Claude 미경유** — 저번 주 마지막 보고서의 week_actions(없으면 actions)를 `report.last_week{start,end,from_report_date,actions}`로 그대로 붙임. `report.week{start,end}`도 저장. 주 = 월~일(KST), 월요일 아침 보고서(D=일요일)가 그 주 전체 마무리. 시스템 프롬프트 원칙: 숫자 근거, 요일 효과(전날보다 지난주 같은 요일·7일 비교 우선), 만 원 단위, 추측은 추측으로, 큰 결정은 '대표 확인 후', 없는 상품·숫자 금지.
- **실패도 행으로 남긴다**(status error + error + 수집 data). API 키가 없으면 `status.configured=false` → 화면 상단 안내 박스.
- **액션**: `run`(POST, 관리자 또는 x-cron-secret) / `collect`(GET, 수집 숫자만 — 점검용) / `status`(GET, 관리자).
- **자동 실행**: pg_cron 잡 `sales-agent-morning`(jobid 2, `0 23 * * *` UTC = **08:00 KST**) → `net.http_post(sales-agent?action=run, Authorization Bearer anon, x-cron-secret, timeout 180s)`. 워크스페이스 meta-budget의 `budget-midnight-kst`와 같은 방식. 잡 수정은 Supabase 관리 API SQL(`cron.unschedule` 후 `cron.schedule`; 관리 토큰은 macOS 키체인 `security find-generic-password -s "Supabase CLI" -w`, python urllib은 403이라 curl).
- **배포**: `supabase functions deploy sales-agent --project-ref eeffmbusaqaadeojjlnc` (secrets 변경 후에도 재배포).
- **필요 secrets**: `ANTHROPIC_API_KEY`(사용자가 2026-09-10 발급·설정 완료, 만료 없음), `AGENT_SECRET`(설정 완료), `CRON_SECRET`(워크스페이스와 공유), `SUPABASE_ANON_KEY`·`SUPABASE_URL`·`SUPABASE_SERVICE_ROLE_KEY`(자동), `VAPID_*`(선택).
- **검증(2026-09-10)**: collect 실측 오류 0건·10.4초, 키 미설정 run → error 행 저장 확인, 화면은 node 스텁 DOM으로 홈·보고서(정상/실패)·비관리자 차단 확인.

## 3-1. 취소·반품 감시 담당 (`supabase/functions/returns-agent`, 에이전트 2호, 2026-09-11)
- **자동 실행**: pg_cron `returns-agent-morning`(jobid 3, `15 23 * * *` UTC = **08:15 KST** — 매출 담당 뒤 15분, 카페24 토큰 갱신 경쟁 회피).
- **취소·반품률 원칙(2026-09-11 사용자 지정, 반드시 유지)**: **결제 주차(월~일) 코호트** — "그 주에 결제된 주문 중 몇 %가 (언제든) 취소·반품됐나". 취소가 다음 주에 나도 결제 주에 귀속. 근거: 8/31 결제 → 9/8 취소 같은 건이 주문일·이벤트일 기준 주간 비교를 틀어지게 하고, 최근 주는 미성숙해 늘 '줄어든 것처럼' 보임(첫 보고서의 "반품 절반 감소"가 이 착시였음). 워크스페이스 `cohortweeks` 액션(/orders/count 3회/구간)으로 6주+14일 코호트 + `age_days`. **성숙 = 경과 14일 이상**, 그 주끼리만 추세 비교. 집계 중·진행 중 주는 "아직 늘어날 수 있음" 명시(시스템 프롬프트에 규칙). 매일 저장되는 data.cohorts.days_last14로 나중에 성숙 곡선(결제 후 n일 경과 시 비율) 추정 가능 — 미구현.
- **수집**(실측 약 50초, 오류 0): ① `cohortweeks&end_date=D&weeks=6&days=14` ①-b `cafe24-claims` 최근 7일 — **사유 분포만**(건수 추세 아님, claim_reasons_last7) ② `returnwatch&end_date=E&top=30&risk=20&min_qty=10&extra=<관리 상품 번호>` — 7/14/30일 창 순반품률(배송완료일 기준, R00~R40) ③ `returnreasons` E−13~E — 상품별 사유 TOP3(40자 절단) ④ `return_watch` 테이블(관리 상품·지정 사유·판매 중단). **판정 기준일 E = D−3**(= 오늘−4일): 반품이 배송완료 후 며칠 뒤 들어와 어제 기준은 절반 이하로 나옴(워크스페이스 반품 관리 메뉴 규칙과 동일).
- **파생**: 등급 = 배송완료 <10 보류 / 순반품률 ≥20 위험 / 10~20 주의 / 그 외 양호. `risk_products`(순위권 상품 중 flagged·위험·주의, 14일 창 순, 12개, 옵션별 14일 위험 옵션(배송 5↑·20%↑)·사유 TOP3·관리 여부), `good_sellers_low_return`(14일 상위 10위 안·양호), `watched_products`(관리 상품 7/14/30 흐름), 상위 30 상품 합산 14일 순반품률.
- **리포트 extra 필드**: `cohort_table[{week, maturity 성숙|집계 중|진행 중, paid, cancel_rate, return_rate, verdict}]`(cohorts.weeks 그대로 + 판단), `risk_products[{name, level 위험|주의, rate_14d, delivered_14d, cause, fix}]`(표), `watch_review[{name, verdict 개선|유지|악화, detail}]`. 프롬프트 규칙: 옵션 집중이면 옵션 문제, 사유별 대응(사이즈→실측·안내 / 색상·소재→사진·설명 / 불량→제작처·검수 / 배송지연→출고), 관리 상품 지정·판매 중단은 사람이(제안만, '대표 확인 후').
- **화면**: 타일 4(최근 성숙 주 취소율·반품률 + 성숙 주 평균, 이번 주 집계 중, 위험·주의 상품 수) → 오늘의 주목/주의 → **결제 주차별 취소·반품률 표(상태 칩·경과일·판단)** → **위험·주의 상품 표(상품·원인 / 판정·수치 / 대응)** + **관리 상품 점검**(개선·유지·악화 칩) → 주간 누적 → 할 일. `rawTableReturns`에 취소반품 표·위험 후보 창별 표.

## 4. DB
- `agent_actions`(마이그레이션 `0007_agent_actions.sql`, 적용 완료, 2026-09-11): **할 일 완료 체크**. agent/action_id(unique 쌍)/week_start/title·owner(스냅숏)/done/done_by/done_at. 앱이 db 프록시(admin)로 `on_conflict=agent,action_id` upsert(prefer merge-duplicates). 키 = `week_actions[].id`(에이전트 부여 `기준일YYYYMMDD-순번`; 유지 항목은 id 불변). id 없는 옛 보고서 항목은 `legacy:since:제목40자` 임시 키(다음 보고서부터 진짜 id로 바뀌어 체크가 이어지지 않음 — 2026-09-10 보고서 한정). `weekContext()`가 done=true id를 읽어 `week_actions_so_far[].done`으로 프롬프트에 넣고, 시스템 프롬프트가 **done=true는 반드시 제외**하게 한다. 화면: 번호 동그라미가 체크박스(완료 = 초록 ✓ + 취소선 + "완료 · 이름 · 시각"), 저번 주 할 일도 체크 가능. 홈 카드에 "이번 주 할 일 M/N 완료".
- `agent_reports`(마이그레이션 `supabase/migrations/0006_agent_reports.sql`, 적용 완료): agent/report_date/trigger(cron|manual)/status(ok|error)/data/report/model/usage/error/created_by/created_at. RLS on·anon 정책 없음 → 읽기는 db 프록시(admin), 쓰기는 sales-agent(service_role).

## 5. 다음 담당자 만드는 법
1. `js/agents.js`의 `AGENTS`에 한 줄 추가(key·name·fn·schedule, status active).
2. `supabase/functions/<key>-agent/index.ts`를 sales-agent를 틀로 복제 — collect/REPORT_SCHEMA/SYSTEM만 바꾸고 `AGENT` 상수를 key로. 저장·알림·인증 코드는 그대로.
3. 필요한 데이터 액션이 워크스페이스 함수에 없거나 admin 전용이면 그쪽에서 `viaAgent` 허용 범위를 넓힌다.
4. pg_cron 잡 추가. 화면은 `reportHtml`이 agent별로 다르게 그려야 하면 `reports.js`에서 분기.
- **원칙(사용자 결정)**: 에이전트는 **제안만** 한다. 광고 게재·가격 변경·고객 발송 같은 바깥 행동은 자동화하지 않는다.

## 6. 남은 일
- 첫 보고서 2건 확인됨(2026-09-10, 입력 약 4.5K·출력 약 2K 토큰/건). 프롬프트·액션 품질 다듬기 계속.
- 완료 체크는 됨(2026-09-11). 담당 배정·에이전트에게 질문하기(보고서 맥락 + 데이터 재조회)는 아직.
- 2호 완료(2026-09-11). 3호 후보 = 상품 콘텐츠(포토 스튜디오·번역기 연동) 또는 마케팅(Meta·안정재고).

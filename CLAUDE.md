# DNRB 에이전트 — 프로젝트 지침 (CLAUDE.md)

> 다나로브(danarobe) 쇼핑몰의 **매출 성장을 돕는 AI 담당자(에이전트) 그룹** 앱. 비개발자인 사용자에게는 쉬운 한국어로 설명한다.
> 2026-09-10 사용자 결정: 워크스페이스(~/dnrb-dashboard, 1만 2천 줄 단일 파일)가 너무 무거워져 **화면은 이 저장소로 분리**, 데이터 연결·계정은 워크스페이스와 **같은 Supabase 프로젝트를 공유**한다.

## 0. 한눈에 보기
- **소스**: `~/dnrb-agents` — `index.html` 뼈대 + `css/app.css` + `js/`(config·api·agents·reports·app, 기능별 분리) + `supabase/functions/`(**`_shared/agent.ts` 공통 뼈대** + `sales-agent` + `returns-agent` + `strategy-agent`).
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
담당자 함수는 `serveAgent({ agent, label, system, schema, collect })` 한 줄로 끝난다. 뼈대가 하는 일: 인증(관리자 또는 x-cron-secret) → `status`/`collect`/`run`/`write` → 기준일 D 보정 → **run은 2단계(2026-09-13)**: ① 이 함수에서 `collect(D)` → api_cache(`agentrun:…`)에 임시 저장 → ② **별도 함수 `agent-write`**(`?agent=&date=&key=`, x-cron-secret)를 **기다리지 않고** 호출(`EdgeRuntime.waitUntil`)하고 즉시 `{queued:true}` 202 응답 → agent-write가 `writeStage(def, D, key)`: `weekContext` → `writeReport`(claude-opus-5, effort medium, json_schema) → `agent_reports` 저장(report에 week/last_week 덧붙임) → `notifyAdmins(label)`(종 알림 link_menu agents + 웹 푸시). 실패는 error 행. 공용 도우미: `callFn`(x-agent-secret), `rest`(service_role), `safeCollector`(항목별 try/catch → errors[]), `reportSchema({highlights, warnings, actions, extra})`(공통 필드 + 주간 3종 + 담당자별 extra), `COMMON_RULES`(글쓰기 원칙 + 주간 항목 규칙 — 각 SYSTEM 끝에 붙임). 선택 훅: `forLLM(data)`(Claude에 보낼 데이터만 줄임 — 표시용 원자료는 data에 그대로), `postProcess(report, data)`(Claude 판단에 숫자를 코드가 채움), `effort`(기본 medium). **뼈대를 고치면 모든 담당자 함수를 재배포**(배포 시 번들 복사).
- **⚠ 시간·CPU 한도**: 무료 요금제 Edge Function 벽시계 150초 + **요청당 CPU 한도(WORKER_RESOURCE_LIMIT, HTTP 546)**. 상품 전략 담당이 트렌드 수집(TLS 20회)을 더하자 546 → run을 collect/write 2단계로 분리(각 단계가 별도 CPU 한도). 새 담당자도 같은 뼈대라 자동 적용. **자기 함수를 다시 부르는 방식은 같은 worker가 받아 CPU가 합산돼 실패**(실측) → 작성은 `agent-write` 함수(별도 worker). 그리고 **호출자가 100초 넘게 기다리면 게이트웨이가 502 HTML을 돌려줌**(실측) → run은 202로 즉시 응답, 앱은 새 보고서 행이 생길 때까지 10초마다 폴링(`agentRun`, 최대 4분). 담당자 정의는 `<agent>-agent/def.ts`(`export const DEF: AgentDef`), `index.ts`는 `serveAgent(DEF)` 한 줄, `agent-write/index.ts`가 세 def를 import해 agent 이름으로 분기 — **새 담당자를 만들면 agent-write에 한 줄 추가 + 재배포**. 반품 담당 첫 코호트판이 137초까지 갔음 → forLLM(일별 코호트 14행·상품 8개 초과 제외)+postProcess(cohort_table·risk_products 숫자는 코드가 채움, Claude는 판단 문장만)+수집 병렬(사유 7일 먼저→코호트·순반품률·사유 동시)+cohortweeks 8 병렬로 **71초**. 새 담당자도 같은 원칙: 수집 ≤60초, Claude 출력 토큰 ≤5K 목표. 실측 토큰: 반품 입력 12K·출력 5K, 매출 입력 8K·출력 5K.

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
- **수집**(실측 약 45초, 오류 0 — 사유 7일 먼저, 나머지 셋 병렬): ① `cohortweeks&end_date=D&weeks=6&days=14` ①-b `cafe24-claims` 최근 7일 — **사유 분포만**(건수 추세 아님, claim_reasons_last7) ② `returnwatch&end_date=E&top=30&risk=20&min_qty=10&extra=<관리 상품 번호>` — 7/14/30일 창 순반품률(배송완료일 기준, R00~R40) ③ `returnreasons` E−13~E — 상품별 사유 TOP3(40자 절단) ④ `return_watch` 테이블(관리 상품·지정 사유·판매 중단). **판정 기준일 E = D−3**(= 오늘−4일): 반품이 배송완료 후 며칠 뒤 들어와 어제 기준은 절반 이하로 나옴(워크스페이스 반품 관리 메뉴 규칙과 동일).
- **파생**: 등급 = 배송완료 <10 보류 / 순반품률 ≥20 위험 / 10~20 주의 / 그 외 양호. `risk_products`(순위권 상품 중 flagged·위험·주의, 14일 창 순, 12개, 옵션별 14일 위험 옵션(배송 5↑·20%↑)·사유 TOP3·관리 여부), `good_sellers_low_return`(14일 상위 10위 안·양호), `watched_products`(관리 상품 7/14/30 흐름), 상위 30 상품 합산 14일 순반품률.
- **리포트 extra 필드**: `cohort_table[{week, maturity 성숙|집계 중|진행 중, paid, cancel_rate, return_rate, verdict}]`(cohorts.weeks 그대로 + 판단), `risk_products[{name, level 위험|주의, rate_14d, delivered_14d, cause, fix}]`(표), `watch_review[{name, verdict 개선|유지|악화, detail}]`. 프롬프트 규칙: 옵션 집중이면 옵션 문제, 사유별 대응(사이즈→실측·안내 / 색상·소재→사진·설명 / 불량→제작처·검수 / 배송지연→출고), 관리 상품 지정·판매 중단은 사람이(제안만, '대표 확인 후').
- **화면**: 타일 4(최근 성숙 주 취소율·반품률 + 성숙 주 평균, 이번 주 집계 중, 위험·주의 상품 수) → 오늘의 주목/주의 → **결제 주차별 취소·반품률 표(상태 칩·경과일·판단)** → **위험·주의 상품 표(상품·원인 / 판정·수치 / 대응)** + **관리 상품 점검**(개선·유지·악화 칩) → 주간 누적 → 할 일. `rawTableReturns`에 취소반품 표·위험 후보 창별 표.

## 3-2. 상품 전략 담당 (`supabase/functions/strategy-agent`, 에이전트 3호, 2026-09-12)
사용자가 2026-09-12 '상품 콘텐츠 담당' 구상을 전면 수정해 만든 것: **어떤 상품에 힘을 실을지 + 광고 소재·상세 제안**. 일문/영문 번역은 불필요(사용자 지정), 상품 관리 시스템 데이터도 안 씀(입력이 불완전).
- **자동 실행**: pg_cron `strategy-agent-morning`(jobid 4, `30 23 * * *` UTC = **08:30 KST**).
- **수집**(실측 13초, 오류 0): `categorymap` → `category_products(33=NEW ARRIVALS)`·`summary` 14일/7일/직전7일·`benefits`(by_product)·`activeads` 병렬 → `productinfo`(신상품 91개, 할인 없이 1회) → `productinfo&with_discount=1`(신상품 조회 상위 24 + 집중 상품만 — 전부 읽으면 62초) → `adcards`(집중 상품 자기 소재 + 참고 소재, 최근 14일 성과·썸네일·문구). **세일 카테고리는 보지 않는다**(사용자 지정).
- **신상품 4분면(코드가 판정, Claude는 전략 문장만)**: 등록 3일↑·14일 조회 30↑인 상품의 **중앙값**(사용자 선택 — 고정 기준 아님) 기준. 주문율↑조회↓=**노출 부족** / 둘↑=**판매 확대** / 조회↑주문율↓=**상세·가격 점검** / 둘↓=**집중도 낮춤**(광고 없으면 '(광고 미테스트)' 꼬리표 — 노출 탓일 수 있어 테스트 후 판단, 사용자 판단 존중). 등록 3일 미만·조회 30 미만은 보류. 함께 보는 것: 마진율 = (판매가−공급가×1.1)÷판매가, 할인가(discountprice), 혜택(1+1=수량할인·기간할인, benefits by_product), 품절, 활성 광고 수.
- **집중 상품 6개 = 급상승 3(7일 vs 직전 7일, 매출 담당과 같은 규칙) + TOP10(14일 결제수량) 3 — TOP10은 최근 4개 보고서에서 다룬 상품을 뒤로 미루는 순환**(며칠에 걸쳐 10개 전부). 상품별: 자기 활성 광고(지출 상위 4, 누적 since_start + 최근 14일 last14: 지출·구매·ROAS·CTR·빈도·문구·영상 여부) + **같은 카테고리(카테고리 지도의 가장 깊은 일반 카테고리) 상위 판매 3상품의 우수 소재**(지출 10만↑ 중 ROAS 상위 2). 광고↔상품 매칭은 워크스페이스 판매 성과 `pa*` 규칙 이식(paKey/paVerTok/paJamo/paGroups/paPickBest) + **우세 규칙(2026-09-12)**: 기본판(ver 없음)이 여럿인 핵심명은 14일 판매량 70%↑인 상품을 우세로 보고 광고를 배정(카페24에서 삭제된 옛 상품 1393 '세러데이 나그랑 티셔츠 (2 colors)'가 애널리틱스 이력에 남아 현행 2447과 핵심명이 겹쳐 광고 11개가 어디에도 안 붙던 사례 — 첫 보고서가 '광고 0개'로 오판).
- **이미지**: 집중 상품 자기 최상위 소재 1장씩 + 참고 소재 최대 6장(총 12장 이내)을 **함수가 내려받아 base64로** Claude에 첨부(`agent.ts writeReport`의 images — Meta CDN은 robots.txt로 막혀 URL 블록은 'disallowed by robots.txt' 400, 실사례). Claude가 썸네일을 보고 소재 특성을 뽑는다.
- **리포트 extra**: `matrix[{name, strategy≤40자}]`(postProcess가 판정·조회·주문율·마진·할인가·행사·등록일·광고 수 채움), `focus[{name, driver, creative_plan, reels_hooks[3], detail_focus, plan}]`(postProcess가 why·수치·own_ads·reference_ads 채움). 프롬프트 원칙: 판정을 바꾸지 말 것, 마진 35% 미만은 우선순위↓, 빈도 3↑=소재 피로, 훅 멘트는 실제 특징·광고 문구 근거(과장 금지), 예산 확대는 '대표 확인 후'.
- **실측(2026-09-12)**: 94~109초, 입력 약 40K(이미지 포함)·출력 약 6.5K 토큰, 건당 약 500원. **WORKER_RESOURCE_LIMIT(546) 실사례**: 600px 썸네일 12장을 문자열 base64로 바꾸다 자원 초과 → adcards 썸네일 320px + `jsr:@std/encoding` encodeBase64 + 최대 10장·장당 400KB로 해결. 헤드라인 "세러데이 나그랑 638개 팔리는데 광고 0개"처럼 광고 미집행 상품을 잡아냄.
- **화면**: 타일 4(신상품 수·판정 기준, 판매 확대·노출 부족 수, 점검·낮춤 수, 집중 상품 수·행사 수) → **4분면 표**(판정 배지 4색·조회/주문율/판매·마진/할인가·행사 칩·전략) → **집중 상품 카드**(자기 소재 목록(썸네일·성과·문구)+견인 소재 / 참고 소재+추가 컨셉 / 릴스 훅 3·상세 강조·판매 계획) → 주간·할 일. `rawTableStrategy`에 신상품 전체·TOP10.
- **트렌드·날씨(2026-09-13, 사용자 아이디어)** — `_shared/trends.ts`: ① **네이버 데이터랩 쇼핑인사이트 '분야별 인기 검색어'**(패션의류 50000000·패션잡화 50000001, 여성) 어제 상위 100 vs 7일 전 → `risingKeywords`(100위 안 새 진입 or 15계단↑). **정해 둔 키워드 목록이 아니라 순위표를 받아 새 유행을 자동 발견**(사용자 지적 반영). 공식 API 아님(화면 내부 통로 `getCategoryKeywordRank.naver`, 20개/페이지·5페이지). ⚠ **한 연결로 7~8번째 요청부터 응답이 멈춤**(엣지 실측: 8번째 타임아웃, 병렬도 동일; 5개 후 3초 쉬거나 새 연결이면 통과) → 호출(5페이지)마다 `Deno.createHttpClient` 새 연결 + 모듈 큐로 직렬화 + 300ms 간격, 다른 수집보다 **먼저 혼자** 실행(약 5초). ② 날씨 Open-Meteo 서울 지난 7일+앞 7일(최저 15°/10° 첫날, 비 오는 날). ③ `matchKeyword`: 키워드↔우리 상품(이름·카테고리, 영문 카테고리 동의어표 SYN, '여성/가을' 접두 제거, 품목 단어 2개면 둘 다 있어야). **미지원**: 우리 몰 내부 검색어(카페24 애널리틱스에 통로 없음, 404 실측), 무신사·지그재그·에이블리(공개 통로 없음, 400/404 실측). 리포트 extra `trend_actions[{keyword, signal, our_products, suggestion}]`(브랜드 제외, 최대 6)·`weather_plan`. 화면: 14일 날씨 띠 + 카테고리별 급상승 키워드 칩(우리 상품 있으면 색칠·개수, 툴팁 상품명) + 키워드 제안.
- **다음(2단계, 사용자 확인 후)**: 상세페이지 내용 점검 — 다나로브 상세는 글자가 전부 세로 1만px 이미지 안이라 잘라서 봐야 함(이미지 슬라이서 필요).

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
- 3호 완료(2026-09-12). 4호 후보 = 마케팅(주간 광고 예산 배분·소재 테스트 계획) 또는 고객 응대. 3호 2단계 = 상세페이지 이미지 판독.

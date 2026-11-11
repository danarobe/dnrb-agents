// ═══════════════════════════════════════════════
// agent-tasks (2026-11-07, 사용자 승인 "추천하는 순서대로 해줘") — 직원용 '오늘 할 일' 보드 + 대표 결정함
//   배경(평가 결과): 매일 보고서 4개가 할 일을 하루 약 24개 냈지만 완료 체크는 누적 3건·완료 0건, 같은 일이 보고서 3곳에 다른 문장으로 반복,
//   광고 할 일 대부분이 '대표 확인 후'에 막혀 며칠째 반복(르 플리츠 광고 착수 11/2~). → 할 일을 한 화면에 모으고, 대표 승인 창구를 만들고, 완료는 데이터로 자동 확인.
//
//   sync (cron·보고서 저장 직후·관리자) ─ 담당자 4명(반품·전략·광고 운영·요약)의 최신 보고서 week_actions를 상품 1개 × 할 일 1개로 쪼개고
//        같은 일(종류|상품번호)은 하나로 합쳐 team_tasks에 반영. 2일 연속 어느 보고서에도 없으면 dropped(에이전트가 더는 제안 안 함).
//        자동 완료: 광고 착수 = 그 상품 ON 광고 수가 처음보다 늘면 / 광고 줄이기 = 줄면 / 상세 보강 = 상세 이미지 해시가 바뀌면.
//        &auto=1(아침 cron만): 상세페이지 점검 요청이 서로 다른 날 2번 이상 쌓인 상품은 상세 점검 담당을 자동 실행(하루 2개, 14일 안에 점검한 상품 제외, 크레딧 부족이면 건너뜀).
//   list (에이전트 사용자) ─ 보드 / done (에이전트 사용자) ─ 완료·되돌리기 / decide (관리자 = 대표) ─ 승인·보류·되돌리기
//   2차(2026-11-07, 사용자 "주말엔 직원만 쉬고 대표는 대부분 본다"): 직원 일은 출근일(토·일·wm_holidays 제외)로 기한·며칠째를 센다.
//     기한 없는 직원 일 = 기준일+3 출근일. 에이전트가 빠뜨린 일은 내리지 않고 stale_since만 찍어 사람이 완료·닫기(close)할 때까지 남긴다.
//     close (에이전트 사용자; 대표 승인 대기 일은 관리자만) ─ '필요 없음'으로 닫기 / postpone (관리자) ─ 다음 출근일로 미루기.
//     아침 cron(auto=1)이 알림: 대표(관리자)는 매일 '결정 대기 n개'(주말 마감 직원 일 포함), 직원(agent_users 알림 켠 비관리자)은 출근일에만 '오늘 할 일 n개'.
//   보고서 쪽: _shared/agent.ts weekContext가 team_board(open·done_7d·held)를 담당자에게 주고, 끝났거나 보류된 일은 그 담당자 할 일에서 뺀다.
//   4차(2026-11-10, 사용자 "개선 제안 4개 다 해줘 + 종류별로 따로 보기"):
//     ① 대표가 승인하면 담당 팀 직원에게 바로 알림(5분 안에 또 승인하면 묶어서 10분마다 flush · 근무 시간 9~19시·팀 출근일에만, 아니면 다음 아침 알림에 같이)
//     ② 승인할 때 방식·하루 예산(decision_detail) — 직원 화면과 다음 날 보고서(team_board)에 그대로
//     ③ list가 광고 일의 상품별 광고 상태(ON·꺼진 광고 목록·30일 성과, 광고 운영 담당 최신 보고서)와 최근 제작안을 같이 준다 — 카드의 '꺼진 광고 보기'·'제작안'
//     ④ 광고 줄이기 전부 + 꺼진 광고를 기존 예산 안에서 다시 켜기(reenable)는 대표 승인 없이 담당 팀으로 바로
// ═══════════════════════════════════════════════
import { handleOptions, json, verifyAuthToken } from "../_shared/util.ts";
import { addDays, addWorkdays, AGENT_LABELS, normOwner, callFn, canUseAgents, isCronRequest, isOffDay, isStaffOwner, loadTeamCal, nextWorkday, notifyUsers, prevWorkday, rest, Row, seoulToday, TASK_KINDS, teamOfRole, TeamCal } from "../_shared/agent.ts";
import { paGroups, paKey, paNorm, PaProd, paPickBest, paVerTok } from "../strategy-agent/def.ts";

const SOURCES = ["returns", "strategy", "ads", "sales"];   // 같은 일이 여럿이면 앞 담당(원래 제안자)의 문장을 쓴다 — 요약은 옮겨 적은 것이라 마지막
const AUTO_KINDS = new Set(["광고 착수", "광고 줄이기", "상세 보강"]);
const sq = (s: unknown) => String(s ?? "").normalize("NFC").replace(/\s+/g, "");
const kstDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const CEO_RE = /\s*[(,·]?\s*(?:예산은\s*)?대표\s*(?:확인|승인|결정)\s*(?:후|필요)?\s*\)?/g;
const cleanTitle = (t: unknown) => {
  let s = String(t ?? "").replace(/\(\s*(?:예산은\s*)?대표\s*(?:확인|승인|결정)\s*(?:후|필요)?\s*,\s*/g, "(").replace(CEO_RE, "").replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").trim();
  if ((s.match(/\(/g) ?? []).length > (s.match(/\)/g) ?? []).length) s += ")";   // '(할인 11/7 종료 전, 대표 확인 후)'에서 뒷부분만 빠진 경우
  return s;
};
function guessKind(t: string): string {   // 옛 보고서(종류 칸이 없던 때)용
  if (/금지|유지$|보류 유지|보류$|하지 않/.test(t) && !/착수|켜기|보강|점검/.test(t)) return "지킬 원칙";
  if (/광고|소재|test|테스트/.test(t) && /착수|켜기|다시 켜|시작|첫 소재/.test(t)) return "광고 착수";
  if (/메인|기획전|배치|진열/.test(t)) return "노출·기획전";
  if (/상세|실측|사이즈 안내|기장|사진|컷/.test(t)) return "상세 보강";
  if (/증액|예산.*(이동|늘|배)|확대/.test(t)) return "광고 증액";
  if (/광고|소재|test/.test(t) && /끄|줄이|정리|중단/.test(t)) return "광고 줄이기";
  if (/노출/.test(t)) return "노출·기획전";
  if (/출고|배송|포장|라벨|오배송|CS|문의/.test(t)) return "CS·출고";
  if (/재고|재입고|소싱|입고|발주/.test(t)) return "재고·소싱";
  if (/할인|가격|쿠폰|1\+1|혜택/.test(t)) return "가격·혜택";
  return "기타";
}
// 승인할 때 대표가 고르는 방식(직원 화면·보고서에 같은 말로)
// 2026-11-11 사용자: '새 소재로 테스트' → '소재 공급 필요', '방식은 담당 판단' → '담당 부서 판단' (코드는 그대로)
const METHODS: Record<string, string> = { new: "소재 공급 필요", reuse: "기존 소재·꺼진 광고 다시 켜기", raise: "지금 광고 예산 늘리기", add: "소재 추가해 늘리기", free: "담당 부서 판단" };
const manwon = (w: number) => { const m = w / 10000; return `${Number.isInteger(m) ? m : m.toFixed(1)}만원`; };
const detailText = (d: unknown) => {
  const x = (d ?? {}) as Row; const parts: string[] = [];
  if (x.method && METHODS[String(x.method)] && x.method !== "free") parts.push(METHODS[String(x.method)]);
  if (Number(x.daily_won) > 0) parts.push(`하루 ${manwon(Number(x.daily_won))}`);
  return parts.join(" · ");
};
const shortName = (n: unknown) => String(n ?? "").replace(/^\s*(?:[\[(][^\])]*[\])]\s*)+/, "").replace(/\s*-\s*Danarobe\s*$/i, "").replace(/\s*\([^)]*colou?rs?[^)]*\)\s*$/i, "").trim().slice(0, 24);

// 광고 운영 담당 최신 보고서의 상품별 광고 상태 — 다시 켜기 판정과 카드의 '꺼진 광고 보기'
function adsInfoOf(products: Row[], decisions: Row[], repId: unknown, repDate: unknown): Map<number, Row> {
  if (!Array.isArray(products)) products = [];
  if (!Array.isArray(decisions)) decisions = [];
  const dec = new Map(decisions.map((d) => [sq(d.product), String(d.kind ?? "")]));
  const m = new Map<number, Row>();
  for (const p of products) {
    const no = Number(p.product_no); if (!(no > 0)) continue;
    m.set(no, { verdict: dec.get(sq(p.name)) || String(p.hint ?? ""), active_ads: p.active_ads ?? null, paused_ads: p.paused_ads ?? null,
      ad_7d: p.ad_7d ?? null, paused_30d: p.paused_30d ?? null, paused_list: ((p.paused_list ?? []) as Row[]).slice(0, 5), report_id: repId, report_date: repDate });
  }
  return m;
}
const adsInfoFromReports = (reports: Row[]) => {
  const rep = reports.find((r) => r.agent === "ads");
  return rep ? adsInfoOf(((((rep.data ?? {}) as Row).products ?? []) as Row[]), ((((rep.report ?? {}) as Row).decisions ?? []) as Row[]), rep.id, rep.report_date) : new Map<number, Row>();
};
// 대표 승인 없이 담당 팀이 바로 하는 광고 일(2026-11-10 사용자 승인): 광고 줄이기 전부, 꺼진 광고를 기존 예산 안에서 다시 켜기.
//   다시 켜기 = 광고 착수 중 그 상품 ON 광고 0개·꺼진 광고 1개 이상이고, 광고 운영 담당 판단이 '다시 켜기'이거나 제목이 다시 켜기만 말할 때.
const NO_CEO_KINDS = new Set(["광고 줄이기"]);
function isReenable(kind: string, no: number | null, rawTitle: string, info: Row | undefined): boolean {
  if (kind !== "광고 착수" || !no || !info) return false;
  if (Number(info.active_ads) !== 0 || info.active_ads == null || !(Number(info.paused_ads) > 0)) return false;
  return info.verdict === "다시 켜기" || (/다시\s*켜|재가동/.test(rawTitle) && !/착수|시작|첫\s*소재|새\s*소재/.test(rawTitle));
}
const DONE_WHEN: Record<string, string> = { "광고 착수": "그 상품 ON 광고가 늘면 자동 완료", "광고 줄이기": "그 상품 ON 광고가 줄면 자동 완료", "상세 보강": "상세 이미지가 바뀌면 자동 완료" };

type Item = { key: string; kind: string; title: string; owner: string; why: string; done_when: string; due: string; due_source: string; needs_ceo: boolean; reenable: boolean; product_no: number | null; product_name: string | null; sources: Row[]; first_seen: string; last_seen: string };

async function latestReports(): Promise<Row[]> {
  const r = await rest(`agent_reports?agent=in.(${SOURCES.join(",")})&status=eq.ok&report_date=gte.${addDays(seoulToday(), -5)}&select=id,agent,report_date,report,data,created_at&order=report_date.desc,created_at.desc&limit=40`);
  const rows: Row[] = r.ok ? await r.json() : [];
  const seen = new Set<string>(), out: Row[] = [];
  for (const row of rows) if (!seen.has(String(row.agent))) { seen.add(String(row.agent)); out.push(row); }
  return out.sort((a, b) => SOURCES.indexOf(String(a.agent)) - SOURCES.indexOf(String(b.agent)));
}

// 상품 번호 없이 이름만 온 할 일은 다른 보고서·데이터에서 같은 이름의 번호를 찾아 붙인다 — 같은 상품이 '번호 있는 줄'·'이름만 있는 줄'로 두 번 생기지 않게(2026-11-10)
//   같은 이름에 번호가 둘 이상이면(재등록 상품 등) 붙이지 않는다(-1) — 엉뚱한 상품으로 합치지 않게
function nameIndex(reports: Row[], rows: Row[]): Map<string, number> {
  const m = new Map<string, number>();
  const add = (name: unknown, no: unknown) => { const k = sq(paKey(String(name ?? ""))); const n = Number(no); if (k.length < 3 || !(n > 0)) return; const cur = m.get(k); if (cur == null) m.set(k, n); else if (cur !== n) m.set(k, -1); };
  for (const t of rows) add(t.product_name, t.product_no);
  for (const rep of reports) {
    const arr = (v: unknown) => (Array.isArray(v) ? v : []) as Row[];
    for (const a of arr(((rep.report ?? {}) as Row).week_actions)) for (const r of arr(a.product_refs)) add(r.name, r.no);
    for (const p of arr(((rep.data ?? {}) as Row).products)) add(p.name, p.product_no);
  }
  for (const [k, v] of m) if (v < 0) m.delete(k);
  return m;
}
// 한 문장에 여러 상품의 일이 섞인 제목(예: '우디 나그랑 니트 광고 착수·헤이 나그랑 원피스 광고 다시 켜기')을 상품별로 나눈다(2026-11-10 사용자 지적).
//   '·'/','로 끊은 조각마다 언급된 상품을 찾고(상품명 앞 두 단어), 상품이 없는 조각은 앞 상품 것으로 본다. 그 상품 조각에서 상품명 단어를 빼면 할 일만 남는다
//   (상품명은 카드에 굵게 따로 나오므로). 조각이 상품명뿐이면('르 플리츠 니트 스커트·레이브 … 광고 착수') 마지막 조각의 할 일을 쓴다.
const nameWords = (n: unknown) => paKey(String(n ?? "")).split(/\s+/).filter(Boolean);
const mentionKey = (ws: string[]) => (ws.length >= 2 ? ws.slice(0, 2).join("") : (ws[0]?.length >= 3 ? ws[0] : ""));
// 제목엔 줄임말도 온다('슬리즈 R1') — 첫 단어가 3자 이상이면 그것만으로도 언급으로 본다
const mentionKeys = (ws: string[]) => [mentionKey(ws), ...(ws.length >= 2 && ws[0].length >= 3 ? [ws[0]] : [])].filter(Boolean);
const findMention = (flat: string, ws: string[]) => { let at = -1; for (const k of mentionKeys(ws)) { const i = flat.indexOf(k); if (i >= 0 && (at < 0 || i < at)) at = i; } return at; };
// 제목 앞머리의 내 상품명은 뺀다(카드에 상품명이 굵게 따로 나옴) — 다 빼면 비면 그대로
function dropOwnName(title: string, target: string): string {
  const ws = nameWords(target), ks = mentionKeys(ws);
  if (!ks.length || !ks.some((k) => sq(title).startsWith(k))) return title;
  const words = title.split(/\s+/), set = new Set(ws); let j = 0;
  while (j < words.length && set.has(words[j])) j++;
  const rest = words.slice(j).join(" ").trim();
  return rest.length >= 2 ? rest : title;
}
function splitTitle(title: string, target: string, known: string[][]): string {
  const segs = title.split(/\s*[·,]\s*/).filter(Boolean);
  if (segs.length < 2) return dropOwnName(title, target);
  const tw = nameWords(target), tk = mentionKey(tw);
  if (!tk) return title;
  const cands = [tw, ...known.filter((w) => mentionKey(w) && mentionKey(w) !== tk)];
  const owner: (string[] | null)[] = []; let cur: string[] | null = null;
  for (const sg of segs) {
    const flat = sq(sg);
    let hit: string[] | null = null, at = 1e9;
    for (const w of cands) { const i = findMention(flat, w); if (i >= 0 && i < at) { at = i; hit = w; } }
    if (hit) cur = hit;
    owner.push(cur);
  }
  if (new Set(owner.filter(Boolean).map((w) => mentionKey(w!))).size < 2) return title;   // 다른 상품이 안 섞였으면 그대로
  const strip = (sg: string, w: string[]) => {
    const words = sg.split(/\s+/), set = new Set(w);
    const ks = mentionKeys(w); let i = 0;
    for (; i < words.length; i++) { const rest = sq(words.slice(i).join("")); if (ks.some((k) => rest.startsWith(k))) break; }
    if (i >= words.length) return sg.trim();
    let j = i; while (j < words.length && set.has(words[j])) j++;
    return [...words.slice(0, i), ...words.slice(j)].join(" ").trim();
  };
  const mine = segs.map((sg, i) => ({ sg, w: owner[i] })).filter((x) => x.w && mentionKey(x.w) === tk).map((x) => strip(x.sg, tw)).filter(Boolean);
  // 내 조각에 동사가 없으면(예: '슬리즈 R1 착용컷·더블 빅카라 R1 예산 축소 검토') 마지막 조각의 할 일을 함께 쓴다
  const lw = owner[owner.length - 1];
  const tail = (lw ? strip(segs[segs.length - 1], lw) : "").split(/\s+/).filter((x, i, arr) => !(i < arr.length - 1 && /^(?:[A-Za-z]{1,3}\d+[\w-]*|test)$/i.test(x) && arr.slice(0, i).every((y) => /^(?:[A-Za-z]{1,3}\d+[\w-]*|test)$/i.test(y)))).join(" ");
  const ACT = /착수|켜|끄|중단|확대|증액|축소|줄이|줄여|검토|보강|추가|이동|정리|교체|시작|유지|금지|점검|배치|노출|할인|올리|내리|확인/;
  if (mine.length) { const m = mine.join("·"); return ACT.test(m) || !tail ? m : `${m} ${tail}`; }
  return tail || title;
}
function collectItems(reports: Row[], cal: TeamCal, names: Map<string, number>, known: string[][]): Map<string, Item> {
  const items = new Map<string, Item>();
  const adsInfo = adsInfoFromReports(reports);
  for (const rep of reports) {
    const agent = String(rep.agent), label = AGENT_LABELS[agent], D = String(rep.report_date);
    for (const a of ((((rep.report ?? {}) as Row).week_actions ?? []) as Row[])) {
      const refs0 = ((a.product_refs ?? []) as Row[]);
      const refs = refs0.length ? refs0 : ((a.products ?? []) as string[]).map((n) => ({ name: n, no: null }));
      // 요약 담당이 동료 할 일을 옮겨 적은 것(상품 없음)은 원래 담당 것으로 충분 — 문장만 달라 중복으로 보이므로 뺀다
      if (agent === "sales" && a.source && String(a.source) !== label && !refs.length) continue;
      const rawTitle = String(a.title ?? "");
      let kind = TASK_KINDS.includes(String(a.kind)) ? String(a.kind) : guessKind(rawTitle);
      if (kind === "기타" && /광고|소재/.test(rawTitle) && /다시\s*켜|재가동/.test(rawTitle)) kind = "광고 착수";   // 다시 켜기를 '기타'로 쓴 경우(2026-11-11)
      const title = cleanTitle(rawTitle);
      if (!title) continue;
      const owner = normOwner(a.owner);   // 옛 보고서의 'CS팀'도 '물류/CS팀'으로
      const given = /^\d{4}-\d{2}-\d{2}$/.test(String(a.due ?? ""));
      // 기한이 없으면: 직원 일은 그 팀의 기준일+3 출근일(주말·공휴일·팀 전원 휴가 제외), 대표 일은 +3일
      const base0 = /^\d{4}-\d{2}-\d{2}$/.test(String(a.since ?? "")) ? String(a.since) : D;
      const due = given ? String(a.due) : (isStaffOwner(owner) ? addWorkdays(base0, 3, cal.offFor(owner)) : addDays(base0, 3));
      const base = {
        kind, title, owner, why: String(a.why ?? ""), done_when: String(a.done_when ?? "") || (DONE_WHEN[kind] ?? ""), due, due_source: given ? "agent" : "default",
        needs_ceo: a.needs_ceo === true || /대표\s*(확인|승인|결정)/.test(rawTitle),
        first_seen: /^\d{4}-\d{2}-\d{2}$/.test(String(a.since ?? "")) ? String(a.since) : D, last_seen: D,
      };
      const src = { agent, report_date: D, action_id: String(a.id ?? ""), why: String(a.why ?? "").slice(0, 160) };
      const targets = refs.length ? refs.map((r) => ({ no: Number(r.no) > 0 ? Number(r.no) : (names.get(sq(paKey(String(r.name ?? "")))) ?? null), name: String(r.name ?? "") })) : [{ no: null, name: "" }];
      for (const t of targets) {
        const ttl = t.name ? splitTitle(title, t.name, known) : title;
        const rawT = t.name ? splitTitle(rawTitle, t.name, known) : rawTitle;
        // 상품이 없는 일은 담당자가 날마다 유지하는 할 일 id로 묶는다(문장이 조금 바뀌어도 같은 일 — 대표 승인이 날아가지 않게)
        const key = t.name || t.no ? `${kind}|${t.no ?? "n:" + sq(paKey(t.name))}` : (a.id ? `${kind}|a:${agent}:${String(a.id)}` : `${kind}|t:${sq(title).slice(0, 30)}`);
        const re = isReenable(kind, t.no, rawT, t.no ? adsInfo.get(t.no) : undefined);
        const free = re || NO_CEO_KINDS.has(kind);
        const cur = items.get(key);
        if (!cur) { items.set(key, { key, ...base, title: ttl, needs_ceo: free ? false : base.needs_ceo, reenable: re, product_no: t.no, product_name: t.name || null, sources: [src] }); continue; }
        cur.sources.push(src);
        cur.reenable = cur.reenable || re;
        cur.needs_ceo = cur.reenable || NO_CEO_KINDS.has(kind) ? false : (cur.needs_ceo || base.needs_ceo);
        if (base.due < cur.due) { cur.due = base.due; cur.due_source = base.due_source; }
        if (base.first_seen < cur.first_seen) cur.first_seen = base.first_seen;
        if (base.last_seen > cur.last_seen) cur.last_seen = base.last_seen;
      }
    }
  }
  return items;
}

// ── 자동 완료 판정 재료 ──
async function adCounter(reports: Row[], extra: { no: number; name: string }[]) {
  const act = await callFn("meta-ads", { action: "activeads" }).catch(() => null);
  const ads = ((act as Row | null)?.ads ?? null) as Row[] | null;
  if (!ads) return null;
  const adsRep = reports.find((r) => r.agent === "ads");
  const list = ((((adsRep?.data ?? {}) as Row).products ?? []) as Row[]).map((p) => ({ no: Number(p.product_no), name: String(p.name ?? ""), qty: Number(p.qty_14d ?? 0) }));
  for (const e of extra) if (!list.some((p) => p.no === e.no)) list.push({ no: e.no, name: e.name, qty: 0 });
  const prods: PaProd[] = list.filter((p) => p.no > 0 && p.name).map((p) => ({ no: p.no, name: p.name, key: paNorm(paKey(p.name)), ver: paVerTok(p.name) ? paNorm(paVerTok(p.name)!) : null, qty: p.qty })).filter((p) => p.key.length >= 3);
  const groups = paGroups(prods);
  const count = new Map<number, number>();
  for (const a of ads) { const best = paPickBest(paNorm(String(a.ad_name ?? "")), prods, groups); if (best) count.set(best.no, (count.get(best.no) ?? 0) + 1); }
  return (no: number) => count.get(no) ?? 0;
}
// 광고 착수 상품의 기존 광고 이력(2026-11-11 사용자 요청): 지금 켜진 광고 + 최근 90일 안에 꺼진 광고를 상품에 맞추고(광고명 → 상품, 자동 완료와 같은 매칭),
//   광고마다 최근 90일 '지출이 있던 날' 수를 센다 → 5일 이상 돈 광고(검증된 소재)가 몇 개고 그중 지금 꺼진 게 몇 개인지.
const PROVEN_DAYS = 5, HIST_DAYS = 90;
async function fillAdHistory(tasks: Row[], reports: Row[], now: string): Promise<Row> {
  const ts = tasks.filter((t) => ["open", "held"].includes(String(t.status)) && t.kind === "광고 착수" && Number(t.product_no) > 0);
  if (!ts.length) return { skipped: "광고 착수 상품 없음" };
  const [act, pau] = await Promise.all([callFn("meta-ads", { action: "activeads" }).catch(() => null), callFn("meta-ads", { action: "pausedads" }).catch(() => null)]);
  const actAds = (act as Row | null)?.ads, pauAds = (pau as Row | null)?.ads;
  if (!Array.isArray(actAds) || !Array.isArray(pauAds)) return { skipped: "Meta 광고 목록을 못 받음 — 다음 동기화 때 다시" };
  // 매칭 후보 = 광고 운영·상품 전략 보고서 상품 + 보드 상품 전부(비슷한 이름의 다른 상품 광고가 엉뚱하게 붙지 않게 넓게)
  //   같은 이름의 상품이 둘이면(예: 텀블 워밍 밴딩 팬츠 2527·옛 181) 판매가 압도적인 쪽에 붙인다 — 판매량(보고서 14일·보드 7일)을 같이 넣어야 '우세' 판정이 된다
  const pool = new Map<number, string>(), qty = new Map<number, number>();
  const seeQty = (no: number, q: unknown) => { const n = Number(q) || 0; if (n > (qty.get(no) ?? 0)) qty.set(no, n); };
  for (const r of reports) { const d = (r.data ?? {}) as Row; for (const arr of [d.products, ((d.new_arrivals ?? {}) as Row).matrix, d.surge_top10]) if (Array.isArray(arr)) for (const p of arr as Row[]) { const no = Number(p.product_no); if (!(no > 0) || !p.name) continue; if (!pool.has(no)) pool.set(no, String(p.name)); seeQty(no, p.qty_14d ?? p.qty_7d); } }
  for (const t of tasks) { const no = Number(t.product_no); if (!(no > 0) || !t.product_name) continue; if (!pool.has(no)) pool.set(no, String(t.product_name)); seeQty(no, ((t.sales_7d ?? {}) as Row).qty_7d); }
  const prods: PaProd[] = [...pool.entries()].map(([no, name]) => ({ no, name, key: paNorm(paKey(name)), ver: paVerTok(name) ? paNorm(paVerTok(name)!) : null, qty: qty.get(no) ?? 0 })).filter((p) => p.key.length >= 3);
  const groups = paGroups(prods);
  const want = new Set(ts.map((t) => Number(t.product_no)));
  const byNo = new Map<number, { id: string; name: string; on: boolean; status: string }[]>();
  const add = (a: Row, on: boolean) => { const best = paPickBest(paNorm(String(a.ad_name ?? "")), prods, groups); if (!best || !want.has(best.no) || !a.ad_id) return; (byNo.get(best.no) ?? byNo.set(best.no, []).get(best.no)!).push({ id: String(a.ad_id), name: String(a.ad_name ?? "").normalize("NFC"), on, status: on ? "ACTIVE" : String(a.effective_status ?? "") }); };
  for (const a of actAds as Row[]) add(a, true);
  for (const a of pauAds as Row[]) add(a, false);
  const y = addDays(seoulToday(), -1), since = addDays(y, -(HIST_DAYS - 1));
  const allIds = [...new Set([...byNo.values()].flat().map((a) => a.id))];
  const hist = new Map<string, Row>();
  for (let i = 0; i < allIds.length; i += 60) {
    const h = await callFn("meta-ads", { action: "adhistory", ad_ids: allIds.slice(i, i + 60).join(","), start_date: since, end_date: y }).catch(() => null);
    if (!h || !Array.isArray((h as Row).ads)) return { skipped: "Meta 광고 이력을 못 받음 — 다음 동기화 때 다시" };
    for (const a of (h as Row).ads as Row[]) hist.set(String(a.ad_id), a);
  }
  let patched = 0;
  for (const t of ts) {
    const ads = (byNo.get(Number(t.product_no)) ?? []).map((a) => { const h = hist.get(a.id); return { ...a, days: Number(h?.days ?? 0), spend: Number(h?.spend ?? 0), value: Number(h?.purchase_value ?? 0), purchases: Number(h?.purchases ?? 0), last: h?.last ?? null }; });
    const proven = ads.filter((a) => a.days >= PROVEN_DAYS), off = proven.filter((a) => !a.on);
    const sp = off.reduce((x, a) => x + a.spend, 0), val = off.reduce((x, a) => x + a.value, 0);
    const v = {
      through: y, days: HIST_DAYS, proven_days: PROVEN_DAYS,
      active: ads.filter((a) => a.on).length, proven: proven.length, proven_on: proven.length - off.length, proven_off: off.length,
      proven_off_roas: sp > 0 ? Math.round(val / sp * 100) / 100 : null, proven_off_spend: Math.round(sp),
      short: ads.filter((a) => a.days > 0 && a.days < PROVEN_DAYS).length, never: ads.filter((a) => a.days === 0).length,
      list: [...proven].sort((a, b) => b.spend - a.spend).slice(0, 6).map((a) => ({ name: a.name.slice(0, 80), on: a.on, status: a.status, days: a.days, spend: Math.round(a.spend), roas: a.spend > 0 ? Math.round(a.value / a.spend * 100) / 100 : null, purchases: a.purchases, last: a.last })),
    };
    const cur = t.ad_hist ? JSON.stringify({ ...(t.ad_hist as Row) }) : "";
    if (cur === JSON.stringify(v)) continue;
    await rest(`team_tasks?id=eq.${t.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ad_hist: v, updated_at: now }) });
    patched++;
  }
  return { through: y, products: ts.length, ads: allIds.length, patched };
}
const descHash = async (no: number): Promise<string | null> => {
  const pd = await callFn("cafe24-analytics", { action: "productdesc", product_no: String(no) }).catch(() => null);
  return pd && (pd as Row).desc_hash ? String((pd as Row).desc_hash) : null;
};

async function sync(auto: boolean) {
  const reports = await latestReports();
  if (!reports.length) return { ok: true, note: "최근 보고서 없음" };
  const D = reports.map((r) => String(r.report_date)).sort().pop()!;
  const cal = await loadTeamCal(addDays(D, -40), addDays(D, 40));
  const lr = await rest(`team_tasks?or=(status.in.(open,held),done_at.gte.${addDays(D, -7)}T00:00:00Z,and(done_how.eq.skip,skip_until.gte.${addDays(D, -7)}))&select=*`);
  const existing: Row[] = lr.ok ? await lr.json() : [];
  const names = nameIndex(reports, existing);
  const known = [...new Set([...existing.map((t) => String(t.product_name ?? "")), ...reports.flatMap((r) => (Array.isArray(((r.data ?? {}) as Row).products) ? (((r.data as Row).products) as Row[]).map((p) => String(p.name ?? "")) : []))].filter(Boolean))].map(nameWords).filter((w) => w.length);
  const items = collectItems(reports, cal, names, known);
  // 이름이 똑같은 다른 상품 번호(옛 등록·재등록, 예: 텀블 워밍 밴딩 팬츠 2527·181)로 같은 일이 두 줄 생기면 판매가 많은 쪽만 남긴다(2026-11-11)
  const sold = new Map<number, number>();
  for (const t of existing) { const q = Number(((t.sales_7d ?? {}) as Row).qty_7d); if (Number(t.product_no) > 0 && q >= 0) sold.set(Number(t.product_no), Math.max(sold.get(Number(t.product_no)) ?? 0, q)); }
  for (const r of reports) { const d = (r.data ?? {}) as Row; for (const arr of [d.products, ((d.new_arrivals ?? {}) as Row).matrix]) if (Array.isArray(arr)) for (const p of arr as Row[]) { const no = Number(p.product_no); if (no > 0 && !sold.has(no) && p.qty_14d != null) sold.set(no, Number(p.qty_14d) / 2); } }
  const dupKeys = new Set<string>();
  const byKN = new Map<string, Item[]>();
  for (const it of items.values()) if (it.product_no && it.product_name) { const k = `${it.kind}|${sq(paKey(it.product_name))}`; (byKN.get(k) ?? byKN.set(k, []).get(k)!).push(it); }
  for (const g of byKN.values()) {
    if (new Set(g.map((x) => x.product_no)).size < 2) continue;
    const best = [...g].sort((a, b) => (sold.get(b.product_no!) ?? -1) - (sold.get(a.product_no!) ?? -1))[0];
    if (!(sold.get(best.product_no!) ?? 0)) continue;   // 판매로 가를 수 없으면 둘 다 둔다
    for (const x of g) if (x.product_no !== best.product_no) { items.delete(x.key); dupKeys.add(x.key); }
  }
  const live = new Map(existing.filter((t) => ["open", "held"].includes(String(t.status))).map((t) => [String(t.task_key), t]));
  const recentDone = new Set(existing.filter((t) => (t.status === "done" || t.status === "closed") && t.done_how !== "skip" && String(t.done_at ?? "") >= addDays(D, -7)).map((t) => String(t.task_key)));
  // 미진행(2026-11-11 사용자 "시즌 지남으로 미진행해도 몇 주·몇 달 지나거나 판매가 급등하면 다시 제안"): 같은 일은 skip_until 전까지 다시 만들지 않는다.
  //   단 그 사이 에이전트가 다시 제안했고 판매가 급등했으면(아래 skipWait) 바로 다시. 기간이 끝난 뒤 다시 제안되면 사연(reopen_note)을 달고 새로.
  const skips = new Map<string, Row>();
  for (const t of existing) if (t.status === "closed" && t.done_how === "skip") { const k = String(t.task_key), o = skips.get(k); if (!o || String(t.done_at) > String(o.done_at)) skips.set(k, t); }
  const skipWait: { it: Item; sk: Row }[] = [];
  const skipLabel = (sk: Row) => `${String(sk.done_at ?? "").slice(5, 10).replace("-", "/")} 미진행(${String(sk.skip_reason ?? "").slice(0, 30)})`;
  const now = new Date().toISOString();
  const stat = { ad_hist: null as Row | null, sales: null as Row | null, inserted: 0, updated: 0, stale: 0, dropped: 0, reopened: 0, skip_reopened: 0, auto_done: 0, detail_runs: [] as Row[], notified: null as Row | null };
  const insertItem = async (it: Item, reopen_note: string | null) => {
    const ins = await rest("team_tasks", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
      task_key: it.key, kind: it.kind, title: it.title, product_no: it.product_no, product_name: it.product_name, owner: it.owner, why: it.why, done_when: it.done_when,
      due: it.due, due_source: it.due_source, needs_ceo: it.needs_ceo, reenable: it.reenable, sources: it.sources, first_seen: it.first_seen, last_seen: it.last_seen,
      ...(reopen_note ? { reopen_note: reopen_note.slice(0, 200) } : {}),
    }) });
    if (ins.ok) stat.inserted++;   // 동시에 두 번 돌면 같은 키는 고유 색인이 막는다(409) — 무시
  };
  for (const it of items.values()) {
    const cur = live.get(it.key);
    if (cur) {
      const old = (cur.sources ?? []) as Row[];
      const merged = [...it.sources, ...old.filter((o) => !it.sources.some((n) => n.agent === o.agent && n.action_id === o.action_id))].slice(0, 10);
      const patch: Row = { last_seen: it.last_seen > String(cur.last_seen) ? it.last_seen : cur.last_seen, sources: merged, why: it.why || cur.why, title: it.title || cur.title, done_when: it.done_when || cur.done_when, stale_since: null, updated_at: now };
      // 다시 켜기 판정은 한 번 나면 유지(광고를 켜면 ON 수가 바뀌어 판정이 풀리므로) · 승인 필요 없는 일은 결정함에서 바로 팀으로
      const reen = it.reenable || !!cur.reenable;
      if (reen !== !!cur.reenable) patch.reenable = reen;
      if (!cur.decision) patch.needs_ceo = reen || NO_CEO_KINDS.has(String(cur.kind)) ? false : (it.needs_ceo || !!cur.needs_ceo);
      // 코드가 정한 기한(default)은 출근일 규칙으로 다시 맞춘다 — 에이전트가 정했거나(agent) 대표가 미룬(ceo) 기한은 그대로
      if (String(cur.due_source ?? "default") === "default") { patch.due = it.due; patch.due_source = it.due_source; }
      await rest(`team_tasks?id=eq.${cur.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
      stat.updated++;
      continue;
    }
    if (it.last_seen < addDays(D, -1)) continue;   // 오래된 보고서에만 있는 일은 새로 만들지 않음
    const sk = skips.get(it.key);
    if (sk && D < String(sk.skip_until ?? "")) { skipWait.push({ it, sk }); continue; }   // 미진행 기간 중 — 판매 급등이면 아래에서 다시
    if (!sk && recentDone.has(it.key)) continue;   // 최근 7일 안에 끝난 일 — 에이전트가 하루 늦게 빼는 경우가 있어 다시 열지 않는다
    await insertItem(it, sk ? `${skipLabel(sk)} — 기간이 끝나 다시 제안` : null);
  }
  // 미진행 기간 중인데 에이전트가 다시 제안한 일: 최근 7일 판매가 미진행할 때의 2배 이상이고 하루 2개↑ 늘었으면 다시 연다
  if (skipWait.length) {
    const q7 = await qty7Map();
    for (const { it, sk } of skipWait) {
      const no = Number(it.product_no ?? sk.product_no); if (!(no > 0) || !q7) continue;
      const now7 = q7.get(no) ?? 0, was7 = Number(sk.skip_qty7 ?? 0);
      if (now7 >= was7 * 2 && now7 - was7 >= 14) { await insertItem(it, `${skipLabel(sk)} — 판매 급등(하루 ${(was7 / 7).toFixed(1)}→${(now7 / 7).toFixed(1)}개)으로 다시 제안`); stat.skip_reopened++; }
    }
  }
  // 담당자들의 최신 보고서 어디에도 없는 진행 중 일 → 내리지 않고 stale_since(에이전트가 더는 제안 안 함)만 찍는다 — 휴일·주말에 사람이 못 본 채 사라지지 않게(2026-11-07).
  //   사람이 완료·닫기 하거나 데이터로 자동 완료될 때까지 보드에 남는다. 다시 제안되면 stale이 풀린다(위 update).
  // 보류 7일이 지난 일: 아직 제안되면 결정함으로 다시, 아니면 내림
  const lr2 = await rest(`team_tasks?status=in.(open,held)&select=*`);
  const tasks: Row[] = lr2.ok ? await lr2.json() : [];
  const drop = async (t: Row) => { await rest(`team_tasks?id=eq.${t.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "dropped", updated_at: now }) }); stat.dropped++; t.status = "dropped"; };
  for (const t of tasks) {
    // 이름만 있던 옛 줄인데 이제 같은 상품 번호 줄이 있으면 중복 — 결정 전이면 내린다
    const nk = String(t.task_key).match(/^(.+)\|n:(.+)$/);
    if (nk && t.status === "open" && !t.decision) { const no = names.get(nk[2]); if (no && items.has(`${nk[1]}|${no}`)) { await drop(t); continue; } }
    if (dupKeys.has(String(t.task_key)) && t.status === "open" && !t.decision) { await drop(t); continue; }   // 같은 이름의 덜 팔리는 상품 줄
    // 대표 승인 없이 하는 종류(광고 줄이기)는 예전에 승인 대기로 들어온 것도 팀으로
    if (t.status === "open" && !t.decision && t.needs_ceo && NO_CEO_KINDS.has(String(t.kind))) { await rest(`team_tasks?id=eq.${t.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ needs_ceo: false, updated_at: now }) }); t.needs_ceo = false; }
    const proposed = items.has(String(t.task_key));
    // 옛 형식 줄(보고서 할 일 번호 a: · 상품 이름 n: — 상품별 줄로 바뀌기 전 11/2~11/10)은 더 제안되지 않은 지 2일이면 내린다.
    //   제목에 상품 여러 개가 섞여 있고, 같은 일은 이미 상품별 줄로 따로 있다(2026-11-11 사용자 "여전히 상품 2개가 합쳐져 있어").
    if (t.status === "open" && !proposed && /\|[an]:/.test(String(t.task_key)) && t.stale_since && String(t.stale_since) <= addDays(D, -2)) { await drop(t); continue; }
    if (t.status === "open" && !proposed) {
      if (!t.stale_since) { await rest(`team_tasks?id=eq.${t.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ stale_since: D, updated_at: now }) }); stat.stale++; t.stale_since = D; }
      continue;
    }
    if (t.status === "held" && String(t.decided_at ?? "") < addDays(D, -6)) {
      if (!proposed) { await drop(t); continue; }
      await rest(`team_tasks?id=eq.${t.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "open", decision: null, decision_note: `지난 보류(${String(t.decided_at).slice(5, 10)}): ${t.decision_note ?? ""}`.slice(0, 200), decided_at: null, decided_by: null, updated_at: now }) });
      stat.reopened++; t.status = "open"; t.decision = null;
    }
  }
  // 자동 완료 판정
  const checks = tasks.filter((t) => t.status === "open" && AUTO_KINDS.has(String(t.kind)) && Number(t.product_no) > 0);
  const adTasks = checks.filter((t) => String(t.kind).startsWith("광고"));
  const adCount = adTasks.length ? await adCounter(reports, adTasks.map((t) => ({ no: Number(t.product_no), name: String(t.product_name ?? "") }))) : null;
  for (const t of checks) {
    const bl = (t.baseline ?? {}) as Row, no = Number(t.product_no);
    let evidence: string | null = null; const nb: Row = { ...bl };
    if (String(t.kind).startsWith("광고") && adCount) {
      const n = adCount(no);
      if (bl.active_ads == null) nb.active_ads = n;
      else if (t.kind === "광고 착수" && n > Number(bl.active_ads)) evidence = `ON 광고 ${bl.active_ads}개 → ${n}개`;
      else if (t.kind === "광고 줄이기" && n < Number(bl.active_ads)) evidence = `ON 광고 ${bl.active_ads}개 → ${n}개`;
      nb.active_ads_now = n;
    }
    if (t.kind === "상세 보강") {
      const h = await descHash(no);
      if (h) { if (!bl.desc_hash) nb.desc_hash = h; else if (h !== bl.desc_hash) evidence = "상세 이미지가 바뀜"; }
    }
    const body: Row = { baseline: nb, updated_at: now };
    if (evidence) Object.assign(body, { status: "done", done_how: "auto", done_at: now, done_by: "자동 확인", done_evidence: evidence });
    await rest(`team_tasks?id=eq.${t.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
    if (evidence) stat.auto_done++;
  }
  // 상품별 최근 7일 판매(2026-11-11 사용자 요청 "일평균 판매량 — 광고 착수 결정에 도움"): 어제까지 꽉 찬 7일 vs 그 앞 7일, 카페24 상품별 집계(summary — 상품 전략 담당과 같은 숫자)
  stat.ad_hist = await fillAdHistory(tasks, reports, now).catch((e) => ({ error: String((e as Error)?.message ?? e).slice(0, 200) }));
  stat.sales = await fillSales(tasks.filter((t) => ["open", "held"].includes(String(t.status)) && Number(t.product_no) > 0), now);
  // 상세 점검 자동 실행 (아침 cron만)
  if (auto) { stat.detail_runs = await autoDetail(D); stat.notified = await morningNotify(cal); }
  return { ok: true, report_date: D, reports: reports.map((r) => `${r.agent} ${r.report_date}`), items: items.size, ...stat };
}

// 상품별 최근 7일(어제까지) 판매 수량 — 미진행 일의 판매 급등 판정용. 못 받으면 null(판정 안 함)
async function qty7Map(): Promise<Map<number, number> | null> {
  const y = addDays(seoulToday(), -1);
  const a = await callFn("cafe24-analytics", { action: "summary", start_date: addDays(y, -6), end_date: y }).catch(() => null);
  const rows = (a as Row | null)?.rows;
  return Array.isArray(rows) ? new Map((rows as Row[]).map((r) => [Number(r.product_no), Number(r.order_qty) || 0])) : null;
}
async function fillSales(tasks: Row[], now: string): Promise<Row> {
  if (!tasks.length) return { skipped: "상품 할 일 없음" };
  const y = addDays(seoulToday(), -1);
  const [a, b] = await Promise.all([
    callFn("cafe24-analytics", { action: "summary", start_date: addDays(y, -6), end_date: y }).catch(() => null),
    callFn("cafe24-analytics", { action: "summary", start_date: addDays(y, -13), end_date: addDays(y, -7) }).catch(() => null),
  ]);
  const rowsA = (a as Row | null)?.rows, rowsB = (b as Row | null)?.rows;
  if (!Array.isArray(rowsA) || !Array.isArray(rowsB)) return { skipped: "카페24 판매 집계를 못 받음 — 다음 동기화 때 다시" };
  const m7 = new Map((rowsA as Row[]).map((r) => [Number(r.product_no), r])), mp = new Map((rowsB as Row[]).map((r) => [Number(r.product_no), r]));
  const n = (v: unknown) => Number(v) || 0;
  let patched = 0;
  for (const t of tasks) {
    const no = Number(t.product_no), r = m7.get(no), rp = mp.get(no);
    const v = { qty_7d: n(r?.order_qty), qty_prev7d: n(rp?.order_qty), views_7d: n(r?.views), views_prev7d: n(rp?.views), through: y };
    const cur = (t.sales_7d ?? {}) as Row;
    if (cur.through === y && cur.qty_7d === v.qty_7d && cur.qty_prev7d === v.qty_prev7d && cur.views_7d === v.views_7d) continue;
    await rest(`team_tasks?id=eq.${t.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ sales_7d: v, updated_at: now }) });
    patched++;
  }
  return { through: y, patched };
}

// 알림 받을 직원(알림 켠 비관리자)을 팀별로 — 오늘 종일 휴가인 사람은 뺀다. 팀을 모르는 계정은 '전체'
async function staffByTeam(cal: TeamCal, today: string, admins: string[]): Promise<{ groups: Map<string, string[]>; skipped: number }> {
  const sres = await rest("agent_users?notify=eq.true&select=user_id");
  const staff = (sres.ok ? ((await sres.json()) as Row[]).map((u) => String(u.user_id)) : []).filter((id) => !admins.includes(id));
  const rres = staff.length ? await rest(`app_users?id=in.(${staff.map((i) => `"${i}"`).join(",")})&select=id,role`) : null;
  const roleOf = new Map((rres?.ok ? ((await rres.json()) as Row[]) : []).map((u) => [String(u.id), String(u.role)]));
  const onLeave = new Set(cal.leaves.filter((l) => l.date === today && l.type !== "half").map((l) => l.user_id));
  const groups = new Map<string, string[]>();
  for (const id of staff) { if (onLeave.has(id)) continue; const team = teamOfRole(roleOf.get(id)) ?? "전체"; (groups.get(team) ?? groups.set(team, []).get(team)!).push(id); }
  return { groups, skipped: [...onLeave].filter((id) => staff.includes(id)).length };
}
const adminIds = async () => { const u = await rest("app_users?role=eq.admin&select=id"); return u.ok ? ((await u.json()) as Row[]).map((x) => String(x.id)) : []; };
const kstHour = () => Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul", hour: "numeric", hourCycle: "h23" }));

// 대표 승인 알림: 승인됐는데 아직 안 알린 일을 담당 팀에 묶어서. 근무 시간(9~19시)·그 팀 출근일에만 — 아니면 다음 아침 알림이 같이 알린다.
//   team을 주면(승인 직후) 그 팀만, 5분 안에 이미 보냈으면 미뤄서 10분마다 도는 flush가 묶어 보낸다(연달아 승인할 때 알림 여러 번 안 가게).
async function flushApprovals(team?: string): Promise<Row> {
  const today = seoulToday(), h = kstHour();
  if (h < 9 || h >= 19) return { note: "근무 시간이 아니라 다음 출근일 아침 알림에 같이 가요" };
  const r = await rest(`team_tasks?status=eq.open&decision=eq.approve&notified_at=is.null${team ? `&owner=eq.${encodeURIComponent(team)}` : ""}&select=id,owner,kind,product_name,decision_detail&order=decided_at.asc`);
  const pend = (r.ok ? ((await r.json()) as Row[]) : []).filter((t) => isStaffOwner(t.owner));
  if (!pend.length) return { note: "" };
  const cal = await loadTeamCal(addDays(today, -3), addDays(today, 14));
  const { groups } = await staffByTeam(cal, today, await adminIds());
  const out: Row[] = []; let note = "";
  for (const tm of new Set(pend.map((t) => String(t.owner)))) {
    if (isOffDay(today, cal.offFor(tm))) { out.push({ team: tm, skipped: "off" }); note = `오늘은 ${tm}이 쉬는 날이라 다음 출근일 아침 알림에 같이 가요`; continue; }
    if (team) {
      const rc = await rest(`team_tasks?owner=eq.${encodeURIComponent(tm)}&notified_at=gte.${new Date(Date.now() - 5 * 60000).toISOString()}&select=id&limit=1`);
      if (rc.ok && ((await rc.json()) as Row[]).length) { out.push({ team: tm, deferred: true }); note = "방금 보낸 알림이 있어 10분 안에 묶어서 보내요"; continue; }
    }
    const mine = pend.filter((t) => t.owner === tm);
    const ids = [...(groups.get(tm) ?? []), ...(groups.get("전체") ?? [])];
    const lab = (t: Row) => { const d = detailText(t.decision_detail); return `${shortName(t.product_name) ? shortName(t.product_name) + " " : ""}${t.kind}${d ? `(${d})` : ""}`; };
    const msg = mine.length === 1 ? `대표 승인: ${lab(mine[0])} — 팀 작업보드에서 시작해 주세요` : `대표가 ${mine.length}개 승인: ${lab(mine[0])} 외 ${mine.length - 1}개 — 팀 작업보드에서 확인`;
    const res = ids.length ? await notifyUsers(ids, "대표 승인", msg, "대표가 할 일을 승인했어요", "#board") : { saved: 0, pushed: 0 };
    await rest(`team_tasks?id=in.(${mine.map((t) => t.id).join(",")})`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ notified_at: new Date().toISOString() }) });
    out.push({ team: tm, count: mine.length, ...res });
    note = ids.length ? `${tm} ${ids.length}명에게 바로 알렸어요` : `${tm}에 알림을 켠 직원이 없어 보드에만 표시돼요`;
  }
  return { note, sent: out };
}

// 아침 알림: 대표(관리자)는 매일 결정 대기, 직원은 출근일에만 오늘 할 일
async function morningNotify(cal: TeamCal): Promise<Row> {
  const today = seoulToday();
  const off = cal.holidays;
  const r = await rest(`team_tasks?status=eq.open&select=id,owner,kind,needs_ceo,decision,notified_at,due,due_source,created_at,stale_since`);
  const open: Row[] = r.ok ? await r.json() : [];
  const pendingCeo = open.filter((t) => t.needs_ceo && !t.decision).length;
  const offToday = isOffDay(today, off);
  const prevW = prevWorkday(today, off), nextW = nextWorkday(today, off);
  // 직원이 쉬는 동안 마감인 일(에이전트가 정한 기한이 이번 휴일 안) — 대표에게 올린다
  // 담당 팀이 쉬는 날(주말·공휴일·팀 전원 휴가)이면 그 사이 마감인 일을 대표에게
  const offDeadline = open.filter((t) => {
    if (!isStaffOwner(t.owner) || t.kind === "지킬 원칙" || t.due_source !== "agent" || t.stale_since || (t.needs_ceo && !t.decision)) return false;
    const o = cal.offFor(t.owner);
    return isOffDay(today, o) && String(t.due) > prevWorkday(today, o) && String(t.due) < nextWorkday(today, o);
  }).length;
  const admins = await adminIds();
  const out: Row = { off_today: offToday };
  if (pendingCeo + offDeadline > 0) {
    const msg = `대표 결정 대기 ${pendingCeo}개${offDeadline ? ` · 담당 팀이 쉬는 동안 마감 ${offDeadline}개` : ""} — 대표 결정함에서 확인`;
    out.ceo = await notifyUsers(admins, "오늘 할 일", msg, "대표 결정이 필요한 일이 있어요", "#decide");
  }
  if (!offToday) {
    // 사람마다 자기 팀 할 일 수로(팀을 모르는 계정은 전체) · 종일 휴가인 사람은 알림 안 보냄
    const { groups, skipped } = await staffByTeam(cal, today, admins);
    const work = open.filter((t) => isStaffOwner(t.owner) && t.kind !== "지킬 원칙" && !t.stale_since && !(t.needs_ceo && !t.decision));
    const sent: Row[] = [], told = new Set<string>();
    for (const [team, ids] of groups) {
      const mine = team === "전체" ? work : work.filter((t) => t.owner === team);
      if (!mine.length) continue;
      const late = mine.filter((t) => t.due && String(t.due) < today).length;
      const fresh = prevW < addDays(today, -1) ? mine.filter((t) => String(t.created_at ?? "").slice(0, 10) > prevW).length : 0;   // 쉬는 날 뒤 첫 출근일이면 그 사이 생긴 일
      const appr = mine.filter((t) => t.decision === "approve" && !t.notified_at);   // 아직 안 알린 대표 승인(밤·쉬는 날에 승인한 것)
      appr.forEach((t) => told.add(String(t.id)));
      sent.push({ team, ...(await notifyUsers(ids, "오늘 할 일", `${team === "전체" ? "" : team + " "}오늘 할 일 ${mine.length}개${appr.length ? ` · 대표 승인 ${appr.length}개` : ""}${late ? ` · 기한 지남 ${late}개` : ""}${fresh ? ` · 쉬는 동안 생긴 일 ${fresh}개` : ""}`, "오늘 할 일이 있어요", "#board")) });
    }
    if (told.size) await rest(`team_tasks?id=in.(${[...told].join(",")})`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ notified_at: new Date().toISOString() }) });
    out.staff = { sent, skipped_on_leave: skipped, approvals_told: told.size };
  }
  return out;
}

async function autoDetail(D: string): Promise<Row[]> {
  const since = new Date(Date.now() - 86400000).toISOString();
  const credit = await rest(`detail_reviews?error=ilike.*credit*&updated_at=gte.${since}&select=id&limit=1`);
  if (credit.ok && ((await credit.json()) as unknown[]).length) return [{ skipped: "API 크레딧 부족(최근 24시간 실패) — 충전 후 다시" }];
  const today = await rest(`detail_reviews?created_at=gte.${addDays(seoulToday(), 0)}T00:00:00%2B09:00&reason=like.*동료 요청*&select=id`);
  const doneToday = today.ok ? ((await today.json()) as unknown[]).length : 0;
  if (doneToday >= 2) return [{ skipped: "오늘 자동 점검 2개 다 함" }];
  const r = await rest(`agent_reports?agent=in.(sales,returns,strategy,ads)&status=eq.ok&report_date=gte.${addDays(D, -6)}&select=agent,report_date,report&order=created_at.desc&limit=40`);
  const rows: Row[] = r.ok ? await r.json() : [];
  const days = new Map<number, { name: string; dates: Set<string> }>();
  for (const row of rows) for (const h of ((((row.report ?? {}) as Row).handoffs ?? []) as Row[])) {
    if (String(h.to) !== AGENT_LABELS.detail || !(Number(h.product_no) > 0)) continue;
    const no = Number(h.product_no), e = days.get(no) ?? { name: String(h.product ?? ""), dates: new Set<string>() };
    e.dates.add(String(row.report_date)); days.set(no, e);
  }
  const cands = [...days.entries()].filter(([, e]) => e.dates.size >= 2).sort((a, b) => b[1].dates.size - a[1].dates.size);
  const out: Row[] = [];
  for (const [no, e] of cands) {
    if (out.length + doneToday >= 2) break;
    const rec = await rest(`detail_reviews?product_no=eq.${no}&created_at=gte.${addDays(D, -14)}T00:00:00Z&status=in.(ok,reading,judging)&select=id&limit=1`);
    if (rec.ok && ((await rec.json()) as unknown[]).length) continue;
    const reason = `동료 요청 ${e.dates.size}번(팀 할 일 자동 점검)`;
    const d = await rest("rpc/agent_call", { method: "POST", body: JSON.stringify({ p_fn: "detail-agent", p_qs: `action=run&product_no=${no}&reason=${encodeURIComponent(reason)}` }) });
    out.push({ product_no: no, name: e.name, requests: e.dates.size, dispatched: d.ok });
  }
  return out;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req); if (opt) return opt;
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "list";
  const viaCron = isCronRequest(req);
  const me = viaCron ? null : await verifyAuthToken(req);
  if (!viaCron && !(await canUseAgents(me))) return json({ error: "접근 권한이 없습니다" }, 403);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) as Row : {};
  try {
    if (action === "sync") {
      if (!viaCron && me?.role !== "admin") return json({ error: "관리자만" }, 403);
      return json(await sync(url.searchParams.get("auto") === "1"));
    }
    if (action === "flush") {   // 승인 알림 묶어 보내기 (10분마다 cron)
      if (!viaCron && me?.role !== "admin") return json({ error: "관리자만" }, 403);
      return json(await flushApprovals());
    }
    if (action === "list") {
      const D = seoulToday();
      const r = await rest(`team_tasks?or=(status.in.(open,held),done_at.gte.${addDays(D, -7)}T00:00:00Z,and(status.eq.dropped,updated_at.gte.${addDays(D, -3)}T00:00:00Z),and(done_how.eq.skip,skip_until.gt.${D}))&select=*&order=due.asc,first_seen.asc&limit=300`);
      if (!r.ok) return json({ error: `불러오기 실패 ${r.status}` }, 500);
      const cal = await loadTeamCal(addDays(D, -40), addDays(D, 40));
      const holidays = [...cal.holidays];   // 공휴일만 — 토·일은 화면이 계산
      const team_off = Object.fromEntries(Object.entries(cal.teamOff).map(([t, ds]) => [t, [...ds].sort()]));   // 팀 전원 종일 휴가인 날
      const leaves = cal.leaves.filter((l) => l.date >= addDays(D, -3) && l.date <= addDays(D, 14)).map(({ date, team, name, type }) => ({ date, team, name, type })).sort((a, b) => a.date.localeCompare(b.date));
      const team_size = Object.fromEntries(Object.entries(cal.members).map(([t, ms]) => [t, ms.length]));
      const tasks: Row[] = await r.json();
      // 광고 일 카드용: 상품별 광고 상태(광고 운영 담당 최신 보고서) + 최근 30일 제작안
      const adNos = [...new Set(tasks.filter((t) => String(t.kind).startsWith("광고") && Number(t.product_no) > 0 && ["open", "held"].includes(String(t.status))).map((t) => Number(t.product_no)))];
      const ad_info: Record<number, Row> = {}, creative: Record<number, Row> = {};
      if (adNos.length) {
        const [ar, cr] = await Promise.all([
          rest(`agent_reports?agent=eq.ads&status=eq.ok&select=id,report_date,products:data->products,decisions:report->decisions&order=report_date.desc,created_at.desc&limit=1`),
          rest(`creative_briefs?product_no=in.(${adNos.join(",")})&status=eq.ok&created_at=gte.${addDays(D, -30)}T00:00:00Z&select=product_no,batch_id,created_at&order=created_at.desc&limit=50`),
        ]);
        const rep0 = ar.ok ? ((await ar.json()) as Row[])[0] : null;
        if (rep0) { const m = adsInfoOf((rep0.products ?? []) as Row[], (rep0.decisions ?? []) as Row[], rep0.id, rep0.report_date); for (const no of adNos) { const x = m.get(no); if (x) ad_info[no] = x; } }
        const briefs: Row[] = cr.ok ? await cr.json() : [];
        for (const b of briefs) if (!creative[Number(b.product_no)]) creative[Number(b.product_no)] = { batch_id: b.batch_id, date: kstDay(String(b.created_at)) };
        const batches = [...new Set(Object.values(creative).map((c) => String(c.batch_id)))];
        if (batches.length) {
          const rr = await rest(`agent_reports?agent=eq.creative&select=id,batch:data->>batch_id&data->>batch_id=in.(${batches.map((b) => `"${b}"`).join(",")})`);
          const ids = new Map((rr.ok ? ((await rr.json()) as Row[]) : []).map((x) => [String(x.batch), String(x.id)]));
          for (const c of Object.values(creative)) c.report_id = ids.get(String(c.batch_id)) ?? null;
        }
      }
      // 상세 보강 카드의 '자세히&권장방안'(2026-11-11 사용자): 그 상품을 상세 점검 담당이 최근 90일에 읽었으면 그 결과(1순위·빠진 것·붙여 넣을 문장)도
      const detail_review: Record<number, Row> = {};
      const dNos = [...new Set(tasks.filter((t) => t.kind === "상세 보강" && Number(t.product_no) > 0 && t.status === "open").map((t) => Number(t.product_no)))];
      if (dNos.length) {
        const dr = await rest(`detail_reviews?product_no=in.(${dNos.join(",")})&status=eq.ok&created_at=gte.${addDays(D, -90)}T00:00:00Z&select=product_no,report_date,review&order=created_at.desc&limit=40`);
        for (const x of (dr.ok ? await dr.json() : []) as Row[]) {
          const no = Number(x.product_no), rv = (x.review ?? {}) as Row;
          if (detail_review[no] || !rv.top_priority) continue;
          detail_review[no] = { date: x.report_date, score: rv.score ?? null, top: rv.top_priority, missing: ((rv.missing ?? []) as unknown[]).slice(0, 4), snippets: ((rv.copy_snippets ?? []) as unknown[]).slice(0, 3) };
        }
      }
      return json({ tasks, today: D, holidays, team_off, leaves, team_size, ad_info, creative, detail_review, methods: METHODS, me: { name: me?.name, admin: me?.role === "admin" } });
    }
    const id = String(body.id ?? "");
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "id 필요" }, 400);
    const now = new Date().toISOString();
    // 상태 전환은 PATCH 조건으로 강제(보안 검토 2026-11-07): 화면을 거치지 않고 직접 불러도 대표 승인 전·보류된 일을 완료하거나 되살릴 수 없게
    const upd = async (b: Row, cond = ""): Promise<Row | null> => {
      const r = await rest(`team_tasks?id=eq.${id}${cond}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ ...b, updated_at: now }) });
      const rows = r.ok ? await r.json() as Row[] : [];
      return rows[0] ?? null;
    };
    const CONFLICT = "지금 상태에서는 바꿀 수 없어요(대표 승인 전이거나 이미 바뀐 할 일) — 새로고침해 주세요";
    const patch = async (b: Row, cond = "") => { const row = await upd(b, cond); return row ? json({ ok: true, task: row }) : json({ error: CONFLICT }, 409); };
    if (action === "done") {
      if (body.undo) return await patch({ status: "open", done_how: null, done_by: null, done_at: null, done_evidence: null, skip_reason: null, skip_until: null, skip_qty7: null }, "&status=in.(done,closed)");
      // 관리자(대표)는 승인 대기 일도 직접 처리할 수 있다('내가 처리함' — 직접 했으면 승인한 셈). 직원은 승인 필요 없거나 승인된 일만.
      // start: true = '시작과 함께 완료'(2026-11-11 사용자) — 시작 안 한 일이면 시작한 사람·때도 같이 남긴다
      return await patch({ status: "done", done_how: "manual", done_by: String(me?.name ?? ""), done_at: now, done_evidence: null, ...(body.start ? { started_at: now, started_by: String(me?.name ?? "") } : {}) },
        me?.role === "admin" ? "&status=eq.open" : "&status=eq.open&or=(needs_ceo.eq.false,decision.eq.approve)");
    }
    // 진행 중(2026-11-11 사용자 "팀 작업보드 + 진행 중 단계"): 직원이 '시작'을 누르면 started_at·by. 완료할 수 있는 일만(대표 승인 전이면 시작도 안 됨). undo = 시작 취소
    if (action === "start") {
      if (body.undo) return await patch({ started_at: null, started_by: null }, "&status=eq.open&started_at=not.is.null");
      return await patch({ started_at: now, started_by: String(me?.name ?? "") },
        me?.role === "admin" ? "&status=eq.open&started_at=is.null" : "&status=eq.open&started_at=is.null&or=(needs_ceo.eq.false,decision.eq.approve)");
    }
    // 미진행(2026-11-11 사용자 "할 일에 '미진행' 버튼 + 이유 기입"): 담당 팀이 이 일을 하지 않기로 — 이유 필수. closed + done_how 'skip'.
    //   다음 날 보고서에서 빠지고, 에이전트는 이유를 참고 데이터로만 본다(_shared/agent.ts brief). 되돌리기는 done undo.
    if (action === "skip") {
      const reason = String(body.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (reason.length < 2) return json({ error: "미진행 이유를 적어 주세요" }, 400);
      // 다시 제안될 수 있는 날(2026-11-11): 시즌 90일 · 효과 의문·그 외 30일 · 재고 14일 · 더 급한 일 7일. 그 사이 판매 급등이면 바로(sync)
      const days = /시즌|계절|날씨|추워|더워|철 지/.test(reason) ? 90 : /재고|품절|입고/.test(reason) ? 14 : /급함|급해|우선|바빠|바쁨|여유/.test(reason) ? 7 : 30;
      const cr = await rest(`team_tasks?id=eq.${id}&select=sales_7d`);
      const q7 = Number((((cr.ok ? ((await cr.json()) as Row[])[0] : null)?.sales_7d ?? {}) as Row).qty_7d);
      return await patch({ status: "closed", done_how: "skip", done_by: String(me?.name ?? ""), done_at: now, done_evidence: null, skip_reason: reason, skip_until: addDays(seoulToday(), days), skip_qty7: Number.isFinite(q7) ? q7 : null },
        me?.role === "admin" ? "&status=eq.open" : "&status=eq.open&or=(needs_ceo.eq.false,decision.eq.approve)");
    }
    if (action === "close") {   // '필요 없음'으로 닫기 — 에이전트가 더는 제안 안 하는 일, 주말 마감 '넘기기'
      return await patch({ status: "closed", done_how: "manual", done_by: String(me?.name ?? ""), done_at: now, done_evidence: null },
        me?.role === "admin" ? "&status=eq.open" : "&status=eq.open&or=(needs_ceo.eq.false,decision.eq.approve)");
    }
    if (action === "postpone") {   // 대표: 직원이 쉬는 동안 마감인 일을 다음 출근일로
      if (me?.role !== "admin") return json({ error: "대표(관리자)만 미룰 수 있어요" }, 403);
      const cur = await rest(`team_tasks?id=eq.${id}&select=owner`);
      const owner = cur.ok ? String(((await cur.json()) as Row[])[0]?.owner ?? "") : "";
      const cal = await loadTeamCal(addDays(seoulToday(), -5), addDays(seoulToday(), 40));
      const to = nextWorkday(seoulToday(), cal.offFor(owner));   // 그 팀이 오늘 다음에 처음 출근하는 날(주말·공휴일·팀 전원 휴가 제외)
      return await patch({ due: to, due_source: "ceo" }, "&status=eq.open");
    }
    if (action === "decide") {
      if (me?.role !== "admin") return json({ error: "대표(관리자)만 결정할 수 있어요" }, 403);
      const d = String(body.decision ?? "");
      if (d === "undo") return await patch({ status: "open", decision: null, decision_note: null, decided_by: null, decided_at: null, decision_detail: null, notified_at: null }, "&status=in.(open,held)");
      if (!["approve", "hold"].includes(d)) return json({ error: "decision은 approve·hold·undo" }, 400);
      // 승인할 때 방식·하루 예산(선택) — 정해진 방식 코드와 숫자만 저장
      let detail: Row | null = null;
      if (d === "approve" && body.detail && typeof body.detail === "object") {
        const m = String((body.detail as Row).method ?? ""), w = Math.round(Number((body.detail as Row).daily_won));
        detail = { ...(METHODS[m] ? { method: m } : {}), ...(w > 0 && w <= 50_000_000 ? { daily_won: w } : {}) };
        if (!Object.keys(detail).length) detail = null;
      }
      const row = await upd({ decision: d, decision_note: String(body.note ?? "").slice(0, 200) || null, decision_detail: detail, notified_at: null, decided_by: String(me?.name ?? ""), decided_at: now, status: d === "hold" ? "held" : "open" }, "&status=eq.open");
      if (!row) return json({ error: CONFLICT }, 409);
      if (d !== "approve" || !isStaffOwner(row.owner)) return json({ ok: true, task: row });
      const notify = await flushApprovals(String(row.owner)).catch((e) => ({ note: `알림 실패: ${String((e as Error)?.message ?? e).slice(0, 80)}` }));
      const fresh = await rest(`team_tasks?id=eq.${id}&select=*`);
      return json({ ok: true, task: (fresh.ok ? ((await fresh.json()) as Row[])[0] : null) ?? row, notify_note: (notify as Row).note ?? "" });
    }
    return json({ error: "알 수 없는 action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});

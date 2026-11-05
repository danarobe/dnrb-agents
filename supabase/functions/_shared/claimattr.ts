// ═══════════════════════════════════════════════
// 묶음 취소·반품 사유의 주인 찾기 (2026-11-05 사용자 요청)
//   카페24는 사유를 '신청(클레임) 한 건'에 하나만 받는다. A·B·C를 한 번에 반품하며 "기장이 짧아요"라고 쓰면
//   같은 문장이 세 상품 모두에 붙는다(실측 2주: 반품 품목 38%·취소 품목 43%가 여러 상품 신청). 그래서 품목마다:
//     sole     = 혼자 신청 → 이 상품 사유 확실
//     named    = 사유에 이 상품 이름이 있음 → 확실
//     kind     = 사유의 품목 단어(원피스·블라우스 등)가 신청 안에서 이 상품 하나뿐 → 확실
//     cue      = 사유 단서(발볼·허리·어깨·사이즈 등)와 맞는 상품 종류가 신청 안에서 이 상품 하나뿐 → 확실
//     other    = 사유가 같은 신청의 '다른' 상품을 가리킴 → 이 상품 사유 아님(제외)
//     shared   = 어느 상품 얘기인지 모름 → 따로 보여 줌(아무 상품에나 넣지 않음)
//   ①②는 워크스페이스 index.html '반품 사유' 화면 규칙과 같고, ③ 단서 규칙은 여기서 더했다.
// ═══════════════════════════════════════════════

export type ClaimItem = { claim: string; product_no: number; product_name: string; option?: string; qty: number; request?: string; accept?: string };
export type Share = "sole" | "named" | "kind" | "cue" | "other" | "shared";
export type Attributed = ClaimItem & { reason: string; share: Share; with: string[] };

const BRAND_SUFFIX = /\s*[-–—|]\s*(danarobe|dana|다나로브|다나)\s*$/i;
// 핵심 상품명 (strategy-agent paKey와 같은 식 — 앞뒤 괄호·브랜드 접미사 제거)
export function coreName(name: string): string {
  let s = String(name || "").trim().replace(BRAND_SUFFIX, "").trim();
  for (;;) { const m = s.match(/^\s*(?:\([^)]*\)|\[[^\]]*\])\s*(.*)$/); if (m) s = m[1]; else break; }
  for (;;) { const m = s.match(/^(.*?)\s*(?:\([^)]*\)|\[[^\]]*\])\s*$/); if (m) s = m[1]; else break; }
  return s.trim();
}

// 상품 종류 — 이름의 단어로 판정. 모르면 null(어느 단서와도 맞을 수 있다고 보고 보수적으로 처리)
type Kind = "shoes" | "bag" | "acc" | "dress" | "bottom" | "top" | "outer" | "set";
const KIND_WORDS: [Kind, RegExp][] = [
  ["set", /셋업|세트|set\b/i],
  ["shoes", /슈즈|플랫|로퍼|부츠|부티|샌들|힐|스니커즈|운동화|뮬|슬링백|메리제인|펌프스|블로퍼|슬리퍼|단화|워커/],
  ["bag", /(?:^|\s)\S*(?:백|가방)(?:\s|$)|토트|숄더|크로스바디|파우치|에코백/],
  ["acc", /목걸이|귀걸이|이어링|반지|링\b|팔찌|벨트|머플러|스카프|목도리|모자|비니|캡\b|양말|삭스|장갑|헤어|집게|핀\b|브로치|키링|선글라스|워머/],
  ["dress", /원피스|\bops\b|드레스|점프수트/i],
  ["bottom", /팬츠|슬랙스|스커트|치마|데님|청바지|진\b|쇼츠|반바지|바지|레깅스|조거|와이드/],
  ["outer", /코트|자켓|재킷|점퍼|패딩|무스탕|블루종|트렌치|아우터|베스트|조끼/],
  ["top", /니트|블라우스|셔츠|티셔츠|티\b|맨투맨|후드|가디건|탑\b|나시|슬리브리스|폴라|터틀넥|스웨터|풀오버|카라/],
];
// 상품명 마지막 단어가 품목인 경우가 많아 그 단어를 먼저 본다('제인 워머 폴라' = 상의, '워머'로 액세서리 판정 금지)
function kindOf(name: string): Kind | null {
  const s = coreName(name), last = s.split(/\s+/).pop() ?? "";
  for (const [k, re] of KIND_WORDS) if (re.test(last)) return k;
  for (const [k, re] of KIND_WORDS) if (re.test(s)) return k;
  return null;
}
// 사유에서 상품을 가리키는 말 = 이름 마지막 단어 + 같은 뜻의 흔한 말(고객은 '슬랙스'를 '바지'로 쓴다)
const MENTION_SYN: [RegExp, string[]][] = [
  [/슬랙스|팬츠|바지|데님|청바지|조거|와이드|레깅스/, ["바지", "팬츠", "슬랙스"]],
  [/스커트|치마/, ["치마", "스커트"]],
  [/원피스|ops|드레스/i, ["원피스", "ops", "드레스"]],
  [/자켓|재킷|쟈켓/, ["자켓", "재킷", "쟈켓"]],
  [/가디건/, ["가디건", "가디간"]],
  [/니트|스웨터|풀오버/, ["니트"]],
  [/폴라|터틀넥/, ["폴라", "터틀넥", "니트"]],
  [/티셔츠/, ["티셔츠"]],
  [/슈즈|플랫|로퍼|부츠|부티|샌들|힐|뮬|단화|스니커즈|펌프스/, ["신발", "구두"]],
  [/백$|가방/, ["가방"]],
];
function mentionWords(name: string): string[] {
  const last = (coreName(name).split(/\s+/).pop() ?? "").toLowerCase();
  const ws = new Set<string>(last.length >= 2 ? [last] : []);
  for (const [re, syn] of MENTION_SYN) if (re.test(last)) syn.forEach((w) => ws.add(w));
  return [...ws];
}
const APPAREL: Kind[] = ["dress", "bottom", "top", "outer", "set"];
// 사유 단서 → 그 말이 나올 수 있는 상품 종류. 여러 단서가 있으면 모두 맞는 종류만 남긴다(교집합).
const CUES: [RegExp, Kind[]][] = [
  [/발볼|발등|발가락|뒤꿈치|뒷꿈치|굽|깔창|신발|발이|발사이즈|발 사이즈|(?<!\d)2[2-6][05](?!\d)/, ["shoes"]],
  [/허리|밑위|엉덩이|힙|허벅지|밴딩|바지|치마/, ["bottom", "dress", "set"]],
  [/어깨|소매|팔통|팔 길이|팔길이|팔이|가슴|암홀|목둘레|목이|넥|카라|품이/, ["top", "outer", "dress", "set"]],
  [/기장|총장/, APPAREL],
  [/사이즈|작아|작음|작네|커요|커서|크고|크네|크다|큼|큽|핏|타이트|끼어|껴서|헐렁|짧|길어|길고|길이/, [...APPAREL, "shoes"]],
  [/보풀|비침|비쳐|두께|두꺼|얇|원단|소재|까슬|따가|털빠|털 빠|늘어|구김/, [...APPAREL, "acc"]],
  [/귀가|귀에|알레르기|도금|변색|체인/, ["acc"]],
  [/수납|가방|끈 길이|스트랩/, ["bag", "shoes"]],
];

export function claimText(x: { request?: string; accept?: string }): string {
  // "(구매자 주문취소 : 구매 의사 취소)"처럼 접수 꼬리표만 남은 사유는 괄호 속 사유만
  return String(x.request || x.accept || "").replace(/\s+/g, " ").trim().replace(/^\((?:구매자|판매자)\s*주문취소\s*:\s*([^)]*)\)$/, "$1").trim();
}

export function attribute(items: ClaimItem[]): Attributed[] {
  const claims = new Map<string, Map<number, string>>();
  for (const x of items) {
    if (!x.claim) continue;
    let m = claims.get(x.claim); if (!m) { m = new Map(); claims.set(x.claim, m); }
    m.set(x.product_no, x.product_name);
  }
  return items.map((x) => {
    const reason = claimText(x);
    const prods = x.claim ? claims.get(x.claim) : undefined;
    const others = prods ? [...prods].filter(([no]) => no !== x.product_no).map(([, nm]) => coreName(nm)) : [];
    const out = (share: Share): Attributed => ({ ...x, reason, share, with: others });
    if (!prods || prods.size <= 1) return out("sole");
    if (!reason || !/[0-9A-Za-z가-힣]/.test(reason)) return out("shared");
    const textN = reason.replace(/\s+/g, "");
    // ① 상품 이름을 직접 씀 — 서로 포함 관계면 긴 이름만
    let named = [...prods].map(([no, nm]) => ({ no, full: coreName(nm).replace(/\s+/g, "") })).filter((p) => p.full.length >= 4 && textN.includes(p.full));
    named = named.filter((a) => !named.some((b) => b.no !== a.no && b.full.includes(a.full) && b.full !== a.full));
    if (named.length) return out(named.some((p) => p.no === x.product_no) ? "named" : "other");
    // ② 품목을 가리키는 말(이름 마지막 단어·같은 뜻의 말) — "바지는 크고 블라우스는 얇아요"처럼 둘 다 나오면 둘 다 확실.
    //    그 말이 신청 안 여러 상품에 해당하면(원피스 2개) 그 상품들은 불확실, 언급되지 않은 상품은 '다른 상품 얘기'
    const low = reason.toLowerCase();
    const wordOwners = new Map<string, number[]>();
    for (const [no, nm] of prods) for (const w of mentionWords(nm)) wordOwners.set(w, [...(wordOwners.get(w) ?? []), no]);
    const sure = new Set<number>(), maybe = new Set<number>();
    for (const [w, owners] of wordOwners) {
      if (!low.includes(w)) continue;
      if (owners.length === 1) sure.add(owners[0]); else owners.forEach((o) => maybe.add(o));
    }
    if (sure.size || maybe.size) {
      if (sure.has(x.product_no)) return out("kind");
      if (maybe.has(x.product_no)) return out("shared");
      return out("other");
    }
    // ③ 단서 → 맞는 종류가 신청 안에서 한 상품뿐이면 그 상품. 종류를 모르는 상품이 있으면 그 상품도 후보로 남겨 보수적으로.
    const hits = CUES.filter(([re]) => re.test(reason)).map(([, ks]) => new Set(ks));
    if (hits.length) {
      const fits = [...prods].filter(([, nm]) => { const k = kindOf(nm); return k === null || hits.every((s) => s.has(k)); }).map(([no]) => no);
      if (fits.length === 1) return out(fits[0] === x.product_no ? "cue" : "other");
      if (fits.length === 0) return out("shared");
    }
    return out("shared");
  });
}
export const isCertain = (s: Share) => s === "sole" || s === "named" || s === "kind" || s === "cue";

// ═══════════════════════════════════════════════
// 트렌드·날씨 수집 (2026-09-13, 사용자 아이디어 — 유행·날씨에 따른 급상승 키워드를 전략에 반영)
//   ① 네이버 데이터랩 쇼핑인사이트 '분야별 인기 검색어' 순위표 — 정해진 키워드 목록이 아니라 **순위표**를 받아
//      새로 진입했거나 크게 뛴 키워드를 자동으로 발견한다(사용자 지적: 정해 둔 키워드만 보면 새 유행을 못 잡음).
//      공식 API가 아니라 데이터랩 화면이 쓰는 내부 통로(getCategoryKeywordRank.naver) — 20개씩 페이지, 실측 안정.
//      화면이 바뀌면 끊길 수 있으니 실패해도 보고서는 계속 나가게 errors[]로만 남긴다.
//   ② 날씨: Open-Meteo(무료·키 없음) 서울 지난 7일 + 앞으로 7일 최고/최저기온·강수확률.
//   ③ 우리 몰 내부 검색어: 카페24 애널리틱스에 통로가 없어(searchwords 등 404 실측) 미지원.
//   ④ 무신사·지그재그·에이블리: 공개 통로 없음(실측 400/404) — 미지원, 나중에 시도.
// ═══════════════════════════════════════════════
export type Row = Record<string, unknown>;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
export const NAVER_CATS: Record<string, string> = { "50000000": "패션의류", "50000001": "패션잡화" };

// ⚠ 데이터랩은 **한 연결로 7~8번째 요청부터 응답을 멈춘다**(엣지 실측 2026-09-13: 같은 연결 순차 8번째에서 타임아웃, 병렬도 동일.
//   5개 후 3초 쉬거나 요청마다 새 HttpClient를 쓰면 10/10 성공). 그래서 요청마다 새 연결(Deno.createHttpClient)을 쓰고, 호출은 한 줄로 세운다.
let naverQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = naverQueue.then(task, task);
  naverQueue = run.catch(() => {});
  return run;
}

// 하루치 순위 (상위 pages×20개). gender 'f' = 여성 (다나로브는 여성복)
export function naverCategoryRanks(cid: string, day: string, pages = 5, gender = "f"): Promise<Map<string, number>> {
  return serialized(() => naverCategoryRanksRaw(cid, day, pages, gender));
}
async function naverCategoryRanksRaw(cid: string, day: string, pages: number, gender: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // deno-lint-ignore no-explicit-any
  const D: any = Deno;
  // 호출(≤5페이지)마다 새 연결 하나 — 요청마다 새로 열면 TLS 핸드셰이크 20번이라 CPU 한도(WORKER_RESOURCE_LIMIT)에 걸림
  const client = typeof D.createHttpClient === "function" ? D.createHttpClient({}) : undefined;
  try {
  for (let page = 1; page <= pages; page++) {
    const res = await fetch("https://datalab.naver.com/shoppingInsight/getCategoryKeywordRank.naver", {
      method: "POST",
      headers: {
        "Referer": "https://datalab.naver.com/shoppingInsight/sCategory.naver", "Origin": "https://datalab.naver.com",
        "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: new URLSearchParams({ cid, timeUnit: "date", startDate: day, endDate: day, age: "", gender, device: "", page: String(page), count: "20" }).toString(),
      signal: AbortSignal.timeout(8000),
      ...(client ? { client } : {}),
    } as RequestInit);
    const text = await res.text();
    if (!res.ok || !text.trim().startsWith("{")) throw new Error(`datalab ${res.status} page ${page}`);
    const ranks = (JSON.parse(text).ranks ?? []) as { rank: number; keyword: string }[];
    if (!ranks.length) break;
    for (const r of ranks) out.set(String(r.keyword), Number(r.rank));
    if (page < pages) await new Promise((r) => setTimeout(r, 300));   // 연속 호출 완충
  }
  } finally { client?.close?.(); }
  return out;
}

export type Rising = { keyword: string; rank: number; prev_rank: number | null; move: number; kind: "new" | "up" };
// 어제 vs 7일 전: 새 진입(100위 안) 또는 15계단 이상 상승
export function risingKeywords(cur: Map<string, number>, prev: Map<string, number>, minUp = 15): Rising[] {
  const out: Rising[] = [];
  for (const [k, r] of cur) {
    const p = prev.get(k) ?? null;
    if (p == null) out.push({ keyword: k, rank: r, prev_rank: null, move: 0, kind: "new" });
    else if (p - r >= minUp) out.push({ keyword: k, rank: r, prev_rank: p, move: p - r, kind: "up" });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// 키워드 ↔ 우리 상품 매칭 (이름·카테고리에 키워드가 들어 있으면). 영문 카테고리명은 한글 동의어로 보강.
const SYN: Record<string, string[]> = {
  가디건: ["cardigan", "가디건"], 니트: ["knit", "니트", "스웨터"], 블라우스: ["blouse", "블라우스", "셔츠", "shirts"], 셔츠: ["shirts", "셔츠"],
  원피스: ["ops", "dress", "원피스"], 팬츠: ["pants", "팬츠", "슬랙스", "바지", "데님"], 바지: ["pants", "팬츠", "슬랙스", "바지"], 슬랙스: ["슬랙스", "pants"],
  스커트: ["skirt", "스커트"], 자켓: ["jacket", "자켓", "재킷", "outer"], 재킷: ["jacket", "자켓", "재킷"], 코트: ["coat", "코트", "outer"], 아우터: ["outer", "자켓", "코트", "점퍼"],
  티셔츠: ["t-shirt", "티셔츠", "티", "tee"], 맨투맨: ["mtm", "맨투맨"], 후드: ["hood", "후드"], 집업: ["zip-up", "집업"], 데님: ["denim", "데님", "청"],
  트렌치: ["trench", "트렌치"], 바람막이: ["바람막이", "윈드"], 점퍼: ["점퍼", "jumper", "블루종"], 조끼: ["vest", "조끼", "베스트"],
  로퍼: ["로퍼", "loafer"], 플랫: ["플랫", "flat"], 슈즈: ["shoes", "슈즈", "플랫", "로퍼", "샌들"], 가방: ["bag", "가방", "백"], 나시: ["나시", "슬리브리스", "탑"],
  트위드: ["트위드", "tweed"], 레이스: ["레이스", "lace"], 새틴: ["새틴", "satin", "실크"], 골지: ["골지"], 기모: ["기모"], 니트조끼: ["니트 조끼", "니트조끼"],
};
const norm = (s: string) => String(s || "").toLowerCase().replace(/\s+/g, "");
export function matchKeyword(keyword: string, products: { no: number; name: string; category: string }[]): { no: number; name: string }[] {
  const k = norm(keyword).replace(/^여성/, "").replace(/^가을|^겨울|^여름|^봄/, "");   // '여성가을자켓' → '자켓'
  if (k.length < 2) return [];
  // 키워드 안에 들어 있는 품목 단어(가장 긴 것) 찾기 — '트위드자켓' → 트위드 + 자켓 둘 다 봄
  const parts = Object.keys(SYN).filter((w) => k.includes(norm(w)));
  const terms = new Set<string>([k]);
  for (const p of parts) for (const s of SYN[p]) terms.add(norm(s));
  const hit = products.filter((p) => {
    const n = norm(p.name), c = norm(p.category);
    if (n.includes(k)) return true;
    // 품목 단어가 2개 이상 잡히면(예: 트위드+자켓) 둘 다 이름/카테고리에 있어야 매칭
    if (parts.length >= 2) return parts.every((pt) => SYN[pt].some((s) => n.includes(norm(s)) || c.includes(norm(s))));
    if (parts.length === 1) return SYN[parts[0]].some((s) => n.includes(norm(s)) || c.includes(norm(s)));
    return false;
  });
  return hit.slice(0, 6).map((p) => ({ no: p.no, name: p.name }));
}

// 서울 날씨: 지난 7일 + 앞으로 7일
export async function seoulWeather(): Promise<Row> {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.978&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&timezone=Asia%2FSeoul&forecast_days=7&past_days=7";
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const d = (await res.json()).daily as Record<string, unknown[]>;
  const days = (d.time as string[]).map((t, i) => ({
    date: t, max: Number(d.temperature_2m_max[i]), min: Number(d.temperature_2m_min[i]),
    rain_prob: Number(d.precipitation_probability_max?.[i] ?? 0), code: Number(d.weathercode[i]),
  }));
  const past = days.slice(0, 7), next = days.slice(7);
  const avg = (a: number[]) => a.length ? +(a.reduce((t, x) => t + x, 0) / a.length).toFixed(1) : null;
  const firstBelow = (limit: number) => next.find((x) => x.min <= limit)?.date ?? null;
  return {
    source: "Open-Meteo 서울", past_7d: past, next_7d: next,
    summary: {
      past_avg_max: avg(past.map((x) => x.max)), past_avg_min: avg(past.map((x) => x.min)),
      next_avg_max: avg(next.map((x) => x.max)), next_avg_min: avg(next.map((x) => x.min)),
      first_min_below_15: firstBelow(15), first_min_below_10: firstBelow(10),
      rainy_days_next: next.filter((x) => x.rain_prob >= 60).map((x) => x.date),
    },
  };
}

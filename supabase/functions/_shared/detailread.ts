// ═══════════════════════════════════════════════
// 상세페이지 이미지 읽기 공용 모듈 (2026-09-18 — detail-agent에서 분리, creative-agent와 함께 씀)
//   다나로브 상세는 글자가 전부 세로 1만px 이미지 안에 있다 → wsrv.nl로 폭 900·세로 1500 조각을 내 Gemini(flash-lite)로 읽는다.
//   ⚠ READ_PROMPT를 바꾸면 READ_VERSION을 올린다 — 옛 버전으로 읽은 pages는 재사용하지 않는다(features 같은 새 필드가 없어서).
// ═══════════════════════════════════════════════
import { Row } from "./agent.ts";

export const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
export const GEMINI_MODEL = "gemini-flash-lite-latest";
export const MAX_IMAGES = 12, TILE_W = 900, TILE_H = 1500, MAX_TILES = 8;
export const READ_VERSION = 2;   // 2 = features·사이즈 문구 원문 보존(2026-09-15)

// ── wsrv.nl 조각: 폭 900으로 줄인 뒤 세로 1500씩 (리사이즈 후 크롭 순서 — 실측) ──
export const wsrv = (u: string, extra: string) => `https://wsrv.nl/?url=${encodeURIComponent(u)}${extra}`;
export async function imageMeta(u: string): Promise<{ w: number; h: number } | null> {
  try {
    const r = await fetch(wsrv(u, "&output=json"), { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const m = await r.json();
    return { w: Number(m.width), h: Number(m.height) };
  } catch { return null; }
}
export function tilePlan(w: number, h: number): { cy: number; ch: number }[] {
  const sh = Math.round(h * TILE_W / Math.max(1, w));   // 폭 900 기준 세로
  const n = Math.min(MAX_TILES, Math.max(1, Math.ceil(sh / TILE_H)));
  const step = n === MAX_TILES ? Math.ceil(sh / MAX_TILES) : TILE_H;   // 너무 길면 조각을 키워 8개로
  return Array.from({ length: n }, (_, i) => ({ cy: i * step, ch: Math.min(step, sh - i * step) }));
}

// ── Gemini 읽기 ──
export const READ_PROMPT = `이것은 여성 패션 쇼핑몰(다나로브) 상세페이지 이미지 한 장을 위에서 아래로 자른 조각들입니다(의류·신발·가방·액세서리 중 하나). 모든 조각을 합쳐 **JSON 객체 하나**로 정리하세요(조각별 배열 금지).
{"texts":["눈에 띄는 문구·설명 (최대 12개, 원문 그대로 짧게)"],"has_size_table":false,"size_table_text":"실측표(의류: 어깨·가슴·총장 / 신발: 굽높이·발볼·안창길이·무게 / 가방: 가로·세로·폭)가 있으면 항목과 수치를 한 줄로 (없으면 빈 문자열)","has_size_guide":false,"size_guide_text":"사이즈 추천·정사이즈/반업 안내·모델 키/사이즈·발볼 안내 등 사이즈 관련 안내 원문 (없으면 빈 문자열)","has_fabric_care":false,"fabric_text":"소재·혼용률·세탁/관리 안내 (없으면 빈 문자열)","colors_shown":["보이는 색상 이름"],"wear_shots":0,"detail_shots":0,"has_model_info":false,"has_benefit_notice":false,"benefit_text":"할인·1+1·쿠폰 등 혜택 문구 (없으면 빈 문자열)","features":["이미지·문구로 확인되는 디자인 특징 (예: 앞코 리본, 발등 스트랩, 버클, 지퍼, 포켓, 골지, 오버핏 — 보이는 것만, 최대 8개)"],"layout_notes":"구성 특징 한 줄 (예: 첫 조각이 착용컷, 글자 작음, 여백 많음)"}
규칙: 보이는 것만 적고 추측하지 않습니다. 착용컷(사람이 입거나 신은 사진)과 디테일컷(제품 부분 확대)을 세어 주세요. 사이즈 관련 문구는 한 글자도 빼지 말고 size_guide_text에 그대로 옮깁니다.`;
export async function geminiRead(tiles: { mime: string; data: string }[]): Promise<Row> {
  const parts: unknown[] = [{ text: READ_PROMPT }];
  for (const t of tiles) parts.push({ inline_data: { mime_type: t.mime, data: t.data } });
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
    signal: AbortSignal.timeout(90000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const text = body?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const usage = body?.usageMetadata ?? {};
  let parsed: Row = {};
  try { parsed = JSON.parse(text); } catch { parsed = { texts: [String(text).slice(0, 500)], parse_error: true }; }
  // Gemini가 조각별 배열로 답하는 경우(2026-09-15 실사례 — 첫 장이 통째로 문자열로 버려졌음) → 한 객체로 합친다
  if (Array.isArray(parsed)) parsed = mergePages(parsed as Row[]);
  return { ...parsed, _v: READ_VERSION, _usage: { in: usage.promptTokenCount, out: usage.candidatesTokenCount } };
}

export function mergePages(arr: Row[]): Row {
  const out: Row = {};
  for (const o of arr) {
    if (!o || typeof o !== "object") continue;
    for (const [k, v] of Object.entries(o)) {
      const cur = out[k];
      if (Array.isArray(v)) out[k] = [...new Set([...(Array.isArray(cur) ? cur : []), ...v])];
      else if (typeof v === "boolean") out[k] = Boolean(cur) || v;
      else if (typeof v === "number") out[k] = Number(cur ?? 0) + v;
      else if (typeof v === "string") out[k] = [cur, v].filter(Boolean).join(" / ");
      else out[k] = v;
    }
  }
  return out;
}


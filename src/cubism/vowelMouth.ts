/**
 * 母音で口の形を作るリップシンク。
 * riken_live2d_controller/src/audio/vowelMouth.ts を移植したもの（表の値はそのまま）。
 *
 * モデルには母音ごとのパラメータが無く、ベンダーは口を
 * ParamMouthForm (口 変形) × ParamMouthOpenY (口 開閉) の2次元の場として作っている。
 * 下の座標はベンダーの あいうえお 図から読んだもの（Form は -1..1、OpenY は 0..1）:
 *
 *     Form +1.0（横に引く列）: あ(open 1.0) → え(0.6) → い(0.3)
 *     Form  0.0（丸める列）  : お(open 1.0) →        → う(0.3)
 *
 * 母音が変に見えたらこの5つを触る。
 */

export type MouthPoint = {
  /** ParamMouthForm の目標値、-1..1 */
  form: number;
  /** ParamMouthOpenY の目標値、0..1 */
  open: number;
};

export const VOWEL_TARGETS: Record<string, MouthPoint> = {
  a: { form: 1.0, open: 1.0 },
  i: { form: 1.0, open: 0.3 },
  u: { form: 0.0, open: 0.3 },
  e: { form: 1.0, open: 0.6 },
  o: { form: 0.0, open: 1.0 },
};

/**
 * 休みの口。ベンダーモデルでは「－」の形（Form を振り切って閉じる）で、
 * Form 0 の丸い中立ではない。ん / っ / 無音 / 空白のときにこれを使う。
 * Haru のように ParamMouthForm が「への字〜笑顔」の軸になっているモデルでは
 * Form -1 は不機嫌な口になるので、ModelConfig の lipSyncRest で上書きする。
 */
export const REST: MouthPoint = { form: -1.0, open: 0.0 };

/** 再生時刻上の1母音の区間（秒）。 */
export type VowelSpan = {
  vowel: string;
  start: number;
  end: number;
};

/**
 * サーバから来た詰めた形（{t0, v, d}）を区間の列へ展開する。
 * 尺の積算はサーバ側ではなくここで行う（デモの buildVowelTimeline と同じ結果になる）。
 */
export type PackedVowelTimeline = { t0: number; v: string; d: number[] };

export function expandVowelTimeline(packed: PackedVowelTimeline): VowelSpan[] {
  const vowels = packed.v ? packed.v.split(",") : [];
  const spans: VowelSpan[] = [];
  let t = packed.t0 ?? 0;
  for (let i = 0; i < vowels.length; i++) {
    const d = packed.d[i] ?? 0;
    spans.push({ vowel: vowels[i], start: t, end: t + d });
    t += d;
  }
  return spans;
}

/** レスポンスヘッダ X-Vowel-Timeline（base64(JSON)）を区間の列へ。壊れていたら null。 */
export function decodeVowelTimelineHeader(headerValue: string | null): VowelSpan[] | null {
  if (!headerValue) return null;
  try {
    const json = JSON.parse(atob(headerValue)) as PackedVowelTimeline;
    if (typeof json.v !== "string" || !Array.isArray(json.d)) return null;
    const spans = expandVowelTimeline(json);
    return spans.length > 0 ? spans : null;
  } catch {
    return null;
  }
}

/** 時刻 t（秒）で鳴っている母音。区間外なら null。 */
export function vowelAt(timeline: VowelSpan[], t: number): string | null {
  // 単調増加なので二分探索
  let lo = 0;
  let hi = timeline.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = timeline[mid];
    if (t < span.start) hi = mid - 1;
    else if (t >= span.end) lo = mid + 1;
    else return span.vowel;
  }
  return null;
}

/** 母音に対応する口の形。null / ん / っ / 無音 / 表に無いものは休みの形。 */
export function mouthTarget(vowel: string | null, rest: MouthPoint = REST): MouthPoint {
  if (!vowel) return { ...rest };
  return VOWEL_TARGETS[vowel.toLowerCase()] ?? { ...rest };
}

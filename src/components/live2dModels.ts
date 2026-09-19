// Live2D モデル定義レジストリ。
//
// このファイルは Cubism SDK に一切依存しないので、App.tsx から静的 import しても
// 安全（Live2DCanvas.tsx は Cubism Core がブラウザ専用グローバルのため動的 import）。
// モデルごとの差異（モーションの並び、表情の実現方法、パラメータ体系、配置）はすべて
// ここの ModelConfig に閉じ込め、Live2DCanvas.tsx 側はモデル非依存に保つ。

import type { ViewTransform } from "../cubism/CubismLive2DModel";
import type { MouthPoint } from "../cubism/vowelMouth";

// ---- LLM / UI から指定できる動作・表情の語彙 ----

export type AvatarMotion =
  | "neutral"
  | "happy"
  | "sad"
  | "surprised"
  | "thinking"
  | "explaining"
  | "greeting"
  | "nod";

export type AvatarExpression =
  | "neutral"
  | "joy"
  | "anger"
  | "sorrow"
  | "fun"
  | "surprised"
  | "shy"
  | "troubled";

export type LabeledKey<T extends string> = { key: T; ja: string; en: string };

export const AVATAR_MOTIONS: LabeledKey<AvatarMotion>[] = [
  { key: "neutral", ja: "通常", en: "neutral" },
  { key: "happy", ja: "喜ぶ", en: "happy" },
  { key: "sad", ja: "悲しむ", en: "sad" },
  { key: "surprised", ja: "驚く", en: "surprised" },
  { key: "thinking", ja: "考える", en: "thinking" },
  { key: "explaining", ja: "説明する", en: "explaining" },
  { key: "greeting", ja: "あいさつ", en: "greeting" },
  { key: "nod", ja: "うなずく", en: "nod" },
];

export const AVATAR_EXPRESSIONS: LabeledKey<AvatarExpression>[] = [
  { key: "neutral", ja: "通常", en: "neutral" },
  { key: "joy", ja: "喜", en: "joy" },
  { key: "anger", ja: "怒", en: "anger" },
  { key: "sorrow", ja: "哀", en: "sorrow" },
  { key: "fun", ja: "楽", en: "fun" },
  { key: "surprised", ja: "驚き", en: "surprised" },
  { key: "shy", ja: "照れ", en: "shy" },
  { key: "troubled", ja: "困り", en: "troubled" },
];

// ---- モデル定義 ----

/** model3.json の Motions グループ名 + その中のインデックス。再生速度の既定値付き。 */
export type FileMotionEntry = { group: string; index: number; speed?: number };

/** 形態（riken モデルの 通常/五感）。形態を持たないモデルでは undefined。 */
export type AvatarFormDef = { key: string; ja: string; en: string };

export type ModelConfig = {
  id: string;
  ja: string;
  en: string;
  /** model3.json の URL（public/ 配下の絶対パス） */
  settingsUrl: string;
  /**
   * model3.json をそのまま Framework に渡せないモデル用のインメモリ補正。
   * ベンダー提供ファイルには手を入れず、読み込み時にだけ直す。
   */
  patchSettings?: (json: Record<string, unknown>) => Record<string, unknown>;
  /** 画面への収め方。scale は「キャンバスに収まる大きさ」を 1 とした倍率、offset は NDC。 */
  view: ViewTransform;
  /** 形態を持つモデルのみ */
  forms?: AvatarFormDef[];
  defaultForm?: string;
  /** まばたきを自前で駆動するか（ベンダーがまばたきを用意していないモデル向け） */
  manualBlink: boolean;
  /** マウス追従で視線と体を動かすか（ParamAngleX 等の標準パラメータを持つモデルのみ） */
  mouseTracking: boolean;
  /**
   * 母音リップシンクの「休み」の口。省略すると vowelMouth.ts の REST（Form -1 の「－」）。
   * ParamMouthForm が「への字〜笑顔」の軸になっているモデルでは Form -1 が不機嫌な口に
   * なるので、そういうモデルはここで上書きする。
   */
  lipSyncRest?: MouthPoint;
  /** 背景で回し続ける待機ループ。持たないモデルは undefined */
  resolveIdle?: (formKey: string) => FileMotionEntry | null;
  /** AvatarMotion → 単発アクションとして再生するモーション。無ければ null */
  resolveMotion: (motion: AvatarMotion, formKey: string) => FileMotionEntry | null;
  /** AvatarExpression → .exp3.json の Name。exp3 を持たないモデルは undefined */
  resolveExpression?: (expression: AvatarExpression) => string | null;
  /** exp3 を持たないモデル向け: AvatarExpression → 前景の保持ポーズとなるモーション */
  resolveExpressionMotion?: (expression: AvatarExpression, formKey: string) => FileMotionEntry | null;
};

// ---------- Haru（Cubism 公式サンプルモデル） ----------

// model3.json の Avatar グループ配列順。m01=0, m02=1, … m26=25。
// speed: 1.0 = 等速, 0.5 = 半分の速さ, 2.0 = 2倍速
const HARU_MOTION_MAP: Partial<Record<AvatarMotion, FileMotionEntry>> = {
  happy:      { group: "Avatar", index: 7,  speed: 1.5 },  // m08: 深くれい (4.6s)
  sad:        { group: "Avatar", index: 2,  speed: 1.2 },  // m03: 腕を組んで不服そう (4.6s)
  surprised:  { group: "Avatar", index: 9,  speed: 1.8 },  // m10: 大きくのけぞる (5.5s)
  thinking:   { group: "Avatar", index: 19, speed: 1.5 },  // m20: 考えるポーズ (6.0s)
  explaining: { group: "Avatar", index: 5,  speed: 1.5 },  // m06:
  greeting:   { group: "Avatar", index: 13, speed: 1.5 },  // m14: お辞儀してから顔を上げる (3.0s)
  nod:        { group: "Avatar", index: 0,  speed: 1.5 },  // m01: 短くうなずく (2.9s)
};

// Haru の .exp3.json（F01〜F08）を意味のある名前に割り当てたもの。
// 中身は expressions/*.exp3.json を確認して決めた:
//   F01 口角を少し上げる / F02 眉を下げて口を開く（叫び） / F03 眉をひそめて口をへの字
//   F04 目を細めて眉を下げる / F05 目を閉じた笑顔 / F06 目を見開いて眉を上げる
//   F07 ParamTere（照れ） / F08 軽く困った顔
// F02 は今の語彙に対応するものが無いため未使用。
const HARU_EXPRESSION_MAP: Partial<Record<AvatarExpression, string>> = {
  joy: "F05",
  anger: "F03",
  sorrow: "F04",
  fun: "F01",
  surprised: "F06",
  shy: "F07",
  troubled: "F08",
};

const haruConfig: ModelConfig = {
  id: "haru",
  ja: "Haru（公式サンプル）",
  en: "Haru (official sample)",
  settingsUrl: "/assets/models/Haru/Haru.model3.json",
  view: { scale: 0.9, offsetX: 0, offsetY: 0 },
  // まばたきは自前（Framework の CubismEyeBlink は使わず、デモと同じカーブで駆動する）。
  // 前景モーション再生中は抑止するので、目を動かす Avatar モーションとは喧嘩しない。
  manualBlink: true,
  // Haru は ParamAngle* / ParamEyeBall* / ParamBodyAngle* を持つのでマウス追従できる
  mouseTracking: true,
  // Haru の ParamMouthForm は「への字(-1)〜笑顔(+1)」なので、休みは中立(0)にする
  lipSyncRest: { form: 0, open: 0 },
  // Idle グループは空にしてある（memo.txt 参照）ので背景ループは無し
  resolveMotion: (motion) => HARU_MOTION_MAP[motion] ?? null,
  resolveExpression: (expression) => HARU_EXPRESSION_MAP[expression] ?? null,
};

// ---------- Live2D_0730（理研向けベンダーモデル） ----------
//
// riken_live2d_controller のデモと同じベンダービルド。デモの知見をそのまま踏まえている:
//   - .exp3.json を持たない。喜/怒/哀/楽は「形態ごとの全身モーション」として提供される
//     → 表情は resolveExpressionMotion 経由でモーションとして再生する
//   - あいさつ/驚き/説明/考える の4ポーズは「五感の5形態」にだけ存在し、通常(default)には無い
//   - 喜怒哀楽の命名だけ非対称: 五感は `<form>_<emotion>`、通常は `default_face_<emotion>`
//   - 嗅覚(kyuukaku) には surprise が無い
//   - 待機ループは形態対応で2種（default_idle / senses_idle）
//   - EyeBlink / LipSync グループが空 → まばたきとリップシンクはフロント側で駆動する

const RIKEN_MOTION_DIR = "motions";

/** ベンダーの model3.json は Motions を無名グループ1本にまとめ、しかもディレクトリ名が
 *  実体（motions/）と食い違う（motion/）。ファイル名をグループ名にした1件ずつのグループへ
 *  組み替えることで、インデックス計算ではなくベンダーのモーション名で指定できるようにする。 */
function rikenMotionGroups(json: Record<string, unknown>): Record<string, { File: string }[]> {
  const groups: Record<string, { File: string }[]> = {};
  const refs = json?.FileReferences as { Motions?: Record<string, { File?: string }[]> } | undefined;
  const defs = refs?.Motions ?? {};
  for (const list of Object.values(defs)) {
    for (const entry of list ?? []) {
      // .trim() はベンダーのファイル名に紛れ込んだ先頭空白対策
      const base = String(entry?.File ?? "").split("/").pop()?.trim() ?? "";
      const key = base.replace(/\.motion3\.json$/, "");
      if (!key) continue;
      groups[key] = [{ ...entry, File: `${RIKEN_MOTION_DIR}/${base}` }];
    }
  }
  return groups;
}

const RIKEN_FORMS: AvatarFormDef[] = [
  { key: "default", ja: "通常", en: "normal" },
  { key: "syokkaku", ja: "触覚", en: "touch" },
  { key: "shikaku", ja: "視覚", en: "sight" },
  { key: "mikaku", ja: "味覚", en: "taste" },
  { key: "kyuukaku", ja: "嗅覚", en: "smell" },
  { key: "tyoukaku", ja: "聴覚", en: "hearing" },
];

const RIKEN_FORM_KEYS = new Set(RIKEN_FORMS.map((f) => f.key));

/** 喜怒哀楽のモーション名。通常形態だけ `_face_` が挟まるベンダーの非対称に対応。 */
function rikenEmotionKey(formKey: string, emotion: "ki" | "do" | "ai" | "raku"): string {
  return formKey === "default" ? `default_face_${emotion}` : `${formKey}_${emotion}`;
}

/** 形態と対になる待機ループ。 */
function rikenIdleKey(formKey: string): string {
  return formKey === "default" ? "default_idle" : "senses_idle";
}

/** 未知の形態キーが来たら初期形態へ寄せる。 */
function normalizeRikenForm(formKey: string): string {
  return RIKEN_FORM_KEYS.has(formKey) ? formKey : "shikaku";
}

/** 五感形態にだけ存在するポーズ。通常形態では null（ベンダーが用意していない）。 */
function rikenPoseKey(formKey: string, pose: "greeting" | "surprise" | "teach" | "think"): string | null {
  if (formKey === "default") return null;
  // 嗅覚には surprise が無い
  if (pose === "surprise" && formKey === "kyuukaku") return null;
  return `${formKey}_${pose}`;
}

const rikenConfig: ModelConfig = {
  id: "riken",
  ja: "Live2D_0730（理研モデル）",
  en: "Live2D_0730 (RIKEN model)",
  settingsUrl: "/assets/models/Live2D_0730/Live2D.model3.json",
  patchSettings: (json) => ({
    ...json,
    FileReferences: {
      ...(json.FileReferences as Record<string, unknown>),
      Motions: rikenMotionGroups(json),
    },
  }),
  view: { scale: 0.9, offsetX: 0, offsetY: 0 },
  forms: RIKEN_FORMS,
  // 五感形態のうち、喜怒哀楽と4ポーズがすべて揃っているのは 視覚/聴覚/味覚/触覚。
  // 会話アバターとして動作の語彙を一番広く使えるよう 視覚 を初期形態にする。
  defaultForm: "shikaku",
  // EyeBlink グループが空でベンダーもまばたきを付けていないため自前で駆動する
  manualBlink: true,
  // Haru 系のパラメータ名（ParamAngle*/ParamEyeBall*）を持たないので視線追従はしない
  mouseTracking: false,
  // ベンダーは待機ループを形態対応で2本用意している。背景レイヤーで回し続ける。
  resolveIdle: (formKey) => ({ group: rikenIdleKey(normalizeRikenForm(formKey)), index: 0 }),
  resolveMotion: (motion, formKey) => {
    const form = normalizeRikenForm(formKey);
    const pose = (p: "greeting" | "surprise" | "teach" | "think") => {
      const key = rikenPoseKey(form, p);
      return key ? { group: key, index: 0 } : null;
    };
    switch (motion) {
      // 形態遷移モーション = その形態の素の立ち姿に戻る
      case "neutral": return { group: form, index: 0 };
      case "happy": return { group: rikenEmotionKey(form, "ki"), index: 0 };
      case "sad": return { group: rikenEmotionKey(form, "ai"), index: 0 };
      case "surprised": return pose("surprise");
      case "thinking": return pose("think");
      case "explaining": return pose("teach");
      case "greeting": return pose("greeting");
      case "nod": return { group: "nod", index: 0 };
      default: return null;
    }
  },
  resolveExpressionMotion: (expression, formKey) => {
    const form = normalizeRikenForm(formKey);
    switch (expression) {
      // 表情なし = その形態の素の立ち姿（形態遷移モーション）。
      // 背景の待機ループは resolveIdle が別レイヤーで回し続ける。
      case "neutral": return { group: form, index: 0 };
      case "joy": return { group: rikenEmotionKey(form, "ki"), index: 0 };
      case "anger": return { group: rikenEmotionKey(form, "do"), index: 0 };
      case "sorrow": return { group: rikenEmotionKey(form, "ai"), index: 0 };
      case "fun": return { group: rikenEmotionKey(form, "raku"), index: 0 };
      case "surprised": {
        const key = rikenPoseKey(form, "surprise");
        return key ? { group: key, index: 0 } : null;
      }
      // 照れ / 困り はベンダーが用意していない
      default: return null;
    }
  },
};

// ---------- レジストリ ----------

export const AVATAR_MODELS: ModelConfig[] = [haruConfig, rikenConfig];

export const DEFAULT_MODEL_ID = haruConfig.id;

export function getModelConfig(id: string | null | undefined): ModelConfig {
  return AVATAR_MODELS.find((m) => m.id === id) ?? haruConfig;
}

/** そのモデルの初期形態。形態を持たないモデルは空文字。 */
export function defaultFormOf(config: ModelConfig): string {
  return config.defaultForm ?? config.forms?.[0]?.key ?? "";
}

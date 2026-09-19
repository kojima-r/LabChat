import { useEffect, useRef, useState } from "react";

// ⚠ CubismRuntime / CubismLive2DModel は @framework/* を静的 import しており、
// Framework 側は「モジュール評価時」にグローバルの Live2DCubismCore を参照する
// （cubismmodel.ts の enum CubismColorBlend が Live2DCubismCore.ColorBlendType_* で初期化される）。
// つまり Core の <script> を読み込む前にこれらを import すると
// `ReferenceError: Live2DCubismCore is not defined` で即死する。
// そのため値としては ensureCubismCore() の後に await import(...) で取り、
// ここでは型だけを静的に取る。静的 import に戻さないこと。
import type { CubismLive2DModel, ViewTransform } from "../cubism/CubismLive2DModel";
// こちらは Framework に依存しない純粋な計算なので静的で良い
import { opennessFromRms, rms, smoothOpenness } from "../cubism/lipSyncMath";
import { mouthTarget, vowelAt, type VowelSpan } from "../cubism/vowelMouth";
import {
  DEFAULT_MODEL_ID,
  defaultFormOf,
  getModelConfig,
  type AvatarExpression,
  type AvatarMotion,
  type ModelConfig,
} from "./live2dModels";

export type { AvatarExpression, AvatarMotion } from "./live2dModels";

// ===== デバッグログ =====
// モデル読み込みと描画はブラウザでしか動かないので、どこで止まったかはコンソールが唯一の手掛かり。
// 切りたいときは DevTools で `localStorage.live2dDebug = "0"` してリロード。
// 警告・エラーは常に出す。
// localStorage は同期アクセスなので、描画ループから毎フレーム読まないよう1回だけ評価する
// （リロードで反映、という前提はドキュメントどおり）。
const DEBUG_ENABLED = (() => {
  try {
    return localStorage.getItem("live2dDebug") !== "0";
  } catch {
    return true;
  }
})();
function debugEnabled(): boolean {
  return DEBUG_ENABLED;
}
// 起点はページの読み込み開始（performance.now() の原点）。
// モジュール評価時刻を起点にすると、それ以前にかかった時間が見えなくなる。
function stamp(): string {
  return `[Live2D +${(performance.now() / 1000).toFixed(2)}s]`;
}
function dlog(...args: unknown[]): void {
  if (debugEnabled()) console.log(stamp(), ...args);
}
function dwarn(...args: unknown[]): void {
  console.warn(stamp(), ...args);
}
function derr(...args: unknown[]): void {
  console.error(stamp(), ...args);
}

/** Cubism Core のバージョンと、対応している moc3 フォーマットの上限 */
type CubismCoreLike = {
  Version: {
    csmGetVersion: () => number;
    csmGetLatestMocVersion: () => number;
  };
};

function coreInfo(): { version: string; latestMoc: number } | null {
  const core = window.Live2DCubismCore as CubismCoreLike | undefined;
  if (!core?.Version) return null;
  const v = core.Version.csmGetVersion();
  return {
    version: `${(v >> 24) & 0xff}.${(v >> 16) & 0xff}.${v & 0xffff}`,
    latestMoc: core.Version.csmGetLatestMocVersion(),
  };
}

// moc3 のバイト4がフォーマット版。Core の MocVersion_* 定数と同じ番号。
const MOC_VERSION_LABEL: Record<number, string> = {
  1: "Cubism 3.0",
  2: "Cubism 3.3",
  3: "Cubism 4.0",
  4: "Cubism 4.2",
  5: "Cubism 5.0",
  6: "Cubism 5.3",
};

/**
 * moc3 のフォーマット版が Core の対応上限を超えていないか、読み込み前に調べる。
 * 超えていると Core が moc を構築できず分かりにくい失敗になるので、ここで名指しで報告する。
 * 先頭5バイトしか要らないので Range で頭だけ取る（ベンダーモデルの moc3 は 90MB を超える）。
 */
async function checkMocVersion(settingsUrl: string, mocPath: string): Promise<void> {
  const info = coreInfo();
  if (!info) return;
  try {
    const mocUrl = new URL(mocPath, new URL(settingsUrl, location.href)).pathname;
    const res = await fetch(mocUrl, {
      headers: { Range: "bytes=0-15" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      dwarn(`moc3 を取得できません: ${mocUrl} -> HTTP ${res.status}`);
      return;
    }
    let head: Uint8Array;
    let totalBytes: number | undefined;
    if (res.status === 206) {
      totalBytes = Number(res.headers.get("content-range")?.split("/")[1]) || undefined;
      head = new Uint8Array(await res.arrayBuffer());
    } else if (res.body) {
      // Range が効かなかった → 全体を落とさないよう先頭チャンクだけ読んで打ち切る
      totalBytes = Number(res.headers.get("content-length")) || undefined;
      const reader = res.body.getReader();
      const first = await reader.read();
      void reader.cancel();
      head = first.value ?? new Uint8Array();
    } else {
      head = new Uint8Array(await res.arrayBuffer());
    }
    if (head.length < 5) {
      dwarn(`moc3 の先頭を読めませんでした: ${mocUrl} (${head.length} バイト)`);
      return;
    }
    const magic = String.fromCharCode(...head.subarray(0, 4));
    const mocVersion = head[4];
    const label = MOC_VERSION_LABEL[mocVersion] ?? "unknown";
    const sizeText = totalBytes ? ` size=${(totalBytes / 1048576).toFixed(1)}MB` : "";
    dlog(`moc3: ${mocUrl} magic=${magic} version=${mocVersion} (${label})${sizeText}`);
    if (magic !== "MOC3") {
      dwarn(`moc3 のマジックが不正です (${magic})。ファイルが壊れている可能性があります。`);
      return;
    }
    if (mocVersion > info.latestMoc) {
      derr(
        `moc3 のフォーマット版がこの Cubism Core では読めません。\n` +
          `  moc3        : version ${mocVersion} (${label})\n` +
          `  Core 対応上限: version ${info.latestMoc} (${MOC_VERSION_LABEL[info.latestMoc] ?? "unknown"})  Core ${info.version}\n` +
          `  → public/assets/live2dcubismcore.min.js を新しい Cubism SDK for Web の Core に差し替えてください。`,
      );
    }
    if (totalBytes && totalBytes > 20 * 1048576) {
      dwarn(
        `moc3 が ${(totalBytes / 1048576).toFixed(1)}MB あります。初回の読み込みに時間がかかります` +
          `（ブラウザキャッシュに乗れば2回目以降は速くなります）。`,
      );
    }
  } catch (e) {
    dwarn("moc3 バージョン確認に失敗:", e);
  }
}

/** Cubism Core は browser-only グローバルなので <script> で先に読み込む */
async function ensureCubismCore(): Promise<void> {
  if (window.Live2DCubismCore) {
    dlog("Cubism Core: 既に読み込み済み");
  } else {
    dlog("Cubism Core: /assets/live2dcubismcore.min.js を読み込みます");
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "/assets/live2dcubismcore.min.js";
      s.onload = () => res(0);
      s.onerror = () =>
        rej(new Error("Failed to load Cubism Core (/assets/live2dcubismcore.min.js)"));
      document.head.appendChild(s);
    });
    dlog("Cubism Core: 読み込み完了");
  }
  const info = coreInfo();
  if (info) {
    dlog(
      `Cubism Core ${info.version} / 対応 moc3 上限 version ${info.latestMoc} ` +
        `(${MOC_VERSION_LABEL[info.latestMoc] ?? "unknown"})`,
    );
  } else {
    dwarn("Cubism Core のバージョンを取得できませんでした（Version API なし）");
  }
}

/** これ以下の RMS は無音とみなす（ログを出す/止める判定用）。 */
const SILENCE_RMS = 0.001;

/** MediaStream の音量から口の開きを出すメータ。算出は cubism/lipSyncMath.ts（デモ由来）。 */
type LipSyncMeter = {
  /** 平滑化済みの開き具合 0..1 */
  read: () => number;
  /** 直近に読んだ生の RMS（無音なら 0）。診断用 */
  lastRms: () => number;
  dispose: () => void;
};

function createLipSyncMeter(ctx: AudioContext, source: AudioNode): LipSyncMeter {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  // AnalyserNode は destination へ至る経路に入っていないとブラウザに処理されず、
  // getFloatTimeDomainData が常に無音を返すことがある（＝口が動かない）。
  // 音の出力経路は変えたくないので、ゲイン 0 の出口を足して経路だけ成立させる。
  const silentSink = ctx.createGain();
  silentSink.gain.value = 0;
  analyser.connect(silentSink);
  silentSink.connect(ctx.destination);

  const buf = new Float32Array(analyser.fftSize);
  let openness = 0;
  let lastRms = 0;
  return {
    read() {
      analyser.getFloatTimeDomainData(buf);
      lastRms = rms(buf);
      openness = smoothOpenness(openness, opennessFromRms(lastRms));
      return openness;
    },
    lastRms: () => lastRms,
    dispose() {
      for (const [from, to] of [
        [source, analyser],
        [analyser, silentSink],
        [silentSink, ctx.destination],
      ] as const) {
        try {
          from.disconnect(to);
        } catch {
          /* 既に切れている */
        }
      }
    },
  };
}

/** VOICEVOX の母音タイムラインと、その音声を鳴らしている <audio>。 */
export type LipSyncTimeline = {
  timeline: VowelSpan[];
  /** 再生位置を読む元。timeline の t=0 はこの要素の currentTime 0 に対応する */
  audio: HTMLAudioElement;
};

type Live2DCanvasProps = {
  audioStream?: MediaStream | null;
  /**
   * 母音ベースのリップシンク（日本語 TTS のとき）。
   * 無い場合（英語 TTS / バッチ再生）は audioStream の音量だけで口を開閉する。
   */
  lipSync?: LipSyncTimeline | null;
  /** 表示するモデル (live2dModels.ts の ModelConfig.id) */
  modelId?: string;
  /** 形態を持つモデル（riken）のみ有効 */
  form?: string | null;
  motion?: AvatarMotion | null;
  expression?: AvatarExpression | null;
  onMotionPhaseChange?: (phase: string) => void;
  onExpressionPhaseChange?: (phase: string) => void;
  canvasWidth?: number;
  canvasHeight?: number;
  /** 画面への収め方の上書き（省略時は ModelConfig.view）。デバッグパネルから触れる。 */
  viewScale?: number;
  viewOffsetX?: number;
  viewOffsetY?: number;
};

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
    webkitAudioContext?: typeof AudioContext;
    /** デバッグ用。コンソールから現在のモデル / 設定を覗く */
    __live2d?: {
      getModel: () => CubismLive2DModel | null;
      getConfig: () => ModelConfig;
      getView: () => ViewTransform;
      mouth: () => Record<string, unknown>;
    };
  }
}

export default function Live2DCanvas({
  audioStream,
  lipSync,
  modelId = DEFAULT_MODEL_ID,
  form,
  motion,
  expression,
  onMotionPhaseChange,
  onExpressionPhaseChange,
  canvasWidth = 600,
  canvasHeight = 800,
  viewScale,
  viewOffsetX,
  viewOffsetY,
}: Live2DCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const didInit = useRef(false);
  type LoadPhase = "core" | "model" | "done";
  const [loadPhase, setLoadPhase] = useState<LoadPhase>("core");
  // 読み込み失敗時のメッセージ。「Loading model…」のまま無言で固まらないよう画面にも出す。
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modelReady, setModelReady] = useState(0);

  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const modelRef = useRef<CubismLive2DModel | null>(null);
  const config = getModelConfig(modelId);
  const formKey = form ?? defaultFormOf(config);

  // 描画ループから常に最新を読むための ref
  const configRef = useRef<ModelConfig>(config);
  const viewRef = useRef<ViewTransform>(config.view);
  const mouseRef = useRef({ x: 0, y: 0, inside: false });
  const meterRef = useRef<LipSyncMeter | null>(null);
  const lipSyncRef = useRef<LipSyncTimeline | null>(null);
  // 口の形の平滑化（デモの LipSyncDriver と同じく前回値から寄せる）
  const mouthRef = useRef({ open: 0, form: 0 });
  const onMotionPhaseChangeRef = useRef(onMotionPhaseChange);
  const onExpressionPhaseChangeRef = useRef(onExpressionPhaseChange);
  // いま描画しているモデルの id。読み込み完了までは前のモデルなので、
  // その間 apply 系 effect は何もしない（configRef と modelRef のズレを防ぐ）。
  const loadedModelIdRef = useRef<string | null>(null);

  // 描画ループ / 非同期処理から読む値を ref に同期する（描画中に ref を触らない）。
  // 以降の effect より先に宣言してあるので、下の effect からは常に最新が読める。
  useEffect(() => {
    configRef.current = getModelConfig(modelId);
    viewRef.current = {
      scale: viewScale ?? config.view.scale,
      offsetX: viewOffsetX ?? config.view.offsetX,
      offsetY: viewOffsetY ?? config.view.offsetY,
    };
    lipSyncRef.current = lipSync ?? null;
    onMotionPhaseChangeRef.current = onMotionPhaseChange;
    onExpressionPhaseChangeRef.current = onExpressionPhaseChange;
  });

  // ====== WebGL2 + Cubism Framework + 描画ループ（1回だけ） ======
  useEffect(() => {
    if (import.meta.env.SSR) return;
    if (didInit.current) return;
    didInit.current = true;

    let raf = 0;
    (async () => {
      dlog("=== Live2DCanvas 初期化 ===");
      await ensureCubismCore();

      const canvas = canvasRef.current;
      if (!canvas) {
        derr("canvas 要素が見つかりません");
        return;
      }
      const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true });
      if (!gl) {
        derr("WebGL2 が使えません");
        setLoadError("WebGL2 が使えないため Live2D を表示できません。");
        return;
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      // Core が居る状態になってから Framework を読み込む（上の注意書き参照）
      const { CubismRuntime } = await import("../cubism/CubismRuntime");
      CubismRuntime.start((msg) => dlog("[CSM]", msg));
      dlog(`WebGL2 + CubismFramework 初期化完了 (${canvas.width}x${canvas.height})`);

      // gl の公開は Framework の準備が済んでから（モデル読み込み effect がこれを待つ）
      glRef.current = gl;
      setLoadPhase("model");

      window.__live2d = {
        getModel: () => modelRef.current,
        getConfig: () => configRef.current,
        getView: () => viewRef.current,
        // リップシンクが動かないときの一次切り分け用
        mouth: () => ({
          ...(modelRef.current?.mouthState ?? {}),
          source: lipSyncRef.current ? "母音" : meterRef.current ? "音量" : "なし",
          timelineSpans: lipSyncRef.current?.timeline.length ?? 0,
          audioTime: lipSyncRef.current?.audio.currentTime ?? null,
        }),
      };
      dlog("window.__live2d でコンソールから getModel() / getConfig() / getView() を参照できます");

      // ====== 描画ループ ======
      let last = performance.now();
      let lipSyncLoggedAt = 0;
      let lipSyncWasSpeaking = false;
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        // タブ復帰時の巨大な dt でモーションが飛ばないよう上限を設ける
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        const model = modelRef.current;
        if (!model) return;
        const cfg = configRef.current;

        // ---- リップシンク ----
        // 母音タイムラインがあるときは、デモと同じく開き具合も母音から取る（音量で変調しない）。
        // そうしないと「あ」が音量次第で申し訳程度にしか開かなくなる。
        // タイムラインが無いとき（英語 TTS / バッチ再生）は音量だけで開閉し、
        // 口の形（ParamMouthForm）はモーションに任せる。
        const ls = lipSyncRef.current;
        const meter = meterRef.current;
        const mouth = mouthRef.current;
        if (ls) {
          const vowel = vowelAt(ls.timeline, ls.audio.currentTime);
          const target = mouthTarget(vowel, cfg.lipSyncRest);
          mouth.open = smoothOpenness(mouth.open, target.open);
          mouth.form = smoothOpenness(mouth.form, target.form);
          model.setLipSync(mouth.open, mouth.form);
        } else if (meter) {
          mouth.open = meter.read();
          mouth.form = 0;
          model.setLipSync(mouth.open, null);
        } else {
          mouth.open = 0;
          mouth.form = 0;
          model.clearLipSync();
        }

        // マウス追従の視線
        if (cfg.mouseTracking && mouseRef.current.inside) {
          model.setGaze(mouseRef.current.x, mouseRef.current.y);
        } else {
          model.clearGaze();
        }

        model.update(dt);
        model.draw(gl.drawingBufferWidth, gl.drawingBufferHeight, viewRef.current);

        // ---- リップシンクのログ ----
        // 喋っている間だけ出す。audioStream は発話が終わっても残り続けるので、
        // メータの有無だけで判定するとコンソールが延々と埋まる。
        const speaking = ls
          ? !ls.audio.paused && !ls.audio.ended
          : meter
            ? meter.lastRms() > SILENCE_RMS
            : false;
        if (speaking !== lipSyncWasSpeaking) {
          lipSyncWasSpeaking = speaking;
          if (speaking) {
            lipSyncLoggedAt = 0; // 開始直後に1行出す
            dlog(
              ls
                ? `lipsync 開始 [母音] 区間${ls.timeline.length}件 / 全長 ${ls.timeline[ls.timeline.length - 1].end.toFixed(2)}秒`
                : "lipsync 開始 [音量]",
            );
          } else {
            dlog("lipsync 終了");
          }
        }
        if (debugEnabled() && speaking && now - lipSyncLoggedAt > 1000) {
          lipSyncLoggedAt = now;
          const m = model.mouthState;
          if (ls) {
            const vowel = vowelAt(ls.timeline, ls.audio.currentTime);
            dlog(
              `lipsync[母音] t=${ls.audio.currentTime.toFixed(2)}s vowel=${vowel ?? "-"}` +
                ` → open=${m.open.toFixed(2)} form=${m.form === null ? "-" : m.form.toFixed(2)}` +
                ` / モデル ParamMouthOpenY=${m.openValue?.toFixed(2) ?? "n/a"}` +
                ` ParamMouthForm=${m.formValue?.toFixed(2) ?? "n/a"}`,
            );
          } else {
            dlog(
              `lipsync[音量] rms=${meter!.lastRms().toFixed(4)} open=${m.open.toFixed(2)}` +
                ` / モデル ParamMouthOpenY=${m.openValue?.toFixed(2) ?? "n/a"}`,
            );
          }
        }
      };
      raf = requestAnimationFrame(frame);
    })().catch((e) => {
      derr("初期化に失敗しました:", e);
      setLoadError(`Live2D の初期化に失敗しました: ${String(e?.message ?? e)}`);
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      modelRef.current?.release();
      modelRef.current = null;
      glRef.current = null;
    };
    // canvasWidth / canvasHeight は生成時の1回だけ効く
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ====== マウス追従 ======
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = {
        // キャンバス中心を 0、端を ±1 にする
        x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
        y: -(((e.clientY - rect.top) / rect.height) * 2 - 1),
        inside: true,
      };
    };
    // キャンバスは pointerEvents: none の層に載っているので window で拾う
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // ====== モデルの読み込み / 切り替え ======
  useEffect(() => {
    if (import.meta.env.SSR) return;
    let cancelled = false;
    const target = getModelConfig(modelId);

    (async () => {
      dlog(`=== モデル読み込み開始: "${modelId}" (${target.ja}) ===`);

      // WebGL の初期化待ち（初回のみ）
      if (!glRef.current) dlog("WebGL2 の初期化を待っています…");
      const waitStart = performance.now();
      while (!glRef.current && !cancelled) {
        if (performance.now() - waitStart > 15000) {
          derr("WebGL2 が 15 秒経っても初期化されません。初期化 effect のログを確認してください。");
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      const gl = glRef.current;
      if (!gl || cancelled) {
        dlog(`中断: gl=${!!gl} cancelled=${cancelled}`);
        return;
      }

      setLoadPhase("model");
      setLoadError(null);

      // moc3 が Core で読めるフォーマットかを先に確認して、読めないなら名指しで警告する。
      // （model3.json から Moc のパスを拾うため、ここだけ先に JSON を見る）
      try {
        const res = await fetch(target.settingsUrl);
        if (res.ok) {
          const json = (await res.json()) as { FileReferences?: { Moc?: string } };
          const mocPath = json.FileReferences?.Moc;
          if (mocPath) await checkMocVersion(target.settingsUrl, mocPath);
        }
      } catch (e) {
        dwarn("model3.json の先読みに失敗（読み込み本体は続行します）:", e);
      }
      if (cancelled) {
        dlog("中断: moc 確認後");
        return;
      }

      // Framework は Core 読み込み後でないと評価できないので、ここで初めて値を取る
      const { CubismLive2DModel } = await import("../cubism/CubismLive2DModel");
      const loaded = await CubismLive2DModel.load(gl, {
        settingsUrl: target.settingsUrl,
        patchSettings: target.patchSettings,
        manualBlink: target.manualBlink,
        log: (msg) => dlog(" ", msg),
        warn: (msg, ...rest) => dwarn(" ", msg, ...rest),
      });
      if (cancelled) {
        dlog("中断: モデル読み込み後 — 破棄します");
        loaded.release();
        return;
      }

      const size = loaded.canvasSize;
      dlog(
        `モデル内容: canvas ${size.width.toFixed(2)}x${size.height.toFixed(2)} 単位` +
          ` / モーショングループ ${loaded.motionGroups.length}件 / 表情 ${loaded.expressionNames.length}件`,
      );
      dlog("  モーショングループ:", loaded.motionGroups);
      dlog(
        "  表情:",
        loaded.expressionNames.length ? loaded.expressionNames : "(なし — exp3 を持たないモデル)",
      );

      // 旧モデルを差し替え
      const prev = modelRef.current;
      if (prev) {
        dlog(`旧モデル (${loadedModelIdRef.current}) を破棄します`);
        prev.release();
      }
      modelRef.current = loaded;
      // 描画ループと apply 系 effect が見る設定をモデルと同時に切り替える
      configRef.current = target;
      loadedModelIdRef.current = target.id;
      setLoadPhase("done");
      // 各 apply 系 effect をモデル読み込み後に走らせる
      setModelReady((n) => n + 1);
      dlog(`=== モデル読み込み完了: "${target.id}" ===`);
    })().catch((e) => {
      derr(`モデル読み込みが例外で終了しました: "${modelId}"`, e);
      setLoadError(`モデルの読み込みに失敗しました: ${String(e?.message ?? e)}`);
    });

    return () => {
      cancelled = true;
    };
  }, [modelId]);

  // ====== モーション / 表情 / 形態 の適用 ======
  //
  // 3つのレイヤーへの振り分けをここ1箇所で決める（デモの3層構成に対応）:
  //   背景  … 形態と対になる待機ループ。形態が変わったときだけ差し替える
  //   前景  … 表情＝保持ポーズ。exp3 を持つモデルは独立した exp3 レイヤーへ流す
  //   単発  … motion prop。終わると Framework 側でオーバーレイが外れ保持ポーズへ戻る
  const lastAppliedRef = useRef({
    modelId: "",
    form: "",
    motion: undefined as AvatarMotion | null | undefined,
    expression: undefined as AvatarExpression | null | undefined,
    ready: -1,
  });

  useEffect(() => {
    const cfg = getModelConfig(modelId);
    const motionName = motion ?? "neutral";
    const expressionName = expression ?? "neutral";

    // 切り替え後のモデルの読み込みが終わるまでは触らない。
    // （lastAppliedRef を更新せずに戻るので、読み込み完了時に改めて全部適用される）
    const model = modelRef.current;
    if (!model || loadedModelIdRef.current !== modelId) {
      dlog(
        `apply スキップ（モデル待ち）: 要求=${modelId} 読み込み済み=${loadedModelIdRef.current ?? "なし"}`,
      );
      return;
    }

    const last = lastAppliedRef.current;
    const reloaded = last.ready !== modelReady || last.modelId !== modelId;
    const formChanged = !reloaded && last.form !== formKey;
    const motionChanged = !reloaded && last.motion !== motion;
    const expressionChanged = !reloaded && last.expression !== expression;
    lastAppliedRef.current = { modelId, form: formKey, motion, expression, ready: modelReady };
    dlog(
      `apply: model=${modelId} form=${formKey || "-"} motion=${motion ?? "null"} expression=${expression ?? "null"}` +
        ` [${[reloaded && "reloaded", formChanged && "form", motionChanged && "motion", expressionChanged && "expression"].filter(Boolean).join(",") || "変化なし"}]`,
    );

    // --- 背景レイヤー: 形態と対になる待機ループ ---
    if (cfg.resolveIdle && (reloaded || formChanged)) {
      const idle = cfg.resolveIdle(formKey);
      if (idle) void model.playIdle(idle.group, idle.index);
      else model.stopIdle();
    }

    // --- 前景レイヤー（= 表情。保持ポーズ）---
    if (reloaded || formChanged || expressionChanged) {
      if (cfg.resolveExpression) {
        // .exp3.json を持つモデル: モーションと独立したレイヤーに当てる
        const expId = cfg.resolveExpression(expressionName);
        if (expId) {
          void model.setExpression(expId).then((ok) => {
            onExpressionPhaseChangeRef.current?.(ok ? `exp:${expId}` : `exp:failed(${expId})`);
          });
        } else {
          model.resetExpression();
          onExpressionPhaseChangeRef.current?.("exp:none");
        }
      } else if (cfg.resolveExpressionMotion) {
        // exp3 を持たないモデル: ベンダーの喜怒哀楽モーションを保持ポーズとして前景に置く
        const entry = cfg.resolveExpressionMotion(expressionName, formKey);
        if (entry) {
          void model.playMotion(entry.group, entry.index, { layer: "foreground" }).then((ok) => {
            onExpressionPhaseChangeRef.current?.(
              ok ? `motion:${entry.group}` : `motion:failed(${entry.group})`,
            );
          });
        } else {
          onExpressionPhaseChangeRef.current?.(`none:${expressionName}`);
        }
      } else {
        onExpressionPhaseChangeRef.current?.("unsupported");
      }
    }

    // --- 単発レイヤー（= motion prop）---
    // 終了後は Framework 側でオーバーレイが外れ、前景の保持ポーズがそのまま戻る。
    if (motionChanged && motionName !== "neutral") {
      const entry = cfg.resolveMotion(motionName, formKey);
      if (entry) {
        void model.playMotion(entry.group, entry.index, { layer: "action" }).then((ok) => {
          onMotionPhaseChangeRef.current?.(
            ok ? `action:${entry.group}` : `action:failed(${entry.group})`,
          );
        });
      } else {
        // このモデル・形態にはそのモーションが無い（例: 通常形態のあいさつ）
        onMotionPhaseChangeRef.current?.(`none:${motionName}`);
      }
    } else if (motionChanged) {
      // neutral に戻す → 単発レイヤーが空になり保持ポーズだけになる
      onMotionPhaseChangeRef.current?.("idle");
    }
  }, [motion, expression, formKey, modelId, modelReady]);

  // ====== リップシンク（audioStream ごとに WebAudio グラフを作り直す） ======
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);

  useEffect(() => {
    meterRef.current?.dispose();
    meterRef.current = null;
    try {
      srcNodeRef.current?.disconnect();
    } catch {
      /* 既に切れている */
    }
    srcNodeRef.current = null;

    if (!audioStream) return;

    let disposed = false;
    const ensureTracks = async () => {
      if (audioStream.getAudioTracks().length > 0) return;
      await new Promise<void>((resolve) => {
        const onAdd = () => {
          if (audioStream.getAudioTracks().length > 0) {
            audioStream.removeEventListener?.("addtrack", onAdd);
            resolve();
          }
        };
        audioStream.addEventListener?.("addtrack", onAdd);
        setTimeout(() => {
          audioStream.removeEventListener?.("addtrack", onAdd);
          resolve();
        }, 3000);
      });
    };

    (async () => {
      await ensureTracks();
      if (disposed) return;
      if (audioStream.getAudioTracks().length === 0) {
        dwarn(
          "audioStream に音声トラックが現れませんでした（captureStream が空）。" +
            "音量ベースのリップシンクは動きません。",
        );
        return;
      }

      const ctx = (audioCtxRef.current ||= new (window.AudioContext ||
        window.webkitAudioContext!)());
      if (ctx.state !== "running") await ctx.resume();
      if (disposed) return;

      const src = ctx.createMediaStreamSource(audioStream);
      // 従来どおり出力にも繋ぐ（音の経路は変えない）
      src.connect(ctx.destination);
      srcNodeRef.current = src;
      meterRef.current = createLipSyncMeter(ctx, src);
      dlog(
        `音量メータを構築しました (AudioContext=${ctx.state}, 音声トラック=${audioStream.getAudioTracks().length}件)`,
      );
    })().catch((e) => dwarn("リップシンクの構築に失敗:", e));

    return () => {
      disposed = true;
      meterRef.current?.dispose();
      meterRef.current = null;
      try {
        srcNodeRef.current?.disconnect();
      } catch {
        /* 既に切れている */
      }
      srcNodeRef.current = null;
    };
  }, [audioStream]);

  return (
    <div style={{ position: "relative" }}>
      {(loadPhase !== "done" || loadError) && (
        <p
          style={{
            position: "absolute",
            top: "40%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            opacity: loadError ? 0.95 : 0.7,
            color: loadError ? "#ff6b6b" : undefined,
            fontSize: loadError ? "1rem" : "2rem",
            maxWidth: "80%",
            zIndex: 10,
            pointerEvents: "none",
            whiteSpace: loadError ? "pre-wrap" : "nowrap",
          }}
        >
          {loadError ?? (loadPhase === "core" ? "Loading Live2D…" : "Loading model…")}
        </p>
      )}
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={canvasHeight}
        style={{ width: canvasWidth, height: canvasHeight, display: "block" }}
      />
    </div>
  );
}

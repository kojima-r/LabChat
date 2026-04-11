import { useEffect, useRef, useState } from "react";

import type { Application as PixiApplication } from "pixi.js";

type LoudnessMeterOptions = {
  smoothing?: number;
  gate?: number;
  gain?: number;
};

type LoudnessMeter = {
  get: () => number;
  analyser: AnalyserNode;
};

type Live2DModelLike = {
  x: number;
  y: number;
  scale: { set: (scale: number) => void };
  internalModel: {
    motionManager: {
      stopAllMotions: () => void;
      isFinished: () => boolean;
    };
    coreModel: {
      setParameterValueById: (id: string, value: number) => void;
      getParameterValueById: (id: string) => number;
    };
  };
  motion: (group: string, index?: number, priority?: number) => Promise<void>;
  update: (delta: number, autoUpdate?: boolean) => void;
  enableLipSyncFromNode?: (node: AudioNode) => unknown;
  lipSync?: { connectNode?: (node: AudioNode) => unknown };
};

export type AvatarMotion =
  | "neutral"
  | "happy"
  | "sad"
  | "surprised"
  | "thinking"
  | "explaining"
  | "greeting"
  | "nod";

type MotionParams = {
  ParamAngleX?: number;
  ParamAngleY?: number;
  ParamAngleZ?: number;
  ParamEyeLOpen?: number;
  ParamEyeROpen?: number;
  ParamBrowLY?: number;
  ParamBrowRY?: number;
  ParamMouthForm?: number;
  ParamMouthOpenY?: number;
  ParamBodyAngleX?: number;
  ParamBodyAngleY?: number;
  ParamBodyAngleZ?: number;
  ParamArmLA?: number;
  ParamArmRA?: number;
  ParamArmLB?: number;
  ParamArmRB?: number;
  ParamHandAngleL?: number;
  ParamHandAngleR?: number;
};

const MOTION_PRESETS: Record<AvatarMotion, MotionParams> = {
  neutral: {},
  happy: {
    ParamBrowLY: 1,
    ParamBrowRY: 1,
    ParamMouthForm: 1,
    ParamEyeLOpen: 1.2,
    ParamEyeROpen: 1.2,
    ParamAngleZ: 8,
    ParamBodyAngleX: 5,
    ParamArmLA: 0.6,
    ParamArmRA: 0.6,
    ParamHandAngleL: 0.4,
    ParamHandAngleR: 0.4,
  },
  sad: {
    ParamBrowLY: -1,
    ParamBrowRY: -1,
    ParamMouthForm: -1,
    ParamAngleY: 20,
    ParamAngleZ: -6,
    ParamEyeLOpen: 0.4,
    ParamEyeROpen: 0.4,
    ParamBodyAngleX: -5,
    ParamBodyAngleY: -3,
    ParamArmLA: -0.5,
    ParamArmRA: -0.5,
    ParamArmLB: -0.3,
    ParamArmRB: -0.3,
  },
  surprised: {
    ParamEyeLOpen: 1.6,
    ParamEyeROpen: 1.6,
    ParamBrowLY: 1.5,
    ParamBrowRY: 1.5,
    ParamMouthOpenY: 1,
    ParamAngleY: -8,
    ParamBodyAngleX: -8,
    ParamArmLA: 0.8,
    ParamArmRA: 0.8,
    ParamArmLB: 0.5,
    ParamArmRB: 0.5,
    ParamHandAngleL: 0.6,
    ParamHandAngleR: 0.6,
  },
  thinking: {
    ParamAngleX: 25,
    ParamAngleY: -15,
    ParamAngleZ: -10,
    ParamBrowLY: 0.6,
    ParamBrowRY: -0.6,
    ParamEyeLOpen: 0.5,
    ParamEyeROpen: 0.5,
    ParamBodyAngleX: -10,
    ParamArmRA: 0.8,
    ParamArmRB: 0.6,
    ParamHandAngleR: 0.8,
  },
  explaining: {
    ParamBodyAngleX: 15,
    ParamBodyAngleZ: 5,
    ParamAngleX: 12,
    ParamAngleZ: 5,
    ParamBrowLY: 0.8,
    ParamBrowRY: 0.8,
    ParamMouthForm: 0.5,
    ParamEyeLOpen: 1.1,
    ParamEyeROpen: 1.1,
    ParamArmLA: 1,
    ParamArmRA: 1,
    ParamArmLB: 0.8,
    ParamArmRB: 0.8,
    ParamHandAngleL: 0.7,
    ParamHandAngleR: 0.7,
  },
  greeting: {
    ParamAngleY: 25,
    ParamAngleZ: 10,
    ParamBrowLY: 1,
    ParamBrowRY: 1,
    ParamMouthForm: 1,
    ParamEyeLOpen: 1.2,
    ParamEyeROpen: 1.2,
    ParamBodyAngleX: 8,
    ParamArmRA: 1,
    ParamArmRB: 0.6,
    ParamHandAngleR: 0.8,
  },
  nod: {
    ParamAngleY: 30,
    ParamBrowLY: 0.6,
    ParamBrowRY: 0.6,
    ParamMouthForm: 0.5,
    ParamBodyAngleX: 5,
    ParamArmLA: 0.3,
    ParamArmRA: 0.3,
  },
};

// モーション名 → ファイルモーション (Avatar グループのインデックス + 再生速度)
// m01=0, m02=1, ... m26=25 (model3.json の Avatar 配列順)
// speed: 1.0 = 等速, 0.5 = 半分の速さ, 2.0 = 2倍速
type FileMotionEntry = { index: number; speed?: number };
const MOTION_FILE_MAP: Partial<Record<AvatarMotion, FileMotionEntry>> = {
  happy:      { index: 7,  speed: 1.5 },  // m08: 深くれい (4.6s)
  sad:        { index: 2,  speed: 1.2 },  // m03: 腕を組んで不服そう (4.6s)
  surprised:  { index: 9,  speed: 1.8 },  // m10: 大きくのけぞる (5.5s)
  thinking:   { index: 19, speed: 1.5 },  // m20: 考えるポーズ (6.0s)
  explaining: { index: 5,  speed: 1.5 },  // m06:
  greeting:   { index: 13, speed: 1.5 },  // m14: お辞儀してから顔を上げる (3.0s)
  nod:        { index: 0,  speed: 1.5 },  // m01: 短くうなずく (2.9s)
};

type Live2DCanvasProps = {
  audioStream?: MediaStream | null;
  motion?: AvatarMotion | null;
  /** ファイルモーション再生速度の上書き (省略時は MOTION_FILE_MAP の speed を使用) */
  motionSpeed?: number;
  onMotionPhaseChange?: (phase: string) => void;
  canvasWidth?: number;
  canvasHeight?: number;
  left?: number;
  top?: number;
  scale?: number;
};

declare global {
  interface Window {
    Live2DCubismCore?: unknown;
    webkitAudioContext?: typeof AudioContext;
  }
}

/** 簡易RMSメータ（平滑化＆ゲート） */
function createLoudnessMeter(
  audioCtx: BaseAudioContext,
  sourceNode: AudioNode,
  { smoothing = 0.25, gate = 0.02, gain = 10 }: LoudnessMeterOptions = {},
): LoudnessMeter {
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  sourceNode.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  let smooth = 0;
  return {
    get() {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128; // -1..1
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length); // 0..1
      smooth = smooth * smoothing + rms * (1 - smoothing);
      const gated = Math.max(0, smooth - gate);
      //console.log("[Live2D values] ", gated);
      return Math.min(1, gated * gain); // 0..1
    },
    analyser,
  };
}

export default function Live2DCanvas({
  audioStream,
  motion,
  motionSpeed,
  onMotionPhaseChange,
  canvasWidth = 600,
  canvasHeight = 800,
  left = 10,
  top = 10,
  scale = 0.5,
}: Live2DCanvasProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const didInit = useRef(false);
  const [ready, setReady] = useState(false);

  const appRef = useRef<PixiApplication | null>(null);
  const modelRef = useRef<Live2DModelLike | null>(null);

  // モーション表情の補間用 state
  const motionTargetRef = useRef<MotionParams>({});
  const motionCurrentRef = useRef<MotionParams>({});
  const motionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ファイルモーション再生中は手動パラメータ制御を一時停止
  const fileMotionPlayingRef = useRef(false);
  // ファイルモーション再生速度 (Ticker delta に掛ける倍率)
  const fileMotionSpeedRef = useRef(1.0);
  // ファイルモーション終了後に適用するプリセット名
  const pendingPresetRef = useRef<AvatarMotion | null>(null);
  // Ticker クロージャからコールバックを呼ぶための ref
  const onMotionPhaseChangeRef = useRef(onMotionPhaseChange);
  onMotionPhaseChangeRef.current = onMotionPhaseChange;
  useEffect(() => {
    if (import.meta.env.SSR) return;
    if (didInit.current) return;
    didInit.current = true;

    let app: PixiApplication;
    console.log("[Live2D] initializing…", audioStream);
    (async () => {
      // Core を先に
      if (!window.Live2DCubismCore) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "/assets/live2dcubismcore.min.js";
          s.onload = () => res(0);
          s.onerror = () => rej(new Error("Failed to load Cubism Core"));
          document.head.appendChild(s);
        });
      }

      // ⭐ v7 を読み込み
      const PIXI = await import("pixi.js");
      //const { Live2DModel } = await import("pixi-live2d-display-lipsyncpatch/cubism4");
      const { Live2DModel } = await import("pixi-live2d-display/cubism4");
      //const { Live2DModel } = await import("pixi-live2d-display/dist/cubism4.es.js");
      //const { Live2DModel } = await import("pixi-live2d-display/cubism4");

      // ⭐ Ticker を登録（v7は shared を渡す）
      Live2DModel.registerTicker(PIXI.Ticker.shared as any);

      // ⭐ v7 は同期生成、canvasは app.view
      app = new PIXI.Application({ width: canvasWidth, height: canvasHeight, backgroundAlpha: 0 });
      ref.current?.appendChild(app.view);

      //model = await Live2DModel.from("assets/models/Hiyori/Hiyori.model3.json");
      // ライブラリの autoUpdate を使わず手動更新で確実に
      //model = await Live2DModel.from("assets/models/Hiyori/Hiyori.model3.json", { autoUpdate: false });
      let model = await Live2DModel.from("assets/models/Haru/Haru.model3.json", { autoUpdate: false }) as Live2DModelLike;
      model.x = left; model.y = top; model.scale.set(scale);
      model.internalModel.motionManager.stopAllMotions();
      setReady(true);

      app.stage.addChild(model);
      appRef.current = app;
      modelRef.current = model as Live2DModelLike;
      // ====== マウス操作で視線と表情を制御 ======
      let mouseX = 0, mouseY = 0;
      app.view.addEventListener("mousemove", (e) => {
        const rect = app.view.getBoundingClientRect();
        mouseX = (e.clientX - rect.left) / rect.width;
        mouseY = (e.clientY - rect.top) / rect.height;
      });

      // ====== Ticker 更新ループ ======
      app.ticker.add((delta: number) => {
        // ファイルモーション再生中は速度倍率を適用
        const effectiveDelta = fileMotionPlayingRef.current
          ? delta * fileMotionSpeedRef.current
          : delta;
        model.update(effectiveDelta, true); // 通常更新

        const core = model.internalModel.coreModel;
        const t = performance.now() / 1000;
        // ファイルモーション再生中はモーション側にパラメータ制御を委ねる
        if (fileMotionPlayingRef.current) {
          // motionManager が終了したかチェック
          if (model.internalModel.motionManager.isFinished()) {
            fileMotionPlayingRef.current = false;
            pendingPresetRef.current = null;
            motionTargetRef.current = MOTION_PRESETS.neutral;
            motionCurrentRef.current = {};
            console.log("[Live2D] file motion finished, returning to neutral");
            onMotionPhaseChangeRef.current?.("preset:neutral");
          }
          return;
        }

        // 1️⃣ 視線ベース値（マウス追従）
        const angleX = (mouseX - 0.5) * 60; // -30〜+30度
        const angleY = (mouseY - 0.5) * 30;

        // 2️⃣ 瞬きベース値（周期的に）
        const blink = (Math.sin(t * 3) + 1) / 2; // 0〜1

        // 3️⃣ 体のゆらぎベース値
        const bodyAngle = Math.sin(t) * 5;

        // 4️⃣ 口パク（ランダム or オーディオに連動可能）
        // ここに audioStream リップシンクの loud 値を入れてもOK
        //const mouth = (Math.sin(t * 4) + 1) / 2;
        //core.setParameterValueById("ParamMouthOpenY", mouth);

        // 5️⃣ 表情の強弱（モーション未指定時のデフォルト）
        const defaultBrowY = Math.sin(t * 2) * 0.5;

        // 6️⃣ モーション表情の補間適用
        const LERP = 0.08; // 補間速度
        const target = motionTargetRef.current;
        const cur = motionCurrentRef.current;
        const allKeys: (keyof MotionParams)[] = [
          "ParamAngleX", "ParamAngleY", "ParamAngleZ",
          "ParamEyeLOpen", "ParamEyeROpen",
          "ParamBrowLY", "ParamBrowRY",
          "ParamMouthForm", "ParamMouthOpenY",
          "ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ",
          "ParamArmLA", "ParamArmRA", "ParamArmLB", "ParamArmRB",
          "ParamHandAngleL", "ParamHandAngleR",
        ];
        for (const key of allKeys) {
          const tv = target[key] ?? 0;
          const cv = cur[key] ?? 0;
          cur[key] = cv + (tv - cv) * LERP;
        }
        motionCurrentRef.current = cur;

        const hasMotion = Object.keys(target).length > 0;

        // 視線: マウス追従 + モーションオフセット
        core.setParameterValueById("ParamAngleX", angleX + (cur.ParamAngleX ?? 0));
        core.setParameterValueById("ParamAngleY", angleY + (cur.ParamAngleY ?? 0));
        if (cur.ParamAngleZ) core.setParameterValueById("ParamAngleZ", cur.ParamAngleZ);

        // 瞬き: モーション側の目の開き度合いを加味
        const eyeL = blink * (hasMotion && target.ParamEyeLOpen !== undefined ? (cur.ParamEyeLOpen ?? 1) : 1);
        const eyeR = blink * (hasMotion && target.ParamEyeROpen !== undefined ? (cur.ParamEyeROpen ?? 1) : 1);
        core.setParameterValueById("ParamEyeLOpen", eyeL);
        core.setParameterValueById("ParamEyeROpen", eyeR);

        // 体: デフォルト揺らぎ + モーションオフセット
        core.setParameterValueById("ParamBodyAngleX", bodyAngle + (cur.ParamBodyAngleX ?? 0));
        core.setParameterValueById("ParamBodyAngleY", cur.ParamBodyAngleY ?? 0);
        core.setParameterValueById("ParamBodyAngleZ", cur.ParamBodyAngleZ ?? 0);

        // 眉: モーション指定があればそちら、なければデフォルト揺らぎ
        core.setParameterValueById("ParamBrowLY", hasMotion ? (cur.ParamBrowLY ?? 0) : defaultBrowY);
        core.setParameterValueById("ParamBrowRY", hasMotion ? (cur.ParamBrowRY ?? 0) : defaultBrowY);

        // 口の形（笑顔・への字など。口パクとは別）
        core.setParameterValueById("ParamMouthForm", cur.ParamMouthForm ?? 0);
        // モーション側の口の開きは口パクが無いときのみ
        if ((cur.ParamMouthOpenY ?? 0) !== 0 && !meterRef.current) {
          core.setParameterValueById("ParamMouthOpenY", cur.ParamMouthOpenY ?? 0);
        }

        // 腕・手: explaining 時のジェスチャーは sin で揺らしてより動的に
        const armSwing = hasMotion ? Math.sin(t * 2.5) * 0.15 : 0;
        core.setParameterValueById("ParamArmLA", (cur.ParamArmLA ?? 0) + armSwing);
        core.setParameterValueById("ParamArmRA", (cur.ParamArmRA ?? 0) - armSwing);
        core.setParameterValueById("ParamArmLB", cur.ParamArmLB ?? 0);
        core.setParameterValueById("ParamArmRB", cur.ParamArmRB ?? 0);
        core.setParameterValueById("ParamHandAngleL", cur.ParamHandAngleL ?? 0);
        core.setParameterValueById("ParamHandAngleR", cur.ParamHandAngleR ?? 0);
      });

    })().catch(e => console.error("[Live2D init]", e));

    return () => {
      try { appRef.current?.destroy(true); } catch {}
    };
  }, []);
  
  // motion prop が変わったら表情ターゲットを更新 & ファイルモーション再生
  useEffect(() => {
    const model = modelRef.current;
    const motionName = motion ?? "neutral";
    const preset = MOTION_PRESETS[motionName] ?? {};
    const fileEntry = MOTION_FILE_MAP[motionName];

    if (motionTimerRef.current) clearTimeout(motionTimerRef.current);

    if (model && fileEntry !== undefined && motionName !== "neutral") {
      // ファイルモーション再生開始 — 終了検知は Ticker で行う
      const { index: fileIndex, speed: entrySpeed } = fileEntry;
      fileMotionPlayingRef.current = true;
      fileMotionSpeedRef.current = motionSpeed ?? entrySpeed ?? 1.0;
      pendingPresetRef.current = motionName;
      const fileName = `m${String(fileIndex + 1).padStart(2, "0")}`;
      onMotionPhaseChange?.(`file:${fileName} (x${fileMotionSpeedRef.current.toFixed(1)})`);
      console.log(`[Live2D] playing file motion Avatar[${fileIndex}] speed=${fileMotionSpeedRef.current} for "${motionName}"`);
      model.motion("Avatar", fileIndex, 3 /* force priority */).catch(() => {
        // 再生開始に失敗 → プリセットにフォールバック
        fileMotionPlayingRef.current = false;
        fileMotionSpeedRef.current = 1.0;
        pendingPresetRef.current = null;
        motionTargetRef.current = preset;
        onMotionPhaseChange?.(`preset:${motionName}`);
      });
    } else {
      // ファイルモーション無し → 即座にプリセット適用
      fileMotionPlayingRef.current = false;
      pendingPresetRef.current = null;
      motionTargetRef.current = preset;
      onMotionPhaseChange?.(`preset:${motionName}`);

      if (motionName !== "neutral") {
        motionTimerRef.current = setTimeout(() => {
          motionTargetRef.current = MOTION_PRESETS.neutral;
          onMotionPhaseChange?.("preset:neutral");
        }, 15000);
      }
    }

    return () => {
      if (motionTimerRef.current) clearTimeout(motionTimerRef.current);
    };
  }, [motion]);

  // audioStream が変わるたびに WebAudio グラフを作り直す
  const audioCtxRef = useRef<AudioContext | null>(null);
  const srcNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const meterRef = useRef<LoudnessMeter | null>(null);

  const tickCbRef = useRef<(() => void) | null>(null);
  // audioStream 到着後にリップシンクを構築
  useEffect(() => {
    const app = appRef.current;
    const model = modelRef.current;

    // 既存の接続を掃除
    if (tickCbRef.current) {
      try { app?.ticker.remove(tickCbRef.current); } catch {}
      tickCbRef.current = null;
    }
    try { meterRef.current?.dispose?.(); } catch {}
    meterRef.current = null;
    try { srcNodeRef.current?.disconnect(); } catch {}
    srcNodeRef.current = null;

    if (!audioStream || !model) return;

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
      
      const ctx = (audioCtxRef.current ||= new (window.AudioContext || window.webkitAudioContext!)());
      if (ctx.state !== "running") await ctx.resume();
      
      console.log("[Live2D] setting up lipsync…", audioStream);
      const src = ctx.createMediaStreamSource(audioStream);
      src.connect(ctx.destination);
      srcNodeRef.current = src;

      // Lipsync パッチがあれば利用、なければ createLoudnessMeter
      let usedPatch = false
      try {
        if (model.enableLipSyncFromNode) usedPatch = !!model.enableLipSyncFromNode(src);
        else if (model.lipSync?.connectNode) usedPatch = !!model.lipSync.connectNode(src);
      } catch { usedPatch = false; }
      // アップデート
      if (!usedPatch) {
        console.log("[Live2D] using custom loudness meter for lipsync", ctx);
        const meter = createLoudnessMeter(ctx, src, { smoothing: 0.25, gate: 0.005, gain: 1 });
        meterRef.current = meter;

        const cb = () => {
          const dt = app?.ticker.deltaMS || 16.7;
          // 1) まず通常更新（モーション・物理など）を進める
          //model.update(dt, true);
          // 2) その“後”に口パクを上乗せ（モーションに上書きされない）
          const loud = meter.get();                    // 0..1
          const target = Math.min(1, loud * 1.0);      // 必要ならゲイン調整
          const core = model.internalModel.coreModel;
          //console.log(target)
	        core.setParameterValueById("ParamMouthOpenY", target*10);
	
          //console.log("[live2d]",meter.get())
          //model.internalModel.update();
          //model.forceUpdate();
        };
        tickCbRef.current = cb;
        app.ticker.add(cb);
      }
    })();

    return () => {
      if (tickCbRef.current) {
        try { app?.ticker.remove(tickCbRef.current); } catch {}
        tickCbRef.current = null;
      }
      try { meterRef.current?.dispose?.(); } catch {}
      try { srcNodeRef.current?.disconnect(); } catch {}
    };
  }, [audioStream]);
  
  return (<div>
    {!ready && <p style={{opacity:.6}}>Loading Live2D…</p>}
	  <div ref={ref} />      
  	</div>);
}

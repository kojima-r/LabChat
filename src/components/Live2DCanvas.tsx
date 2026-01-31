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
    motionManager: { stopAllMotions: () => void };
    coreModel: {
      setParameterValueById: (id: string, value: number) => void;
      getParameterValueById: (id: string) => number;
    };
  };
  update: (delta: number, autoUpdate?: boolean) => void;
  enableLipSyncFromNode?: (node: AudioNode) => unknown;
  lipSync?: { connectNode?: (node: AudioNode) => unknown };
};

type Live2DCanvasProps = {
  audioStream?: MediaStream | null;
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
        model.update(delta, true); // 通常更新

        const core = model.internalModel.coreModel;
        const t = performance.now() / 1000;
        // 1️⃣ 視線をマウスに追従
        const angleX = (mouseX - 0.5) * 60; // -30〜+30度
        const angleY = (mouseY - 0.5) * 30;
        core.setParameterValueById("ParamAngleX", angleX);
        core.setParameterValueById("ParamAngleY", angleY);

        // 2️⃣ 瞬き（周期的に）
        const blink = (Math.sin(t * 3) + 1) / 2; // 0〜1
        core.setParameterValueById("ParamEyeLOpen", blink);
        core.setParameterValueById("ParamEyeROpen", blink);

        // 3️⃣ 体のゆらぎ
        const bodyAngle = Math.sin(t) * 5;
        core.setParameterValueById("ParamBodyAngleX", bodyAngle);

        // 4️⃣ 口パク（ランダム or オーディオに連動可能）
        // ここに audioStream リップシンクの loud 値を入れてもOK
        //const mouth = (Math.sin(t * 4) + 1) / 2;
        //core.setParameterValueById("ParamMouthOpenY", mouth);

        // 5️⃣ 表情の強弱
        const browY = Math.sin(t * 2) * 0.5;
        core.setParameterValueById("ParamBrowLY", browY);
        core.setParameterValueById("ParamBrowRY", browY);
      });

    })().catch(e => console.error("[Live2D init]", e));

    return () => {
      try { appRef.current?.destroy(true); } catch {}
    };
  }, []);
  
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

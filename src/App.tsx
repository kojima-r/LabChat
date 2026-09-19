import { useEffect, useRef, useState } from "react";
import "./App.css";
import TodoPanel from "./components/TodoPanel";
import { decodeVowelTimelineHeader } from "./cubism/vowelMouth";
import type { LipSyncTimeline } from "./components/Live2DCanvas";
import {
  AVATAR_EXPRESSIONS,
  AVATAR_MODELS,
  AVATAR_MOTIONS,
  DEFAULT_MODEL_ID,
  defaultFormOf,
  getModelConfig,
  type AvatarExpression,
  type AvatarMotion,
} from "./components/live2dModels";
//import reactLogo from "./assets/react.svg";
//import viteLogo from "/vite.svg";

const disableLive2D=false

// 起動の内訳を測るためのログ。時刻の起点は performance.now() の原点（ページ読み込み開始）で、
// Live2DCanvas の [Live2D +Ns] と同じ物差しなので前後がそのまま繋がる。
function boot(msg: string) {
  console.log(`[Boot +${(performance.now() / 1000).toFixed(2)}s] ${msg}`);
}
boot("App.tsx 評価");

type ImageInfo = {
  id: string;
  filename: string;
  title: string;
  description: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  image?: ImageInfo;
  meta?: {
    sttMs?: number;
    chatMs?: number;
    ttsMs?: number;
  };
};

function getMediaStreamFromAudioElement(audio: HTMLAudioElement): MediaStream {
  // Chrome / Edge / Firefox 対応
  const stream =
    (audio as any).captureStream?.() ??
    (audio as any).mozCaptureStream?.();

  if (!stream) {
    throw new Error("captureStream() is not supported in this browser");
  }

  return stream;
}

function App() {
  //
  const [todoRefreshKey, setTodoRefreshKey] = useState(0);
  //
  const [isMicOn, setIsMicOn] = useState(false);
  const [partial, setPartial] = useState("");
  const [finals, setFinals] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [textInput, setTextInput] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const playingRef = useRef(false);
  const audioQueueRef = useRef<string[]>([]);

  const [remoteStream, setRemoteStream] = useState<MediaStream|null>(null);
  // VOICEVOX が返した母音タイムライン（口の形をこれで作る）。英語 TTS では null のまま。
  const [lipSyncTimeline, setLipSyncTimeline] = useState<LipSyncTimeline | null>(null);
  const [displayedImage, setDisplayedImage] = useState<ImageInfo | null>(null);
  const [avatarMotion, setAvatarMotion] = useState<AvatarMotion | null>(null);
  const [avatarExpression, setAvatarExpression] = useState<AvatarExpression | null>(null);
  const [motionPhase, setMotionPhase] = useState("none");
  const [expressionPhase, setExpressionPhase] = useState("none");
  // アバターモデルと形態（デバッグパネルから切り替える。LLM は制御しない）
  const [avatarModelId, setAvatarModelId] = useState<string>(DEFAULT_MODEL_ID);
  const avatarModelConfig = getModelConfig(avatarModelId);
  const [avatarForm, setAvatarForm] = useState<string>(defaultFormOf(avatarModelConfig));
  // 画面への収め方（Cubism の投影行列に渡す）。モデルごとの既定値をパネルから微調整できる。
  const [avatarView, setAvatarView] = useState(avatarModelConfig.view);
  const [panelVisible, setPanelVisible] = useState(true);
  const [ClientLive2D, setClientLive2D] = useState<any>(null);
  useEffect(() => {
    // ✅ クライアントでだけサブコンポーネントを読み込む
    boot("App マウント");
    if (disableLive2D) return;
    const t0 = performance.now();
    boot("Live2DCanvas の動的 import 開始");
    import("./components/Live2DCanvas.tsx").then((m) => {
      boot(`Live2DCanvas の動的 import 完了 (${Math.round(performance.now() - t0)}ms)`);
      setClientLive2D(() => m.default);
    });
  }, []);

  // barge-in ON/OFF
  const [bargeInEnabled, setBargeInEnabled] = useState(true);
  // 現在再生中の Audio を保持
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  // いまの utterance が始まった時刻（delta を最初に受けた瞬間）
  const utteranceStartMsRef = useRef<number | null>(null);
  // 短い相づち判定のしきい値
  const MIN_UTTERANCE_MS = 10;

  type AiPhase =
    | "idle"            // 何もしていない
    | "listening"       // 音声認識中（STT streaming）
    | "thinking"        // Chat 応答生成中
    | "speaking";       // TTS 再生中

  const [aiPhase, setAiPhase] = useState<AiPhase>("idle");
  // 最新ターンID（古い非同期処理が state を上書きしないため）
  const turnIdRef = useRef(0);
  // chat/tts の中断用（barge-in でも使える）
  const chatAbortRef = useRef<AbortController | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);

  // turnId ごとの計測結果を保持
  type Latency = { sttMs?: number; chatMs?: number; ttsMs?: number };
  const latencyByTurnRef = useRef<Map<number, Latency>>(new Map());

  // TTS ストリーミング再生 ON/OFF
  const [ttsStreamingEnabled, setTtsStreamingEnabled] = useState(true);
  // Conversation language toggle
  const [isEnglishConversation, setIsEnglishConversation] = useState(false);
  // 字幕表示 ON/OFF
  const [subtitleEnabled, setSubtitleEnabled] = useState(true);
  // 字幕フォントサイズ（rem）
  const [subtitleFontSize, setSubtitleFontSize] = useState(1.4);
  // turnId -> TTS streaming の create 時刻
  const ttsStreamStartMsRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // モデルを切り替えたら形態はそのモデルの初期形態に戻す
  useEffect(() => {
    const cfg = getModelConfig(avatarModelId);
    console.log(`[Avatar] model -> "${avatarModelId}" (${cfg.ja}) settings=${cfg.settingsUrl} form=${defaultFormOf(cfg) || "-"}`);
    setAvatarForm(defaultFormOf(cfg));
    setAvatarView(cfg.view);
  }, [avatarModelId]);

  // ---- アバター デバッグ操作 ----
  // 同じ値を選び直しても再生し直せるよう、いったん null を通す
  const pickMotion = (key: AvatarMotion) => {
    console.log(`[Avatar] panel motion -> "${key}"`, avatarModelConfig.resolveMotion(key, avatarForm));
    if (avatarMotion === key) {
      setAvatarMotion(null);
      window.setTimeout(() => setAvatarMotion(key), 0);
    } else {
      setAvatarMotion(key);
    }
  };
  const pickExpression = (key: AvatarExpression) => {
    console.log(
      `[Avatar] panel expression -> "${key}"`,
      avatarModelConfig.resolveExpression?.(key) ??
        avatarModelConfig.resolveExpressionMotion?.(key, avatarForm),
    );
    if (avatarExpression === key) {
      setAvatarExpression(null);
      window.setTimeout(() => setAvatarExpression(key), 0);
    } else {
      setAvatarExpression(key);
    }
  };
  const resetAvatar = () => {
    console.log("[Avatar] panel reset");
    setAvatarMotion(null);
    setAvatarExpression(null);
  };
  /** そのモデル・形態でその表情が表現できるか（できないものはボタンを無効化する） */
  const isExpressionSupported = (key: AvatarExpression) => {
    if (key === "neutral") return true;
    if (avatarModelConfig.resolveExpression) {
      return avatarModelConfig.resolveExpression(key) !== null;
    }
    if (avatarModelConfig.resolveExpressionMotion) {
      return avatarModelConfig.resolveExpressionMotion(key, avatarForm) !== null;
    }
    return false;
  };
  /** 同様にモーション。ベンダーがそのモデル・形態に用意していないものは選べない */
  const isMotionSupported = (key: AvatarMotion) => {
    if (key === "neutral") return true;
    return avatarModelConfig.resolveMotion(key, avatarForm) !== null;
  };
  const avatarDebugButtonStyle = (active: boolean): React.CSSProperties => ({
    padding: "4px 10px",
    borderRadius: 14,
    border: active ? "1px solid #1565c0" : "1px solid #999",
    background: active ? "#1e88e5" : "#f5f5f5",
    color: active ? "#fff" : "#222",
    cursor: "pointer",
    fontSize: 13,
  });
  const setPhaseSafely = (turnId: number, phase: AiPhase) => {
    // 最新ターン以外は無視
    if (turnId !== turnIdRef.current) return;
    setAiPhase(phase);
  };

  
  // for burge-in
  const stopTtsImmediately = () => {
    // 非ストリーミング再生停止
    if (currentAudioRef.current) {
      try {
        currentAudioRef.current.pause();
        currentAudioRef.current.currentTime = 0;
      } catch {}
      currentAudioRef.current = null;
    }

    
    // ストリーミング Speech API streaming 停止
    streamingAbortRef.current?.abort();
    streamingAbortRef.current = null;

    if (streamingAudioRef.current) {
      try {
        streamingAudioRef.current.pause();
        streamingAudioRef.current.currentTime = 0;
      } catch {}
      streamingAudioRef.current = null;
    }
    ttsStreamStartMsRef.current.clear();
    // 口の形も音声と一緒に捨てる（残すと止まった口の形が固まる）
    setLipSyncTimeline(null);

    // キュー破棄
    audioQueueRef.current = [];
    playingRef.current = false;

    // 進行中の chat/tts をキャンセル（古い処理が speaking/thinking を上書きしない）
    chatAbortRef.current?.abort();
    ttsAbortRef.current?.abort();

    // 状態は「listening」に（マイクON前提）
    setAiPhase(isMicOn ? "listening" : "idle");
  };

  useEffect(() => {
    return () => {
      stopMic().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getEphemeralToken = async () => {
    const r = await fetch(`/api/realtime-token`);
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    if (!data?.token) throw new Error("token is missing");
    return data.token as string; // ek_...
  };

  

  const connectRealtimeTranscription = async () => {
    const token = await getEphemeralToken();
    console.log("Got ephemeral token:", token);
    // ブラウザWebSocketはAuthorizationヘッダを付けづらいので subprotocol を使う（短命 token なので安全性が上がる）
    // client secret は ek_... の短命トークン
    const ws = new WebSocket(
      "wss://api.openai.com/v1/realtime?intent=transcription",
      ["realtime", "openai-insecure-api-key." + token]
    );

    ws.onopen = () => {
      // transcription session 設定（server_vad で途切れ検知）
      ws.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                noise_reduction: { type: "near_field" },
                transcription: {
                  model: "gpt-4o-mini-transcribe",
                  language: isEnglishConversation ? "en" : "ja",
                },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 600,
                },
              },
            },
          },
        })
      );
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        console.log("WS message:", msg);
        if (msg.type === "conversation.item.input_audio_transcription.delta") {
          const deltaText = msg.delta ?? "";

          // 「発話開始」を検知：最初の delta が来た瞬間を開始時刻にする
          if (utteranceStartMsRef.current === null) {
            utteranceStartMsRef.current = performance.now();
          }

          // barge-in ON なら、話し始めた瞬間に TTS 停止
          if (bargeInEnabled) {
            stopTtsImmediately();
          }

          setPartial((prev) => (prev + deltaText).slice(-2000));
          return;
        }

        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          const text: string = (msg.transcript ?? "").trim();

          // utterance が終わったので partial はクリア
          setPartial("");

          // 発話時間計測
          const startedAt = utteranceStartMsRef.current;
          utteranceStartMsRef.current = null;
          const sttMs = startedAt ? Math.round(performance.now() - startedAt) : undefined;
          
          
          if (!text) return;

          // 短い相づちは「(ignored)」として表示
          const ignored = sttMs != null && sttMs < MIN_UTTERANCE_MS;

          setFinals((prev) => [
            ignored ? `${text}  (ignored: ${Math.round(sttMs)}ms)` : text,
            ...prev,
          ].slice(0, 50));

          const myTurnId = ++turnIdRef.current;
          latencyByTurnRef.current.set(myTurnId, { sttMs });

          // MIN_UTTERANCE_MS ms 未満は Chat/TTS に送らない
          if (ignored) return;

          setAiPhase("thinking");
          console.log("Final utterance:", text, "turnId:", myTurnId);
          // 途切れたところで非同期に Chat -> TTS（STTストリーミングは継続）
          void handleUtteranceFinal(text, myTurnId);
          return;
        }

        if (msg.type === "error") {
          setError(msg?.error?.message ?? "Realtime error");
        }
      } catch (e) {
        console.error("WS parse error:", e);
      }
    };

    ws.onerror = () => setError("A WebSocket error occurred.");
    wsRef.current = ws;
  };

  const startMic = async () => {
    setError(null);
    if (isMicOn) return;

    await connectRealtimeTranscription();

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;

    const source = audioCtx.createMediaStreamSource(stream);
    sourceNodeRef.current = source;

    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (event) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const input = event.inputBuffer.getChannelData(0);
      const pcm16 = floatTo16BitPCMResampled(input, audioCtx.sampleRate, 24000);
      const b64 = base64FromInt16(pcm16);

      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);

    setIsMicOn(true);
    setAiPhase("listening");
  };

  const stopMic = async () => {
    setIsMicOn(false);

    try {
      processorRef.current?.disconnect();
      sourceNodeRef.current?.disconnect();
    } catch {}
    processorRef.current = null;
    sourceNodeRef.current = null;

    if (audioCtxRef.current) {
      try {
        await audioCtxRef.current.close();
      } catch {}
      audioCtxRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    // 発話時間もリセット
    utteranceStartMsRef.current = null;
    // 全部止める
    chatAbortRef.current?.abort();
    ttsAbortRef.current?.abort();
    stopTtsImmediately(); // これで idle/listening は中で整う
    setAiPhase("idle");
  };

  
  const sendTextToChat = (text: string) => {　//todolist から呼ばれる
    const trimmed = text.trim();
    if (!trimmed) return;
    const myTurnId = ++turnIdRef.current;
    latencyByTurnRef.current.set(myTurnId, {});
    setAiPhase("thinking");
    void handleUtteranceFinal(trimmed, myTurnId);
  };

  const submitTextInput = () => {
    const text = textInput.trim();
    if (!text) return;
    setTextInput("");
    sendTextToChat(text);
  };
  const getJstIsoString = (): string => {
    const now = new Date();
    // 'sv' ロケールは 'YYYY-MM-DD HH:mm:ss' 形式 (24時間表記)
    const jstString = now.toLocaleString('sv', { timeZone: 'Asia/Tokyo' });
    // 空白をTに置換し、タイムゾーン+09:00を付与
    return jstString.replace(' ', 'T') + '+09:00';
  };
  const handleUtteranceFinal = async (utterance: string, turnId: number) => {
    try {
      // 既存の chat/tts をキャンセル（新しい発話が来たら古い処理は止める）
      chatAbortRef.current?.abort();
      ttsAbortRef.current?.abort();
      const chatAbort = new AbortController();
      const ttsAbort = new AbortController();
      chatAbortRef.current = chatAbort;
      ttsAbortRef.current = ttsAbort;

      setPhaseSafely(turnId, "thinking");
      
      // turnId から sttMs を取り出す ---
      const lat0 = latencyByTurnRef.current.get(turnId) ?? {};

      // ユーザー発話を追記
      let historyForChat: ChatMessage[] = [];
      const userMsg: ChatMessage = {
        id: `u-${turnId}`,
        role: "user",
        content: utterance + " (Current time: " + getJstIsoString() + ")",
        meta: { sttMs: lat0.sttMs },
      };
      setMessages((prev) => {
        historyForChat = [...prev, userMsg];
        return historyForChat;
      });

      // Chat計測
      const chatT0 = performance.now();
      // 即時に historyForChat を使うため ref を使う
      historyForChat = [...messagesRef.current, userMsg];
      const chatResult = await backendChat(historyForChat, chatAbort.signal);
      const reply = chatResult.reply;
      const chatMs = Math.round(performance.now() - chatT0);
      // turn が古ければ結果を捨てる（既存のガード）
      if (turnId !== turnIdRef.current) return;
      latencyByTurnRef.current.set(turnId, { ...lat0, chatMs });

      // 画像表示
      if (chatResult.image) {
        setDisplayedImage(chatResult.image);
      }

      // アバター動作
      if (chatResult.motion) {
        setAvatarMotion(chatResult.motion);
      }

      // アバター表情
      if (chatResult.expression) {
        setAvatarExpression(chatResult.expression);
      }

      // TTS を取りに行く前に speaking 表示（ただしこのターンのみ）
      setPhaseSafely(turnId, "speaking");

      if (ttsStreamingEnabled) {
        // --- assistant メッセージを追加（Chat/TTS ms を meta に入れる）---
        const lat2 = latencyByTurnRef.current.get(turnId) ?? {};
        const assistantMsg: ChatMessage = {
          id: `a-${turnId}`,
          role: "assistant",
          content: reply,
          image: chatResult.image,
          meta: { chatMs: lat2.chatMs },// ttsMs はcompletedで入れる
        };
        setMessages((prev) => [...prev, assistantMsg]);
        //
        console.log("Using TTS streaming:", reply);
        await playTtsViaSpeechApiStreaming(reply, turnId);
        
      } else {// バッチ
  
        // TTS計測
        const ttsT0 = performance.now();
        const audioUrl = await backendTtsToBlobUrl(reply, ttsAbort.signal);
        const ttsMs = Math.round(performance.now() - ttsT0);
        if (turnId !== turnIdRef.current) {
          URL.revokeObjectURL(audioUrl);
          return;
        }
        const lat1 = latencyByTurnRef.current.get(turnId) ?? {};
        latencyByTurnRef.current.set(turnId, { ...lat1, ttsMs });
        // --- assistant メッセージを追加（Chat/TTS ms を meta に入れる）---
        const lat2 = latencyByTurnRef.current.get(turnId) ?? {};
        const assistantMsg: ChatMessage = {
          id: `a-${turnId}`,
          role: "assistant",
          content: reply,
          image: chatResult.image,
          meta: { chatMs: lat2.chatMs, ttsMs: lat2.ttsMs },
        };
        setMessages((prev) => [...prev, assistantMsg]);

        // キュー再生
        audioQueueRef.current.push(audioUrl);
        void playQueue(turnId);
      }
      // TODOリストの更新
      setTodoRefreshKey((k) => k + 1);
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      console.error(e);
      setError("An error occurred during chat/TTS processing.");
      if (turnId === turnIdRef.current && isMicOn) setAiPhase("listening");
    }
  };

  const backendChat = async (history: ChatMessage[], signal: AbortSignal): Promise<{ reply: string; image?: ImageInfo; motion?: AvatarMotion; expression?: AvatarExpression }> => {
    console.log("Sending to backend chat:", history);
    const r = await fetch(`/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: history.map(({ role, content }) => ({ role, content })),
        isEnglishConversation,
      }),
      signal,
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    console.log("Replying to backend chat:", data.reply);
    return {
      reply: String(data.reply ?? "").trim(),
      image: data.image ?? undefined,
      motion: data.motion ?? undefined,
      expression: data.expression ?? undefined,
    };
  };

  const backendTtsToBlobUrl = async (text: string, signal: AbortSignal) => {
    const r = await fetch(`/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!r.ok) throw new Error(await r.text());
    const buf = await r.arrayBuffer();
    const blob = new Blob([buf], { type: "audio/mpeg" });
    return URL.createObjectURL(blob);
  };
  const streamingAudioRef = useRef<HTMLAudioElement | null>(null);
  const streamingAbortRef = useRef<AbortController | null>(null);
  const playTtsViaSpeechApiStreaming = async (text: string, turnId: number) => {
    // barge-in 等で前の音声を止める
    stopTtsImmediately();

    const ac = new AbortController();
    streamingAbortRef.current = ac;

    // MediaSource で mp3 を逐次 append して再生
    const audio = new Audio();
    streamingAudioRef.current = audio;
    
    //MediaSource のサポート確認
    // （mp3をMSEで流せるか）
    if (!("MediaSource" in window)) throw new Error("MediaSource not supported");
    if (!MediaSource.isTypeSupported("audio/mpeg")) {
      throw new Error("MSE does not support audio/mpeg on this browser");
    }

    const mediaSource = new MediaSource();
    audio.src = URL.createObjectURL(mediaSource);

    // sourceopen を先に登録（取りこぼし防止）
    await new Promise<void>((resolve, reject) => {
      mediaSource.addEventListener(
        "sourceopen",
        async () => {
          console.log("MSE sourceopen fired");
          try {
            const sb = mediaSource.addSourceBuffer("audio/mpeg");

            console.log("TTS stream send:", text);
            let endpoint = "/api/tts-stream";
            if (!isEnglishConversation) {
              endpoint = "/api/tts-stream2";
            }
            const r = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text }),
              signal: ac.signal,
            });
            console.log("TTS stream response:", r.status, r.statusText);

            if (!r.ok) throw new Error(await r.text());
            if (!r.body) throw new Error("No stream body");

            // VOICEVOX のモーラ情報（母音タイムライン）。日本語 TTS のときだけ付く。
            // 無ければ音量のみのリップシンクへフォールバックする。
            const rawTimeline = r.headers.get("X-Vowel-Timeline");
            const spans = decodeVowelTimelineHeader(rawTimeline);
            if (spans) {
              console.log(
                `[tts] 母音タイムライン ${spans.length}件 (${spans[spans.length - 1].end.toFixed(2)}秒)`,
              );
              setLipSyncTimeline({ timeline: spans, audio });
            } else {
              // どこで途切れたのかを一意に言い当てる。
              // X-Tts-Features は「この Express は転送に対応している」目印なので、
              // 無ければ Express が古く、あって X-Vowel-Timeline が無ければ VOICEVOX が古い。
              const hasForwarder = r.headers.get("X-Tts-Features")?.includes("vowel-timeline");
              const upstream = r.headers.get("X-Tts-Server-Features");
              const cause = isEnglishConversation
                ? "英語モードなので OpenAI TTS が使われ、モーラ情報は存在しません（仕様どおり）"
                : !hasForwarder
                  ? "Express が古いプロセスです。再起動してください（node server/server.js）。" +
                    "ポートが埋まっていると起動に失敗して古い方が応答し続けます: ss -lptn 'sport = :8787'"
                  : !upstream
                    ? "VOICEVOX サーバが古いプロセスです。再起動してください（cd voicevox && ./run.sh）。" +
                      "起動時に '[tts_server] 起動完了 features=vowel-timeline' のバナーが出ます。" +
                      "ポートが埋まっていると uvicorn は Address already in use で起動できず、" +
                      "古い方が応答し続けます: ss -lptn 'sport = :5005'"
                    : rawTimeline === null
                      ? "VOICEVOX は対応版ですがタイムライン生成に失敗しています。" +
                        "VOICEVOX 側のログのトレースバックを確認してください"
                      : `ヘッダはあるがデコードに失敗しました (${rawTimeline.length}文字)`;
              console.warn(
                `[tts] 母音タイムラインなし → 音量のみのリップシンクになります\n` +
                  `  原因            : ${cause}\n` +
                  `  endpoint        : ${endpoint}\n` +
                  `  X-Tts-Features  : ${r.headers.get("X-Tts-Features") ?? "(なし)"}（Express 側の目印）\n` +
                  `  X-Tts-Server-Features: ${upstream ?? "(なし)"}（VOICEVOX 側の目印）\n` +
                  `  X-Vowel-Timeline: ${rawTimeline === null ? "(なし)" : `あり(${rawTimeline.length}文字)`}\n` +
                  `  応答ヘッダ一覧   : ${[...r.headers.entries()].map(([k]) => k).join(", ")}`,
              );
              setLipSyncTimeline(null);
            }

            const reader = r.body.getReader();

            const append = (chunk: Uint8Array) =>
              new Promise<void>((res, rej) => {
          	console.log("append>>MSE sourceopen fired");
                const onEnd = () => {
          	  console.log("append>>onEnd");
		  
                  sb.removeEventListener("updateend", onEnd);
                  sb.removeEventListener("error", onErr);
                  res();
                };
                const onErr = () => {
          	  console.log("append>>onEnd");

                  sb.removeEventListener("updateend", onEnd);
                  sb.removeEventListener("error", onErr);
                  rej(new Error("SourceBuffer error"));
                };
                sb.addEventListener("updateend", onEnd, { once: true });
                sb.addEventListener("error", onErr, { once: true });
		console.log("append>>chunk",chunk.length)
                sb.appendBuffer(chunk as BufferSource);
              });
            const prune = async () => {
              console.log("prune fired");
              // SourceBufferが busy なら何もしない（次のタイミングで）
              if (sb.updating) return;

              if (sb.buffered.length === 0) return;

              const current = audio.currentTime;
              const removeEnd = Math.max(0, current - 5); // 再生位置より5秒前まで削る（調整可）

              // bufferedの先頭範囲
              const start = sb.buffered.start(0);

              // 削りすぎ防止：1秒以上溜まっているときだけ削除
              if (removeEnd <= start + 1) return;

              sb.remove(start, removeEnd);

              // remove完了を待つ
              await new Promise<void>((res, rej) => {
                const onEnd = () => {
                  sb.removeEventListener("updateend", onEnd);
                  sb.removeEventListener("error", onErr);
                  res();
                };
                const onErr = () => {
                  sb.removeEventListener("updateend", onEnd);
                  sb.removeEventListener("error", onErr);
                  rej(new Error("SourceBuffer remove error"));
                };
                sb.addEventListener("updateend", onEnd, { once: true });
                sb.addEventListener("error", onErr, { once: true });
              });
            };
            // play は「止めない」：失敗してもストリーム処理は続ける
            audio.play().catch((e) => console.warn("audio.play blocked:", e));

            // captureStream は再生開始直後に渡す。
            // 以前はダウンロード完了後に渡していたため、音量ベースのリップシンクが
            // 再生の終盤まで立ち上がらなかった。トラックが未生成でも
            // Live2DCanvas 側が addtrack を待つので早出しして問題ない。
            setRemoteStream(getMediaStreamFromAudioElement(audio));

            let lastPruneAt = performance.now();
            while (true) {
              if (turnId !== turnIdRef.current) break;
              const { value, done } = await reader.read();
              if (done) break;
              if (value) {
                setAiPhase("speaking");
                console.log("Appended chunk:", value.byteLength);
                await append(value);
                // 一定間隔で prune（例：500msに1回）
                const now = performance.now();
                if (now - lastPruneAt > 500) {
                  await prune();
                  lastPruneAt = now;
                }
              }
            }

            try {
              mediaSource.endOfStream();
            } catch {}

            // 再生終了待ち（任意）
            audio.onended = () => {
              if (turnId === turnIdRef.current) setAiPhase(isMicOn ? "listening" : "idle");
              // 鳴り終わったら口をモーションに返す
              setLipSyncTimeline((cur) => (cur?.audio === audio ? null : cur));
              resolve();
            };
            
            // もし endOfStream 後にすぐ終わらない/鳴らない場合の保険（任意）
            // setTimeout(resolve, 30000);
          } catch (e) {
	    console.log(e)
            reject(e);
          }
        },
        { once: true }
      );

      mediaSource.addEventListener("sourceclose", () => console.log("MSE sourceclose"), { once: true });
      mediaSource.addEventListener("sourceended", () => console.log("MSE sourceended"), { once: true });
    });
    
  };
  const playQueue = async (turnId: number) => {
    if (playingRef.current) return;
    playingRef.current = true;

    try {
      while (audioQueueRef.current.length > 0) {
        // 途中で新ターンになったら再生停止（古いターンの speaking を継続しない）
        if (turnId !== turnIdRef.current) break;

        const url = audioQueueRef.current.shift()!;
        await new Promise<void>((resolve) => {
          const audio = new Audio(url);
          currentAudioRef.current = audio;

          const finish = () => {
            URL.revokeObjectURL(url);
            if (currentAudioRef.current === audio) currentAudioRef.current = null;
            resolve();
          };
          audio.onended = finish;
          audio.onerror = finish;

          void audio.play();
          // この経路（TTS streaming OFF）はストリームを渡していなかったため
          // リップシンクが成立していなかった。ストリーミング経路と同じく渡す。
          // 母音タイムラインは付かない（/api/tts は OpenAI）ので音量ベースになる。
          try {
            setRemoteStream(getMediaStreamFromAudioElement(audio));
          } catch (e) {
            console.warn("captureStream に失敗（リップシンクなしで再生します）:", e);
          }
        });
      }
    } finally {
      playingRef.current = false;

      // turnId が最新のときだけ listening/idle に戻す
      if (turnId === turnIdRef.current) {
        setAiPhase(isMicOn ? "listening" : "idle");
      }
    }
  };

  const latestUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  })();
  const latestAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  })();
  const latestUserSubtitle =
    partial.trim() ||
    (latestUserIndex >= 0 ? messages[latestUserIndex].content : "") ||
    "";
  const latestAssistantSubtitle =
    latestAssistantIndex >= 0 ? messages[latestAssistantIndex].content : "";
  // 新しい発話を下に表示する（partial があればユーザーが最新）
  const userIsNewer = partial.trim()
    ? true
    : latestUserIndex > latestAssistantIndex;

  return (
    <>
      {/* 字幕オーバーレイ */}
      {subtitleEnabled && (latestUserSubtitle || latestAssistantSubtitle) && (
        <div
          style={{
            position: "fixed",
            bottom: panelVisible ? "calc(50vh + 16px)" : 60,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 30,
            width: "min(90vw, 1000px)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            pointerEvents: "none",
            textAlign: "center",
            transition: "bottom 0.4s ease",
          }}
        >
          {(() => {
            const assistantBlock = latestAssistantSubtitle ? (
              <div
                key="assistant"
                style={{
                  background: "rgba(0, 0, 0, 0.65)",
                  color: "#ffe98a",
                  padding: "10px 18px",
                  borderRadius: 10,
                  fontSize: `${subtitleFontSize}rem`,
                  fontWeight: 600,
                  lineHeight: 1.4,
                  textShadow: "0 2px 4px rgba(0,0,0,0.8)",
                  whiteSpace: "pre-wrap",
                }}
              >
                <span style={{ opacity: 0.75, fontSize: "0.85rem", marginRight: 8 }}>AI</span>
                {latestAssistantSubtitle}
              </div>
            ) : null;
            const userBlock = latestUserSubtitle ? (
              <div
                key="user"
                style={{
                  background: "rgba(0, 0, 0, 0.65)",
                  color: "#ffffff",
                  padding: "10px 18px",
                  borderRadius: 10,
                  fontSize: `${subtitleFontSize}rem`,
                  fontWeight: 600,
                  lineHeight: 1.4,
                  textShadow: "0 2px 4px rgba(0,0,0,0.8)",
                  whiteSpace: "pre-wrap",
                }}
              >
                <span style={{ opacity: 0.75, fontSize: "0.85rem", marginRight: 8 }}>You</span>
                {latestUserSubtitle.replace(/\s*\(Current time:[^)]*\)\s*$/, "")}
              </div>
            ) : null;
            return userIsNewer
              ? [assistantBlock, userBlock]
              : [userBlock, assistantBlock];
          })()}
        </div>
      )}

      {/* Live2D + 背面画像 レイヤー */}
      <div style={{ position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh", pointerEvents: "none", zIndex: 0 }}>
        {/* 背面画像 */}
        {displayedImage && (
          <div style={{
            position: "absolute",
            top: "50%",
            right: "5%",
            transform: "translateY(-50%)",
            maxWidth: "45vw",
            maxHeight: "80vh",
            zIndex: 1,
          }}>
            <img
              src={`/images/${displayedImage.filename}`}
              alt={displayedImage.title}
              style={{
                maxWidth: "100%",
                maxHeight: "80vh",
                borderRadius: 12,
                boxShadow: "0 4px 24px rgba(0,0,0,0.6)",
                display: "block",
              }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
            <button
              onClick={() => setDisplayedImage(null)}
              style={{
                position: "absolute",
                top: 2,
                right: 2,
                background: "rgba(0,0,0,0.6)",
                color: "#fff",
                border: "none",
                borderRadius: "50%",
                width: 32,
                height: 32,
                cursor: "pointer",
                fontSize: 16,
                pointerEvents: "auto",
              }}
            >
              X
            </button>
          </div>
        )}
        {/* Live2D アバター（左寄り） */}
        <div style={{ position: "absolute", bottom: 0, left: 0, zIndex: 2 }}>
          {ClientLive2D
            ? <ClientLive2D
                audioStream={remoteStream}
                lipSync={lipSyncTimeline}
                modelId={avatarModelId}
                form={avatarForm}
                motion={avatarMotion}
                expression={avatarExpression}
                onMotionPhaseChange={setMotionPhase}
                onExpressionPhaseChange={setExpressionPhase}
                canvasWidth={1100}
                canvasHeight={1200}
                viewScale={avatarView.scale}
                viewOffsetX={avatarView.offsetX}
                viewOffsetY={avatarView.offsetY}
              />
            : !disableLive2D && <p style={{ opacity: .7, fontSize: "2rem", padding: 40 }}>Loading Live2D…</p>
          }
        </div>
      </div>

      {/* パネル表示/非表示トグルボタン */}
      <button
        onClick={() => setPanelVisible((v) => !v)}
        style={{
          position: "fixed",
          bottom: panelVisible ? "52vh" : 12,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 20,
          background: "#333",
          color: "#fff",
          border: "1px solid #555",
          borderRadius: 20,
          padding: "6px 20px",
          cursor: "pointer",
          fontSize: 14,
          transition: "bottom 0.4s ease",
        }}
      >
        {panelVisible ? "Panel ▼" : "Panel ▲"}
      </button>

      <div
        className="card"
        style={{
          maxWidth: 720,
          margin: "0 auto",
          textAlign: "left",
          position: "fixed",
          bottom: 0,
          left: "50%",
          transform: panelVisible ? "translateX(-50%) translateY(0)" : "translateX(-50%) translateY(100%)",
          transition: "transform 0.4s ease",
          zIndex: 10,
          maxHeight: "50vh",
          overflowY: "auto",
          width: "95vw",
          background: "#d0d0d0",
          color: "#222",
          borderRadius: "16px 16px 0 0",
          padding: 16,
          boxShadow: "0 -4px 20px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <input
            type="text"
            value={textInput}
            placeholder="Type text and send"
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitTextInput();
              }
            }}
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #555",
              background: "#111",
              color: "#fff",
            }}
          />
          <button onClick={submitTextInput} disabled={!textInput.trim()}>
            Send
          </button>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {!isMicOn ? (
            <button onClick={() => void startMic()}>🎙️ Start Mic</button>
          ) : (
            <button onClick={() => void stopMic()}>■ Stop</button>
          )}
          <span style={{ opacity: 0.8 }}>
            {isMicOn ? "Listening (server_vad detects pauses)" : "Stopped"}
          </span>
          {/* barge-in ON/OFF */}
          <div style={{ marginTop: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={bargeInEnabled}
                onChange={(e) => setBargeInEnabled(e.target.checked)}
              />
              <span>
                Interrupt TTS while speaking (barge-in)
                <strong style={{ marginLeft: 6 }}>
                  {bargeInEnabled ? "ON" : "OFF"}
                </strong>
              </span>
            </label>
          </div>
          {/* TTS ストリーミング ON/OFF */}
          <div style={{ marginTop: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={ttsStreamingEnabled}
                onChange={(e) => setTtsStreamingEnabled(e.target.checked)}
              />
              <span>
                TTS streaming
                <strong style={{ marginLeft: 6 }}>
                  {ttsStreamingEnabled ? "ON" : "OFF"}
                </strong>
              </span>
            </label>
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={isEnglishConversation}
                onChange={(e) => setIsEnglishConversation(e.target.checked)}
              />
              <span>
                English conversation
                <strong style={{ marginLeft: 6 }}>
                  {isEnglishConversation ? "ON" : "OFF"}
                </strong>
              </span>
            </label>
          </div>
          {/* 字幕表示 ON/OFF */}
          <div style={{ marginTop: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={subtitleEnabled}
                onChange={(e) => setSubtitleEnabled(e.target.checked)}
              />
              <span>
                Subtitles
                <strong style={{ marginLeft: 6 }}>
                  {subtitleEnabled ? "ON" : "OFF"}
                </strong>
              </span>
            </label>
          </div>
          {/* 字幕フォントサイズ */}
          <div style={{ marginTop: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Subtitle size</span>
              <input
                type="range"
                min={0.8}
                max={3}
                step={0.1}
                value={subtitleFontSize}
                onChange={(e) => setSubtitleFontSize(parseFloat(e.target.value))}
                disabled={!subtitleEnabled}
              />
              <strong>{subtitleFontSize.toFixed(1)}rem</strong>
            </label>
          </div>
        </div>
        {/* ---- アバター（モデル / 表情 / モーション）デバッグ操作 ---- */}
        <section
          style={{
            marginTop: 18,
            padding: 12,
            border: "1px solid #aaa",
            borderRadius: 10,
            background: "#e4e4e4",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1rem" }}>
            {isEnglishConversation ? "Avatar (debug)" : "アバター（デバッグ）"}
          </h2>
          <p style={{ margin: "4px 0 10px", fontSize: 12, opacity: 0.7 }}>
            {isEnglishConversation
              ? "Motion and expression are normally driven by the LLM; these controls override them manually."
              : "モーション・表情は通常 LLM が制御します。ここからは手動で上書きできます。"}
          </p>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>{isEnglishConversation ? "Model" : "モデル"}</span>
              <select
                value={avatarModelId}
                onChange={(e) => setAvatarModelId(e.target.value)}
              >
                {AVATAR_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {isEnglishConversation ? m.en : m.ja}
                  </option>
                ))}
              </select>
            </label>

            {/* 形態は riken モデルのみ。喜怒哀楽・各ポーズのモーション名が形態ごとに分かれている */}
            {avatarModelConfig.forms && (
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span>{isEnglishConversation ? "Form" : "形態"}</span>
                <select
                  value={avatarForm}
                  onChange={(e) => {
                    console.log(`[Avatar] panel form -> "${e.target.value}"`);
                    setAvatarForm(e.target.value);
                  }}
                >
                  {avatarModelConfig.forms.map((f) => (
                    <option key={f.key} value={f.key}>
                      {isEnglishConversation ? f.en : f.ja}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <button onClick={resetAvatar}>
              {isEnglishConversation ? "Reset" : "リセット"}
            </button>
          </div>

          {/* 表示位置・大きさ。Cubism の投影行列に渡すのでモデルごとに要調整 */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 10, fontSize: 13 }}>
            {([
              { key: "scale", label: isEnglishConversation ? "Size" : "大きさ", min: 0.2, max: 4, step: 0.05 },
              { key: "offsetX", label: isEnglishConversation ? "X" : "左右", min: -2, max: 2, step: 0.02 },
              { key: "offsetY", label: isEnglishConversation ? "Y" : "上下", min: -2, max: 2, step: 0.02 },
            ] as const).map((c) => (
              <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span>{c.label}</span>
                <input
                  type="range"
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  value={avatarView[c.key]}
                  onChange={(e) =>
                    setAvatarView((v) => ({ ...v, [c.key]: parseFloat(e.target.value) }))
                  }
                />
                <strong style={{ minWidth: 42 }}>{avatarView[c.key].toFixed(2)}</strong>
              </label>
            ))}
            <button onClick={() => setAvatarView(avatarModelConfig.view)}>
              {isEnglishConversation ? "Reset view" : "表示リセット"}
            </button>
          </div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
              {isEnglishConversation ? "Expression" : "表情 (exp)"}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {AVATAR_EXPRESSIONS.map((e) => {
                const supported = isExpressionSupported(e.key);
                return (
                  <button
                    key={e.key}
                    onClick={() => pickExpression(e.key)}
                    disabled={!supported}
                    title={supported ? e.key : `${e.key} (not available on this model/form)`}
                    style={avatarDebugButtonStyle(avatarExpression === e.key)}
                  >
                    {isEnglishConversation ? e.en : e.ja}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
              {isEnglishConversation ? "Motion" : "モーション"}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {AVATAR_MOTIONS.map((m) => {
                const supported = isMotionSupported(m.key);
                return (
                  <button
                    key={m.key}
                    onClick={() => pickMotion(m.key)}
                    disabled={!supported}
                    title={supported ? m.key : `${m.key} (not available on this model/form)`}
                    style={avatarDebugButtonStyle(avatarMotion === m.key)}
                  >
                    {isEnglishConversation ? m.en : m.ja}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <div style={{ marginTop: 16, minHeight: 32 }}>
          {aiPhase === "listening" && (
            <Status label="Listening…" />
          )}

          {aiPhase === "thinking" && (
            <Status label="AI is thinking…" spinning />
          )}

          {aiPhase === "speaking" && (
            <Status label="AI is speaking…" spinning />
          )}

          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
            Motion: <strong>{avatarMotion ?? "none"}</strong> | Phase: <strong>{motionPhase}</strong>
            <br />
            Expression: <strong>{avatarExpression ?? "none"}</strong> | Phase: <strong>{expressionPhase}</strong>
          </div>
        </div>
        {error && (
          <p style={{ color: "red", whiteSpace: "pre-wrap", marginTop: 12 }}>
            Error: {error}
          </p>
        )}

        <section style={{ marginTop: 18 }}>
          <h2>Partial</h2>
          <div style={{ minHeight: 56, padding: 10, border: "1px solid #555", borderRadius: 10, whiteSpace: "pre-wrap" }}>
            {partial || "(waiting for speech)"}
          </div>
        </section>

        <section style={{ marginTop: 18 }}>
          <h2>Final (completed)</h2>
          <div style={{ maxHeight: 180, overflowY: "auto", padding: 10, border: "1px solid #555", borderRadius: 10 }}>
            {finals.length === 0 ? (
              <p>(none yet)</p>
            ) : (
              finals.map((t, i) => (
                <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid #333" }}>
                  {t}
                </div>
              ))
            )}
          </div>
        </section>

        <section style={{ marginTop: 18 }}>
          <h2>Chat</h2>
          <div style={{ maxHeight: 240, overflowY: "auto", padding: 10, border: "1px solid #555", borderRadius: 10, fontSize: "0.9rem" }}>
            {messages.length === 0 ? (
              <p>(none yet)</p>
            ) : (
              messages.map((m, idx) => (
                <div key={idx} style={{ marginBottom: 10, textAlign: m.role === "user" ? "right" : "left" }}>
                  <div style={{ display: "inline-block", padding: "8px 10px", borderRadius: 12, background: m.role === "user" ? "#1e88e5" : "#444", color: "#fff", whiteSpace: "pre-wrap", maxWidth: "92%" }}>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>{m.role === "user" ? "You" : "AI"}</div>
                    {m.content}
                    {m.image && (
                      <img
                        src={`/images/${m.image.filename}`}
                        alt={m.image.title}
                        style={{
                          display: "block",
                          marginTop: 6,
                          maxWidth: 200,
                          maxHeight: 150,
                          borderRadius: 6,
                          cursor: "pointer",
                        }}
                        onClick={() => setDisplayedImage(m.image!)}
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    )}
                  </div>
                  
                  {m.meta && (
                  <div style={{ fontSize: 11, opacity: 0.8, marginTop: 6 }}>
                    {m.role === "user" && m.meta.sttMs != null && <span>STT: {m.meta.sttMs}ms</span>}
                    {m.role === "assistant" && (
                      <>
                        {m.meta.chatMs != null && <span>Chat: {m.meta.chatMs}ms</span>}
                        {m.meta.ttsMs != null && <span style={{ marginLeft: 10 }}>TTS: {m.meta.ttsMs}ms</span>}
                      </>
                    )}
                  </div>
                )}
                </div>
                
              ))
            )}
          </div>
        </section>

        <TodoPanel
          refreshKey={todoRefreshKey}
          onDueNotification={(text) => sendTextToChat(text)}
          isEnglishConversation={isEnglishConversation}
        />
      </div>
    </>
  );
}

export default App;

// ---- helpers ----
function floatTo16BitPCMResampled(input: Float32Array, inRate: number, outRate: number): Int16Array {
  if (inRate === outRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = inRate / outRate;
  const newLen = Math.floor(input.length / ratio);
  const out = new Int16Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const idx0 = Math.floor(idx);
    const idx1 = Math.min(idx0 + 1, input.length - 1);
    const frac = idx - idx0;
    const sample = input[idx0] * (1 - frac) + input[idx1] * frac;
    const s = Math.max(-1, Math.min(1, sample));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function base64FromInt16(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}


// Spinner とステータス表示コンポーネント
function Status({
  label,
  spinning = false,
}: {
  label: string;
  spinning?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {spinning && <Spinner />}
      <span style={{ opacity: 0.85 }}>{label}</span>
    </div>
  );
}

function Spinner() {
  return (
    <div
      style={{
        width: 16,
        height: 16,
        border: "2px solid #555",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "spin 1s linear infinite",
      }}
    />
  );
}

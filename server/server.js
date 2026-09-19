import express from "express";
import { Readable } from "node:stream";
import { registerTodoRoutes, todoTools, runTodoTool } from "./todolist.js";
import { pipeline } from "node:stream/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const app = express();
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is missing");
  process.exit(1);
}
const PY_TTS_BASE = process.env.PY_TTS_BASE ?? "http://localhost:5005";
const MCP_PYTHON = process.env.MCP_PYTHON ?? "python";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_REFERENCE_SERVER =
  process.env.MCP_REFERENCE_SERVER ??
  path.resolve(__dirname, "../mcp/reference_search.py");

let mcpClientPromise = null;
async function getMcpClient() {
  if (!mcpClientPromise) {
    mcpClientPromise = (async () => {
      const client = new Client({ name: "labchat-backend", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: MCP_PYTHON,
        args: [MCP_REFERENCE_SERVER],
      });
      await client.connect(transport);
      return client;
    })();
  }
  return mcpClientPromise;
}

async function callMcpTool(name, args) {
  const client = await getMcpClient();
  const result = await client.callTool({ name, arguments: args ?? {} });
  if (result?.isError) {
    throw new Error(`MCP tool error: ${name}`);
  }
  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (item?.type === "json" && item.json !== undefined) return item.json;
      if (item?.type === "text" && typeof item.text === "string") {
        try {
          return JSON.parse(item.text);
        } catch {
          return item.text;
        }
      }
    }
  }
  return result;
}

const mcpTools = [
  {
    type: "function",
    function: {
      name: "search_articles",
      description: "論文を検索して候補を返す。",
      parameters: {
        type: "object",
        properties: {
          keywords: { type: "string", description: "部分一致検索キーワード" },
          criterion: {
            type: "string",
            enum: ["year", "score", "cited_count"],
            description: "ソート基準",
          },
          nhits: { type: "integer", minimum: 1, maximum: 50, description: "表示件数" },
        },
        required: ["keywords"],
        additionalProperties: false,
      },
    },
  },
];

// ---- 画像マニフェスト ----
const IMAGES_DIR = path.resolve(__dirname, "../public/images");
const MANIFEST_PATH = path.join(IMAGES_DIR, "manifest.json");

function loadImageManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function runShowImage(args) {
  const manifest = loadImageManifest();
  const { id } = args;
  const entry = manifest.find((e) => e.id === id);
  if (!entry) return { ok: false, error: "image_not_found", id };
  return {
    ok: true,
    id: entry.id,
    filename: entry.filename,
    title: entry.title,
    description: entry.description,
  };
}

const imageTools = [
  {
    type: "function",
    function: {
      name: "show_image",
      description:
        "画像を画面に表示する。ユーザーが画像・写真・グラフ・図などの表示を要求したとき、適切な id を選んで呼び出す。呼び出すと画像が画面に表示され、description が返されるのでそれをもとにユーザーに説明する。",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "表示する画像の id（manifest の id）",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];

// ---- アバター動作・表情ツール ----
// この2つの語彙は src/components/live2dModels.ts の AvatarMotion / AvatarExpression と
// 対応している（モデルごとのモーション/exp3 への割り当てはフロント側が持つ）。
const VALID_MOTIONS = ["neutral", "happy", "sad", "surprised", "thinking", "explaining", "greeting", "nod"];
const VALID_EXPRESSIONS = ["neutral", "joy", "anger", "sorrow", "fun", "surprised", "shy", "troubled"];

function runSetAvatarMotion(args) {
  const { motion } = args;
  console.log("motion:",motion)
  if (!VALID_MOTIONS.includes(motion)) {
    return { ok: false, error: "invalid_motion", motion, valid: VALID_MOTIONS };
  }
  return { ok: true, motion };
}

function runSetAvatarExpression(args) {
  const { expression } = args;
  console.log("expression:", expression)
  if (!VALID_EXPRESSIONS.includes(expression)) {
    return { ok: false, error: "invalid_expression", expression, valid: VALID_EXPRESSIONS };
  }
  return { ok: true, expression };
}

const avatarTools = [
  {
    type: "function",
    function: {
      name: "set_avatar_motion",
      description:
        "アバターの表情・動作を変更する。会話の内容や雰囲気に合わせて毎回必ず呼び出すこと。"
        + " 例: 挨拶→greeting、嬉しい話題→happy、悲しい話題→sad、驚き→surprised、考え中→thinking、説明→explaining、同意→nod、通常→neutral",
      parameters: {
        type: "object",
        properties: {
          motion: {
            type: "string",
            enum: VALID_MOTIONS,
            description: "アバターに設定する動作",
          },
        },
        required: ["motion"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_avatar_expression",
      description:
        "アバターの顔の表情を変更する。動作(set_avatar_motion)とは別のレイヤーで、話している間ずっと保持される。会話の感情に合わせて毎回必ず呼び出すこと。"
        + " 例: 通常→neutral、喜び→joy、怒り→anger、哀しみ→sorrow、楽しい→fun、驚き→surprised、照れ→shy、困り→troubled",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            enum: VALID_EXPRESSIONS,
            description: "アバターに設定する表情",
          },
        },
        required: ["expression"],
        additionalProperties: false,
      },
    },
  },
];

registerTodoRoutes(app); //todolist.js

// 画像マニフェスト API
app.get("/api/images", (_req, res) => {
  const manifest = loadImageManifest();
  res.json({ images: manifest });
});


// 1) エフェメラルトークン発行
app.get("/api/realtime-token", async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 600 }, // 例: 10分
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "ja",
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
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: t });
    }

    const data = await r.json();
    // docs: client secret は value が `ek_...` 
    res.json({ token: data?.value, expires_at: data?.expires_at });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// TTS用（realtime セッション）
app.post("/api/tts-stream", async (req, res) => {
  try {
    const { text } = req.body;
    console.log("TTS stream request for text:", text);
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice: "alloy",
        input: text ?? "",
        response_format: "mp3",
      }),
    });

    if (!r.ok) {
      return res.status(500).json({ error: await r.text() });
    }
    console.log("TTS stream response received:",r) ;
    // ストリーム転送（chunked）
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");

    // Node の Response.body(WebStream) → Node Stream に変換して pipe
    const nodeStream = Readable.fromWeb(r.body);
    nodeStream.pipe(res);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/tts-stream2", async (req, res) => {
  const startedAt = Date.now();
  const { text } = req.body ?? {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: "text is empty" });

  const ac = new AbortController();
  req.on("aborted", () => ac.abort("client aborted"));
  res.on("close", () => { if (!res.writableEnded) ac.abort("client disconnected"); });

  try {
    console.log("[tts] start len=", String(text).length);

    const r = await fetch(`${PY_TTS_BASE}/tts-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, style_id: 0, bitrate: "128k" }),
      signal: ac.signal,
    });

    console.log("[tts] upstream headers received in", Date.now() - startedAt, "ms", r.status);

    if (!r.ok) return res.status(500).json({ error: await r.text() });
    if (!r.body) return res.status(500).json({ error: "No upstream stream body" });

    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    // このプロセスが母音タイムラインの転送に対応していることを示す目印。
    // 変更前の古いプロセスが残って応答していると、これが無いのでブラウザ側から判別できる
    // （実際に EADDRINUSE で古い Express が居座り、ヘッダが付かない事例があった）。
    res.setHeader("X-Tts-Features", "vowel-timeline");
    // 口の形のための母音タイムライン（base64(JSON)）をそのまま通す。
    // 音声はストリームなので本文には載せられず、かつ音声と1対1で対応させたいのでヘッダに乗せる。
    // barge-in で中断すればタイムラインも一緒に捨てられる。
    const vowelTimeline = r.headers.get("x-vowel-timeline");
    // VOICEVOX 側も対応の目印を返す。これで「古い VOICEVOX」と
    // 「新しいがタイムライン生成に失敗」を区別できる。
    const upstreamFeatures = r.headers.get("x-tts-server-features");
    if (upstreamFeatures) res.setHeader("X-Tts-Server-Features", upstreamFeatures);
    if (vowelTimeline) {
      res.setHeader("X-Vowel-Timeline", vowelTimeline);
      console.log("[tts] vowel timeline", vowelTimeline.length, "chars (base64)");
    } else if (!upstreamFeatures) {
      console.log(
        `[tts] vowel timeline なし: VOICEVOX (${PY_TTS_BASE}) が古いプロセスです。` +
          `再起動してください。上流の応答ヘッダ: ${[...r.headers.keys()].join(", ")}`,
      );
    } else {
      console.log(
        "[tts] vowel timeline なし: VOICEVOX は対応版ですが生成に失敗しています。" +
          "VOICEVOX 側のログのトレースバックを確認してください。",
      );
    }
    // 同一オリジンなら不要だが、API を別オリジンに置いた場合でも fetch から読めるように
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Vowel-Timeline, X-Tts-Features, X-Tts-Server-Features",
    );
    res.flushHeaders?.();

    const upstream = Readable.fromWeb(r.body);

    let first = true;
    let bytes = 0;
    let chunks = 0;

    upstream.on("data", (chunk) => {
      if (first) {
        first = false;
        console.log("[tts] first audio bytes after", Date.now() - startedAt, "ms");
      }
      chunks++;
      bytes += chunk.length;
      if (chunks % 20 === 0) console.log("[tts] streamed", chunks, "chunks", bytes, "bytes");
    });

    upstream.on("end", () => {
      console.log("[tts] upstream end after", Date.now() - startedAt, "ms", "total", bytes, "bytes");
    });

    upstream.on("error", (e) => {
      console.error("[tts] upstream error", e);
    });

    upstream.pipe(res);
  } catch (e) {
    if (ac.signal.aborted) {
      console.log("[tts] aborted:", ac.signal.reason);
      return;
    }
    console.error("[tts] error", e);
    if (!res.headersSent) res.status(500).json({ error: String(e) });
    else res.end();
  }
});


// 2) Chat（APIキーはサーバ側だけ）
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, isEnglishConversation } = req.body ?? {};
    const useEnglish = Boolean(isEnglishConversation);

    // 画像マニフェストからタイトル一覧を生成してシステムプロンプトに埋め込む
    const manifest = loadImageManifest();
    const imageListText = manifest.length > 0
      ? manifest.map((e) => `  - id="${e.id}": ${e.title}`).join("\n")
      : "(画像なし)";

    const system = {
      role: "system",
      content: useEnglish
        ? "You are a voice assistant that speaks naturally and concisely in English. If necessary, you can call tools (todo_*) in response to user requests."
          + " Use search_articles if you need to search for references."
          + " due_at must be ISO8601(+09:00) or null."
          + " Use tools to list/complete/delete/change due dates."
          + " When the user asks to show an image, photo, chart, or diagram, call show_image with the appropriate id. Then explain the image using the returned description."
          + "\nAvailable images:\n" + imageListText
          + "\nIMPORTANT: Always call set_avatar_motion to match the conversation mood. Examples: greeting→greeting, explaining→explaining, happy topic→happy, sad topic→sad, surprised→surprised, agreeing→nod, thinking→thinking."
          + "\nIMPORTANT: Also always call set_avatar_expression for the facial expression, which is a separate layer that is held while you speak. Examples: joy→joy, anger→anger, sorrow→sorrow, fun→fun, surprise→surprised, embarrassed→shy, troubled→troubled, otherwise→neutral."
        : "あなたは日本語で自然に短めに話す音声アシスタントです。ユーザーの依頼に応じて必要ならツール(todo_*)を呼び出す。"
          + " 参考文献の検索が必要なら search_articles を使う。"
          + " due_at は必ず ISO8601(+09:00) か null。"
          + " 一覧/完了/削除/期限変更はツールを使う。"
          + " ユーザーが画像・写真・グラフ・図の表示を求めたら show_image を呼び出し、返された description をもとに説明する。"
          + "\n利用可能な画像:\n" + imageListText
          + "\n重要: 毎回必ず set_avatar_motion を呼び出して、会話の雰囲気に合った動作を設定すること。例: 挨拶→greeting、説明→explaining、楽しい→happy、悲しい→sad、驚き→surprised、同意→nod、考え中→thinking。"
          + "\n重要: 併せて毎回必ず set_avatar_expression を呼び出して顔の表情を設定すること。表情は動作とは別のレイヤーで、話している間ずっと保持される。例: 喜び→joy、怒り→anger、哀しみ→sorrow、楽しい→fun、驚き→surprised、照れ→shy、困り→troubled、それ以外→neutral。",
    };

    let convo = [system, ...(messages ?? [])];
    let shownImage = null; // show_image が呼ばれた場合の画像情報
    let avatarMotion = null; // set_avatar_motion が呼ばれた場合の動作
    let avatarExpression = null; // set_avatar_expression が呼ばれた場合の表情

    for (let i = 0; i < 5; i++) {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4.1-nano",
          messages: convo,
          tools: [...todoTools, ...mcpTools, ...imageTools, ...avatarTools],
        }),
      });

      const raw = await r.text();
      if (!r.ok) return res.status(500).json({ error: raw });

      const data = JSON.parse(raw);
      const msg = data.choices?.[0]?.message;

      // no tool calls => final
      if (!msg?.tool_calls || msg.tool_calls.length === 0) {
        const result = { reply: msg?.content ?? "" };
        if (shownImage) result.image = shownImage;
        if (avatarMotion) result.motion = avatarMotion;
        if (avatarExpression) result.expression = avatarExpression;
        return res.json(result);
      }

      // add assistant message with tool_calls
      convo.push(msg);

      // execute tools and append tool results
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name;

        let args = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          args = {};
        }

        let out;
        if (name?.startsWith("todo_")) {
          out = runTodoTool(name, args);
        } else if (name === "search_articles") {
          out = await callMcpTool(name, args);
        } else if (name === "show_image") {
          out = runShowImage(args);
          if (out.ok) {
            shownImage = {
              id: out.id,
              filename: out.filename,
              title: out.title,
              description: out.description,
            };
          }
        } else if (name === "set_avatar_motion") {
          out = runSetAvatarMotion(args);
          if (out.ok) {
            avatarMotion = out.motion;
          }
        } else if (name === "set_avatar_expression") {
          out = runSetAvatarExpression(args);
          if (out.ok) {
            avatarExpression = out.expression;
          }
        } else {
          out = { ok: false, error: "unknown_tool", name };
        }

        convo.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(out),
        });
      }
    }

    const result = {
      reply: useEnglish
        ? "Too many tool calls. Please try again with a shorter request."
        : "ツール処理が多いため中断しました。もう一度短く指示してください。",
    };
    if (shownImage) result.image = shownImage;
    if (avatarMotion) result.motion = avatarMotion;
    if (avatarExpression) result.expression = avatarExpression;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
// 3) TTS（サーバ→mp3を返す）
app.post("/api/tts", async (req, res) => {
  try {
    const { text } = req.body;

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice: "alloy",
        input: text ?? "",
        response_format: "mp3",
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: t });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.listen(8787, () => {
  console.log("Backend listening on http://localhost:8787");
});

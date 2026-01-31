import express from "express";
import { Readable } from "node:stream";
import { registerTodoRoutes, todoTools, runTodoTool } from "./todolist.js";
import { pipeline } from "node:stream/promises";
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

registerTodoRoutes(app); //todolist.js


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

    const system = {
      role: "system",
      content: useEnglish
        ? "You are a voice assistant that speaks naturally and concisely in English. If necessary, you can call tools (todo_*) in response to user requests."
          + " Use search_articles if you need to search for references."
          + " due_at must be ISO8601(+09:00) or null."
          + " Use tools to list/complete/delete/change due dates."
        : "あなたは日本語で自然に短めに話す音声アシスタントです。ユーザーの依頼に応じて必要ならツール(todo_*)を呼び出す。"
          + " 参考文献の検索が必要なら search_articles を使う。"
          + " due_at は必ず ISO8601(+09:00) か null。"
          + " 一覧/完了/削除/期限変更はツールを使う。",
    };

    let convo = [system, ...(messages ?? [])];

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
          tools: [...todoTools, ...mcpTools],
        }),
      });

      const raw = await r.text();
      if (!r.ok) return res.status(500).json({ error: raw });

      const data = JSON.parse(raw);
      const msg = data.choices?.[0]?.message;

      // no tool calls => final
      if (!msg?.tool_calls || msg.tool_calls.length === 0) {
        return res.json({ reply: msg?.content ?? "" });
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

    res.json({
      reply: useEnglish
        ? "Too many tool calls. Please try again with a shorter request."
        : "ツール処理が多いため中断しました。もう一度短く指示してください。",
    });
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

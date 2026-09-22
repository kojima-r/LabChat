# LabChat

音声対話・Live2D アバター・学術論文検索・TODO 管理を統合したマルチモーダル AI アシスタントです。

## 主な機能

- **音声対話** — OpenAI Realtime API による音声認識 + TTS（英語: OpenAI TTS / 日本語: VOICEVOX）でハンズフリー会話。割り込み（Barge-in）対応
- **Live2D アバター** — Pixi.js + Live2D Cubism 4 によるキャラクター表示。音声に連動したリップシンク・視線追従・まばたきアニメーション
- **TODO 管理** — 自然言語で追加・完了・削除。期限が来るとブラウザ通知でリマインド
- **学術論文検索** — Crossref API 経由で Nature / Science 等のジャーナルを検索（MCP サーバー）
- **研究エージェント** — AutoGen マルチエージェントが arXiv 論文を調査し、記事を自動執筆（Planning → Research → Writer → Critic の 2 フェーズワークフロー）
- **日英バイリンガル** — 会話言語を切り替え可能

## アーキテクチャ

```
Browser (React 19 + TypeScript + Vite)
  ├─ OpenAI Realtime API (WebSocket) ─── 音声認識 (STT)
  ├─ Express Backend (:8787)
  │    ├─ /api/chat ─── GPT-4o-mini（Tool Calling: TODO / 論文検索）
  │    ├─ /api/tts-stream ─── OpenAI TTS（英語）
  │    ├─ /api/tts-stream2 ── VOICEVOX TTS（日本語）
  │    └─ /api/todos ──────── TODO CRUD
  ├─ MCP Server (Python) ─── Crossref 論文検索
  ├─ VOICEVOX TTS Server (:5005) ─── FastAPI + ffmpeg
  └─ AutoGen Agent Server ─── arXiv 調査 & 記事執筆
```

## ディレクトリ構成

```
src/                        # フロントエンド (React)
  ├─ App.tsx                #   メインアプリケーション
  ├─ components/
  │    ├─ Live2DCanvas.tsx   #   Live2D 描画 & リップシンク
  │    └─ TodoPanel.tsx      #   TODO パネル & 通知
  └─ main.tsx               #   エントリーポイント
server/                     # バックエンド (Express)
  ├─ server.js              #   API サーバー
  └─ todolist.js            #   TODO ツール定義
agents/arxiv_agent/         # 研究エージェント (AutoGen)
  ├─ main.py                #   ジョブ管理
  ├─ agents.py              #   エージェント定義
  ├─ workflow.py             #   2 フェーズワークフロー
  ├─ server.py              #   FastAPI ジョブサーバー
  └─ tools/arxiv_tool.py    #   arXiv 検索ツール
mcp/
  └─ reference_search.py    # Crossref 論文検索 (FastMCP)
voicevox/
  └─ tts_server.py          # 日本語 TTS サーバー (FastAPI)
```

## セットアップ

### 前提条件

- Node.js 18+
- Python 3.8+
- ffmpeg（VOICEVOX の WAV → MP3 変換に必要）
- VOICEVOX モデルファイル (.vvm) と Open JTalk 辞書（日本語 TTS を使う場合）

### インストール

```bash
# フロントエンド & バックエンドの依存関係
npm install

# Python 依存関係（エージェント・MCP・VOICEVOX）
pip install autogen arxiv fastmcp crossref-commons fastapi uvicorn voicevox_core
```

### 環境変数

プロジェクトルートに `.env` を作成:

```
OPENAI_API_KEY=sk-...
```

オプション:

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PY_TTS_BASE` | `http://localhost:5005` | VOICEVOX サーバーの URL |
| `MCP_PYTHON` | `python` | Python インタプリタのパス |
| `MCP_REFERENCE_SERVER` | `mcp/reference_search.py` | MCP サーバーのパス |

### Live2D モデル

Live2D Cubism Core JS と モデルファイルを `public/assets/` に配置:

```
public/assets/
  ├─ live2dcubismcore.min.js
  └─ models/Haru/Haru.model3.json
```

## 起動

```bash
# 1. バックエンド (Express)
node server/server.js

# 2. フロントエンド (Vite dev server)
npm run dev

# 3. VOICEVOX TTS サーバー（日本語音声を使う場合）
python voicevox/tts_server.py

# 4. 研究エージェント（記事執筆機能を使う場合）
python agents/arxiv_agent/server.py
```

ブラウザで http://localhost:5173 を開きます。

### LAN 上の他端末からアクセスする

`npm run dev` はデフォルトで `localhost` にしかバインドしません。同じネットワーク内の
スマホ・別 PC など、このマシン以外の端末からアクセスしたい場合はルートの `./run.sh` を
使ってください。

```bash
./run.sh
```

`run.sh` は Vite を `0.0.0.0` で待ち受けさせ、同時に自己署名証明書で HTTPS を有効化します
（`vite.config.ts` の `LABCHAT_LAN=1` 分岐、`@vitejs/plugin-basic-ssl` が証明書を自動生成）。
起動すると次のように表示されるので、`Network:` の URL を他端末のブラウザで開きます。

```
➜  Local:   https://localhost:5173/
➜  Network: https://192.168.x.x:5173/
```

- **マイク (音声入力) には HTTPS が必須です。** ブラウザの `getUserMedia` は
  「セキュアコンテキスト」（`localhost` または HTTPS）でしか動作しないため、`http://<LAN
  IP>:5173` のままでは音声入力が使えません。`./run.sh` が自己署名証明書で HTTPS 化するのは
  このためです。
- 証明書は自己署名なので、初回アクセス時にブラウザが警告を出します。「詳細設定」→
  「`<IP>` にアクセスする（安全ではありません）」の順に進めば、以降は同じブラウザ・端末で
  そのまま使えます。
- バックエンド (`node server/server.js`) は `0.0.0.0:8787` で待ち受け、起動時に LAN 側の
  URL もログに出します。Vite は開発時 `/api/*` をこのバックエンドへサーバーサイドで
  プロキシするので、ブラウザから直接 `:8787` を叩く必要はありません。
- 別マシンからの接続がタイムアウトする場合は、ホスト側ファイアウォール（`ufw` など）で
  `5173/tcp`（と、直接デバッグしたい場合は `8787/tcp`）を許可してください。
- VOICEVOX (`:5005`) と研究エージェント (`:8000`) はバックエンドが内部的に呼び出すだけで
  ブラウザから直接アクセスしないため、LAN 公開は不要です。

## 詳細ドキュメント

各コンポーネントの環境構築・起動手順の詳細は以下を参照してください。

- [フロントエンド（React + Vite + Live2D）](docs/setup-frontend.md)
- [バックエンド（Express API サーバー）](docs/setup-backend.md)
- [VOICEVOX TTS サーバー](docs/setup-voicevox.md)
- [研究エージェント & MCP 論文検索サーバー](docs/setup-agents.md)

## 技術スタック

| レイヤー | 技術 |
|---|---|
| フロントエンド | React 19, TypeScript, Vite 7 |
| バックエンド | Express 5, Node.js |
| AI モデル | GPT-4o-mini (Chat), OpenAI Realtime API (STT) |
| 音声合成 | OpenAI TTS (英語), VOICEVOX (日本語) |
| アバター | Pixi.js 7, pixi-live2d-display, Live2D Cubism 4 |
| エージェント | AutoGen, arXiv API |
| 論文検索 | Crossref API, FastMCP (Model Context Protocol) |

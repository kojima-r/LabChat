# バックエンド環境構築・起動ガイド

## 概要

Express 5 (Node.js) で構築された API サーバーです。
フロントエンドからのチャット・TTS・TODO・トークン発行リクエストを処理し、OpenAI API や VOICEVOX サーバーと連携します。

## 前提条件

- **Node.js 18+**
- **OpenAI API キー**（Chat / TTS / Realtime API に使用）

## インストール

フロントエンドと同じ `npm install` でバックエンドの依存関係もインストールされます。

```bash
cd LabChat
npm install
```

バックエンドが使用する主なパッケージ:

| パッケージ | 用途 |
|---|---|
| `express` (v5) | HTTP サーバー |
| `cors` | CORS 設定 |
| `@modelcontextprotocol/sdk` | MCP クライアント（論文検索サーバーとの通信） |

## 環境変数の設定

プロジェクトルートに `.env` ファイルを作成します。

```bash
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

### オプション環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `PY_TTS_BASE` | `http://localhost:5005` | VOICEVOX TTS サーバーの URL |
| `MCP_PYTHON` | `python` | Python インタプリタのパス（venv 使用時はフルパス指定） |
| `MCP_REFERENCE_SERVER` | `mcp/reference_search.py` | MCP 論文検索サーバーのスクリプトパス |

## 起動

```bash
node server/server.js
```

`Backend listening on http://localhost:8787` と表示されれば起動完了です。

> **注意**: `.env` に `OPENAI_API_KEY` が設定されていない場合、起動時にエラーで終了します。

## API エンドポイント一覧

### 認証トークン

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/realtime-token` | OpenAI Realtime API 用エフェメラルトークン発行（有効期限 10 分） |

### チャット

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/chat` | GPT-4o-mini によるチャット応答（Tool Calling 対応） |

リクエストボディ:

```json
{
  "messages": [{"role": "user", "content": "..."}],
  "isEnglishConversation": false
}
```

Tool Calling で以下のツールが自動実行されます:

- `todo_add` — TODO 追加（`text`, `due_at`）
- `todo_list` — TODO 一覧取得
- `todo_complete` — TODO 完了（`id`）
- `todo_remove` — TODO 削除（`id`）
- `todo_update_due` — TODO 期限変更（`id`, `due_at`）
- `search_articles` — 論文検索（`keywords`, `criterion`, `nhits`）

1 ターンあたり最大 5 回のツール呼び出しループを実行します。

### 音声合成 (TTS)

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/tts` | OpenAI TTS（バッチ、MP3 バイナリ返却） |
| POST | `/api/tts-stream` | OpenAI TTS（ストリーミング、英語用） |
| POST | `/api/tts-stream2` | VOICEVOX TTS（ストリーミング、日本語用）。`X-Vowel-Timeline` ヘッダでモーラ情報も返す |

リクエストボディ（共通）:

```json
{
  "text": "読み上げるテキスト"
}
```

`/api/tts-stream2` は VOICEVOX サーバー（`PY_TTS_BASE`）にプロキシします。
音声ストリームに加えて、上流の `X-Vowel-Timeline`（母音タイムライン、base64 の JSON）を
そのまま通します。フロントエンドはこれで母音ベースのリップシンクを行い、ヘッダが無い場合は
音量のみのリップシンクにフォールバックします（詳細は
[VOICEVOX ガイド](./setup-voicevox.md)）。
日本語 TTS を使う場合は [VOICEVOX サーバー](./setup-voicevox.md)を先に起動してください。

### TODO 管理

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/todos` | TODO 一覧取得（期限順） |
| POST | `/api/todo/remove` | TODO 削除（`{"id": "..."}` ） |

> TODO はインメモリ管理です。サーバーを再起動するとデータは消去されます。

## MCP サーバー連携

バックエンドは起動時に MCP（Model Context Protocol）論文検索サーバーを子プロセスとして自動起動します。

- サーバースクリプト: `mcp/reference_search.py`
- 通信方式: stdio
- 検索対象ジャーナル: Nature, Science, Nature Communications（Crossref API 経由）

MCP サーバーを使用するには Python と依存パッケージが必要です（[MCP サーバーガイド](./setup-agents.md#mcp-論文検索サーバー)参照）。

## ディレクトリ構成

```
server/
├── server.js       # Express API サーバー本体
│                   #   エフェメラルトークン発行、チャット (Tool Calling)、
│                   #   TTS プロキシ、MCP クライアント
└── todolist.js     # TODO のインメモリストア、ツール定義、REST ルート
```

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `OPENAI_API_KEY is missing` で起動しない | `.env` に `OPENAI_API_KEY` を設定 |
| `/api/tts-stream2` が 500 エラー | VOICEVOX サーバー（port 5005）が起動しているか確認 |
| `/api/chat` で `search_articles` が失敗する | Python と `crossref-commons`, `fastmcp` がインストールされているか確認 |
| MCP サーバー起動エラー | `MCP_PYTHON` が正しい Python パスを指しているか確認 |

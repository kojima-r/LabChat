# 研究エージェント & MCP サーバー環境構築・起動ガイド

## 概要

このプロジェクトには 2 つの Python サーバーがあります。

1. **研究エージェントサーバー** — AutoGen マルチエージェントが arXiv 論文を調査し、解説記事を自動執筆
2. **MCP 論文検索サーバー** — Crossref API で Nature / Science 等のジャーナルを検索（バックエンドから自動起動）

---

## 研究エージェントサーバー

### 仕組み

4 つの AI エージェント（AutoGen）が協調して記事を作成します。

**Phase 1: 探索（GroupChat）**

最大 8 ラウンドの議論で執筆方針を決定します。

| エージェント | 役割 |
|---|---|
| PlanningAgent | タスクを分解し、執筆計画を立案 |
| ResearchAgent | arXiv で関連論文を検索・調査 |
| WriterAgent | 調査結果をもとに記事を執筆 |
| CriticAgent | 記事の正確性・品質をレビュー |

**Phase 2: 執筆（Sequential Workflow）**

確定した方針に基づき、順次処理で最終原稿を生成します。

```
PlanningAgent → ResearchAgent → WriterAgent ↔ CriticAgent（最大 3 往復）
```

CriticAgent が「承認」と回答すると完了。最終原稿は `work/{job_id}/final_article.txt` に保存されます。

### 前提条件

- **Python 3.8+**
- **OpenAI API キー**（GPT-4o-mini を使用）

### Python 依存パッケージ

```bash
pip install autogen arxiv
```

### 環境変数

エージェントは `OAI_CONFIG_LIST` 環境変数、または AutoGen のデフォルト設定を使用して OpenAI API にアクセスします。
`OPENAI_API_KEY` が環境変数に設定されている必要があります。

### 起動

```bash
cd agents/arxiv_agent
uvicorn server:app --host 0.0.0.0 --port 8000
```

FastAPI サーバーがポート 8000 で起動します。

### API エンドポイント

#### ジョブ投入

```
POST /jobs
Content-Type: application/json
```

```json
{
  "text": "AutoGenに関する最近のarXiv研究を調査し、日本語で研究解説記事を書いてください。"
}
```

レスポンス:

```json
{
  "job_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "status": "RUNNING"
}
```

#### ジョブ状態確認・結果取得

```
GET /jobs/{job_id}
```

レスポンス:

```json
{
  "job_id": "...",
  "status": "DONE",
  "result": "（最終原稿のテキスト）"
}
```

`status` は `RUNNING` → `DONE` と遷移します。

### ジョブの出力ファイル

各ジョブの成果物は `agents/arxiv_agent/work/{job_id}/` に保存されます。

```
work/{job_id}/
├── status.txt          # ジョブ状態（RUNNING / DONE）
├── final_article.txt   # 最終原稿
└── log.txt             # エージェント間の議論ログ
```

### ディレクトリ構成

```
agents/arxiv_agent/
├── main.py             # ジョブ実行（Phase 1 → Phase 2）
├── agents.py           # エージェント定義（4 種）
├── workflow.py         # Phase 2 の Sequential Workflow
├── server.py           # FastAPI ジョブサーバー
├── llm_config.py       # LLM 設定（GPT-4o-mini, temperature 0.3）
├── prompts/            # 各エージェントのシステムプロンプト
│   ├── planning.txt
│   ├── research.txt
│   ├── writer.txt
│   └── critic.txt
└── tools/
    └── arxiv_tool.py   # arXiv 検索ツール
```

### スタンドアロン実行

サーバーを使わず直接実行することもできます。

```bash
cd agents/arxiv_agent
python main.py
```

`main.py` 末尾の `main()` 関数内のタスクが実行され、`work/test/` に結果が出力されます。

---

## MCP 論文検索サーバー

### 仕組み

FastMCP（Model Context Protocol）で実装された論文検索ツールです。
Crossref API を使って以下のジャーナルを横断検索します。

- Nature（ISSN: 1476-4687）
- Science（ISSN: 1095-9203）
- Nature Communications（ISSN: 2041-1723）

バックエンド（Express サーバー）が起動時に子プロセスとして自動的にこのサーバーを起動するため、手動で起動する必要はありません。

### Python 依存パッケージ

```bash
pip install fastmcp crossref-commons
```

### ファイル

```
mcp/
└── reference_search.py    # FastMCP サーバー（stdio トランスポート）
```

### ツール仕様

#### `search_articles`

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `keywords` | string | （必須） | 検索キーワード（部分一致） |
| `criterion` | string | `"score"` | ソート基準: `year`, `score`, `cited_count` |
| `nhits` | int | `10` | 取得件数（最大 50） |

レスポンス（各論文）:

```json
{
  "title": "論文タイトル",
  "doi": "https://doi.org/...",
  "journal": "Nature",
  "year": 2024,
  "score": 12.34,
  "cited_count": 56
}
```

### バックエンドとの連携

バックエンドの `/api/chat` エンドポイントで GPT がユーザーの質問に応じて `search_articles` ツールを自動的に呼び出します。

バックエンドが MCP サーバーを見つけられない場合は、以下の環境変数で調整してください:

```bash
MCP_PYTHON=python3           # Python インタプリタのパス
MCP_REFERENCE_SERVER=mcp/reference_search.py  # スクリプトパス
```

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `ModuleNotFoundError: No module named 'autogen'` | `pip install autogen` を実行 |
| `ModuleNotFoundError: No module named 'arxiv'` | `pip install arxiv` を実行 |
| `ModuleNotFoundError: No module named 'fastmcp'` | `pip install fastmcp` を実行 |
| `ModuleNotFoundError: No module named 'crossref'` | `pip install crossref-commons` を実行 |
| エージェントが OpenAI API にアクセスできない | `OPENAI_API_KEY` 環境変数を確認 |
| arXiv 検索結果が 0 件 | クエリを英語で指定してみる（arXiv は英語論文が主） |
| ジョブが `RUNNING` のまま進まない | `work/{job_id}/log.txt` でエージェントのログを確認 |

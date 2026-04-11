# フロントエンド環境構築・起動ガイド

## 概要

React 19 + TypeScript + Vite 7 で構築されたシングルページアプリケーションです。
音声入力（OpenAI Realtime API）、Live2D アバター、TODO パネルなどの UI を提供します。

## 前提条件

- **Node.js 18+**（`node -v` で確認）
- **npm**（Node.js に同梱）

## インストール

プロジェクトルートで依存関係をインストールします。

```bash
cd LabChat
npm install
```

主な依存パッケージ:

| パッケージ | 用途 |
|---|---|
| `react`, `react-dom` | UI フレームワーク |
| `pixi.js` (v7) | Live2D 描画エンジン |
| `pixi-live2d-display` | Live2D Cubism 4 連携 |
| `@modelcontextprotocol/sdk` | MCP クライアント（バックエンド側で使用） |

## Live2D モデルの配置

Live2D キャラクターを表示するには、以下のファイルを手動で配置する必要があります。

### 1. Live2D Cubism Core JS

`public/assets/` に `live2dcubismcore.min.js` を配置します。

```
public/assets/live2dcubismcore.min.js
```

> Live2D 公式サイト（Cubism SDK for Web）からダウンロードしてください。

### 2. Live2D モデルファイル

`public/assets/models/` 以下にモデルを配置します。デフォルトでは Haru モデルを使用します。

```
public/assets/models/Haru/
  ├── Haru.model3.json
  ├── Haru.cdi3.json
  ├── Haru.moc3
  ├── Haru.physics3.json
  └── textures/
```

### 3. モデル設定の変更（重要）

`Haru.model3.json` 内の **Idle モーション**を空欄にしてください。
これを行わないとリップシンクやカスタムアニメーションが正しく動作しません。

```json
"Motions": {
  "Idle": []
}
```

## 開発サーバーの起動

```bash
npm run dev
```

Vite 開発サーバーが起動し、デフォルトで http://localhost:5173 でアクセスできます。

### API プロキシ設定

`vite.config.ts` により、開発時の `/api/*` リクエストはバックエンド（`http://localhost:8787`）に自動プロキシされます。
フロントエンドを使用するには、先にバックエンドサーバーを起動しておく必要があります（[バックエンドガイド](./setup-backend.md)参照）。

## ビルド

本番用ビルドを作成する場合:

```bash
npm run build
```

`dist/` ディレクトリに成果物が生成されます。プレビュー:

```bash
npm run preview
```

## ディレクトリ構成

```
src/
├── App.tsx                 # メインアプリケーション
│                           #   音声入力 (WebSocket)、チャット、TTS 再生、
│                           #   Barge-in、レイテンシ計測、言語切替
├── components/
│   ├── Live2DCanvas.tsx    # Live2D 描画・リップシンク・視線追従
│   └── TodoPanel.tsx       # TODO リスト表示・ブラウザ通知
├── main.tsx                # React エントリーポイント
└── App.css                 # スタイル（ダークテーマ）
```

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| Live2D モデルが表示されない | `public/assets/live2dcubismcore.min.js` が配置されているか確認 |
| キャラクターが Idle モーションでループする | `Haru.model3.json` の `Idle` を空配列 `[]` にする |
| API リクエストが 502/504 になる | バックエンドサーバー（port 8787）が起動しているか確認 |
| マイクが使えない | ブラウザにマイク権限を許可する。HTTPS または localhost が必要 |

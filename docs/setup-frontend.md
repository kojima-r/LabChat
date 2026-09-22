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
| Cubism SDK for Web 5 r.5 | Live2D 描画（Framework ソースを直接バンドル。npm 依存ではない） |
| `@modelcontextprotocol/sdk` | MCP クライアント（バックエンド側で使用） |

## Live2D モデルの配置

Live2D キャラクターを表示するには、以下のファイルを手動で配置する必要があります。

### 1. Live2D Cubism Core JS

> **Core 6 系を置いてください。** `Live2D_0730` の moc3 はフォーマット版 6（Cubism 5.3）で、
> `MocVersion_53` に対応した Core が必要です。`riken_live2d_controller/CubismSdkForWeb-5-r.5/Core/`
> のものをコピーすれば足ります。対応状況はコンソールに
> `Cubism Core x.y.z / 対応 moc3 上限 version N` として出ます。

`public/assets/` に `live2dcubismcore.min.js` を配置します。

```
public/assets/live2dcubismcore.min.js
```

> Live2D 公式サイト（Cubism SDK for Web）からダウンロードしてください。

### 2. Cubism SDK for Web 5 r.5 と ブレンドモード用シェーダ

描画は `pixi-live2d-display` ではなく **SDK の Framework ソースを直接**使います
（理由は `CLAUDE.md` の Live2D セクション）。SDK 一式を以下に置いてください:

```
riken_live2d_controller/CubismSdkForWeb-5-r.5/
```

置き場所を変える場合は `vite.config.ts` の `CUBISM_SDK` の1行だけ直せば済みます。

Framework はブレンドモード用シェーダを**実行時に fetch** するので、13ファイルを
`public/shaders/` へコピーしておく必要があります:

```bash
cp riken_live2d_controller/CubismSdkForWeb-5-r.5/Framework/Shaders/WebGL/* public/shaders/
```

これが無いとモデルが真っ白のまま描画されません。

### 3. Live2D モデルファイル

`public/assets/models/` 以下にモデルを配置します。デフォルトでは Haru モデルを使用します。

```
public/assets/models/Haru/
  ├── Haru.model3.json
  ├── Haru.cdi3.json
  ├── Haru.moc3
  ├── Haru.physics3.json
  ├── expressions/          # F01〜F08.exp3.json（表情）
  ├── motions/              # Avatar グループ 26 モーション
  └── Haru.2048/            # テクスチャ
```

理研提供モデル（`Live2D_0730`）も同じ場所に置けます。`riken_live2d_controller`
のベンダー配布物をそのままコピーしてください。

```
public/assets/models/Live2D_0730/
  ├── Live2D.model3.json
  ├── Live2D.cdi3.json
  ├── Live2D.moc3
  ├── motions/              # default_idle / senses_idle / <形態>_<感情>/<ポーズ> など 52 本
  └── Live2D.2048/
```

### 4. モデル設定の変更（重要）

`Haru.model3.json` 内の **Idle モーション**を空欄にしてください。
これを行わないとリップシンクやカスタムアニメーションが正しく動作しません。

```json
"Motions": {
  "Idle": []
}
```

`Live2D_0730` 側はベンダー配布ファイルに手を入れる必要はありません。
`Motions` の参照パスが実体（`motions/`）と食い違っている点などは、読み込み時に
`live2dModels.ts` の `patchSettings` がメモリ上で補正します。

### 5. モデル / 表情 / モーションの切り替え

- 通常は LLM が `set_avatar_motion` / `set_avatar_expression` ツールで制御します。
- デバッグ時は画面下部パネルの「アバター（デバッグ）」から、モデル・形態・表情・
  モーションを手動で切り替えられます。そのモデル・形態に該当アセットが無い項目は
  ボタンが無効化されます。
- 使用するモデルと、意味付き表情（`joy`/`anger`/…）・モーションから実ファイルへの
  割り当ては `src/components/live2dModels.ts` の `ModelConfig` に集約されています。
  モデルを追加する場合はここに 1 エントリ足すだけで済みます。
- 表示の大きさ・位置は Cubism の投影行列で決まるので、パネルの「大きさ / 左右 / 上下」
  スライダで合わせてから `ModelConfig.view` に書き戻してください。

## 開発サーバーの起動

```bash
npm run dev
```

Vite 開発サーバーが起動し、デフォルトで http://localhost:5173 でアクセスできます（`localhost`
にのみバインドされ、LAN の他端末からは接続できません）。

### API プロキシ設定

`vite.config.ts` により、開発時の `/api/*` リクエストはバックエンド（`http://localhost:8787`）に自動プロキシされます。
フロントエンドを使用するには、先にバックエンドサーバーを起動しておく必要があります（[バックエンドガイド](./setup-backend.md)参照）。

### LAN 上の他端末からアクセスする

ルートの `./run.sh`（`LABCHAT_LAN=1 npm run dev` を実行する）を使うと、Vite が
`0.0.0.0` にバインドされ、`@vitejs/plugin-basic-ssl`（`vite.config.ts` の `lanMode`
分岐）が自己署名証明書で HTTPS を有効化します。ブラウザの `getUserMedia`（マイク）は
セキュアコンテキスト（`localhost` または HTTPS）でしか動かないため、LAN 越しに音声入力を
使うには HTTPS が必須です。起動ログの `Network:` に出る URL（例:
`https://192.168.x.x:5173/`）を他端末のブラウザで開き、自己署名証明書の警告は「詳細設定 →
アクセスする」で進めてください。詳細は [README](../README.md#lan-上の他端末からアクセスする)
参照。

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
│   ├── Live2DCanvas.tsx    # Live2D 描画・リップシンク・視線追従・モーション/表情再生
│   ├── live2dModels.ts     # モデルレジストリ（配置・モーション/表情の割り当て・形態）
│   └── TodoPanel.tsx       # TODO リスト表示・ブラウザ通知
├── main.tsx                # React エントリーポイント
└── App.css                 # スタイル（ダークテーマ）
```

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| Live2D モデルが表示されない | `public/assets/live2dcubismcore.min.js` が配置されているか確認 |
| モデルが真っ白 / 描画されない | `public/shaders/` に13ファイルあるか確認（Framework が実行時に fetch する） |
| dev の初回表示が遅い | `vite.config.ts` の `optimizeDeps.include` に Framework のエントリが並んでいるか確認（無いと 44 モジュールが個別配信される）。`rm -rf node_modules/.vite` で作り直せる |
| `@framework/...` が解決できないとビルドが落ちる | `riken_live2d_controller/CubismSdkForWeb-5-r.5/` が置かれているか確認 |
| 口が動かない（リップシンク） | コンソールの `lipsync[...]` 行を確認。`rms=0.0000` なら音声が解析器に届いていない、`ParamMouthOpenY=n/a` ならモデルにそのパラメータが無い、`母音タイムラインなし` なら VOICEVOX サーバーの再起動が必要 |
| `ReferenceError: Live2DCubismCore is not defined` | Core の `<script>` より先に Framework が評価されている。`Live2DCanvas.tsx` の `CubismRuntime` / `CubismLive2DModel` は動的 import（`await import`）のままにする |
| アバターが小さすぎる / 画角がずれる | パネルの「大きさ / 左右 / 上下」で調整し `ModelConfig.view` に反映 |
| モデル切り替えが「Loading model…」で止まる | ブラウザのコンソールの `[Live2D]` ログを確認。`moc3 のフォーマット版がこの Cubism Core では読めません` と出ていたら Core が古い（下記参照） |
| `Loading model…` のまま 20 秒で失敗する | コンソールに未到達のステージ（`textureLoaded` など）が出るので、そのファイルの HTTP 応答を確認 |
| キャラクターが Idle モーションでループする | `Haru.model3.json` の `Idle` を空配列 `[]` にする |
| デバッグパネルの表情/モーションボタンが無効 | そのモデル・形態にベンダーが該当アセットを用意していない（例: 通常形態のあいさつ、嗅覚の驚き） |
| `Live2D_0730` で表情ボタンの「照れ」「困り」が使えない | このモデルは `.exp3.json` を持たず、喜怒哀楽モーションで表情を表現しているため |
| API リクエストが 502/504 になる | バックエンドサーバー（port 8787）が起動しているか確認 |
| マイクが使えない | ブラウザにマイク権限を許可する。HTTPS または localhost が必要（LAN の他端末からは `npm run dev` ではなく `./run.sh` で HTTPS 化してアクセスする） |

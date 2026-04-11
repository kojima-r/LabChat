# VOICEVOX TTS サーバー環境構築・起動ガイド

## 概要

VOICEVOX Core を使った日本語音声合成（TTS）サーバーです。
FastAPI で構築されており、テキストを受け取って MP3 音声をストリーミング返却します。

> 英語音声のみ使用する場合、このサーバーは不要です（OpenAI TTS が使用されます）。

## 前提条件

- **Python 3.8+**
- **ffmpeg**（WAV → MP3 変換に使用）

### ffmpeg のインストール

```bash
# Ubuntu / Debian
sudo apt install ffmpeg

# macOS (Homebrew)
brew install ffmpeg

# 確認
ffmpeg -version
```

## Python 依存パッケージ

```bash
pip install fastapi uvicorn voicevox_core
```

## VOICEVOX Core の準備

### 1. ONNX Runtime ライブラリ

VOICEVOX Core は ONNX Runtime を使用します。ライブラリファイルを以下のパスに配置します（環境変数で変更可能）。

```
voicevox/voicevox_core/example/python/onnxruntime/lib/
```

### 2. Open JTalk 辞書

日本語の音素解析に Open JTalk 辞書が必要です。

```
voicevox/open_jtalk_dic_utf_8-1.11/
```

> VOICEVOX Core のリリースページからダウンロードできます。

### 3. 音声モデルファイル (.vvm)

話者の音声モデルファイルを配置します。

```
voicevox/model.vvm
```

### 最終的なディレクトリ構成

```
voicevox/
├── tts_server.py                       # FastAPI サーバー本体
├── run.py                              # スタンドアロン TTS 実行スクリプト
├── model.vvm                           # 音声モデル
├── open_jtalk_dic_utf_8-1.11/          # Open JTalk 辞書
└── voicevox_core/
    └── example/python/onnxruntime/lib/ # ONNX Runtime ライブラリ
```

## 環境変数

| 変数 | デフォルト | 説明 |
|---|---|---|
| `VOICEVOX_VVM` | `./model.vvm` | 音声モデルファイルのパス |
| `OPENJTALK_DICT_DIR` | `./open_jtalk_dic_utf_8-1.11` | Open JTalk 辞書ディレクトリ |
| `ONNXRUNTIME_LIB` | （自動検出） | ONNX Runtime ライブラリのパス |
| `VOICEVOX_MODE` | `AUTO` | アクセラレーションモード（`AUTO` / `CPU` / `GPU`） |

## 起動

`voicevox/` ディレクトリに移動して起動します。

```bash
cd voicevox
uvicorn tts_server:app --host 0.0.0.0 --port 5005
```

または直接:

```bash
cd voicevox
python -m uvicorn tts_server:app --host 0.0.0.0 --port 5005
```

起動時にモデルの読み込みが行われます。`INFO: Application startup complete.` と表示されれば準備完了です。

> バックエンドの `PY_TTS_BASE` 環境変数（デフォルト `http://localhost:5005`）でこのサーバーの URL を参照しています。ポートを変更する場合はバックエンド側の設定も合わせてください。

## API エンドポイント

### ヘルスチェック

```
GET /health
```

レスポンス:

```json
{"ok": true, "mode": "AUTO", "vvm": "./model.vvm"}
```

### 音声合成（ストリーミング）

```
POST /tts-stream
Content-Type: application/json
```

リクエストボディ:

```json
{
  "text": "こんにちは",
  "style_id": 0,
  "bitrate": "128k"
}
```

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `text` | string | （必須） | 読み上げるテキスト |
| `style_id` | int | `0` | 話者スタイル ID |
| `bitrate` | string | `"128k"` | MP3 ビットレート |

レスポンス: `audio/mpeg`（chunked ストリーミング）

### 処理の流れ

```
テキスト → VOICEVOX (audio_query → synthesis) → WAV → ffmpeg → MP3 ストリーム
```

1. VOICEVOX Core でテキストから音声クエリを生成
2. 音声クエリから WAV バイナリを合成
3. ffmpeg パイプラインで WAV → MP3 に変換
4. 64KB チャンク単位でストリーミング返却

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `model.vvm` が見つからない | `VOICEVOX_VVM` 環境変数でパスを指定、または `voicevox/` 直下に配置 |
| Open JTalk 辞書エラー | `OPENJTALK_DICT_DIR` のパスを確認。辞書は UTF-8 版を使用 |
| ONNX Runtime ロードエラー | `ONNXRUNTIME_LIB` で正しいライブラリパスを指定 |
| `ffmpeg: command not found` | ffmpeg をインストール |
| MP3 出力が途切れる | ffmpeg のバージョンを確認。`libmp3lame` コーデックが必要 |

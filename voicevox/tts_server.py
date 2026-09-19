#!/usr/bin/env python3
import base64
import json
import os
import multiprocessing
import sys
import traceback
from pathlib import Path
from typing import Optional, Iterator

from fastapi import FastAPI, Body
from fastapi.responses import StreamingResponse, JSONResponse

from voicevox_core import AccelerationMode
from voicevox_core.blocking import Onnxruntime, OpenJtalk, Synthesizer, VoiceModelFile

import subprocess

app = FastAPI()

# このプロセスが母音タイムラインに対応していることの目印。
# 古いプロセスがポートを掴んだまま（uvicorn が Address already in use で
# 起動に失敗したケース）だと、この文字列も下のバナーも出ない。
SERVER_FEATURES = "vowel-timeline"


def log(*args) -> None:
    """標準出力へ即座に流す（uvicorn 経由だとバッファされて見えないことがある）。"""
    print("[tts_server]", *args, flush=True)


log(f"起動中… features={SERVER_FEATURES}")

# ---- 設定（環境変数で渡せるように） ----
VVM_PATH = Path(os.environ.get("VOICEVOX_VVM", "./model.vvm"))
DICT_DIR = Path(os.environ.get("OPENJTALK_DICT_DIR", "./open_jtalk_dic_utf_8-1.11"))
ONNXRUNTIME_PATH = os.environ.get(
    "ONNXRUNTIME_LIB",
    f"./voicevox_core/example/python/onnxruntime/lib/{Onnxruntime.LIB_VERSIONED_FILENAME}",
)
MODE = os.environ.get("VOICEVOX_MODE", "AUTO")  # AUTO / CPU / GPU


# ---- 初期化（起動時にロードして高速化） ----
onnxruntime = Onnxruntime.load_once(filename=ONNXRUNTIME_PATH)
synthesizer = Synthesizer(
    onnxruntime,
    OpenJtalk(DICT_DIR),
    acceleration_mode=MODE,
    cpu_num_threads=max(multiprocessing.cpu_count(), 2),
)

with VoiceModelFile.open(VVM_PATH) as model:
    synthesizer.load_voice_model(model)

log("=" * 60)
log(f"起動完了  features={SERVER_FEATURES}  mode={MODE}")
log(f"  vvm  : {VVM_PATH}")
log(f"  dict : {DICT_DIR}")
log("  このバナーが出ていないプロセスが :5005 を掴んでいる場合は古いプロセスです。")
log("  確認: ss -lptn 'sport = :5005'  /  curl -s localhost:5005/health")
log("=" * 60)

@app.get("/health")
def health():
    return {
        "ok": True,
        "mode": MODE,
        "vvm": str(VVM_PATH),
        # これが無ければ古いプロセス。curl localhost:5005/health で確認できる
        "features": [SERVER_FEATURES],
    }

import subprocess
import threading
from typing import Iterator

def wav_bytes_to_mp3_stream(wav_bytes: bytes, bitrate: str = "128k") -> Iterator[bytes]:
    proc = subprocess.Popen(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "error",
            "-i", "pipe:0",
            "-vn",
            "-acodec", "libmp3lame",
            "-b:a", bitrate,
            "-f", "mp3",
            "pipe:1",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,   # ★詰まり回避
        bufsize=0,
    )

    assert proc.stdin is not None
    assert proc.stdout is not None

    def _writer():
        try:
            # ★大きいバイト列を分割して書く（BrokenPipeは無視）
            mv = memoryview(wav_bytes)
            step = 64 * 1024
            for i in range(0, len(mv), step):
                proc.stdin.write(mv[i:i+step])
            proc.stdin.close()
        except BrokenPipeError:
            pass
        except Exception:
            try:
                proc.stdin.close()
            except Exception:
                pass

    t = threading.Thread(target=_writer, daemon=True)
    t.start()

    try:
        while True:
            chunk = proc.stdout.read(64 * 1024)
            if not chunk:
                break
            yield chunk

        rc = proc.wait(timeout=120)
        if rc != 0:
            raise RuntimeError(f"ffmpeg failed: returncode={rc}")
    finally:
        try:
            proc.kill()
        except Exception:
            pass

"""
def wav_bytes_to_mp3_stream(wav_bytes: bytes, bitrate: str = "128k") -> Iterator[bytes]:
    #
    #WAV(bytes) -> ffmpeg -> MP3(bytes) をストリーミングで返す generator
    #
    # ffmpeg が必要
    # -i pipe:0 で stdin からWAV
    # -f mp3 pipe:1 で stdout にMP3
    proc = subprocess.Popen(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "error",
            "-i", "pipe:0",
            "-vn",
            "-acodec", "libmp3lame",
            "-b:a", bitrate,
            "-f", "mp3",
            "pipe:1",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0,
    )

    try:
        assert proc.stdin is not None
        assert proc.stdout is not None

        # WAV を一気に入力（VOICEVOXが返すWAVはメモリ上にあるため）
        proc.stdin.write(wav_bytes)
        proc.stdin.close()

        # stdout をチャンクで返す
        while True:
            chunk = proc.stdout.read(64 * 1024)
            if not chunk:
                break
            yield chunk

        # ffmpeg 終了待ち
        proc.wait(timeout=100)

        if proc.returncode != 0:
            err = (proc.stderr.read() if proc.stderr else b"").decode("utf-8", errors="ignore")
            raise RuntimeError(f"ffmpeg failed: {err}")

    finally:
        try:
            proc.kill()
        except Exception:
            pass
"""
# ---- 口の形のための母音タイムライン ----
# riken_live2d_controller/src/audio/vowelMouth.ts の buildVowelTimeline と同じ組み立て。
# 各モーラの子音時間は母音のスパンへ畳み込む（口は子音の間も母音の形を保つ）。
# pause_mora は "pau" として並べる。フロント側で母音表に無い音素は「休み」の形になる。
#
# 音声本体はストリームで返すので、タイムラインはレスポンスヘッダ
# X-Vowel-Timeline に base64(JSON) で載せる。こうすると音声と必ず1対1で対応し、
# barge-in で中断するときも音声と一緒に捨てられる。
#
# JSON は次の詰めた形。d は各モーラの尺（秒）で、フロントで積算して開始/終了時刻にする:
#   {"t0": 前の無音, "v": "a,i,pau,u", "d": [0.12, 0.09, 0.2, 0.1]}

def _field(obj, name, default=None):
    """
    voicevox_core のオブジェクトからフィールドを読む。

    0.16.4 のバインディングには非一貫がある: AccentPhrase.moras の要素は Mora
    オブジェクトなのに、AccentPhrase.pause_mora は**素の dict** で返ってくる。
    （実測: {'text': '、', 'consonant': None, 'consonant_length': None,
             'vowel': 'pau', 'vowel_length': 0.32, 'pitch': 0.0}）
    読点を含む文で必ず AttributeError になるので、どちらの形でも読めるようにする。
    """
    if isinstance(obj, dict):
        return obj.get(name, default)
    value = getattr(obj, name, default)
    return default if value is None else value


def build_vowel_timeline(query) -> dict:
    speed = _field(query, "speed_scale", 1.0) or 1.0
    if speed <= 0:
        speed = 1.0
    vowels: list[str] = []
    durations: list[float] = []

    def push(mora) -> None:
        length = (_field(mora, "consonant_length", 0.0) or 0.0) + (
            _field(mora, "vowel_length", 0.0) or 0.0
        )
        vowels.append(str(_field(mora, "vowel", "pau")))
        durations.append(round(length / speed, 4))

    for phrase in _field(query, "accent_phrases", []):
        for mora in _field(phrase, "moras", []):
            push(mora)
        pause = _field(phrase, "pause_mora")
        if pause is not None:
            push(pause)

    return {
        "t0": round((_field(query, "pre_phoneme_length", 0.0) or 0.0) / speed, 4),
        "v": ",".join(vowels),
        "d": durations,
    }


def encode_vowel_timeline(timeline: dict) -> str:
    raw = json.dumps(timeline, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


@app.post("/tts-stream")
def tts_stream(
    text: str = Body(..., embed=True),
    style_id: int = Body(0, embed=True),
    bitrate: str = Body("128k", embed=True),
):
    """
    入力: { "text": "...", "style_id": 0, "bitrate":"128k" }
    出力: audio/mpeg を chunked でストリーム
          ヘッダ X-Vowel-Timeline に base64(JSON) の母音タイムライン
    """
    if not text or not text.strip():
        return JSONResponse({"error": "text is empty"}, status_code=400)

    log(f"/tts-stream text={len(text)}文字 style_id={style_id} bitrate={bitrate}")

    # VOICEVOX: text -> audio_query -> wav(bytes)
    audio_query = synthesizer.create_audio_query(text, style_id)
    log(f"  audio_query: アクセント句 {len(audio_query.accent_phrases)}件"
        f" speed_scale={getattr(audio_query, 'speed_scale', '?')}"
        f" pre_phoneme_length={getattr(audio_query, 'pre_phoneme_length', '?')}")

    # 母音タイムラインは synthesis の前に作れる（合成を待たせない）。
    # 口の形が無くても音声は返したいので、失敗しても例外は外へ出さない。
    # 常に付ける目印で「古いプロセス」と「タイムライン生成が落ちた」を区別できるようにする。
    headers = {"X-Tts-Server-Features": SERVER_FEATURES}
    try:
        timeline = build_vowel_timeline(audio_query)
        encoded = encode_vowel_timeline(timeline)
        headers["X-Vowel-Timeline"] = encoded
        log(f"  母音タイムライン: {len(timeline['d'])}モーラ"
            f" t0={timeline['t0']}秒 全長={round(timeline['t0'] + sum(timeline['d']), 3)}秒"
            f" ヘッダ={len(encoded)}文字")
        log(f"  母音列: {timeline['v'][:120]}{'…' if len(timeline['v']) > 120 else ''}")
    except Exception:  # noqa: BLE001 - 口の形は無くても音声は返したい
        log("  母音タイムラインの生成に失敗しました（音量のみのリップシンクになります）:")
        traceback.print_exc(file=sys.stdout)
        sys.stdout.flush()

    wav = synthesizer.synthesis(audio_query, style_id)
    log(f"  合成完了: wav {len(wav)}バイト")

    # wav -> mp3 ストリーム
    gen = wav_bytes_to_mp3_stream(wav, bitrate=bitrate)
    log(f"  ストリーム開始 (返すヘッダ: {', '.join(headers)})")

    return StreamingResponse(gen, media_type="audio/mpeg", headers=headers)


@app.post("/audio-query-timeline")
def audio_query_timeline(
    text: str = Body(..., embed=True),
    style_id: int = Body(0, embed=True),
):
    """合成せずに母音タイムラインだけ返す（動作確認・デバッグ用）。"""
    if not text or not text.strip():
        return JSONResponse({"error": "text is empty"}, status_code=400)
    query = synthesizer.create_audio_query(text, style_id)
    try:
        timeline = build_vowel_timeline(query)
    except Exception:
        # ここは切り分け用なので、500 で終わらせず原因をそのまま返す
        tb = traceback.format_exc()
        log("/audio-query-timeline: 生成に失敗:")
        print(tb, flush=True)
        return JSONResponse(
            {"error": "build_vowel_timeline failed", "traceback": tb.splitlines()[-6:]},
            status_code=500,
        )
    log(f"/audio-query-timeline: {len(timeline['d'])}モーラ v={timeline['v'][:80]}")
    return JSONResponse(timeline)


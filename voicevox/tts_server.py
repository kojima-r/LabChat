#!/usr/bin/env python3
import os
import multiprocessing
from pathlib import Path
from typing import Optional, Iterator

from fastapi import FastAPI, Body
from fastapi.responses import StreamingResponse, JSONResponse

from voicevox_core import AccelerationMode
from voicevox_core.blocking import Onnxruntime, OpenJtalk, Synthesizer, VoiceModelFile

import subprocess

app = FastAPI()

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

@app.get("/health")
def health():
    return {"ok": True, "mode": MODE, "vvm": str(VVM_PATH)}

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
@app.post("/tts-stream")
def tts_stream(
    text: str = Body(..., embed=True),
    style_id: int = Body(0, embed=True),
    bitrate: str = Body("128k", embed=True),
):
    """
    入力: { "text": "...", "style_id": 0, "bitrate":"128k" }
    出力: audio/mpeg を chunked でストリーム
    """
    if not text or not text.strip():
        return JSONResponse({"error": "text is empty"}, status_code=400)

    # VOICEVOX: text -> audio_query -> wav(bytes)
    print("...start:",text)
    audio_query = synthesizer.create_audio_query(text, style_id)
    wav = synthesizer.synthesis(audio_query, style_id)
    print("...synthesized")

    # wav -> mp3 ストリーム
    gen = wav_bytes_to_mp3_stream(wav, bitrate=bitrate)
    print("...stream")

    return StreamingResponse(gen, media_type="audio/mpeg")


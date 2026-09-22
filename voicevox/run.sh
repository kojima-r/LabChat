export VOICEVOX_VVM=./voicevox_core/example/python/models/vvms/0.vvm
export OPENJTALK_DICT_DIR=./voicevox_core/example/python/dict/open_jtalk_dic_utf_8-1.11
export ONNXRUNTIME_LIB=./voicevox_core/example/python/onnxruntime/lib/libvoicevox_onnxruntime.so.1.17.3
export VOICEVOX_MODE="CPU"

uvicorn tts_server:app --host 0.0.0.0 --port 5005


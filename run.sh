#!/usr/bin/env bash
# LAN 上の他端末（localhost 以外）からアクセスできるように、Vite を 0.0.0.0 で
# 待ち受けさせる。マイク (getUserMedia) はセキュアコンテキストでしか動かないため、
# 自己署名証明書で HTTPS も有効にする (vite.config.ts の LABCHAT_LAN 参照)。
# ブラウザで初回アクセスした際は証明書警告が出るので「詳細設定 → アクセスする」で進める。
cd "$(dirname "$0")"
LABCHAT_LAN=1 npm run dev

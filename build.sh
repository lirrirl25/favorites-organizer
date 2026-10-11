#!/usr/bin/env bash
# 重新生成 index.html
# 用法: ./build.sh                  # 读取 data/ 下所有 .txt（文件名含 douyin/抖音 的自动标为抖音）
#       ./build.sh a.txt b.txt      # 指定文件
set -euo pipefail
cd "$(dirname "$0")"
if [ "$#" -gt 0 ]; then FILES=("$@"); else shopt -s nullglob; FILES=(data/*.txt); fi
if [ "${#FILES[@]}" -eq 0 ]; then echo "没有找到 txt 文件（放到 data/ 目录里）" >&2; exit 1; fi
python3 parse.py -o data.json "${FILES[@]}"
python3 download_covers.py data.json covers
python3 build.py data.json index.html

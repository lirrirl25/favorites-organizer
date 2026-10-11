#!/usr/bin/env bash
# 一键重新打包 Windows 桌面版「收藏夹整理」
# 用法: ./build-win.sh                 # 读取 data/ 下所有 .txt（6 段或 7 段格式都行；文件名含 douyin/抖音 或 douyin.com 链接 = 抖音）
#       ./build-win.sh a.txt b.txt     # 指定文件
# 输出: dist/收藏夹整理-win32-x64.zip  （解压后双击 收藏夹整理.exe）
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd)
APPNAME="收藏夹整理"

if [ "$#" -gt 0 ]; then FILES=("$@"); else shopt -s nullglob; FILES=(data/*.txt); fi
[ "${#FILES[@]}" -gt 0 ] || { echo "没有找到 txt 文件（放到 data/ 目录里）" >&2; exit 1; }

echo "== 1/5 解析收藏"
python3 parse.py -o data.json "${FILES[@]}"
echo "== 2/5 下载封面（已下载的会跳过）"
python3 download_covers.py data.json covers
echo "== 3/5 生成页面"
python3 build.py data.json index.html          # 网页版（同目录 covers/）
rm -rf electron/app && mkdir -p electron/app/covers
python3 build.py data.json electron/app/index.html
cp rules.json electron/app/rules.json          # 主进程同步时用同一套分类规则
python3 - <<'PY'
# 复制封面到桌面版；宽度超过 480px 的缩到 400px（1500 张大图同时解码会占用 1.5GB 内存，导致页面崩溃）
import json, shutil, os
try:
    from PIL import Image
except ImportError:
    Image = None
n = small = 0
for i in json.load(open("data.json", encoding="utf-8")):
    p = i.get("cover_local")
    if not (p and os.path.exists(p)): continue
    dst = os.path.join("electron/app", p); n += 1
    if Image:
        try:
            im = Image.open(p)
            if im.width > 480:
                im = im.convert("RGB"); im = im.resize((400, round(im.height * 400 / im.width)), Image.LANCZOS)
                fmt = {"jpg": "JPEG", "jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}.get(p.rsplit(".", 1)[-1].lower(), "JPEG")
                im.save(dst, fmt, quality=82); small += 1; continue
        except Exception as e:
            print("缩图失败", p, e)
    shutil.copy2(p, dst)
print(f"封面 {n} 张，其中 {small} 张缩小到 400px 宽")
PY
echo "== 4/5 测试 + 打包 win32 x64"
cd electron
[ -d node_modules/@electron/packager ] || npm i --silent
node --test test/engine.test.js >/dev/null && echo "逻辑测试通过" || { echo "逻辑测试失败（node --test test/engine.test.js 查看详情）" >&2; exit 1; }
rm -rf "dist/${APPNAME}-win32-x64"
npx --no-install electron-packager . "$APPNAME" --platform=win32 --arch=x64 --out=dist --overwrite --asar \
  --ignore='^/dist($|/)' --ignore='^/selftest\.js$' --ignore='^/test($|/)' --ignore='^/\.cache' --ignore='^/node_modules($|/)' \
  --app-copyright="Erin Li" --app-version="$(node -p "require('./package.json').version")"
echo "== 5/5 压缩"
python3 - "$APPNAME" <<'PY'
import os, sys, zipfile
name = sys.argv[1]; folder = f"{name}-win32-x64"; out = f"dist/{folder}.zip"
if os.path.exists(out): os.remove(out)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, _, files in os.walk(os.path.join("dist", folder)):
        for f in files:
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, "dist"))
print(f"{out}  {os.path.getsize(out)/1048576:.1f} MB")
PY
echo "完成: $ROOT/electron/dist/${APPNAME}-win32-x64.zip"

#!/usr/bin/env python3
"""把 data.json 里每条的 cover（封面图链接）下载到 covers/，并写回 cover_local 字段。

用法: python3 download_covers.py [data.json] [covers目录]
- RedNote 用 Referer https://www.rednote.com/，抖音用 https://www.douyin.com/，加浏览器 UA。
- 已经下载过的不会重复下载（按条目 id 命名）。下载失败的条目保留远程链接，界面显示占位图。
"""
import json, os, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
REFERER = {"rednote": "https://www.rednote.com/", "douyin": "https://www.douyin.com/"}


def sniff(b):
    if b[:3] == b"\xff\xd8\xff": return "jpg"
    if b[:8] == b"\x89PNG\r\n\x1a\n": return "png"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP": return "webp"
    if b[:6] in (b"GIF87a", b"GIF89a"): return "gif"
    if b[4:12] in (b"ftypavif", b"ftypavis"): return "avif"
    if b[4:8] == b"ftyp" and b[8:12] in (b"heic", b"heix", b"mif1"): return "heic"
    return None


def safe_name(s):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in s)[:120]


def fetch(item, outdir):
    url = item.get("cover") or ""
    if not url.startswith("http"):
        return item["id"], None, "no-cover"
    base = safe_name(item["id"])
    for ext in ("jpg", "png", "webp", "gif", "avif"):
        p = os.path.join(outdir, f"{base}.{ext}")
        if os.path.exists(p) and os.path.getsize(p) > 0:
            return item["id"], f"{base}.{ext}", "cached"
    ref = REFERER.get(item.get("source"), "https://www.rednote.com/")
    fd, tmp = tempfile.mkstemp(dir=outdir, suffix=".part"); os.close(fd)
    try:
        r = subprocess.run(["curl", "-sSL", "--compressed", "--max-time", "30", "--retry", "2", "-A", UA, "-e", ref,
                            "-H", "Accept: image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
                            "-o", tmp, "-w", "%{http_code}", url], capture_output=True, text=True)
        code = r.stdout.strip()
        with open(tmp, "rb") as f: head = f.read(16)
        ext = sniff(head)
        if r.returncode != 0 or not code.startswith("2") or not ext:
            return item["id"], None, f"fail http={code} rc={r.returncode} {r.stderr.strip()[:80]}"
        if ext == "heic":
            return item["id"], None, "heic not supported by browser"
        final = os.path.join(outdir, f"{base}.{ext}")
        os.replace(tmp, final)
        os.chmod(final, 0o644)
        return item["id"], f"{base}.{ext}", "ok"
    finally:
        if os.path.exists(tmp): os.remove(tmp)


def main():
    data_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "data.json")
    outdir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "covers")
    os.makedirs(outdir, exist_ok=True)
    items = json.load(open(data_path, encoding="utf-8"))
    todo = [i for i in items if (i.get("cover") or "").startswith("http")]
    stats = {}
    res = {}
    with ThreadPoolExecutor(12) as ex:
        for iid, fn, st in ex.map(lambda i: fetch(i, outdir), todo):
            res[iid] = fn
            k = st.split()[0]; stats[k] = stats.get(k, 0) + 1
            if fn is None: print(f"  ! {iid}: {st}", file=sys.stderr)
    for i in items:
        fn = res.get(i["id"])
        i["cover_local"] = f"covers/{fn}" if fn else ""
    json.dump(items, open(data_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"封面: {len(items)} 条中 {len(todo)} 条有封面链接；" + "，".join(f"{k} {v}" for k, v in stats.items()), file=sys.stderr)


if __name__ == "__main__":
    main()

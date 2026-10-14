#!/usr/bin/env python3
"""把 RedNote / 抖音 收藏 txt 转成 data.json。

用法: python3 parse.py [-o data.json] [--source rednote|douyin|x] file1.txt [file2.txt ...]
每行格式: 标题 | 作者 | 链接 | 点赞数 | 类型(image/video) | 收藏夹(可空) [| 封面图链接]   (6 段或 7 段都行)
标题里本身带 " | " 也没关系：以 http 开头的那一段被当作链接，它前面一段是作者，再前面全是标题。
来源判断顺序: --source 参数 > 链接域名 (douyin.com / rednote.com / xiaohongshu.com) > 文件名含 douyin/抖音 > 默认 rednote。
"""
from collections import Counter
import argparse, hashlib, json, os, re, sys, unicodedata
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))


def load_rules(path=None):
    if not path:
        path = os.path.join(HERE, "rules.json")
        if not os.path.exists(path):  # 没有个人规则时用通用示例
            path = os.path.join(HERE, "rules.example.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def norm(s):
    return unicodedata.normalize("NFKC", s or "").lower()


def kw_match(kw, text):
    kw = norm(kw)
    if re.fullmatch(r"[a-z0-9]{1,3}", kw):
        return re.search(r"(?<![a-z0-9])" + kw + r"(?![a-z0-9])", text) is not None
    return kw in text


def board_hint(board, rules, strength):
    b = norm(board).strip()
    if not b:
        return None
    for name, cat, st in rules.get("board_rules", []):
        if st == strength and norm(name) == b:
            return cat
    return None


def categorize(title, author, note_id, rules, board=""):
    if note_id and note_id in rules.get("overrides", {}):
        return rules["overrides"][note_id]
    h = board_hint(board, rules, "strong")
    if h:
        return h
    t = norm(title)
    for cat, kws in rules["rules"]:
        if any(kw_match(k, t) for k in kws):
            return cat
    h = board_hint(board, rules, "weak")
    if h:
        return h
    a = norm(author)
    for cat, kws in rules.get("author_rules", []):
        if any(kw_match(k, a) for k in kws):
            return cat
    return "其他"


def parse_likes(s):
    s = (s or "").strip().replace(",", "")
    m = re.match(r"^([\d.]+)\s*(万|w|k|千)?(\+)?$", s, re.I)
    if not m:
        return 0
    n = float(m.group(1))
    unit = (m.group(2) or "").lower()
    n *= {"万": 10000, "w": 10000, "k": 1000, "千": 1000}.get(unit, 1)
    return int(n)


def detect_source(url, filename, forced):
    if forced:
        return forced
    host = urlsplit(url).netloc.lower()
    if host in ("x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"):
        return "x"
    if "douyin" in host or "iesdouyin" in host:
        return "douyin"
    if "rednote" in host or "xiaohongshu" in host or "xhslink" in host:
        return "rednote"
    fn = os.path.basename(filename).lower()
    if "douyin" in fn or "抖音" in fn:
        return "douyin"
    return "rednote"


def url_key(url):
    """去重和保存状态用的键。RedNote/抖音 用 “来源/笔记ID”（/explore/ 和 /user/profile/ 两种链接是同一条），
    其他链接用不含 query 的地址（xsec_token 会变，笔记 ID 不变）。"""
    p = urlsplit(url.strip())
    host = p.netloc.lower()
    nid = note_id_of(url)
    if nid and re.search(r"rednote|xiaohongshu", host):
        return "rednote/" + nid
    if nid and "douyin" in host:
        return "douyin/" + nid
    if nid and re.fullmatch(r"(www\.|mobile\.)?(x|twitter)\.com", host) and "/status/" in p.path:
        return "x/" + nid
    return (host + p.path.rstrip("/")) if host else url.strip()


def note_id_of(url):
    path = urlsplit(url).path.rstrip("/")
    seg = path.split("/")[-1] if path else ""
    return seg if re.fullmatch(r"[0-9a-zA-Z]{8,}", seg) else ""


def parse_line(line):
    parts = [p.strip() for p in line.rstrip("\n").split("|")]
    ui = next((i for i, p in enumerate(parts) if re.match(r"https?://", p)), None)
    if ui is None or ui < 2:
        return None
    title = " | ".join(parts[: ui - 1]).strip()
    author = parts[ui - 1]
    url = parts[ui]
    after = parts[ui + 1 :]
    cover = ""
    # 第 7 段（可选）是封面图链接：取链接之后最后一个 http 开头的字段
    for i in range(len(after) - 1, -1, -1):
        if re.match(r"https?://", after[i]):
            cover = after.pop(i)
            break
    rest = after + ["", "", ""]
    return title, author, url, rest[0], rest[1].lower(), rest[2], cover


def parse_files(files, rules, forced_source=None):
    items, seen, problems, dups = [], {}, [], 0
    # 新文件优先：按修改时间从新到旧处理，重复的条目以先出现的位置为准（有封面的记录会覆盖没封面的）
    files = sorted(files, key=lambda f: -os.path.getmtime(f))
    for fn in files:
        with open(fn, encoding="utf-8-sig") as f:
            for ln, line in enumerate(f, 1):
                if not line.strip():
                    continue
                r = parse_line(line)
                if not r:
                    problems.append(f"{os.path.basename(fn)}:{ln} 无法解析: {line.strip()[:80]}")
                    continue
                title, author, url, likes, typ, board, cover = r
                src = detect_source(url, fn, forced_source)
                key = url_key(url)
                if key in seen:
                    old = seen[key]
                    dups += 1
                    if cover and not old.get("cover"):
                        # 新记录有封面：用新记录的内容替换，保留原来的位置和 id
                        nid0 = note_id_of(url)
                        old.update({"title": title or old["title"], "author": author or old["author"], "url": url,
                                    "likes": likes or old["likes"], "likes_num": parse_likes(likes) or old["likes_num"],
                                    "board": board or old["board"], "cover": cover,
                                    "category": categorize(title, author, nid0, rules, board or old["board"])})
                    elif board and not old.get("board"):
                        old["board"] = board
                    continue
                nid = note_id_of(url)
                if src == "x":
                    if not title:
                        title = "[媒体帖] " + (author if author.startswith("@") else "@" + author)
                    if cover:
                        cover = re.sub(r"name=(small|thumb|tiny)", "name=medium", cover)
                typ = typ if typ in ("image", "video") else ("video" if "video" in typ else "image")
                item = {
                    "id": src + "_" + (nid or hashlib.sha1(key.encode()).hexdigest()[:16]),
                    "source": src,
                    "title": title or "(无标题)",
                    "author": author,
                    "url": url,
                    "key": key,
                    "likes": likes,
                    "likes_num": parse_likes(likes),
                    "type": typ,
                    "board": board,
                    "category": categorize(title, author, nid, rules, board),
                    "cover": cover,
                    "order": len(items),
                }
                seen[key] = item
                items.append(item)
    if dups:
        problems.insert(0, f"合并了 {dups} 条重复（按笔记 ID）")
    return items, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("-o", "--out", default=os.path.join(HERE, "data.json"))
    ap.add_argument("--source", choices=["rednote", "douyin", "x"])
    ap.add_argument("--rules")
    a = ap.parse_args()
    rules = load_rules(a.rules)
    items, problems = parse_files(a.files, rules, a.source)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=1)
    c = Counter(i["category"] for i in items)
    src = Counter(i["source"] for i in items)
    cov = Counter(i["source"] for i in items if i.get("cover"))
    print(f"共 {len(items)} 条 -> {a.out}  (" + "，".join(f"{k} {v} 条/有封面 {cov.get(k,0)}" for k, v in src.items()) + ")", file=sys.stderr)
    for cat in rules["categories"]:
        if c.get(cat):
            print(f"  {cat}: {c[cat]}", file=sys.stderr)
    for p in problems:
        print("  ! " + p, file=sys.stderr)


if __name__ == "__main__":
    main()

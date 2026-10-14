#!/usr/bin/env python3
"""把 data.json + rules.json（+ expired_candidates.csv 的过期标记）嵌进 template.html，生成单文件 index.html。"""
import csv, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
def safe(obj):
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return s.replace("</", "<\\/").replace("<!--", "<\\!--").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
def key_of(url):
    m = re.search(r"(rednote|xiaohongshu|douyin)\.com/.*?/([0-9a-zA-Z]{8,})(?:[/?#]|$)", url)
    if not m: return url
    return ("douyin/" if m.group(1) == "douyin" else "rednote/") + m.group(2)
data_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "data.json")
out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "index.html")
data = json.load(open(data_path, encoding="utf-8"))
rules_path = os.path.join(HERE, "rules.json")
if not os.path.exists(rules_path):  # 没有个人规则时用通用示例
    rules_path = os.path.join(HERE, "rules.example.json")
rules = json.load(open(rules_path, encoding="utf-8"))
exp_path = os.path.join(HERE, "expired_candidates.csv")
n_exp = 0
if os.path.exists(exp_path):
    exp = {}
    for r in csv.DictReader(open(exp_path, encoding="utf-8-sig")):
        exp[key_of(r["url"])] = r
    for it in data:
        r = exp.get(it.get("key") or key_of(it["url"]))
        if r:
            it["expired"] = r["confidence"].strip().lower()
            it["expired_reason"] = r["reason"]
            n_exp += 1
        else:
            it.pop("expired", None); it.pop("expired_reason", None)
    if n_exp != len(exp):
        print(f"警告：expired_candidates.csv 有 {len(exp)} 行，只匹配到 {n_exp} 条", file=sys.stderr)
tpl = open(os.path.join(HERE, "template.html"), encoding="utf-8").read()
html = tpl.replace("/*__DATA__*/", safe(data)).replace("/*__RULES__*/", safe(rules))
open(out_path, "w", encoding="utf-8").write(html)
print(f"已生成 {out_path}（{len(data)} 条，过期标记 {n_exp} 条，{len(html)//1024} KB）", file=sys.stderr)



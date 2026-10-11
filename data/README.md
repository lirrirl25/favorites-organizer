# 收藏 txt 格式

把导出的收藏放在这个目录里，一行一条。`data/*.txt` 不会进 git。

字段用 ` | ` 分开，共 6 段或 7 段：

```
title | author | url | likes | type | board | cover_url
```

| 字段 | 含义 |
| --- | --- |
| title | 标题。标题里如果本身有 ` \| `，整段都会算进标题 |
| author | 作者名 |
| url | 原帖链接。`douyin.com` 视为抖音，`rednote.com` / `xiaohongshu.com` 视为 RedNote；也可以用文件名里带 `douyin` 或 `抖音` 来标明来源 |
| likes | 点赞，例如 `1234`、`1.2万`、`3k` |
| type | `image` 或 `video` |
| board | 收藏夹 / 专辑名，可以留空 |
| cover_url | 封面图链接，可省略 |

示例（虚构数据）：

```
示例标题：周末减脂餐 | 示例作者 | https://www.rednote.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa | 1.2万 | image | | https://cdn.example.test/fake-cover.jpg
示例标题：旅行清单 | 示例作者 | https://www.douyin.com/video/7600000000000000001 | 3200 | video | 日本 | https://cdn.example.test/fake-cover-2.jpg
```

生成页面：在仓库根目录运行 `./build.sh`（网页版 `index.html`）或 `./build-win.sh`（Windows 安装包）。解析结果写到 `data.json`，封面下载到 `covers/`，这两个都不要提交。

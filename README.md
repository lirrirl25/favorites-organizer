# 收藏夹整理

**English.** A personal Windows desktop app that organizes saved posts from RedNote (Xiaohongshu international), Douyin and X bookmarks. It has search, categories, statuses (unseen / to-do / done), expired flags, an in-app sync of the user's own favorites, and a review list before new items are kept. There is no official API: sync only reads the favorites page inside the user's own logged-in session. Rate limits and slider captchas can appear. For personal use; follow each platform's terms.

整理 RedNote（小红书国际版）、抖音里自己收藏过的帖子，以及 X 书签。桌面版是 Electron，也可以生成一个离线打开的 `index.html`。

## 功能

- 搜索标题和作者，按分类、来源、状态筛选。
- 状态：未看 / 待做 / 已做。桌面版写在本机数据目录里；网页版写在浏览器 localStorage。
- 分类由 `rules.json` 决定（没有时使用通用示例 `rules.example.json`）：按标题关键词顺序匹配，匹配不到再用收藏夹名和作者名。`overrides` 可以按笔记 ID 指定分类。见下文「自定义分类规则」。
- X 书签：卡片上有「在 x.com 打开」；「取消书签」需要先确认，确认后只放进本地「待取消书签」列表，不会替你在 X 上操作。
- 过期标记：如果旁边有 `expired_candidates.csv`（`url`、`confidence`、`reason`），打包时会标成「已过期」或「可能过期」。可以去原帖取消收藏、在本地标成已取消，或选择保留。
- 导入 txt、`data.json` 或以前导出的备份。同一条帖子按笔记 ID 合并，已有状态会留下。
- 同步：用自己已登录的会话打开收藏页，读页面自己请求的收藏接口。新收藏直接加入主列表（存在本机数据目录，按笔记 ID 去重）；可以在「账号 / 同步」里撤销最近一次同步。同步时已不在收藏列表里的条目只会标上「可能已取消」，不会被自动删除或隐藏。
- X 书签同步：在「账号 / 同步」里登录 X 一次（会话 `persist:x`，和点卡片打开 X 用的是同一个），之后后台打开 x.com/i/bookmarks，只读取页面自己请求的 Bookmarks 接口，不会取消书签、点赞或发帖。遇到 X 限流会直接停下，下次再同步。
- 同步日志：在「账号 / 同步」里点「查看同步日志」，日志直接显示在应用里，可以复制或在文件夹中显示。

## 截图

![主界面（模拟数据）](docs/screenshot.png)

*图中标题和作者都是虚构的示例数据。封面照片来自 Wikimedia Commons（CC0 / 公有领域 / CC BY / CC BY-SA），作者和许可见 [docs/CREDITS.md](docs/CREDITS.md)。*

## 构建

在 Linux 或 macOS 上，仓库根目录：

```bash
./build-win.sh
```

脚本会读取 `data/*.txt`，解析、下载封面、跑逻辑测试，再用 electron-packager 打出 **win32 x64** 压缩包：

`electron/dist/收藏夹整理-win32-x64.zip`

解压后双击 `收藏夹整理.exe`。指定文件时：`./build-win.sh a.txt b.txt`。

只要网页版：

```bash
./build.sh
```

生成的 `index.html` 用浏览器打开即可，不需要服务器。封面在同目录的 `covers/`。

依赖：Python 3、Node.js。封面缩小需要 Pillow（没有的话会原样复制）。第一次打包会在 `electron/` 里安装 Electron。

逻辑测试：

```bash
cd electron && npm ci && node --test test/engine.test.js
```

## 数据格式

收藏导出是纯文本，一行一条，字段用 ` | ` 分开：

```
title | author | url | likes | type | board | cover_url
```

`cover_url` 可以不写。把文件放进 `data/` 再构建。字段说明和示例见 [data/README.md](data/README.md)。

`data/x_bookmarks.sample.txt` 是虚构的示例。`data.json`、`index.html`、`covers/`、`data/*.txt`、`rules.json` 都是本地数据或生成物，已在 `.gitignore` 里。`index.html` 会把收藏嵌进页面，不要提交。

桌面版的状态、同步结果和登录会话在 `%APPDATA%\收藏夹整理\`（`data\`、`covers\`、`logs\`、`Partitions\`）。换掉程序文件夹不会清掉这些。

## 自定义分类规则

仓库里只有一份通用示例 `rules.example.json`。分类不会自动学习，靠的是你写的关键词，所以建议按自己的收藏改一份：

```bash
cp rules.example.json rules.json
```

`rules.json` 已在 `.gitignore` 里，只留在你自己电脑上，不会被提交。解析和打包时优先读 `rules.json`，没有它才用示例规则。

主要字段：

- `categories`：分类按钮的顺序，最后一个通常是「其他」。
- `rules`：`[分类, [关键词...]]`，从上往下匹配，标题里第一个命中的关键词决定分类。同一分类可以出现多次来调整优先级。不超过 3 个字母的纯英文关键词（如 `ai`）按整词匹配。
- `author_rules`：标题都没命中时，再用作者名匹配。
- `board_rules`：`[收藏夹名包含的词, 分类, strong|weak]`。`strong` 直接决定分类，`weak` 只在标题没命中时使用。
- `overrides`：`{"笔记ID": "分类"}`，给个别帖子手动指定分类。
- `emoji`（可选）：`{"分类": "图标"}`，给分类按钮配图标。

例子：想加一个「露营」分类，并把收藏夹「周末计划」里的帖子默认归到旅行：

```json
{
  "categories": ["露营", "旅行", "美食", "其他"],
  "rules": [
    ["露营", ["露营", "帐篷", "camping"]],
    ["旅行", ["旅行", "攻略", "酒店"]],
    ["美食", ["食谱", "探店"]]
  ],
  "author_rules": [],
  "board_rules": [["周末计划", "旅行", "weak"]],
  "overrides": {}
}
```

改完重新运行 `./build.sh` 或 `./build-win.sh` 即可生效。

## 同步怎么工作，以及它做不到什么

没有官方接口。同步不会调用第三方开放平台，也拿不到别人的收藏。

它做的事是：在应用自带的浏览器窗口里打开 **你自己已经登录的** RedNote 或抖音，进入 **你自己的收藏页**，读取这个页面本来就会请求的收藏列表 JSON。读不到接口时，才退回读取带收藏标记的页面卡片。登录态保存在本机的 `persist:rednote` / `persist:douyin`，下次不用重新扫码，除非站点把会话清掉。

因此：

- 只能看到这个窗口里当前账号自己的收藏页。推荐流、首页、别人的主页、作品列表不会被收进来。
- 增量同步慢慢往下滚，连续碰到 8 条本地已经有的就停。全量同步滚到列表末尾，并且和本地对得上至少约 60% 时，才会把不在列表里的标成「可能已取消」（不隐藏、不删除，再次同步看到时自动清除）。
- 平台会限流。访问太频繁，或者出现滑块验证码时，同步会暂停，只有页面上真的出现验证时才弹出窗口，等你手动完成验证后再继续（最多等大约 15 分钟）。
- 页面改版后，收藏接口路径可能对不上。可以用本机的 `sync-config.json` 覆盖规则，这不是稳定的公开 API。
- 滚动节奏是故意放慢的，全量同步会花比较久，也仍然可能触发风控。

## 免责声明

- 本项目仅供个人使用，用来整理你自己的收藏和书签。
- 本项目与 RedNote / 小红书、抖音、X 没有任何关联，也未获得它们的认可。
- 同步用的是这些网站页面自己请求的非公开网页接口，随时可能改变或失效，使用时请遵守各平台的服务条款和相关法律。
- 不要用它抓取他人的数据或内容，不要绕过登录、验证码或风控，也不要把同步到的数据再分发。

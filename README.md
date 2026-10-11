# 收藏夹整理

**English.** A personal Windows desktop app that organizes saved posts from RedNote (Xiaohongshu international) and Douyin. It has search, categories, statuses (unseen / to-do / done), expired flags, an in-app sync of the user's own favorites, and a review list before new items are kept. There is no official API: sync only reads the favorites page inside the user's own logged-in session. Rate limits and slider captchas can appear. For personal use; follow each platform's terms.

整理 RedNote（小红书国际版）和抖音里自己收藏过的帖子。桌面版是 Electron，也可以生成一个离线打开的 `index.html`。

## 功能

- 搜索标题和作者，按分类、来源、状态筛选。
- 状态：未看 / 待做 / 已做。桌面版写在本机数据目录里；网页版写在浏览器 localStorage。
- 分类由 `rules.json` 决定：按标题关键词顺序匹配，匹配不到再用收藏夹名和作者名。`overrides` 可以按笔记 ID 指定分类。
- 过期标记：如果旁边有 `expired_candidates.csv`（`url`、`confidence`、`reason`），打包时会标成「已过期」或「可能过期」。可以去原帖取消收藏、在本地标成已取消，或选择保留。
- 导入 txt、`data.json` 或以前导出的备份。同一条帖子按笔记 ID 合并，已有状态会留下。
- 同步：用自己已登录的会话打开收藏页，读页面自己请求的收藏接口。新条目先进入待确认列表，确认后才加入；可以删掉单条，也可以撤销最近一次加入。
- 复习列表：在待确认和已加入的收藏里继续看、打开原帖。

## 截图

截图待补充。界面稳定后可以把主列表、过期筛选、同步面板和待确认列表的图放在这里。

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

`data.json`、`index.html`、`covers/`、`data/*.txt` 都是本地数据或生成物，已在 `.gitignore` 里。`index.html` 会把收藏嵌进页面，不要提交。

桌面版的状态、同步结果和登录会话在 `%APPDATA%\收藏夹整理\`（`data\`、`covers\`、`logs\`、`Partitions\`）。换掉程序文件夹不会清掉这些。

## 同步怎么工作，以及它做不到什么

没有官方接口。同步不会调用第三方开放平台，也拿不到别人的收藏。

它做的事是：在应用自带的浏览器窗口里打开 **你自己已经登录的** RedNote 或抖音，进入 **你自己的收藏页**，读取这个页面本来就会请求的收藏列表 JSON。读不到接口时，才退回读取带收藏标记的页面卡片。登录态保存在本机的 `persist:rednote` / `persist:douyin`，下次不用重新扫码，除非站点把会话清掉。

因此：

- 只能看到这个窗口里当前账号自己的收藏页。推荐流、首页、别人的主页、作品列表不会被收进来。
- 增量同步慢慢往下滚，连续碰到 8 条本地已经有的就停。全量同步滚到列表末尾，并且和本地对得上至少约 60% 时，才会把不在列表里的标成「已取消收藏」（可以恢复）。
- 平台会限流。访问太频繁，或者出现滑块验证码时，同步会暂停，把窗口带到前面，等你手动完成验证后再继续（最多等大约 15 分钟）。
- 页面改版后，收藏接口路径可能对不上。可以用本机的 `sync-config.json` 覆盖规则，这不是稳定的公开 API。
- 滚动节奏是故意放慢的，全量同步会花比较久，也仍然可能触发风控。

## 免责声明

本项目仅供个人整理自己的收藏。使用时必须遵守 RedNote / 小红书和抖音的服务条款与相关法律。不要用它抓取他人内容、绕过登录或风控、或者把同步到的数据拿去再分发。平台没有为这个工具提供接口，页面一旦改版，同步就可能失效。

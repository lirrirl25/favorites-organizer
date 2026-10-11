// 收藏夹整理 — Electron 主进程
const { app, BrowserWindow, ipcMain, shell, dialog, session, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const engine = require('./lib/engine');
const { SyncManager } = require('./lib/sync');

app.setName('收藏夹整理');
// 用户数据固定在 %APPDATA%\收藏夹整理（和程序文件夹无关），替换/升级程序文件夹不会丢状态和登录
if (process.env.FAV_USERDATA) app.setPath('userData', process.env.FAV_USERDATA);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// ---------- 日志 ----------
const logFile = () => path.join(app.getPath('userData'), 'logs', 'app.log');
function log(msg) {
  try {
    const f = logFile(); fs.mkdirSync(path.dirname(f), { recursive: true });
    try { if (fs.statSync(f).size > 5 * 1024 * 1024) fs.renameSync(f, f + '.old'); } catch (e) {}
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${msg}\n`);
    if (process.env.FAV_LOG_STDOUT) console.log('[log]', msg);
  } catch (e) {}
}
process.on('uncaughtException', (e) => log('uncaughtException: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.stack || e)));

// ---------- 本地 JSON 存储（userData/data） ----------
const dataDir = () => path.join(app.getPath('userData'), 'data');
const coverDir = () => path.join(app.getPath('userData'), 'covers');
const fileOf = (name) => path.join(dataDir(), name + '.json');
function readJSON(name, dflt) {
  try { return JSON.parse(fs.readFileSync(fileOf(name), 'utf8')); } catch (e) { return dflt; }
}
function writeJSON(name, obj) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const f = fileOf(name), tmp = f + '.tmp';
  if (fs.existsSync(f)) { try { fs.copyFileSync(f, f + '.bak'); } catch (e) {} }
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  fs.renameSync(tmp, f);
  return true;
}
const STORES = { status: {}, imported: [], marks: { unsaved: {}, kept: {} }, synced: [], syncmeta: { autoSync: false, last: {} }, pending: { batches: [], rejected: [] }, history: [] };
const loadAll = () => {
  const o = { dir: dataDir(), coverBase: pathToFileURL(coverDir()).href + '/' };
  for (const k of Object.keys(STORES)) if (k !== 'history') o[k] = readJSON(k, STORES[k]);
  o.historyInfo = readJSON('history', []).map((h) => ({ at: h.at, summary: h.summary }));
  return o;
};
ipcMain.on('store:load', (e) => { e.returnValue = loadAll(); });
ipcMain.on('store:reload', (e, name) => {
  if (name === 'historyInfo') { e.returnValue = readJSON('history', []).map((h) => ({ at: h.at, summary: h.summary })); return; }
  e.returnValue = name in STORES && name !== 'history' ? readJSON(name, STORES[name]) : null;
});
ipcMain.handle('store:save', (e, name, obj) => {
  if (!(name in STORES) || ['synced', 'pending', 'history'].includes(name)) throw new Error('bad store');
  return writeJSON(name, obj);
});
ipcMain.handle('backup:export', async (e, text, defaultName) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    title: '导出备份', defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, 'utf8');
  return r.filePath;
});
ipcMain.handle('open:dataDir', () => shell.openPath(app.getPath('userData')));
ipcMain.handle('open:log', () => shell.openPath(logFile()));

// ---------- 同步 ----------
let RULES = null;
function rules() {
  if (!RULES) { try { RULES = JSON.parse(fs.readFileSync(path.join(__dirname, 'app', 'rules.json'), 'utf8')); } catch (e) { log('rules.json 读取失败 ' + e.message); RULES = { rules: [], categories: [] }; } }
  return RULES;
}
let sm = null;
const syncMgr = () => sm || (sm = new SyncManager({
  userData: app.getPath('userData'), rules: rules(), log,
  send: (p) => { if (win && !win.isDestroyed()) win.webContents.send('sync:progress', p); },
}));
const PLATFORMS = ['rednote', 'douyin'];
ipcMain.handle('sync:status', () => syncMgr().status());
ipcMain.handle('sync:login', (e, p) => { if (!PLATFORMS.includes(p)) throw new Error('bad platform'); return syncMgr().openLogin(p); });
ipcMain.handle('sync:cancel', () => { syncMgr().cancel(); return true; });
ipcMain.handle('open:post', (e, p, url) => { if (!PLATFORMS.includes(p)) throw new Error('bad platform'); return syncMgr().openPost(p, url); });
// 抖音：复制视频链接 → 打开抖音 PC 客户端（douyin-pc:// 只能打开首页，深链无效）→ 失败就用内置浏览器
async function launchDouyinPc() {
  const fake = process.env.FAV_SELFTEST && process.env.FAV_FAKE_DOUYIN_PC;
  if (fake === 'ok') return;
  if (fake === 'fail') throw new Error('模拟：未安装抖音客户端');
  await shell.openExternal('douyin-pc://');
}
ipcMain.handle('douyin:openApp', async (e, url) => {
  const m = String(url || '').match(/(\d{15,20})/);
  if (!m) throw new Error('不是抖音链接');
  const videoUrl = 'https://www.douyin.com/video/' + m[1];
  clipboard.writeText(videoUrl);
  try {
    await launchDouyinPc();
    log(`[douyin] 已复制 ${videoUrl} 并打开抖音客户端`);
    return { ok: true, copied: videoUrl };
  } catch (err) {
    log(`[douyin] 打开抖音客户端失败，改用内置浏览器: ${err && err.message || err}`);
    // 不等页面加载完，马上告诉用户已经改用内置浏览器
    syncMgr().openPost('douyin', url).catch((e2) => log('[douyin] 内置浏览器也打开失败: ' + e2.message));
    return { ok: false, fallback: true, copied: videoUrl };
  }
});
ipcMain.handle('sync:start', async (e, p, opts) => {
  if (!PLATFORMS.includes(p)) throw new Error('bad platform');
  opts = opts || {};
  const res = await syncMgr().sync(p, { mode: opts.mode === 'full' ? 'full' : 'incremental', knownKeys: opts.knownKeys || [], localKeys: opts.localKeys || [], auto: !!opts.auto });
  return finishSync(p, res, opts);
});
// 同步结果不直接合并：先放进「待确认」(pending.json)，用户点「全部加入」后才写进 synced.json
async function finishSync(p, res, opts) {
  const pending = readJSON('pending', STORES.pending);
  pending.batches = pending.batches || []; pending.rejected = pending.rejected || [];
  // 已经在待确认里的也算已知，避免重复
  const inPending = pending.batches.flatMap((b) => (b.items || []).map((i) => i.key));
  const batch = engine.buildBatch(res.allItems || [], (opts.knownKeys || []).concat(inPending), pending.rejected, rules(), Date.now(),
    { platform: p, mode: res.mode, source: res.source, stopReason: res.stopReason || res.error || '' });
  if (res.source !== 'api') batch.patches = [];          // 页面读取的数据只用来发现新条目，不改已有条目
  const need = new Set(opts.needCoverKeys || []);
  batch.patches = batch.patches.filter((x) => x.cover || x.likes !== '' || x.url);
  const coverTargets = batch.items.concat(batch.patches.filter((x) => need.has(x.key))).filter((x) => x.cover);
  let covers = { ok: 0, fail: 0 };
  if (coverTargets.length) {
    syncMgr().send({ platform: p, phase: 'covers', msg: `正在下载 ${coverTargets.length} 张封面…` });
    covers = await syncMgr().downloadCovers(coverTargets);
  }
  const rc = res.removedCheck;
  batch.removed = rc && rc.ok ? rc.removed : [];
  batch.seenKeys = res.mode === 'full' && res.reachedEnd ? (res.allItems || []).map((i) => i.key) : [];
  const useful = batch.items.length || batch.patches.length || batch.removed.length || batch.seenKeys.length;
  if (useful) { pending.batches.push(batch); writeJSON('pending', pending); }
  const meta = readJSON('syncmeta', STORES.syncmeta);
  meta.last = meta.last || {};
  meta.last[p] = { at: Date.now(), mode: res.mode, added: batch.items.length, collected: res.collected, reachedEnd: !!res.reachedEnd, stopReason: res.stopReason || res.error || '' };
  meta.loggedIn = meta.loggedIn || {}; meta.loggedIn[p] = await syncMgr().isLoggedIn(p);
  writeJSON('syncmeta', meta);
  await syncMgr().flush();
  const out = {
    platform: p, mode: res.mode, collected: res.collected, added: batch.items.length, patched: batch.patches.length, pendingKeys: batch.items.map((i) => i.key),
    stopReason: res.stopReason, reachedEnd: !!res.reachedEnd, error: res.error || null, source: res.source, covers, stats: res.stats || null,
    removed: rc ? { ok: rc.ok, reason: rc.reason, keys: rc.removed } : null,
    pendingTotal: pending.batches.reduce((n, b) => n + (b.items || []).length, 0),
  };
  log(`[${p}] 放入待确认: 新增=${batch.items.length} 更新=${batch.patches.length} 封面 ok=${covers.ok} fail=${covers.fail}` + (rc ? ` 取消收藏检测: ${rc.ok ? rc.removed.length + ' 条' : rc.reason}` : ''));
  return out;
}
// 确认：把待确认合并进 synced / marks（先存快照，方便「撤销上次同步」）
ipcMain.handle('pending:accept', (e, excludeKeys) => {
  const pending = readJSON('pending', STORES.pending);
  if (!(pending.batches || []).length) return { added: 0, removed: 0, restored: 0 };
  const synced = readJSON('synced', []), marks = readJSON('marks', STORES.marks);
  const hist = readJSON('history', []);
  hist.push({ at: Date.now(), synced: JSON.parse(JSON.stringify(synced)), marks: JSON.parse(JSON.stringify(marks)),
    summary: pending.batches.map((b) => `${b.platform}:${(b.items || []).length}`).join(' ') });
  while (hist.length > 5) hist.shift();
  const ex = excludeKeys || [];
  const r = engine.applyBatches(synced, marks, pending.batches, ex);
  writeJSON('history', hist);
  writeJSON('synced', r.synced); writeJSON('marks', r.marks);
  pending.rejected = Array.from(new Set((pending.rejected || []).concat(ex))).slice(-5000);
  pending.batches = [];
  writeJSON('pending', pending);
  log(`待确认已合并: 新增=${r.added} 标记已取消=${r.removed} 恢复=${r.restored} 删掉=${ex.length}`);
  return { added: r.added, removed: r.removed, restored: r.restored, excluded: ex.length };
});
ipcMain.handle('pending:discard', () => {
  const pending = readJSON('pending', STORES.pending);
  const n = (pending.batches || []).reduce((a, b) => a + (b.items || []).length, 0);
  pending.batches = []; writeJSON('pending', pending);
  log(`待确认已全部丢弃: ${n} 条`);
  return { discarded: n };
});
ipcMain.handle('sync:undo', () => {
  const hist = readJSON('history', []);
  const h = hist.pop();
  if (!h) return null;
  writeJSON('synced', h.synced); writeJSON('marks', h.marks); writeJSON('history', hist);
  log(`已撤销 ${new Date(h.at).toISOString()} 的同步合并（${h.summary}）`);
  return { at: h.at, summary: h.summary, left: hist.length };
});

// ---------- 窗口 ----------
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1300, height: 880, minWidth: 380, minHeight: 500,
    title: '收藏夹整理', backgroundColor: '#f6f5f2', autoHideMenuBar: true,
    show: !process.env.FAV_SELFTEST,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // 外部链接一律用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https?:\/\//i.test(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  const crashes = [];
  win.webContents.on('render-process-gone', (e, d) => {
    log('renderer gone: ' + JSON.stringify(d) + ' 内存: ' + JSON.stringify(process.getSystemMemoryInfo ? process.getSystemMemoryInfo() : {}));
    if (d.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now(); crashes.push(now); while (crashes.length && now - crashes[0] > 10 * 60 * 1000) crashes.shift();
    if (crashes.length <= 3) { log('自动重新加载主窗口'); setTimeout(() => { if (!win.isDestroyed()) win.loadFile(path.join(__dirname, 'app', 'index.html')); }, 800); }
    else dialog.showMessageBox(win, { type: 'error', message: '页面多次崩溃', detail: '请重启软件；如果反复出现，把「文件 → 打开同步日志」里的 app.log 发给我。' }).catch(() => {});
  });
  win.webContents.on('unresponsive', () => log('主窗口无响应'));
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  if (process.env.FAV_SELFTEST) require('./selftest.js')(win, { dataDir, readJSON, writeJSON, log, syncMgr, finishSync });
}

// 导入进来、还没下载到本地的封面：带上 Referer/UA，防盗链
function setupImageHeaders() {
  const rules = [
    [/xhscdn|xiaohongshu|rednote/i, 'https://www.rednote.com/'],
    [/douyin|byteimg|bytedance|pstatp|ibyteimg|zjcdn/i, 'https://www.douyin.com/'],
  ];
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
    if (d.resourceType === 'image') {
      for (const [re, ref] of rules) if (re.test(d.url)) { d.requestHeaders['Referer'] = ref; d.requestHeaders['User-Agent'] = UA; break; }
    }
    cb({ requestHeaders: d.requestHeaders });
  });
}

if (!app.requestSingleInstanceLock() && !process.env.FAV_SELFTEST) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '文件', submenu: [
        { label: '打开数据文件夹', click: () => shell.openPath(app.getPath('userData')) },
        { label: '打开同步日志', click: () => shell.openPath(logFile()) },
        { type: 'separator' }, { label: '退出', role: 'quit' } ] },
      { label: '视图', submenu: [
        { label: '刷新', role: 'reload' }, { label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' }, { type: 'separator' }, { label: '全屏', role: 'togglefullscreen' },
        { label: '开发者工具', role: 'toggleDevTools' } ] },
    ]));
    log(`启动 v${app.getVersion()} userData=${app.getPath('userData')}`);
    app.on('child-process-gone', (e, d) => log('子进程退出: ' + JSON.stringify(d)));
    setupImageHeaders();
    createWindow();
  });
  let flushed = false;
  app.on('before-quit', (e) => { if (flushed || !sm) return; e.preventDefault(); flushed = true; sm.flush().finally(() => app.quit()); });
  app.on('window-all-closed', () => app.quit());
}

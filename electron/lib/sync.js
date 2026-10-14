// 在 App 内置浏览器里同步 RedNote / 抖音 收藏：持久登录、模拟人工滚动、拦截页面自己的收藏接口
// v1.2：只接受收藏接口 + 必须在自己的收藏页；窗口生命周期防护；页面跳转/崩溃自动恢复
'use strict';
const { BrowserWindow, session, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const engine = require('./engine');

const SPEED = +process.env.FAV_SYNC_SPEED || 1; // 仅测试时加速
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * SPEED));
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const jitter = (a, b) => Math.round(rand(a, b) + (Math.random() - 0.5) * 400);
const alive = (w) => !!(w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed());
// 收藏列表第一页常常是服务端直接渲染进页面的（不走接口），接口只拦到第二页起。
// 所以用接口数据时，也把页面上带收藏标记的卡片（已经过 sanitize）按页面顺序放在前面，避免漏掉最新收藏。
function mergedItems(state, useApi) {
  if (!useApi) return state.dom;
  const m = new Map();
  for (const [k, v] of state.dom) if (!state.api.has(k)) m.set(k, v);
  for (const [k, v] of state.api) m.set(k, v);
  return m;
}
class WindowGone extends Error { constructor() { super('同步窗口已关闭'); this.windowGone = true; } }

const DEFAULTS = {
  rednote: {
    partition: 'persist:rednote',
    base: 'https://www.rednote.com',
    home: 'https://www.rednote.com/explore',
    fetchGlobs: ['*/api/sns/web/v*/note/collect/page*', '*/api/sns/web/v*/user/me*'],
    favPatterns: [],           // 空 = 用 engine 里内置的收藏接口规则
    mePatterns: ['/api/sns/web/v\\d+/user/me'],
    loginCookies: ['web_session'],
    endTexts: ['THE END', '没有更多', 'No more'],
    domHrefMarker: 'xsec_source=pc_collect',
  },
  douyin: {
    partition: 'persist:douyin',
    base: 'https://www.douyin.com',
    home: 'https://www.douyin.com/',
    favUrl: 'https://www.douyin.com/user/self?showTab=favorite_collection',
    fetchGlobs: ['*/aweme/v1/web/aweme/listcollection*', '*/aweme/v1/web/collects/video/list*'],
    favPatterns: [],
    mePatterns: [],
    loginCookies: ['sessionid', 'sessionid_ss', 'sid_guard'],
    endTexts: ['暂时没有更多了', '没有更多了'],
    domCoverMarker: 's=PackSourceEnum_COLLECTION',
  },
};
const CAPTCHA_SELECTORS = ['#captcha-verify-image', '#captcha_container', '.captcha_verify_container', '.captcha-verify-container',
  '[id^="red-captcha"]', '.red-captcha', '.verify-wrap', '.secsdk-captcha-drag-icon', 'iframe[src*="captcha"]', 'iframe[src*="verify"]'];
const CAPTCHA_TEXT = /拖动.{0,6}滑块|完成.{0,6}验证|安全验证|访问频次|请求过于频繁|操作太频繁|访问太频繁|Please complete the verification|slide to verify/i;

class SyncManager {
  constructor({ userData, rules, log, send }) {
    this.userData = userData; this.rules = rules; this.log = log; this.send = send;
    this.wins = {}; this.running = null; this.cancelFlag = false;
    this.config = this.loadConfig();
  }
  loadConfig() {
    const cfg = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const f = path.join(this.userData, 'sync-config.json');
      if (fs.existsSync(f)) {
        const over = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const p of Object.keys(over || {})) if (cfg[p]) Object.assign(cfg[p], over[p]);
      }
    } catch (e) { this.log('sync-config.json 读取失败: ' + e.message); }
    for (const p of ['rednote', 'douyin']) { // 仅用于本地测试：把站点指向模拟服务器
      const b = process.env['FAV_SYNC_BASE_' + p.toUpperCase()];
      if (b) { cfg[p].base = b; cfg[p].home = b + (p === 'rednote' ? '/explore' : '/'); if (p === 'douyin') cfg[p].favUrl = b + '/user/self?showTab=favorite_collection'; }
    }
    return cfg;
  }
  ua() { return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome || '130.0.0.0'} Safari/537.36`; }
  ses(platform) {
    const s = session.fromPartition(this.config[platform].partition);
    if (!s.__favInit) { s.setUserAgent(this.ua()); s.__favInit = true; }
    return s;
  }
  /* ---------- 窗口：销毁了就重建，绝不复用已销毁的窗口 ---------- */
  window(platform, { show = true, inactive = false } = {}) {
    let w = this.wins[platform];
    if (!alive(w)) {
      delete this.wins[platform];
      w = new BrowserWindow({
        width: 1180, height: 860, show: false, title: platform === 'rednote' ? 'RedNote' : '抖音', autoHideMenuBar: true,
        webPreferences: { session: this.ses(platform), preload: path.join(__dirname, 'sync-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
      });
      const wc = w.webContents;
      wc.setUserAgent(this.ua());
      wc.setWindowOpenHandler(({ url }) => {   // 站内新窗口在同一窗口打开；非 http(s) 链接（如 bitbrowser://）一律拦下
        if (!/^https?:/i.test(url)) { this.log(`[${platform}] 已拦截外部协议新窗口 ${String(url).slice(0, 80)}`); return { action: 'deny' }; }
        if (this.allowed(platform, url) && alive(w)) w.loadURL(url).catch(() => {});
        return { action: 'deny' };
      });
      // 页面脚本跳转到外部协议会弹出 Windows「选择应用打开」：主框架和子框架都拦下
      const blockScheme = (e, url) => { if (url && !/^(https?|about|data|blob):/i.test(url)) { e.preventDefault(); this.log(`[${platform}] 已拦截外部协议跳转 ${String(url).slice(0, 80)}`); } };
      wc.on('will-navigate', blockScheme);
      wc.on('will-redirect', blockScheme);
      wc.on('will-frame-navigate', (e) => blockScheme(e, e.url));
      // 同步进行中：关窗口要先确认（页面脚本调用 window.close() 已被 preload 拦住）
      w.on('close', (e) => {
        try { this.ses(platform).cookies.flushStore().catch(() => {}); } catch (err) {}
        const r = this.running;
        if (r && r.platform === platform && !w.__allowClose) {
          e.preventDefault();
          this.log(`[${platform}] 同步中收到关闭窗口请求，询问用户`);
          dialog.showMessageBox(w, { type: 'question', buttons: ['继续同步', '停止同步并关闭'], defaultId: 0, cancelId: 0, message: '正在同步收藏，关闭这个窗口会停止同步。' })
            .then((res) => { if (res.response === 1) { this.cancelFlag = true; w.__allowClose = true; if (!w.isDestroyed()) w.close(); } }).catch(() => {});
        }
      });
      w.on('closed', () => {
        if (this.wins[platform] === w) delete this.wins[platform];
        const r = this.running;
        if (r && r.platform === platform) { r.windowGone = true; this.log(`[${platform}] 同步窗口被关闭`); }
      });
      wc.on('render-process-gone', (e, d) => {
        this.log(`[${platform}] 同步窗口页面崩溃: ${JSON.stringify(d)}`);
        const r = this.running; if (r && r.platform === platform) r.crashed = true;
      });
      wc.on('unresponsive', () => this.log(`[${platform}] 同步窗口无响应`));
      wc.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) this.log(`[${platform}] 页面加载失败 ${code} ${desc} ${url}`); });
      wc.on('did-navigate', (e, url) => { if (this.running && this.running.platform === platform) this.log(`[${platform}] 页面 → ${url}`); });
      wc.on('console-message', (e, lvl, msg) => { if (/\[favsync\]/.test(msg)) this.log(`[${platform}] ${msg}`); });
      this.wins[platform] = w;
    }
    if (show) { inactive ? w.showInactive() : (w.show(), w.focus()); }
    return w;
  }
  allowed(platform, url) {
    try {
      const h = new URL(url).host;
      if (process.env['FAV_SYNC_BASE_' + platform.toUpperCase()]) return true;
      return platform === 'rednote' ? /(^|\.)(rednote\.com|xiaohongshu\.com|xhscdn\.com|rednotecdn\.com)$/.test(h) : /(^|\.)(douyin\.com|douyinpic\.com|bytedance\.com|snssdk\.com)$/.test(h);
    } catch (e) { return false; }
  }
  // 加载页面：重定向导致的 ERR_ABORTED / ERR_FAILED 不算失败，等页面停下来再看最终地址
  async load(w, url, platform) {
    if (!alive(w)) throw new WindowGone();
    try { await w.loadURL(url); }
    catch (e) {
      if (!alive(w)) throw new WindowGone();
      this.log(`[${platform}] 加载 ${url} 返回 ${e.code || e.message}（多半是页面重定向，继续等待）`);
    }
    await this.waitLoaded(w, 20000);
    if (!alive(w)) throw new WindowGone();
    return w.webContents.getURL();
  }
  async waitLoaded(w, ms) {
    const t0 = Date.now();
    await realSleep(200);
    while (Date.now() - t0 < ms) { if (!alive(w) || !w.webContents.isLoading()) return; await realSleep(250); }
  }
  async js(w, code, dflt) {
    if (!alive(w)) return dflt;
    try { return await withTimeout(w.webContents.executeJavaScript(code), 15000); } catch (e) { return dflt; }
  }
  url(w) { return alive(w) ? w.webContents.getURL() : ''; }

  async openLogin(platform) {
    const w = this.window(platform);
    await this.load(w, this.config[platform].home, platform).catch((e) => this.log(`[${platform}] 打开首页失败 ${e.message}`));
    return true;
  }
  async openPost(platform, url) {
    if (!this.allowed(platform, url)) throw new Error('不支持的链接');
    if (this.running && this.running.platform === platform) throw new Error('正在同步，请等同步结束再打开');
    const w = this.window(platform);
    await this.load(w, url, platform).catch((e) => this.log(`[${platform}] 打开帖子失败 ${e.message}`));
    return true;
  }
  async isLoggedIn(platform) {
    try {
      const cs = await this.ses(platform).cookies.get({});
      const names = this.config[platform].loginCookies;
      return cs.some((c) => names.includes(c.name) && c.value && c.value.length > 4);
    } catch (e) { return false; }
  }
  async status() {
    return { rednote: await this.isLoggedIn('rednote'), douyin: await this.isLoggedIn('douyin'), running: this.running ? { platform: this.running.platform, mode: this.running.mode } : null };
  }
  cancel() { this.cancelFlag = true; }
  async flush() { for (const p of Object.keys(this.config)) { try { await this.ses(p).cookies.flushStore(); } catch (e) {} } }
  progress(p) { try { this.send(Object.assign({ platform: this.running && this.running.platform }, p)); } catch (e) {} }

  /* ---------- 接口拦截（CDP Fetch：响应在我们读完之前不会被丢掉，不会再有 “No resource with given identifier”） ---------- */
  async attach(w, platform) {
    if (!alive(w)) return false;
    const dbg = w.webContents.debugger;
    try { if (!dbg.isAttached()) dbg.attach('1.3'); } catch (e) { this.log(`[${platform}] debugger attach 失败: ${e.message}`); return false; }
    if (!dbg.__favHooked) {
      dbg.__favHooked = true;
      dbg.on('message', (_e, method, params) => { if (method === 'Fetch.requestPaused') this.onPaused(w, platform, params); });
      dbg.on('detach', (_e, reason) => {
        const r = this.running;
        if (!r || r.platform !== platform) return;
        this.log(`[${platform}] debugger detached: ${reason}`);
        if (alive(w) && !r.done && (r.reattach = (r.reattach || 0) + 1) <= 20) setTimeout(() => this.attach(w, platform).catch(() => {}), 600);
      });
    }
    try {
      const cfg = this.config[platform];
      await withTimeout(dbg.sendCommand('Fetch.enable', { patterns: cfg.fetchGlobs.map((g) => ({ urlPattern: g, requestStage: 'Response' })) }), 8000);
      return true;
    } catch (e) { this.log(`[${platform}] Fetch.enable 失败: ${e.message}`); return false; }
  }
  async onPaused(w, platform, params) {
    const r = this.running && this.running.platform === platform ? this.running : null;
    const dbg = alive(w) ? w.webContents.debugger : null;
    if (!dbg) return;
    const url = params.request && params.request.url, code = params.responseStatusCode;
    let body = null;
    try {
      if (r && code >= 200 && code < 300) {
        const b = await withTimeout(dbg.sendCommand('Fetch.getResponseBody', { requestId: params.requestId }), 10000);
        body = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
      }
    } catch (e) { if (r) { r.state.errors++; this.log(`[${platform}] 读取接口内容失败: ${e.message}`); } }
    finally { try { if (dbg.isAttached()) await dbg.sendCommand('Fetch.continueRequest', { requestId: params.requestId }); } catch (e) {} }
    if (!r) return;
    if (code === 429 || code === 461 || code === 471) { r.state.blocked = true; r.state.rateHits++; this.log(`[${platform}] 接口返回 ${code}（限流/验证）`); return; }
    if (body != null) this.handleApi(w, platform, url, body, r);
  }
  handleApi(w, platform, url, text, r) {
    const st = r.state, cfg = this.config[platform];
    if (!text || !String(text).trim()) return;   // CORS 预检 / 空响应
    let json; try { json = JSON.parse(text); } catch (e) { this.log(`[${platform}] 接口不是 JSON: ${shortUrl(url)}`); return; }
    if ((cfg.mePatterns || []).some((p) => new RegExp(p).test(url))) { const d = json.data || json; st.meId = String(d.user_id || d.userId || '') || st.meId; return; }
    if (!engine.isFavApi(platform, url, cfg.favPatterns)) { st.ignoredApi++; if (st.ignoredApi <= 5) this.log(`[${platform}] 忽略非收藏接口 ${shortUrl(url)}`); return; }
    const page = this.url(w);
    if (!this.onFavPage(platform, page, st)) { st.ignoredOffPage++; this.log(`[${platform}] 不在收藏页（${shortUrl(page)}），忽略这次接口数据`); return; }
    const pr = engine.parsePayload(platform, json, { base: cfg.base });
    st.apiHits++;
    if (pr.blocked) { st.blocked = true; this.log(`[${platform}] 接口提示风控/验证 code=${pr.code} ${text.slice(0, 200)}`); }
    if (pr.hasMore !== null) st.lastHasMore = pr.hasMore;
    const san = engine.sanitizeItems(platform, pr.items);
    if (san.dropped.length) { st.dropped += san.dropped.length; this.log(`[${platform}] 丢弃 ${san.dropped.length} 条可疑条目，例如 ${JSON.stringify(san.dropped.slice(0, 2))}`); }
    if (!pr.items.length && !pr.blocked) this.log(`[${platform}] 收藏接口没有解析出条目（结构可能变了）: ${text.slice(0, 300)}`);
    for (const it of san.items) if (!st.api.has(it.key)) st.api.set(it.key, it);
  }
  onFavPage(platform, pageUrl, st) {
    const cfg = this.config[platform];
    if (platform === 'douyin') return engine.isFavPage('douyin', pageUrl, { base: cfg.base });
    return engine.isFavPage('rednote', pageUrl, { base: cfg.base, uid: st.uid || undefined, favTabActive: true });
  }

  /* ---------- 主流程 ---------- */
  async sync(platform, { mode = 'incremental', knownKeys = [], localKeys = [], auto = false } = {}) {
    if (this.running) throw new Error('已有同步在进行中');
    this.cancelFlag = false;
    const cfg = this.config[platform];
    const known = new Set(knownKeys);
    const state = { api: new Map(), dom: new Map(), lastHasMore: null, blocked: false, rateHits: 0, meId: '', uid: '', apiHits: 0, errors: 0, ignoredApi: 0, ignoredOffPage: 0, dropped: 0 };
    const run = this.running = { platform, mode, started: Date.now(), state, crashed: false, windowGone: false, done: false };
    const result = { platform, mode, collected: 0, newItems: [], allItems: [], reachedEnd: false, stopReason: '', removedCheck: null };
    const check = () => { if (run.windowGone) throw new WindowGone(); if (this.cancelFlag) throw Object.assign(new Error('已手动停止'), { cancelled: true }); };
    let w;
    try {
      if (auto && !(await this.isLoggedIn(platform))) { result.stopReason = '未登录，自动同步跳过'; this.log(`[${platform}] 未登录，自动同步跳过`); return result; }
      w = this.window(platform, { show: true, inactive: auto });
      this.log(`[${platform}] 开始同步 mode=${mode} auto=${auto} 本地已有=${known.size}`);
      if (!this.url(w)) await this.load(w, 'about:blank', platform).catch(() => {});
      await this.attach(w, platform);

      // ----- 登录 -----
      if (!(await this.isLoggedIn(platform))) {
        await this.load(w, cfg.home, platform);
        if (alive(w)) { w.show(); w.focus(); }
        this.progress({ phase: 'login', msg: '请在弹出的窗口里扫码登录，登录后会自动继续…' });
        const t0 = Date.now();
        while (!(await this.isLoggedIn(platform))) {
          check();
          if (Date.now() - t0 > 5 * 60 * 1000) throw new Error('5 分钟内没有完成登录');
          await realSleep(2000);
        }
        await sleep(2500);
      }
      this.log(`[${platform}] 已登录，打开收藏页`);
      this.progress({ phase: 'open', msg: '正在打开收藏页…' });
      await this.openFavPage(w, platform, state);
      check();
      // 等收藏列表真正出现（接口返回或收藏卡片出现），之前的任何数据都不收
      const t1 = Date.now();
      while (Date.now() - t1 < 20000 && !state.api.size && state.lastHasMore === null) {
        check();
        if ((await this.collectDom(w, platform, state)).length) break;
        await realSleep(500);
      }

      // ----- 滚动收集 -----
      const maxScrolls = mode === 'full' ? 3000 : 120;
      const deadline = Date.now() + (mode === 'full' ? 120 : 15) * 60 * 1000;
      let idle = 0, lastCount = 0, lastH = 0, scrolls = 0, sinceBreak = 0, nextBreak = Math.round(rand(22, 34)), recover = 0;
      for (;;) {
        check();
        if (run.crashed || !this.onFavPage(platform, this.url(w), state)) {
          // 页面崩了、或者被跳转到别的页面（推荐页、视频详情等）：先停止收集，回到收藏页
          if (++recover > 3) throw new Error('页面多次离开收藏页（当前：' + shortUrl(this.url(w)) + '），已停止');
          this.log(`[${platform}] ${run.crashed ? '页面崩溃' : '离开了收藏页 ' + shortUrl(this.url(w))}，重新打开收藏页（第 ${recover} 次）`);
          run.crashed = false;
          await this.openFavPage(w, platform, state);
          await sleep(jitter(2500, 3500));
          continue;
        }
        if (!w.webContents.debugger.isAttached()) await this.attach(w, platform);
        const cap = await this.checkCaptcha(w);
        if (cap || state.blocked) {
          const ok = await this.waitCaptcha(w, platform, state, cap);
          if (!ok) { result.stopReason = '验证 / 限流没有解除，已停止（已收集的会保存）'; break; }
          continue;
        }
        const dom = await this.collectDom(w, platform, state);
        for (const it of dom) if (!state.dom.has(it.key)) state.dom.set(it.key, it);
        const useApi = state.api.size > 0 || state.apiHits > 0;
        const cur = mergedItems(state, useApi);
        const keys = [...cur.keys()];
        const newCount = keys.filter((k) => !known.has(k)).length;
        this.progress({ phase: 'scroll', collected: keys.length, added: newCount, msg: `已读取 ${keys.length} 条，新增 ${newCount} 条` + (useApi ? '' : '（页面读取模式）') });

        if (mode === 'incremental' && engine.shouldStopIncremental(keys, known, 8)) { result.stopReason = '已读到本地已有的收藏'; result.reachedKnown = true; break; }
        const endText = await this.hasEndText(w, cfg.endTexts);
        if (state.lastHasMore === false && keys.length === lastCount) { result.reachedEnd = true; result.stopReason = '已到收藏列表末尾'; break; }
        const sc = await this.scrollOnce(w);
        scrolls++; sinceBreak++;
        if (keys.length === lastCount && sc && Math.abs(sc.h - lastH) < 5) idle++; else idle = 0;
        lastCount = keys.length; lastH = sc ? sc.h : lastH;
        if (idle >= 6) {
          result.reachedEnd = state.lastHasMore === false || endText;
          result.stopReason = result.reachedEnd ? '已到收藏列表末尾' : '页面不再加载新内容';
          break;
        }
        if (scrolls >= maxScrolls) { result.stopReason = '达到单次滚动上限'; break; }
        if (Date.now() > deadline) { result.stopReason = '达到单次同步时间上限'; break; }
        if (Math.random() < 0.08) { await this.scrollOnce(w, -Math.round(rand(120, 260))); await sleep(jitter(800, 1500)); }
        if (sinceBreak >= nextBreak) { sinceBreak = 0; nextBreak = Math.round(rand(22, 34)); await sleep(jitter(6000, 12000)); }
        await sleep(jitter(2000, 3000));
      }
      await realSleep(1500 * Math.max(SPEED, 0.3));
      this.finish(result, state, known, mode, localKeys);
      return result;
    } catch (e) {
      if (e.windowGone) { result.stopReason = '同步窗口被关闭了（已收集的会放进待确认）'; this.log(`[${platform}] ${result.stopReason}`); }
      else if (e.cancelled) { result.stopReason = '已手动停止'; }
      else { this.log(`[${platform}] 同步失败: ${e.stack || e}`); result.error = e.message; }
      this.finish(result, state, known, 'partial', localKeys);
      result.mode = mode;
      return result;
    } finally {
      run.done = true;
      this.running = null;
      try { if (alive(w)) { const dbg = w.webContents.debugger; if (dbg.isAttached()) { await dbg.sendCommand('Fetch.disable').catch(() => {}); dbg.detach(); } } } catch (e) {}
    }
  }
  finish(result, state, known, mode, localKeys) {
    const useApi = state.api.size > 0;
    const cur = mergedItems(state, useApi);
    result.allItems = [...cur.values()];
    result.collected = result.allItems.length;
    result.newItems = result.allItems.filter((i) => !known.has(i.key));
    result.source = useApi ? 'api' : (state.dom.size ? 'dom' : 'none');
    result.stats = { apiHits: state.apiHits, ignoredApi: state.ignoredApi, ignoredOffPage: state.ignoredOffPage, dropped: state.dropped, errors: state.errors };
    if (mode === 'full') result.removedCheck = engine.detectRemoved(localKeys, result.allItems.map((i) => i.key), result.reachedEnd);
    this.log(`[${result.platform}] 同步结束 mode=${mode} 读取=${result.collected} 新增=${result.newItems.length} 来源=${result.source} 原因=${result.stopReason || result.error} 到底=${result.reachedEnd} ` +
      `接口=${state.apiHits} 忽略接口=${state.ignoredApi} 不在收藏页=${state.ignoredOffPage} 丢弃=${state.dropped} 错误=${state.errors}`);
  }

  async openFavPage(w, platform, state) {
    const cfg = this.config[platform];
    if (platform === 'douyin') {
      let u = await this.load(w, cfg.favUrl, platform);
      if (!this.onFavPage('douyin', u, state)) {
        this.log(`[douyin] 打开收藏页后地址是 ${shortUrl(u)}，尝试点「收藏」标签`);
        await this.js(w, `(function(){var els=[].slice.call(document.querySelectorAll('[data-e2e*="tab"] span,[data-e2e*="tab"] div,[role="tab"],span,div'));
          var t=els.find(function(e){return e.children.length===0&&/^收藏\\s*\\d*$/.test((e.innerText||'').trim());});if(t){t.click();return true;}return false;})()`, false);
        await sleep(2500); u = this.url(w);
        if (!this.onFavPage('douyin', u, state)) { u = await this.load(w, cfg.favUrl, platform); }
        if (!this.onFavPage('douyin', u, state)) throw new Error('没能打开抖音「我的 → 收藏」页（当前页面：' + shortUrl(u) + '）。可能没登录或页面改版');
      }
      return;
    }
    // RedNote：先拿到自己的用户 ID，再打开 主页 → 收藏
    if (!state.uid) {
      await this.load(w, cfg.home, platform);
      await sleep(jitter(2000, 3000));
      let uid = state.meId;
      if (!uid) {
        uid = await this.js(w, `(function(){
          var as=[].slice.call(document.querySelectorAll('a[href*="/user/profile/"]'));
          var pick=as.find(function(a){var t=(a.innerText||'').trim();return /^(我|Me|我的)$/.test(t);})||as.find(function(a){return a.closest('.side-bar,.channel-list,[class*="side"]');});
          if(!pick)return '';var m=pick.getAttribute('href').match(/user\\/profile\\/([0-9a-zA-Z]+)/);return m?m[1]:'';})()`, '');
      }
      if (!uid) { await realSleep(3000); uid = state.meId; }
      if (!uid) throw new Error('找不到你的 RedNote 主页（可能没登录或页面改版）');
      state.uid = uid;
    }
    await this.load(w, `${cfg.base}/user/profile/${state.uid}?tab=fav&subTab=note`, platform);
    await sleep(jitter(1500, 2500));
    if (!engine.isFavPage('rednote', this.url(w), { base: cfg.base, uid: state.uid, favTabActive: true })) throw new Error('没能打开 RedNote 收藏页（当前页面：' + shortUrl(this.url(w)) + '）');
    await this.js(w, `(function(){
      var els=[].slice.call(document.querySelectorAll('.reds-tab-item,.tab-content-item,[role="tab"]'));
      var t=els.find(function(e){return /^(收藏|Collections?|Saved|Collect)$/i.test((e.innerText||'').trim());});
      if(t&&!/active|selected/.test(t.className+(t.parentNode&&t.parentNode.className))){t.click();return true;}return false;})()`, false);
  }

  async scrollOnce(w, delta) {
    const d = delta != null ? delta : Math.round(rand(600, 900));
    return this.js(w, `(function(d){
      function scrollable(el){if(!el||el===document.body)return false;var s=getComputedStyle(el);return /(auto|scroll)/.test(s.overflowY)&&el.scrollHeight>el.clientHeight+200;}
      var el=window.__favScrollEl;
      if(!el||!document.contains(el)||!scrollable(el)){el=null;var best=0;
        var cands=document.querySelectorAll('div,main,section,ul');
        for(var i=0;i<cands.length&&i<6000;i++){var c=cands[i];if(c.clientHeight<200)continue;if(scrollable(c)&&c.scrollHeight>best){best=c.scrollHeight;el=c;}}
        window.__favScrollEl=el;}
      var se=document.scrollingElement||document.documentElement;
      if(se.scrollHeight>window.innerHeight+200)window.scrollBy({top:d,behavior:'smooth'});
      if(el)el.scrollBy({top:d,behavior:'smooth'});
      return {h:Math.max(se.scrollHeight,el?el.scrollHeight:0),top:Math.max(se.scrollTop,el?el.scrollTop:0)};})(${d})`, null);
  }
  async hasEndText(w, texts) {
    return this.js(w, `(function(ts){var b=document.body?document.body.innerText.slice(-4000):'';return ts.some(function(t){return b.indexOf(t)>=0;});})(${JSON.stringify(texts)})`, false);
  }
  async checkCaptcha(w) {
    if (!alive(w)) return '';
    const url = this.url(w);
    if (/captcha|\/verify|website-login\/error/i.test(url)) return '页面跳到了验证页';
    return this.js(w, `(function(sels,reSrc){
      function vis(e){var r=e.getBoundingClientRect();var s=getComputedStyle(e);return r.width>30&&r.height>30&&s.visibility!=='hidden'&&s.display!=='none';}
      for(var i=0;i<sels.length;i++){var e=document.querySelector(sels[i]);if(e&&vis(e))return '出现了滑块验证';}
      // 只看弹层 / 验证容器里的文字（页面正文里的标题、评论可能碰巧带「验证」「太频繁」之类的字）
      var re=new RegExp(reSrc,'i');var boxes=[].slice.call(document.querySelectorAll('[role="dialog"],[class*="captcha"],[id*="captcha"],[class*="verify"],[id*="verify"],[class*="secsdk"],[class*="modal"],[class*="toast"]'));
      for(var j=0;j<boxes.length&&j<200;j++){var b=boxes[j];if(!vis(b))continue;var tx=(b.innerText||'').slice(0,500);if(tx.length<300&&re.test(tx))return '页面提示需要验证 / 访问太频繁';}
      return '';})(${JSON.stringify(CAPTCHA_SELECTORS)},${JSON.stringify(CAPTCHA_TEXT.source)})`, '');
  }
  async waitCaptcha(w, platform, state, why) {
    const t0 = Date.now();
    if (state.rateHits >= 4) { this.log(`[${platform}] 多次限流，停止`); return false; }
    if (alive(w)) { w.show(); w.focus(); }
    this.progress({ phase: 'captcha', captcha: true, msg: (why || '平台提示访问太频繁 / 需要验证') + '：请在弹出的窗口里完成验证，完成后会自动继续（最多等 15 分钟）' });
    this.log(`[${platform}] 暂停等待验证: ${why || 'api blocked'}`);
    let clear = 0;
    while (Date.now() - t0 < 15 * 60 * 1000) {
      if (this.cancelFlag || !alive(w)) return false;
      await sleep(3000);
      const cap = await this.checkCaptcha(w);
      if (!cap) clear++; else clear = 0;
      if (!why && clear >= 1 && Date.now() - t0 > 45000) break;
      if (why && clear >= 2) break;
    }
    if (Date.now() - t0 >= 15 * 60 * 1000) return false;
    state.blocked = false;
    this.progress({ phase: 'scroll', captcha: false, msg: '验证已通过，继续同步…' });
    await sleep(jitter(3000, 5000));
    return true;
  }

  /* 页面卡片读取（兜底）：只在自己的收藏页，只认带收藏标记的卡片 */
  async collectDom(w, platform, state) {
    if (!this.onFavPage(platform, this.url(w), state)) return [];
    const cfg = this.config[platform];
    const js = platform === 'rednote' ? `(function(marker){
      var out=[],seen={};
      // 卡片链接有两种：/explore/ID?... 和（2026 起的收藏页）/user/profile/UID/ID?...；都要带收藏标记
      [].slice.call(document.querySelectorAll('a[href*="/explore/"],a[href*="/user/profile/"]')).forEach(function(a){
        if(a.closest('header,nav,aside,.side-bar'))return;
        var href=a.getAttribute('href')||'';if(href.indexOf(marker)<0)return;
        var m=href.match(/explore\\/([0-9a-f]{24})/)||href.match(/user\\/profile\\/[0-9a-zA-Z]+\\/([0-9a-f]{24})/);if(!m||seen[m[1]])return;
        var card=a.closest('section,.note-item,[class*="note-item"]');if(!card)return;seen[m[1]]=1;
        function q(s){var e=card.querySelector(s);return e?(e.innerText||e.textContent||'').trim():'';}
        var img=card.querySelector('img');var qs=href.split('?')[1]||'';
        out.push({nid:m[1],href:location.origin+'/explore/'+m[1]+(qs?'?'+qs:''),title:q('.title, .footer .title, [class*="title"]'),author:q('.author .name, .name, [class*="author"] [class*="name"]'),
          likes:q('.like-wrapper .count, [class*="like"] .count, .count'),cover:img?(img.currentSrc||img.src||''):'',video:!!card.querySelector('.play-icon,[class*="play-icon"]')});});
      // 首屏服务端渲染的数据：只在「收藏 → 笔记」标签页读 user.notes 里的收藏列表
      try{
        if(/[?&]tab=fav/.test(location.search)&&!/subTab=(board|album)/.test(location.search)){
          var raw=function(x){return x&&(x._rawValue!==undefined?x._rawValue:(x._value!==undefined?x._value:x));};
          var u=window.__INITIAL_STATE__&&window.__INITIAL_STATE__.user;var lists=raw(u&&u.notes)||[];var list=raw(lists[1])||[];
          list.forEach(function(x){x=raw(x)||{};var c=raw(x.noteCard)||{};var id=c.noteId||x.id;if(!/^[0-9a-f]{24}$/.test(id||'')||seen[id])return;seen[id]=1;
            var tok=c.xsecToken||x.xsecToken||'';var cv=raw(c.cover)||{};var ii=raw(c.interactInfo)||{};var us=raw(c.user)||{};
            out.push({nid:id,href:location.origin+'/explore/'+id+'?xsec_token='+encodeURIComponent(tok)+'&'+marker,title:c.displayTitle||'',author:us.nickname||us.nickName||'',
              likes:String(ii.likedCount||''),cover:cv.urlDefault||cv.url||'',video:c.type==='video',ssr:true});});}
      }catch(e){}
      return out;})(${JSON.stringify(cfg.domHrefMarker || 'xsec_source=pc_collect')})` : `(function(marker){
      var out=[],seen={};
      [].slice.call(document.querySelectorAll('li a[href*="/video/"],li a[href*="/note/"]')).forEach(function(a){
        if(a.closest('header,nav,aside,[data-e2e="feed-active-video"]'))return;
        var href=a.getAttribute('href')||'';var m=href.match(/\\/(video|note)\\/(\\d{15,20})/);if(!m||seen[m[2]])return;
        var card=a.closest('li');if(!card)return;
        var img=card.querySelector('img');var src=img?(img.currentSrc||img.src||''):'';
        if(!src||src.indexOf(marker)<0)return;   // 收藏列表里的封面带 PackSourceEnum_COLLECTION
        seen[m[2]]=1;
        var txt=(card.innerText||'').trim().split('\\n').filter(Boolean);
        var likes=txt.find(function(s){return /^[\\d.]+[万wk]?$/i.test(s.trim());})||'';
        var title=(img&&img.alt)||txt.filter(function(s){return s.length>4&&s!==likes;}).sort(function(x,y){return y.length-x.length;})[0]||'';
        out.push({nid:m[2],kind:m[1],href:a.href,title:title,author:'',likes:likes,cover:src});});
      return out;})(${JSON.stringify(cfg.domCoverMarker || 's=PackSourceEnum_COLLECTION')})`;
    const raw = await this.js(w, js, []);
    if (platform === 'rednote' && state && !state.diagDone) {
      // 诊断：页面上的笔记卡片有多少，其中多少带收藏标记（只记数量和链接参数名，不记 ID）
      const dg = await this.js(w, `(function(marker){var as=[].slice.call(document.querySelectorAll('a[href*="/explore/"],a[href*="/user/profile/"]')).filter(function(a){return !a.closest('header,nav,aside,.side-bar');});
        var ids={},mk={},params={};as.forEach(function(a){var h=a.getAttribute('href')||'';var m=h.match(/explore\\/([0-9a-f]{24})/)||h.match(/user\\/profile\\/[0-9a-zA-Z]+\\/([0-9a-f]{24})/);if(!m)return;ids[m[1]]=1;if(h.indexOf(marker)>=0)mk[m[1]]=1;
          var q=h.split('?')[1]||'';q.split('&').forEach(function(kv){var k=kv.split('=')[0],v=kv.split('=')[1]||'';if(k)params[k+(k==='xsec_source'?'='+v:'')]=1;});});
        return {cards:Object.keys(ids).length,withMarker:Object.keys(mk).length,params:Object.keys(params).slice(0,12)};})(${JSON.stringify(cfg.domHrefMarker || 'xsec_source=pc_collect')})`, null);
      if (dg && dg.cards) {
        state.diagDone = true;
        this.log(`[rednote] 首屏诊断: 首屏数据(含SSR)=${(raw || []).filter((x) => x.ssr).length} 页面卡片=${dg.cards} 带收藏标记=${dg.withMarker} 被过滤=${dg.cards - dg.withMarker} 链接参数=${(dg.params || []).join(',')} 已读取=${(raw || []).length}`);
      }
    }
    const base = cfg.base;
    const items = (raw || []).map((r) => {
      if (platform === 'rednote') {
        return { id: 'rednote_' + r.nid, nid: r.nid, source: 'rednote', key: 'rednote/' + r.nid, title: r.title || '(无标题)', author: r.author, url: r.href,
          likes: r.likes, likes_num: engine.parseLikes(r.likes), type: r.video ? 'video' : 'image', cover: /^https?:/.test(r.cover) ? r.cover : '', board: '', _dom: true };
      }
      return { id: 'douyin_' + r.nid, nid: r.nid, source: 'douyin', key: 'douyin/' + r.nid, title: r.title || '(无标题)', author: r.author,
        url: base + '/' + r.kind + '/' + r.nid, likes: r.likes, likes_num: engine.parseLikes(r.likes), type: r.kind === 'note' ? 'image' : 'video',
        cover: /^https?:/.test(r.cover) ? r.cover : '', board: '', _dom: true };
    });
    return engine.sanitizeItems(platform, items, { fromDom: true }).items;
  }

  /* ---------- 封面下载到 userData/covers（大图缩到 400px 宽，省内存） ---------- */
  async downloadCovers(items) {
    const dir = path.join(this.userData, 'covers');
    fs.mkdirSync(dir, { recursive: true });
    const todo = items.filter((i) => i.cover && /^https?:/.test(i.cover));
    let ok = 0, fail = 0;
    const one = async (it) => {
      const safe = String(it.id).replace(/[^0-9a-zA-Z_-]/g, '_');
      const exist = fs.readdirSync(dir).find((f) => f.startsWith(safe + '.'));
      if (exist) { it.cover_local = 'ucov:' + exist; ok++; return; }
      const ref = it.source === 'douyin' ? 'https://www.douyin.com/' : 'https://www.rednote.com/';
      try {
        const r = await fetch(it.cover, { headers: { Referer: ref, 'User-Agent': this.ua(), Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        let buf = Buffer.from(await r.arrayBuffer());
        let ext = sniff(buf);
        if (!ext || buf.length < 500) throw new Error('不是图片');
        if (ext === 'heic') throw new Error('HEIC 格式无法显示');
        try {
          const img = nativeImage.createFromBuffer(buf);
          if (!img.isEmpty() && img.getSize().width > 480) { buf = img.resize({ width: 400, quality: 'good' }).toJPEG(82); ext = 'jpg'; }
        } catch (e) {}
        const name = safe + '.' + ext;
        fs.writeFileSync(path.join(dir, name), buf);
        it.cover_local = 'ucov:' + name; ok++;
      } catch (e) { fail++; this.log(`封面下载失败 ${it.id}: ${e.message}`); }
    };
    for (let i = 0; i < todo.length; i += 4) await Promise.all(todo.slice(i, i + 4).map(one));
    return { ok, fail };
  }
}
function shortUrl(u) { try { const x = new URL(u); return x.host + x.pathname + (x.search ? x.search.slice(0, 60) : ''); } catch (e) { return String(u).slice(0, 80); } }
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + ms + 'ms')), ms))]);
}
function sniff(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (b.slice(0, 3).toString() === 'GIF') return 'gif';
  if (b.slice(4, 12).toString().startsWith('ftypavif')) return 'avif';
  if (b.slice(4, 8).toString() === 'ftyp') return 'heic';
  return '';
}
module.exports = { SyncManager, DEFAULTS, sniff };

// 纯逻辑：分类规则（与 parse.py / 页面内 JS 一致）、接口数据解析、合并、增量停止判断、取消收藏检测
// 不依赖 Electron，可直接用 node 测试。
'use strict';

/* ---------------- 分类 ---------------- */
function norm(s) { return String(s || '').normalize('NFKC').toLowerCase(); }
function kwMatch(kw, t) {
  kw = norm(kw);
  if (/^[a-z0-9]{1,3}$/.test(kw)) return new RegExp('(^|[^a-z0-9])' + kw + '(?![a-z0-9])').test(t);
  return t.indexOf(kw) >= 0;
}
function boardHint(RULES, board, strength) {
  const b = norm(board).trim(); if (!b) return null;
  for (const r of RULES.board_rules || []) if (r[2] === strength && norm(r[0]) === b) return r[1];
  return null;
}
function categorize(RULES, title, author, nid, board) {
  if (nid && RULES.overrides && RULES.overrides[nid]) return RULES.overrides[nid];
  let h = boardHint(RULES, board, 'strong'); if (h) return h;
  const t = norm(title);
  for (const [cat, kws] of RULES.rules) for (const k of kws) if (kwMatch(k, t)) return cat;
  h = boardHint(RULES, board, 'weak'); if (h) return h;
  const a = norm(author);
  for (const [cat, kws] of RULES.author_rules || []) for (const k of kws) if (kwMatch(k, a)) return cat;
  return '其他';
}

/* ---------------- 工具 ---------------- */
function parseLikes(s) {
  if (typeof s === 'number') return Math.round(s);
  const m = String(s || '').trim().replace(/,/g, '').match(/^([\d.]+)\s*(万|w|k|千)?(\+)?$/i);
  if (!m) return 0;
  const u = (m[2] || '').toLowerCase();
  return Math.round(parseFloat(m[1]) * ({ '万': 1e4, w: 1e4, k: 1e3, '千': 1e3 }[u] || 1));
}
function fmtLikes(n) {
  if (typeof n === 'string') return n;
  if (!n && n !== 0) return '';
  return n >= 10000 ? (Math.round(n / 1000) / 10) + '万' : String(n);
}
function noteIdFromUrl(url) {
  try {
    const s = new URL(url).pathname.replace(/\/+$/, '').split('/').pop();
    return /^[0-9a-zA-Z]{8,}$/.test(s) ? s : '';
  } catch (e) { return ''; }
}
function keyOf(source, id) { return source + '/' + id; }
const first = (...vals) => { for (const v of vals) if (v !== undefined && v !== null && v !== '') return v; return ''; };
const str = (v) => (v === undefined || v === null) ? '' : String(v);

/* ---------------- RedNote 解析 ---------------- */
function rnCover(c) {
  if (!c) return '';
  if (typeof c === 'string') return c;
  let u = first(c.url_default, c.urlDefault, c.url_pre, c.urlPre, c.url);
  const list = c.info_list || c.infoList;
  if (!u && Array.isArray(list) && list.length) u = first(list[list.length - 1].url, list[0].url);
  return httpsCdn(str(u));
}
function httpsCdn(u) { return /^http:\/\/[^/]*(xhscdn|rednotecdn|xiaohongshu|douyinpic|byteimg|douyin)\./i.test(u) ? u.replace(/^http:/, 'https:') : u; }
function looksLikeRnNote(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const id = first(o.note_id, o.noteId, o.id);
  if (!/^[0-9a-f]{24}$/i.test(str(id))) return false;
  return ('display_title' in o) || ('displayTitle' in o) || ('title' in o && ('cover' in o || 'user' in o)) || ('cover' in o && 'user' in o);
}
function rnItem(o, base) {
  const id = str(first(o.note_id, o.noteId, o.id));
  const user = o.user || o.author || {};
  const ii = o.interact_info || o.interactInfo || {};
  const tok = first(o.xsec_token, o.xsecToken);
  const host = base || 'https://www.rednote.com';
  const url = host + '/explore/' + id + (tok ? '?xsec_token=' + encodeURIComponent(tok) + '&xsec_source=pc_collect' : '');
  const likesRaw = first(ii.liked_count, ii.likedCount, o.liked_count, o.likes);
  return {
    id: 'rednote_' + id, nid: id, source: 'rednote', key: keyOf('rednote', id),
    title: str(first(o.display_title, o.displayTitle, o.title, o.desc)).trim() || '(无标题)',
    author: str(first(user.nickname, user.nick_name, user.nickName, user.name)),
    url, likes: fmtLikes(likesRaw), likes_num: parseLikes(likesRaw),
    type: /video/i.test(str(o.type)) ? 'video' : 'image',
    cover: rnCover(o.cover || o.image_list && o.image_list[0]),
    board: '',
  };
}

/* ---------------- 抖音解析 ---------------- */
function pickUrl(list) {
  if (!Array.isArray(list) || !list.length) return '';
  const jpg = list.find((u) => /jpe?g/i.test(u) && !/heic/i.test(u));
  return str(jpg || list.find((u) => !/heic/i.test(u)) || list[0]);
}
function looksLikeAweme(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  return /^\d{15,20}$/.test(str(o.aweme_id)) && ('desc' in o || 'author' in o || 'video' in o);
}
function dyItem(o) {
  const id = str(o.aweme_id);
  const isNote = o.aweme_type === 68 || o.aweme_type === 150 || (Array.isArray(o.images) && o.images.length > 0);
  const st = o.statistics || {};
  const v = o.video || {};
  let cover = '';
  if (isNote && Array.isArray(o.images) && o.images[0]) cover = pickUrl(o.images[0].url_list || (o.images[0].display_image || {}).url_list);
  if (!cover) cover = pickUrl((v.cover || {}).url_list) || pickUrl((v.origin_cover || {}).url_list) || pickUrl((v.dynamic_cover || {}).url_list);
  const likesRaw = first(st.digg_count, st.diggCount);
  let title = str(o.desc).trim();
  if (!title && o.preview_title) title = str(o.preview_title);
  return {
    id: 'douyin_' + id, nid: id, source: 'douyin', key: keyOf('douyin', id),
    title: title || '(无标题)',
    author: str((o.author || {}).nickname),
    url: 'https://www.douyin.com/' + (isNote ? 'note/' : 'video/') + id,
    likes: fmtLikes(likesRaw === '' ? '' : +likesRaw), likes_num: parseLikes(likesRaw === '' ? 0 : +likesRaw),
    type: isNote ? 'image' : 'video',
    cover: httpsCdn(cover),
    board: '',
  };
}

/* 深度遍历任意 JSON，找出看起来像笔记/视频的对象（防御式：接口结构改了也尽量能用） */
function walk(obj, test, out, depth) {
  if (depth > 12 || !obj || typeof obj !== 'object') return;
  if (test(obj)) { out.push(obj); return; }
  if (Array.isArray(obj)) { for (const x of obj) walk(x, test, out, depth + 1); return; }
  for (const k of Object.keys(obj)) walk(obj[k], test, out, depth + 1);
}
// 返回 { items, hasMore, blocked, code }
function parsePayload(platform, json, opts = {}) {
  const res = { items: [], hasMore: null, blocked: false, code: null };
  if (!json || typeof json !== 'object') return res;
  const found = [];
  if (platform === 'rednote') {
    walk(json, looksLikeRnNote, found, 0);
    res.items = found.map((o) => rnItem(o, opts.base));
    const d = json.data || {};
    if (typeof d.has_more === 'boolean') res.hasMore = d.has_more;
    else if (typeof json.has_more === 'boolean') res.hasMore = json.has_more;
    res.code = json.code != null ? json.code : null;
    // 300011 账号异常 / 300012 IP 风控 / 300013 访问频次异常 / 461 验证码
    if ([300011, 300012, 300013, 300015, 461, 471].includes(+json.code) || /验证|频繁|captcha|verify/i.test(str(json.msg))) res.blocked = true;
  } else {
    walk(json, looksLikeAweme, found, 0);
    res.items = found.map(dyItem);
    if (json.has_more !== undefined) res.hasMore = !!json.has_more;
    res.code = json.status_code != null ? json.status_code : null;
    if (json.status_code && +json.status_code !== 0 && /verify|captcha|验证|频繁|limit/i.test(str(json.status_msg) + str(json.verify_type))) res.blocked = true;
    if (json.verify_type || json.verify_ticket) res.blocked = true;
  }
  // 去重（同一个 payload 里可能重复）
  const seen = new Set();
  res.items = res.items.filter((i) => (seen.has(i.key) ? false : (seen.add(i.key), true)));
  return res;
}

/* ---------------- 合并 ----------------
 * synced: userData/synced.json 里的数组（同步得到的条目）
 * incoming: 本次同步按页面顺序（最新收藏在前）收集到的条目
 * knownKeys: 本地已有的全部 key（内置数据 + 导入 + 已同步）
 * 新条目：完整写入，order 为负数，保证排在最前面（越新的同步越靠前，同一次同步内保持页面顺序）
 * 已有条目：只写补丁（封面、点赞、类型、更新后的链接），不改分类和收藏顺序
 */
function mergeSynced(synced, incoming, knownKeys, RULES, now) {
  now = now || Date.now();
  const known = new Set(knownKeys || []);
  const idx = new Map();
  synced.forEach((s, i) => idx.set(s.key, i));
  const base = -Math.floor(now / 1000);
  let added = 0, patched = 0;
  const addedKeys = [];
  incoming.forEach((it, i) => {
    if (!it || !it.key) return;
    if (!known.has(it.key) && !idx.has(it.key)) {
      const full = Object.assign({}, it, {
        category: categorize(RULES, it.title, it.author, it.nid, it.board),
        order: base + i / 10000, synced_at: now,
      });
      delete full.nid; delete full._dom;
      idx.set(it.key, synced.length); synced.push(full); known.add(it.key); added++; addedKeys.push(it.key);
    } else {
      const patch = { key: it.key, id: it.id, source: it.source, url: it.url, likes: it.likes, likes_num: it.likes_num, type: it._dom ? '' : it.type, seen_at: now, _patch: true };
      if (it.cover) patch.cover = it.cover;
      if (it.title && it.title !== '(无标题)') patch.title_live = it.title;
      if (idx.has(it.key)) {
        const old = synced[idx.get(it.key)];
        if (old._patch) Object.assign(old, patch);
        else { for (const p of ['likes', 'likes_num', 'url', 'type']) if (patch[p] !== '' && patch[p] != null) old[p] = patch[p]; if (!old.cover && patch.cover) old.cover = patch.cover; old.seen_at = now; }
      } else { idx.set(it.key, synced.length); synced.push(patch); }
      patched++;
    }
  });
  return { synced, added, patched, addedKeys };
}

/* 增量同步停止条件：从开头起已收集到连续 N 条本地已有的条目 */
function shouldStopIncremental(orderedKeys, knownKeys, threshold) {
  threshold = threshold || 8;
  const known = knownKeys instanceof Set ? knownKeys : new Set(knownKeys);
  let run = 0;
  for (const k of orderedKeys) { if (known.has(k)) { run++; if (run >= threshold) return true; } else run = 0; }
  return false;
}

/* 全量同步后检测已取消收藏：只有真正到达列表末尾、且收集数量足够可信时才判定 */
function detectRemoved(localKeysOfSource, seenKeys, reachedEnd, opts = {}) {
  const minRatio = opts.minRatio != null ? opts.minRatio : 0.6;
  const seen = new Set(seenKeys);
  const local = [...new Set(localKeysOfSource)];
  if (!reachedEnd) return { ok: false, reason: '没有到达列表末尾，不判定取消收藏', removed: [] };
  const overlap = local.filter((k) => seen.has(k)).length;
  if (local.length && overlap / local.length < minRatio) {
    return { ok: false, reason: `只匹配到本地 ${overlap}/${local.length} 条，可能没加载完整，为安全起见不判定`, removed: [] };
  }
  return { ok: true, reason: '', removed: local.filter((k) => !seen.has(k)) };
}

/* ---------------- 来源校验（防止把推荐流 / 其他页面的内容当成收藏） ---------------- */
const FAV_API = {
  rednote: [/\/api\/sns\/web\/v\d+\/note\/collect\/page(\?|$)/],
  douyin: [/\/aweme\/v\d+\/web\/aweme\/listcollection\/?(\?|$)/, /\/aweme\/v\d+\/web\/collects\/video\/list\/?(\?|$)/],
};
function isFavApi(platform, url, patterns) {
  const res = (patterns && patterns.length ? patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p))) : FAV_API[platform]) || [];
  let path = '';
  try { const u = new URL(url); path = u.pathname + (u.search ? '?' : ''); } catch (e) { return false; }
  return res.some((r) => r.test(path));
}
// 当前窗口是不是“我自己的收藏页”
function isFavPage(platform, pageUrl, opts = {}) {
  let u; try { u = new URL(pageUrl); } catch (e) { return false; }
  if (opts.base) { try { if (new URL(opts.base).host !== u.host) return false; } catch (e) {} }
  if (platform === 'douyin') {
    return /^\/user\/self\/?$/.test(u.pathname) && u.searchParams.get('showTab') === 'favorite_collection';
  }
  const m = u.pathname.match(/^\/user\/profile\/([0-9a-zA-Z]+)\/?$/);
  if (!m) return false;
  if (opts.uid && m[1] !== opts.uid) return false;
  return u.searchParams.get('tab') === 'fav' || opts.favTabActive === true;
}
// 抖音封面里的来源标记：收藏列表里的封面带 s=PackSourceEnum_COLLECTION；带了别的来源（推荐流等）就不要
function coverSourceTag(cover) { const m = String(cover || '').match(/[?&]s=PackSourceEnum_([A-Z_]+)/); return m ? m[1] : ''; }
function sanitizeItems(platform, items, opts = {}) {
  const out = [], dropped = [];
  for (const it of items || []) {
    if (!it || !it.key || !it.nid && !/\/[0-9a-zA-Z]{8,}$/.test(it.key)) { dropped.push([it && it.key, '缺少 ID']); continue; }
    if (platform === 'douyin') {
      const tag = coverSourceTag(it.cover);
      if (tag && tag !== 'COLLECTION') { dropped.push([it.key, '封面来源是 ' + tag + '，不是收藏列表']); continue; }
      if (opts.fromDom && tag !== 'COLLECTION') { dropped.push([it.key, '页面卡片没有收藏列表标记']); continue; }
    }
    if (platform === 'rednote' && opts.fromDom && !/xsec_source=pc_collect/.test(it.url || '')) { dropped.push([it.key, '页面卡片不是收藏列表里的']); continue; }
    out.push(it);
  }
  return { items: out, dropped };
}

/* ---------------- 待确认（同步结果先放这里，用户确认后才合并） ---------------- */
function buildBatch(incoming, knownKeys, rejectedKeys, RULES, now, meta = {}) {
  const rejected = new Set(rejectedKeys || []);
  const tmp = [];
  const m = mergeSynced(tmp, (incoming || []).filter((i) => i && !rejected.has(i.key)), knownKeys, RULES, now);
  return Object.assign({ id: String(now || Date.now()), at: now || Date.now(), items: tmp.filter((x) => !x._patch), patches: tmp.filter((x) => x._patch) }, meta, { added: m.added });
}
function applyPatch(synced, idx, patch) {
  if (idx.has(patch.key)) {
    const old = synced[idx.get(patch.key)];
    if (old._patch) Object.assign(old, patch);
    else { for (const p of ['likes', 'likes_num', 'url', 'type']) if (patch[p] !== '' && patch[p] != null) old[p] = patch[p]; if (!old.cover && patch.cover) old.cover = patch.cover; if (patch.cover_local && !old.cover_local) old.cover_local = patch.cover_local; old.seen_at = patch.seen_at; }
  } else { idx.set(patch.key, synced.length); synced.push(Object.assign({}, patch)); }
}
// 把待确认的批次合并进 synced / marks。excludeKeys = 用户删掉的条目
function applyBatches(synced, marks, batches, excludeKeys, now) {
  now = now || Date.now();
  const ex = new Set(excludeKeys || []);
  marks = marks || {}; marks.unsaved = marks.unsaved || {}; marks.kept = marks.kept || {}; marks.gone = marks.gone || {};
  const idx = new Map(); synced.forEach((s, i) => idx.set(s.key, i));
  let added = 0, removed = 0, restored = 0; const addedKeys = [];
  for (const b of batches || []) {
    for (const it of b.items || []) {
      if (ex.has(it.key)) continue;
      if (idx.has(it.key) && !synced[idx.get(it.key)]._patch) continue;
      if (idx.has(it.key)) synced[idx.get(it.key)] = Object.assign({}, it); else { idx.set(it.key, synced.length); synced.push(Object.assign({}, it)); }
      added++; addedKeys.push(it.key);
    }
    for (const p of b.patches || []) applyPatch(synced, idx, p);
    // 远端已不在收藏里的：只打「可能已取消」标记，不隐藏、不删除
    for (const k of b.removed || []) if (!ex.has(k) && !marks.gone[k] && !marks.unsaved[k]) { marks.gone[k] = { by: 'sync', at: now }; removed++; }
    for (const k of b.seenKeys || []) {
      if (marks.gone[k]) { delete marks.gone[k]; restored++; }
      const mk = marks.unsaved[k]; if (mk && mk.by === 'sync') { delete marks.unsaved[k]; restored++; }
    }
  }
  return { synced, marks, added, removed, restored, addedKeys };
}

module.exports = { isFavApi, isFavPage, coverSourceTag, sanitizeItems, buildBatch, applyBatches, norm, kwMatch, categorize, parseLikes, fmtLikes, noteIdFromUrl, parsePayload, mergeSynced, shouldStopIncremental, detectRemoved, rnItem, dyItem };

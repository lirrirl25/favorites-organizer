// node --test test/   —— 合并 / 解析 / 分类 逻辑测试（假接口数据）
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const E = require('../lib/engine');
const ROOT = path.join(__dirname, '..', '..');
const RULES = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules.example.json'), 'utf8'));
// 全部是虚构样本，不读取 data.json / debug/
const SAMPLE = [
  { id: 'rednote_6aaa00000000000000000001', key: 'rednote/6aaa00000000000000000001', source: 'rednote', title: '示例已有笔记：美甲', author: '示例作者甲', board: '' },
  { id: 'douyin_7600000000000000101', key: 'douyin/7600000000000000101', source: 'douyin', title: '示例已有视频', author: '示例作者乙', board: '' },
];

const rnNote = (id, title, extra = {}) => Object.assign({
  note_id: id, display_title: title, type: 'normal', xsec_token: 'FAKE_XSEC_' + id.slice(-4),
  user: { nickname: '示例作者' + id.slice(-2), user_id: 'fake_user_1' }, interact_info: { liked_count: '1.2万', liked: false },
  cover: { url_default: 'http://fake-cdn.xhscdn.com/sample/' + id + '.webp', info_list: [{ image_scene: 'WB_PRV', url: 'http://cdn.example.test/sample/' + id }] },
}, extra);
const rnPage = (notes, hasMore = true) => ({ code: 0, success: true, msg: '成功', data: { notes, cursor: notes.length ? notes[notes.length - 1].note_id : '', has_more: hasMore } });
const dyAweme = (id, desc, extra = {}) => Object.assign({
  aweme_id: id, desc, aweme_type: 0, author: { nickname: '示例作者', uid: 'fakeuser002' }, statistics: { digg_count: 23456, collect_count: 10 },
  video: { cover: { url_list: ['https://fake.douyinpic.com/sample/' + id + '.heic', 'https://fake.douyinpic.com/sample/' + id + '.jpeg'] } },
}, extra);

test('分类：JS 版与 parse.py 对示例条目结果一致', () => {
  const samples = [
    { title: '示例：番茄意面食谱', author: '示例作者甲', nid: '6aaa00000000000000000001', board: '' },
    { title: '示例：秋季通勤穿搭', author: '示例作者乙', nid: '6aaa00000000000000000002', board: '' },
    { title: '示例：随便看看', author: '示例作者丙', nid: '7600000000000000101', board: '学习' },
    { title: '示例：随便看看', author: '示例作者-tech', nid: '6aaa00000000000000000003', board: '' },
    { title: '示例：随便看看', author: '示例作者丁', nid: '6aaa00000000000000000004', board: '想去' },
    { title: '示例：Cursor 做网站', author: '示例作者戊', nid: '6aaa00000000000000000005', board: '' },
  ];
  const py = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from parse import categorize, load_rules
import os
rules = load_rules(os.path.join(sys.argv[1], 'rules.example.json'))
samples = json.loads(sys.stdin.read())
json.dump([categorize(s["title"], s["author"], s["nid"], rules, s["board"]) for s in samples], sys.stdout)
`, ROOT], { input: JSON.stringify(samples), encoding: 'utf8' });
  assert.strictEqual(py.status, 0, py.stderr || py.stdout);
  const fromPy = JSON.parse(py.stdout);
  const fromJs = samples.map((s) => E.categorize(RULES, s.title, s.author, s.nid, s.board));
  assert.deepStrictEqual(fromJs, fromPy);
  assert.deepStrictEqual(fromJs, ['美食', '穿搭', '学习/职场', '科技/AI', '旅行', '科技/AI']);
});

test('RedNote 收藏接口解析', () => {
  const r = E.parsePayload('rednote', rnPage([rnNote('6aaa0000000000000000000a', '示例笔记：猫眼美甲'), rnNote('6ac000000000000000000001', '示例笔记：编程入门', { type: 'video', interact_info: { liked_count: '987' } })], false));
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.hasMore, false);
  const [a, b] = r.items;
  assert.strictEqual(a.key, 'rednote/6aaa0000000000000000000a');
  assert.match(a.url, /^https:\/\/www\.rednote\.com\/explore\/6aaa0000000000000000000a\?xsec_token=FAKE_XSEC_000a&xsec_source=pc_collect$/);
  assert.strictEqual(a.likes_num, 12000);
  assert.match(a.cover, /^https:\/\/fake-cdn\.xhscdn\.com\/sample\//);
  assert.strictEqual(a.author, '示例作者0a');
  assert.strictEqual(b.type, 'video');
  assert.strictEqual(b.likes_num, 987);
});

test('RedNote：结构变化（camelCase / 嵌套）也能找到', () => {
  const r = E.parsePayload('rednote', { data: { list: [{ noteCard: { noteId: '6ac0000000000000000000aa', displayTitle: '示例笔记：新结构', user: { nickName: '示例作者', userId: 'fake_user_2' }, cover: { urlDefault: 'https://cdn.example.test/sample/cover.jpg' }, interactInfo: { likedCount: '5' }, xsecToken: 'FAKE_XSEC_00aa' } }] } });
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].title, '示例笔记：新结构');
  assert.strictEqual(r.items[0].likes_num, 5);
});

test('RedNote：风控 / 验证码返回被识别', () => {
  assert.ok(E.parsePayload('rednote', { code: 300013, msg: '访问频次异常' }).blocked);
  assert.ok(!E.parsePayload('rednote', rnPage([])).blocked);
});

test('抖音收藏接口解析：视频 + 图文（/note/）', () => {
  const r = E.parsePayload('douyin', { status_code: 0, has_more: 1, cursor: 123, aweme_list: [
    dyAweme('7600000000000000002', '示例视频：减脂餐'),
    dyAweme('7600000000000000001', '示例图文：旅行清单', { aweme_type: 68, images: [{ url_list: ['https://fake.douyinpic.com/sample/note.webp', 'https://fake.douyinpic.com/sample/note.jpeg'] }] }),
  ] });
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.hasMore, true);
  const [v, n] = r.items;
  assert.strictEqual(v.url, 'https://www.douyin.com/video/7600000000000000002');
  assert.strictEqual(v.type, 'video');
  assert.match(v.cover, /\.jpeg$/, '应优先选 jpeg 而不是 heic');
  assert.strictEqual(v.likes, '2.3万');
  assert.strictEqual(n.url, 'https://www.douyin.com/note/7600000000000000001');
  assert.strictEqual(n.type, 'image');
  assert.match(n.cover, /note\.jpeg$/);
});

test('抖音：验证 / 异常返回', () => {
  assert.ok(E.parsePayload('douyin', { status_code: 8, status_msg: '请完成验证', verify_type: 'slide' }).blocked);
  assert.strictEqual(E.parsePayload('douyin', { status_code: 0, aweme_list: null, has_more: 0 }).items.length, 0);
});

test('乱七八糟的数据不会抛错', () => {
  for (const j of [null, 1, 'x', [], {}, { data: null }, { a: { b: { c: [1, 2, { note_id: 'bad' }] } } }]) {
    E.parsePayload('rednote', j); E.parsePayload('douyin', j);
  }
});

test('合并：新条目排最前且保持页面顺序；已有条目只打补丁；重复同步不重复添加', () => {
  const known = SAMPLE.map((i) => i.key);
  const existing = SAMPLE.find((i) => i.source === 'rednote');
  const inc1 = E.parsePayload('rednote', rnPage([
    rnNote('6ad000000000000000000002', '示例：最新收藏减脂餐一周食谱'),
    rnNote('6ad000000000000000000001', '示例：Cursor 做网站'),
    rnNote(existing.key.split('/')[1], existing.title),
  ])).items;
  const synced = [];
  const m1 = E.mergeSynced(synced, inc1, known, RULES, 1_800_000_000_000);
  assert.strictEqual(m1.added, 2);
  assert.strictEqual(m1.patched, 1);
  const [a, b, p] = synced;
  assert.ok(a.order < 0 && a.order < b.order, '最新的排在最前');
  assert.strictEqual(a.category, '美食');
  assert.strictEqual(b.category, '科技/AI');
  assert.ok(p._patch && p.key === existing.key && !('category' in p) && !('order' in p), '已有条目只写补丁');
  // 第二次同步：之前新增的变成已知，再来一条更新的
  const known2 = known.concat(m1.addedKeys);
  const inc2 = E.parsePayload('rednote', rnPage([rnNote('6ad000000000000000000003', '示例：更新的一条'), rnNote('6ad000000000000000000002', '示例：最新收藏减脂餐一周食谱')])).items;
  const m2 = E.mergeSynced(synced, inc2, known2, RULES, 1_800_000_100_000);
  assert.strictEqual(m2.added, 1);
  assert.strictEqual(synced.length, 4);
  const c = synced.find((s) => s.key === 'rednote/6ad000000000000000000003');
  assert.ok(c.order < a.order, '后一次同步的新条目排在前一次之前');
  assert.strictEqual(synced.filter((s) => s.key === 'rednote/6ad000000000000000000002').length, 1);
});

test('增量停止：连续读到 8 条本地已有就停', () => {
  const known = new Set(['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']);
  assert.strictEqual(E.shouldStopIncremental(['n1', 'n2', 'k1', 'k2', 'k3'], known, 8), false);
  assert.strictEqual(E.shouldStopIncremental(['n1', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'], known, 8), true);
  assert.strictEqual(E.shouldStopIncremental(['k1', 'k2', 'n9', 'k3', 'k4', 'k5', 'k6', 'k7'], known, 8), false);
});

test('取消收藏检测：只有到底且匹配率足够才判定', () => {
  const local = ['a', 'b', 'c', 'd', 'e'];
  assert.deepStrictEqual(E.detectRemoved(local, ['a', 'b', 'c', 'd', 'x'], true).removed, ['e']);
  assert.strictEqual(E.detectRemoved(local, ['a', 'b', 'c', 'd'], false).ok, false);
  assert.strictEqual(E.detectRemoved(local, ['a'], true).ok, false);
});

/* ---------- v1.2：防止推荐流 / 其他页面混进收藏 ---------- */

test('只认收藏接口：推荐流 / 首页 / 详情 / 合集等接口全部拒绝', () => {
  const ok = ['https://www.douyin.com/aweme/v1/web/aweme/listcollection/?device_platform=webapp&aid=6383&cursor=0&count=18',
    'https://www.douyin.com/aweme/v1/web/collects/video/list/?collects_id=1', 'https://edith.rednote.com/api/sns/web/v2/note/collect/page?num=30&cursor=&user_id=fakeuser001'];
  const bad = ['https://www.douyin.com/aweme/v1/web/tab/feed/?count=10', 'https://www.douyin.com/aweme/v1/web/module/feed/?x=1',
    'https://www.douyin.com/aweme/v1/web/mix/listcollection/?cursor=0', 'https://www.douyin.com/aweme/v1/web/aweme/favorite/?sec_user_id=FAKE_SEC_UID',
    'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=FAKE_SEC_UID', 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1',
    'https://www.douyin.com/aweme/v1/web/aweme/related/?aweme_id=1', 'https://www.douyin.com/aweme/v1/web/hot/search/list/',
    'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=a', 'https://www.douyin.com/aweme/v1/web/aweme/listcollection_fake/'];
  for (const u of ok) assert.ok(E.isFavApi(u.includes('douyin') ? 'douyin' : 'rednote', u), u);
  for (const u of bad) assert.ok(!E.isFavApi('douyin', u), u);
  for (const u of ['https://edith.rednote.com/api/sns/web/v1/homefeed', 'https://edith.rednote.com/api/sns/web/v1/feed', 'https://edith.rednote.com/api/sns/web/v1/search/notes',
    'https://edith.rednote.com/api/sns/web/v1/user_posted?num=30']) assert.ok(!E.isFavApi('rednote', u), u);
});

test('只在自己的收藏页收集', () => {
  assert.ok(E.isFavPage('douyin', 'https://www.douyin.com/user/self?showTab=favorite_collection'));
  assert.ok(E.isFavPage('douyin', 'https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection'));
  for (const u of ['https://www.douyin.com/', 'https://www.douyin.com/?recommend=1', 'https://www.douyin.com/user/self?showTab=post',
    'https://www.douyin.com/user/self?showTab=like', 'https://www.douyin.com/user/FAKE_USER_ID?showTab=favorite_collection', 'https://www.douyin.com/video/7600000000000000099',
    'https://www.douyin.com/jingxuan', 'about:blank']) assert.ok(!E.isFavPage('douyin', u), u);
  assert.ok(E.isFavPage('rednote', 'https://www.rednote.com/user/profile/fakeuser001?tab=fav&subTab=note', { uid: 'fakeuser001' }));
  assert.ok(!E.isFavPage('rednote', 'https://www.rednote.com/user/profile/otheruser?tab=fav', { uid: 'fakeuser001' }));
  assert.ok(!E.isFavPage('rednote', 'https://www.rednote.com/explore', { uid: 'fakeuser001', favTabActive: true }));
});

test('混进收藏页的推荐流条目会被丢弃，带收藏标记的保留', () => {
  const full = [];
  for (let i = 1; i <= 8; i++) {
    const id = '760000000000000020' + i;
    full.push({ key: 'douyin/' + id, nid: id, title: '示例推荐流 ' + i, author: '示例作者', cover: '' });
  }
  for (let i = 1; i <= 2; i++) {
    const id = '760000000000000030' + i;
    full.push({ key: 'douyin/' + id, nid: id, title: '示例收藏 ' + i, author: '示例作者', cover: 'https://fake.douyinpic.com/sample/kept-' + i + '.jpeg?s=PackSourceEnum_COLLECTION' });
  }
  const r = E.sanitizeItems('douyin', full, { fromDom: true });
  const kept = r.items.map((i) => i.key);
  for (const x of full.filter((x) => !x.cover)) assert.ok(!kept.includes(x.key), '应丢弃 ' + x.title);
  for (const x of full.filter((x) => /PackSourceEnum_COLLECTION/.test(x.cover || ''))) assert.ok(kept.includes(x.key), '应保留 ' + x.title);
  assert.strictEqual(r.dropped.length, 8);
});

test('推荐流接口的内容即使被解析也会因为封面来源不对被丢掉', () => {
  const feed = { status_code: 0, aweme_list: [dyAweme('7600000000000000011', '示例推荐：明星领证', { video: { cover: { url_list: ['https://fake.douyinpic.com/sample/feed.jpeg?s=PackSourceEnum_FEED'] } } }),
    dyAweme('7600000000000000012', '示例详情：课堂笔记', { video: { cover: { url_list: ['https://fake.douyinpic.com/sample/detail.jpeg?s=PackSourceEnum_AWEME_DETAIL'] } } }),
    dyAweme('7600000000000000013', '示例收藏：个人网站', { video: { cover: { url_list: ['https://fake.douyinpic.com/sample/collection.jpeg?biz_tag=pcweb_cover&s=PackSourceEnum_COLLECTION&sc=cover'] } } })] };
  const r = E.sanitizeItems('douyin', E.parsePayload('douyin', feed).items);
  assert.deepStrictEqual(r.items.map((i) => i.key), ['douyin/7600000000000000013']);
});

test('RedNote 页面卡片：只认收藏列表链接（xsec_source=pc_collect）', () => {
  const mk = (id, src) => ({ id: 'rednote_' + id, nid: id, key: 'rednote/' + id, source: 'rednote', url: 'https://www.rednote.com/explore/' + id + '?xsec_token=FAKE_XSEC_TOKEN&xsec_source=' + src });
  const r = E.sanitizeItems('rednote', [mk('6ad000000000000000000001', 'pc_collect'), mk('6ad000000000000000000002', 'pc_feed')], { fromDom: true });
  assert.deepStrictEqual(r.items.map((i) => i.nid), ['6ad000000000000000000001']);
});

test('待确认：buildBatch 不碰已知 / 已删除的；applyBatches 支持删掉、取消收藏标记、恢复', () => {
  const inc = E.parsePayload('rednote', rnPage([rnNote('6ae000000000000000000001', '示例新笔记1'), rnNote('6ae000000000000000000002', '示例新笔记2'), rnNote('6ae000000000000000000003', '示例：曾被删过')])).items;
  const b = E.buildBatch(inc, ['rednote/6ae000000000000000000002'], ['rednote/6ae000000000000000000003'], RULES, 1_800_000_000_000, { platform: 'rednote' });
  assert.deepStrictEqual(b.items.map((i) => i.key), ['rednote/6ae000000000000000000001']);
  assert.strictEqual(b.patches.length, 1);
  b.removed = ['douyin/1111111111111111111']; b.seenKeys = ['douyin/2222222222222222222'];
  const marks = { unsaved: { 'douyin/2222222222222222222': { by: 'sync' }, 'douyin/3333333333333333333': { by: 'manual' } }, kept: {} };
  const r = E.applyBatches([], marks, [b], [], 1);
  assert.strictEqual(r.added, 1); assert.strictEqual(r.removed, 1); assert.strictEqual(r.restored, 1);
  // 远端消失的只标「可能已取消」(marks.gone)，绝不自动标成已取消收藏
  assert.ok(r.marks.gone['douyin/1111111111111111111'] && !r.marks.unsaved['douyin/1111111111111111111']);
  assert.ok(!r.marks.unsaved['douyin/2222222222222222222'] && r.marks.unsaved['douyin/3333333333333333333']);
  const r2 = E.applyBatches([], { unsaved: {}, kept: {} }, [b], ['rednote/6ae000000000000000000001'], 1);
  assert.strictEqual(r2.added, 0);
  // 重复确认不会重复添加
  const r3 = E.applyBatches(r.synced, r.marks, [b], [], 2);
  assert.strictEqual(r3.added, 0);
});



test('同步合并：新条目直接进 synced 且去重；可能已取消的再次出现会自动清除标记', () => {
  const inc = E.parsePayload('douyin', { status_code: 0, aweme_list: [dyAweme('7600000000000002001', '示例：新视频甲'), dyAweme('7600000000000002002', '示例：新视频乙')], has_more: 0 }).items;
  const b1 = E.buildBatch(inc, [], [], RULES, 1_800_000_000_000, { platform: 'douyin' });
  b1.removed = ['douyin/7600000000000002999'];
  const r1 = E.applyBatches([], { unsaved: {}, kept: {} }, [b1], [], 1);
  assert.strictEqual(r1.added, 2);
  assert.deepStrictEqual(r1.synced.map((s) => s.key).sort(), ['douyin/7600000000000002001', 'douyin/7600000000000002002']);
  assert.ok(r1.marks.gone['douyin/7600000000000002999']);
  assert.ok(!r1.marks.unsaved['douyin/7600000000000002999']);
  // 同一批再合并一次不重复
  const r2 = E.applyBatches(r1.synced, r1.marks, [b1], [], 2);
  assert.strictEqual(r2.added, 0); assert.strictEqual(r2.synced.length, 2);
  // 全量同步又看到了它 → 清除「可能已取消」
  const r3 = E.applyBatches(r2.synced, r2.marks, [{ items: [], patches: [], removed: [], seenKeys: ['douyin/7600000000000002999'] }], [], 3);
  assert.ok(!r3.marks.gone['douyin/7600000000000002999']); assert.strictEqual(r3.restored, 1);
});

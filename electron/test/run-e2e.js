// 端到端测试：启动模拟站点 → 用临时 userData 跑 Electron（xvfb）→ 自动操作过期标记 + 三次同步 → 重启检查持久化
// 用法：node test/run-e2e.js   （需要 xvfb-run 和 linux 版 electron）
const path = require('path'), fs = require('fs'), os = require('os');
const { spawn } = require('child_process');
const startMock = require('./mock-sites');
const ROOT = path.join(__dirname, '..', '..');
// 1×1 占位 JPEG，不读取 covers/ 里的真实封面
const coverFile = path.join(os.tmpdir(), 'fav-sample-cover.jpg');
fs.writeFileSync(coverFile, Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA//2Q==', 'base64'));

const rnKnown = Array.from({ length: 52 }, (_, i) => {
  const id = (BigInt('0x6ab000000000000000000000') + BigInt(i)).toString(16);
  return { key: 'rednote/' + id, title: '示例已有笔记 ' + i, author: '示例作者', likes: '100' };
});
const dyKnown = Array.from({ length: 10 }, (_, i) => ({
  key: 'douyin/' + String(7600000000000001000n + BigInt(i)), title: '示例已有视频 ' + i, author: '示例作者',
}));
const BAD_DY = [
  ['7600000000000000901', '示例推荐流视频甲'],
  ['7600000000000000902', '示例推荐流视频乙'],
  ['7600000000000000903', '示例推荐流视频丙'],
];
const BAD_RN = ['fe0000000000000000000001', 'fe0000000000000000000002', 'fe0000000000000000000003'];
const BAD_KEYS = BAD_DY.map(([id]) => 'douyin/' + id).concat(BAD_RN.map((id) => 'rednote/' + id), ['douyin/7699999999999999999']);
const makeData = (rnBase, dyBase) => {
  const rnN = (id, t, author, likes) => ({ note_id: id, display_title: t, type: 'normal', xsec_token: 'FAKE_XSEC_' + id.slice(-4), user: { nickname: author || '示例作者', user_id: 'fake_user_1' },
    interact_info: { liked_count: likes || '321' }, cover: { url_default: rnBase + '/img/' + id + '.jpg' } });
  const newTitles = ['示例：一周减脂餐', '示例：用 Cursor 做网站', '示例：酒店推荐', '示例：周末去哪', '示例：猫眼美甲', '示例：面试准备', '示例：宠物护理', '示例：自动化工作流'];
  const rnNotes = newTitles.map((t, i) => rnN('6ad00000000000000000000' + i, t))
    .concat(rnKnown.map((k) => rnN(k.key.split('/')[1], k.title, k.author, k.likes)));
  const dyA = (id, desc, note) => ({ aweme_id: id, desc, aweme_type: note ? 68 : 0, author: { nickname: '示例作者', uid: 'fake_dy_user' }, statistics: { digg_count: 12345 },
    video: { cover: { url_list: [dyBase + '/img/' + id + '.jpeg?s=PackSourceEnum_COLLECTION'] } }, images: note ? [{ url_list: [dyBase + '/img/' + id + '-n.jpeg?s=PackSourceEnum_COLLECTION'] }] : undefined });
  const dyAwemes = [];
  for (let i = 0; i < 40; i++) dyAwemes.push(dyA(String(7700000000000000000n + BigInt(i)), (i % 4 === 0 ? '示例图文：旅行清单 ' : '示例视频：编程教程 ') + i, i % 4 === 0));
  // 收藏接口里混进一条封面来源是推荐流的（应被丢弃）
  const odd = dyA('7699999999999999999', '示例：封面来源是推荐流', false); odd.video.cover.url_list = [dyBase + '/img/odd.jpeg?s=PackSourceEnum_FEED']; dyAwemes.splice(5, 0, odd);
  dyKnown.forEach((k) => dyAwemes.push(dyA(k.key.split('/')[1], k.title, false)));
  const feedAwemes = BAD_DY.map(([id, t]) => ({ aweme_id: id, desc: t, aweme_type: 0, author: { nickname: '示例推荐账号', uid: 'fake_feed_user' }, statistics: { digg_count: 1 },
    video: { cover: { url_list: [dyBase + '/img/' + id + '.jpeg?s=PackSourceEnum_FEED'] } } }));
  const feedNotes = BAD_RN.map((id, i) => rnN(id, '推荐流笔记 ' + i));
  return { rnNotes, dyAwemes, feedAwemes, feedNotes };
};

(async () => {
  for (const f of ['/tmp/fav-e2e-1.json', '/tmp/fav-e2e-2.json']) try { fs.unlinkSync(f); } catch (e) {}
  const mock = await startMock({ makeData, coverFile, captchaOnPage: 2 });
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fav-ud-'));
  const electron = require('electron'); // linux binary path
  const run = (mode, out) => new Promise((resolve) => {
    const env = Object.assign({}, process.env, { FAV_SELFTEST: mode, FAV_SELFTEST_OUT: out, FAV_USERDATA: ud, FAV_SYNC_SPEED: '0.1',
      FAV_SYNC_BASE_REDNOTE: mock.rnBase, FAV_SYNC_BASE_DOUYIN: mock.dyBase, FAV_E2E_BAD_KEYS: JSON.stringify(BAD_KEYS), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' });
    const p = spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x1000x24', electron, '--no-sandbox', path.join(__dirname, '..')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; p.stdout.on('data', (d) => logs += d); p.stderr.on('data', (d) => logs += d);
    const t = setTimeout(() => { p.kill('SIGKILL'); }, +process.env.E2E_TIMEOUT || 240000);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, logs }); });
  });
  const r1 = await run('e2e', '/tmp/fav-e2e-1.json');
  const r2 = process.env.E2E_ONLY1 ? { code: 0, logs: '' } : await run('check', '/tmp/fav-e2e-2.json');
  mock.close();
  const rd = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return { missing: f }; } };
  const o1 = rd('/tmp/fav-e2e-1.json'), o2 = rd('/tmp/fav-e2e-2.json');
  fs.writeFileSync('/tmp/fav-e2e-mocklog.txt', mock.log.join('\n'));
  let applog = ''; try { applog = fs.readFileSync(path.join(ud, 'logs', 'app.log'), 'utf8'); } catch (e) {}
  console.log(JSON.stringify({ run1: o1, run2: o2, exit: [r1.code, r2.code], userData: ud }, null, 1));
  console.log('---- app.log ----\n' + applog);
  if (r1.code || r2.code || o1.missing) console.log('---- electron output ----\n' + r1.logs.slice(-3000) + '\n' + r2.logs.slice(-3000));
})();

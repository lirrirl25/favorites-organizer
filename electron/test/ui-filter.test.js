// 页面筛选回归测试：用虚构数据生成页面，在无头 Chrome 里点分类 / 来源 / 状态 / 搜索 / 卡片。
// 需要 puppeteer-core 和本机 Chrome（CHROME_PATH，默认 /usr/bin/google-chrome）；缺少时自动跳过。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
let pptr = null; try { pptr = require('puppeteer-core'); } catch (e) {}
const skip = !pptr || !fs.existsSync(CHROME) ? '需要 puppeteer-core 和 Chrome' : false;

function buildPage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favui-'));
  const items = [];
  const cats = [['示例：番茄意面食谱', 'rednote'], ['示例：秋季通勤穿搭', 'rednote'], ['示例：Cursor 做网站', 'x'], ['示例：三天旅行攻略', 'douyin'], ['示例：英语学习计划', 'douyin'], ['示例：猫咪洗澡', 'rednote']];
  cats.forEach(([t, s], i) => {
    const id = s === 'douyin' ? '76000000000000030' + String(i).padStart(2, '0') : s === 'x' ? '10000000000000030' + String(i).padStart(2, '0') : '6af0000000000000000000' + String(i).padStart(2, '0');
    const url = s === 'douyin' ? 'https://www.douyin.com/video/' + id : s === 'x' ? 'https://x.com/demo/status/' + id : 'https://www.rednote.com/explore/' + id;
    items.push(`${t} | 示例作者${i} | ${url} | ${i * 10} | image |  | `);
  });
  fs.writeFileSync(path.join(dir, 'demo.txt'), items.join('\n') + '\n');
  const py = spawnSync('python3', [path.join(ROOT, 'parse.py'), '--rules', path.join(ROOT, 'rules.example.json'), '-o', path.join(dir, 'data.json'), path.join(dir, 'demo.txt')], { encoding: 'utf8' });
  if (py.status !== 0) {
    const py2 = spawnSync('python3', [path.join(ROOT, 'parse.py'), '-o', path.join(dir, 'data.json'), path.join(dir, 'demo.txt')], { encoding: 'utf8' });
    assert.strictEqual(py2.status, 0, py2.stderr);
  }
  const b = spawnSync('python3', [path.join(ROOT, 'build.py'), path.join(dir, 'data.json'), path.join(dir, 'index.html')], { encoding: 'utf8' });
  assert.strictEqual(b.status, 0, b.stderr);
  return path.join(dir, 'index.html');
}

test('筛选：分类 / 来源 / 状态 / 搜索 / 特殊视图都能切换，卡片点击不报错', { skip }, async () => {
  const page = buildPage();
  const browser = await pptr.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const pg = await browser.newPage();
    const errors = []; pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto('file://' + page);
    const st = () => pg.evaluate(() => ({ n: window.__FAV_APP__.filtered().length, cat: window.__FAV_APP__.F.cat, view: window.__FAV_APP__.F.view, cards: document.querySelectorAll('#grid .card').length }));
    const all = await st();
    assert.strictEqual(all.n, 6);
    const cats = await pg.$$eval('#chips .chip[data-c]', (b) => b.map((x) => x.dataset.c).filter((c) => c !== '全部'));
    assert.ok(cats.length >= 3, '应该有多个分类');
    for (const c of cats) {
      await pg.click(`#chips .chip[data-c="${c}"]`);
      const s = await st();
      assert.strictEqual(s.cat, c); assert.ok(s.n >= 1 && s.n < 6, c + ' 应该只显示部分条目'); assert.strictEqual(s.cards, s.n);
      assert.strictEqual(await pg.$eval('#chips .chip.on', (x) => x.dataset.c), c);
    }
    // 进入「过期」视图后再点分类，应回到普通视图
    await pg.click('#chips .chip[data-v="expired"]');
    assert.strictEqual((await st()).view, 'expired');
    await pg.click(`#chips .chip[data-c="${cats[0]}"]`);
    const s2 = await st(); assert.strictEqual(s2.view, 'normal'); assert.ok(s2.n >= 1);
    await pg.click('#chips .chip[data-c="全部"]'); assert.strictEqual((await st()).n, 6);
    // 来源
    await pg.click('#f-source button[data-v="douyin"]'); assert.strictEqual((await st()).n, 2);
    await pg.click('#f-source button[data-v="x"]'); assert.strictEqual((await st()).n, 1);
    await pg.click('#f-source button[data-v="all"]'); assert.strictEqual((await st()).n, 6);
    // 状态
    await pg.click('#grid .card .status button[data-s="todo"]');
    await pg.click('#f-status button[data-v="todo"]'); assert.strictEqual((await st()).n, 1);
    await pg.click('#f-status button[data-v="all"]');
    // 搜索
    await pg.type('#q', '猫咪'); await new Promise((r) => setTimeout(r, 400)); assert.strictEqual((await st()).n, 1);
    // 卡片点击：拦截 window.open，确认打开的是原帖链接
    await pg.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
    await pg.click('#grid .card a.body .title');
    const opened = await pg.evaluate(() => window.__opened);
    assert.strictEqual(opened.length, 1); assert.match(opened[0], /^https:\/\/www\.rednote\.com\/explore\//);
    assert.deepStrictEqual(errors, []);
  } finally { await browser.close(); }
});

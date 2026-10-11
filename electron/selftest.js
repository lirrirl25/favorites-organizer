// 仅在 FAV_SELFTEST 设置时加载：自动操作界面，检查 userData 里的持久化，然后退出
// FAV_SELFTEST=1     旧的冒烟测试（加载 + 可选点一下状态）
// FAV_SELFTEST=e2e   过期标记 + 打开帖子 + 三次同步（配合 test/run-e2e.js 的模拟站点）
// FAV_SELFTEST=check 重启后检查持久化
const fs = require('fs');
const path = require('path');
module.exports = (win, h) => {
  const { dataDir, readJSON } = h;
  const out = process.env.FAV_SELFTEST_OUT || '/tmp/fav-selftest.json';
  const mode = process.env.FAV_SELFTEST;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 2) console.log('[renderer]', msg); });
  win.webContents.once('did-finish-load', async () => {
    const res = { mode };
    const js = (s) => win.webContents.executeJavaScript(s);
    const snap = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(out.replace(/\.json$/, '-' + name + '.png'), img.toPNG()); };
    const pageInfo = () => js(`({count:document.getElementById('count').textContent,cards:document.querySelectorAll('#grid .card').length,
      expChip:(document.querySelector('.chip[data-v="expired"] .n')||{}).textContent, unsChip:(document.querySelector('.chip[data-v="unsaved"] .n')||{}).textContent})`);
    try {
      await sleep(800);
      if (mode === 'e2e') {
        res.initial = await pageInfo();
        // ---- 过期筛选 ----
        await js(`document.querySelector('.chip[data-v="expired"]').click()`); await sleep(200);
        res.expiredView = await js(`({cards:document.querySelectorAll('#grid .card').length,
          withBadge:document.querySelectorAll('#grid .card .tag.exp-high, #grid .card .tag.exp-medium').length,
          high:document.querySelectorAll('#grid .tag.exp-high').length, medium:document.querySelectorAll('#grid .tag.exp-medium').length,
          withButtons:document.querySelectorAll('#grid .card .x-go').length, reason:(document.querySelector('#grid .reason')||{}).textContent})`);
        await snap('expired');
        res.unsavedKey = await js(`(function(){var c=document.querySelector('#grid .card');var k=c.dataset.k;c.querySelector('.x-unsave').click();return k;})()`); await sleep(200);
        res.keptKey = await js(`(function(){var c=document.querySelector('#grid .card');var k=c.dataset.k;c.querySelector('.x-keep').click();return k;})()`); await sleep(200);
        res.afterMarks = await pageInfo();
        await sleep(300);
        res.marksFile = readJSON('marks', null);
        // 默认视图里已取消的被隐藏
        await js(`document.querySelector('.chip[data-v="expired"]').click()`); await sleep(200);
        res.normalHasUnsaved = await js(`!!document.querySelector('#grid .card[data-k="${res.unsavedKey}"]')`);
        res.normalCount = (await pageInfo()).count;
        // 状态持久化
        res.todoKey = await js(`(function(){var c=document.querySelector('#grid .card');c.querySelector('.status button[data-s="todo"]').click();return c.dataset.k;})()`);
        await sleep(300);
        res.statusFile = readJSON('status', null);
        // ---- 抖音：复制链接 + 打开抖音客户端（成功 / 失败回退）----
        const { clipboard } = require('electron');
        const dyCardSel = `#grid .card[data-k^="douyin/"]`;
        await js(`(function(){document.querySelector('.chip[data-v="expired"]').click();})()`); await sleep(200);
        await js(`(function(){var s=document.querySelector('[data-v="douyin"]');})()`);
        res.dyApp = {};
        res.dyApp.expiredDouyinCards = await js(`document.querySelectorAll('${dyCardSel} .x-go').length`);
        res.dyApp.dyappButtonsInExpired = await js(`document.querySelectorAll('${dyCardSel} button.dyapp').length`);
        res.dyApp.rednoteHasDyapp = await js(`document.querySelectorAll('#grid .card[data-k^="rednote/"] button.dyapp').length`);
        clipboard.writeText('');
        process.env.FAV_FAKE_DOUYIN_PC = 'ok';
        res.dyApp.xgoKey = await js(`(function(){var c=document.querySelector('${dyCardSel}');c.querySelector('.x-go').click();return c.dataset.k;})()`);
        await sleep(600);
        res.dyApp.clipAfterXgo = clipboard.readText();
        res.dyApp.toastOk = await js(`document.getElementById('toast').textContent`);
        clipboard.writeText('');
        process.env.FAV_FAKE_DOUYIN_PC = 'fail';
        res.dyApp.dyappKey = await js(`(function(){var c=document.querySelector('${dyCardSel}');c.querySelector('button.dyapp').click();return c.dataset.k;})()`);
        await sleep(1500);
        res.dyApp.clipAfterFail = clipboard.readText();
        res.dyApp.toastFail = await js(`document.getElementById('toast').textContent`);
        res.dyApp.fallbackWindow = !!(h.syncMgr().wins.douyin && !h.syncMgr().wins.douyin.isDestroyed());
        res.dyApp.fallbackUrl = h.syncMgr().wins.douyin && h.syncMgr().wins.douyin.webContents.getURL();
        delete process.env.FAV_FAKE_DOUYIN_PC;
        // RedNote 的「去取消收藏」不变：仍然走内置浏览器
        res.dyApp.rnXgoTitle = await js(`(function(){var b=document.querySelector('#grid .card[data-k^="rednote/"] .x-go');var t=b.title;document.querySelector('.chip[data-v="expired"]').click();return t;})()`);
        // ---- 内置浏览器打开帖子（模拟站点）----
        await js(`window.favStore.openPost('rednote', ${JSON.stringify(process.env.FAV_SYNC_BASE_REDNOTE + '/explore')})`);
        await sleep(800);
        const sm = h.syncMgr();
        res.postWindowUrl = sm.wins.rednote && sm.wins.rednote.webContents.getURL();
        // ---- 同步：拦截进度，碰到验证码就“手动”点通过 ----
        const progress = [];
        const origSend = sm.send;
        sm.send = (p) => {
          progress.push(p.phase + ':' + (p.msg || '').slice(0, 60)); origSend(p);
          if (p.phase === 'captcha') setTimeout(() => { const w = sm.wins[p.platform]; if (w) w.webContents.executeJavaScript(`document.getElementById('cap-ok')&&document.getElementById('cap-ok').click()`).catch(() => {}); }, 1500);
        };
        const R = (expr) => `${expr}.then(function(r){return r&&{added:r.added,patched:r.patched,collected:r.collected,stop:r.stopReason,end:r.reachedEnd,src:r.source,covers:r.covers,stats:r.stats,pendingTotal:r.pendingTotal,removed:r.removed&&{ok:r.removed.ok,reason:r.removed.reason,n:r.removed.keys.length},err:r.error};})`;
        const BAD = JSON.parse(process.env.FAV_E2E_BAD_KEYS || '[]');
        const badIn = (keys) => keys.filter((k) => BAD.includes(k));
        const pendKeys = () => { const p = readJSON('pending', {}); return (p.batches || []).flatMap((b) => (b.items || []).map((i) => i.key)); };
        res.syncRnInc = await js(R(`window.__FAV_APP__.runSync('rednote','incremental',true)`));
        res.syncedAfterRnInc = readJSON('synced', []).length;       // 待确认：还没合并
        res.syncRnFull = await js(R(`window.__FAV_APP__.runSync('rednote','full',true)`));
        await js(`window.favStore.sync.login('douyin')`); await sleep(1500);
        res.dyLoggedInAfterLogin = (await js(`window.favStore.sync.status()`)).douyin;
        res.syncDyFull = await js(R(`window.__FAV_APP__.runSync('douyin','full',true)`));
        res.pending = { keys: pendKeys().length, bad: badIn(pendKeys()), badge: await js(`(document.querySelector('#syncbtn .pbadge')||{}).textContent`), synced: readJSON('synced', []).length };
        // ---- 待确认界面：删掉一条，然后全部加入 ----
        await js(`window.__FAV_APP__.openReview()`); await sleep(300);
        res.review = await js(`({rows:document.querySelectorAll('.rvi').length, accept:document.getElementById('rv-accept').textContent})`);
        await snap('review');
        res.rejectedKey = await js(`(function(){var r=document.querySelector('.rvi');var k=r.dataset.k;r.querySelector('.rv-x').click();return k;})()`); await sleep(200);
        res.reviewAfterX = await js(`({ex:document.querySelectorAll('.rvi.ex').length, accept:document.getElementById('rv-accept').textContent})`);
        await js(`document.getElementById('rv-accept').click()`); await sleep(1200);
        const s1 = readJSON('synced', []);
        res.afterAccept = { full: s1.filter((x) => !x._patch).length, patches: s1.filter((x) => x._patch).length, pendingLeft: pendKeys().length,
          rejected: (readJSON('pending', {}).rejected || []).includes(res.rejectedKey), hasRejected: s1.some((x) => x.key === res.rejectedKey && !x._patch),
          page: await pageInfo(), history: (readJSON('history', []) || []).length };
        // ---- 撤销上次同步 ----
        await js(`window.favStore.undoSync().then(function(){window.__FAV_APP__.reloadMerged();})`); await sleep(500);
        res.afterUndo = { synced: readJSON('synced', []).length, page: await pageInfo() };
        // 再同步一次：被删掉的那条不会再出现
        res.syncRnInc2 = await js(R(`window.__FAV_APP__.runSync('rednote','incremental',true)`));
        res.syncDyInc2 = await js(R(`window.__FAV_APP__.runSync('douyin','incremental',true)`));
        res.pending2 = { keys: pendKeys().length, hasRejected: pendKeys().includes(res.rejectedKey), bad: badIn(pendKeys()) };
        await js(`window.favStore.pending.accept([]).then(function(){window.__FAV_APP__.reloadMerged();})`); await sleep(800);
        res.finalBad = badIn(await js(`window.__FAV_APP__.items().map(function(i){return i.key;})`));
        res.progressSample = progress.filter((p, i) => i < 4 || /captcha|login|covers/.test(p) || i > progress.length - 3);
        res.captchaSeen = progress.some((p) => p.startsWith('captcha'));
        await sleep(800);
        res.afterSync = await pageInfo();
        res.firstCards = await js(`[].slice.call(document.querySelectorAll('#grid .card')).slice(0,3).map(function(c){var i=c.querySelector('img.cover-img');
          return {k:c.dataset.k,title:c.querySelector('.title').textContent,newTag:!!c.querySelector('.tag.new'),cat:c.querySelector('.tag.cat').textContent.trim(),img:i&&i.src.slice(0,8),loaded:!!(i&&i.complete&&i.naturalWidth>0)};})`);
        res.dyNoteItems = await js(`window.__FAV_APP__.items().filter(function(i){return /douyin\\.com|127\\.0\\.0\\.1/.test(i.url)&&/\\/note\\//.test(i.url)&&i.synced_at;}).length`);
        const synced = readJSON('synced', []);
        res.syncedFile = { total: synced.length, full: synced.filter((s) => !s._patch).length, patches: synced.filter((s) => s._patch).length, withLocalCover: synced.filter((s) => /^ucov:/.test(s.cover_local || '')).length };
        try { res.coverFiles = fs.readdirSync(path.join(path.dirname(dataDir()), 'covers')).length; } catch (e) { res.coverFiles = 0; }
        res.syncmeta = readJSON('syncmeta', null);
        await snap('after-sync');
      } else if (mode === 'shots') {
        win.show(); win.setSize(1300, 900); await sleep(1000);
        await js(`document.querySelector('.chip[data-v="expired"]').click()`); await sleep(1200); await snap('expired');
        await js(`window.__FAV_APP__.openSyncPanel()`); await sleep(1200); res.panelText = await js(`document.getElementById('modal').innerText.slice(0,600)`); await snap('panel');
        await js(`window.__FAV_APP__.openReview()`); await sleep(1200);
        await js(`(function(){var r=document.querySelectorAll('.rvi')[1];if(r)r.querySelector('.rv-x').click();})()`); await sleep(800); await snap('review');
      } else if (mode === 'check') {
        res.page = await pageInfo();
        res.marks = readJSON('marks', null);
        res.status = readJSON('status', null);
        res.syncedTotal = readJSON('synced', []).length;
        res.syncedShown = await js(`window.__FAV_APP__.items().filter(function(i){return i.synced_at;}).length`);
        res.unsavedHidden = await js(`(function(){var m=window.__FAV_APP__.marks();var k=Object.keys(m.unsaved)[0];return k&&!window.__FAV_APP__.filtered().some(function(i){return i.key===k;});})()`);
        res.keptNotExpired = await js(`(function(){var m=window.__FAV_APP__.marks();var k=Object.keys(m.kept)[0];var it=window.__FAV_APP__.items().find(function(i){return i.key===k;});return !!it&&!document.querySelector('#grid .card[data-k="'+k+'"] .tag.exp-high, #grid .card[data-k="'+k+'"] .tag.exp-medium');})()`);
        // 接口监听失效时的页面读取（DOM）兜底：把接口规则改成匹配不到
        fs.writeFileSync(path.join(path.dirname(dataDir()), 'sync-config.json'), JSON.stringify({ rednote: { favPatterns: ['__nomatch__'] }, douyin: { favPatterns: ['__nomatch__'] } }));
        res.domRn = await js(`window.__FAV_APP__.runSync('rednote','incremental',true).then(function(r){return r&&{added:r.added,collected:r.collected,stop:r.stopReason,src:r.source,err:r.error};})`);
        res.domDy = await js(`window.__FAV_APP__.runSync('douyin','incremental',true).then(function(r){return r&&{added:r.added,collected:r.collected,stop:r.stopReason,src:r.source,err:r.error};})`);
        const BAD = JSON.parse(process.env.FAV_E2E_BAD_KEYS || '[]');
        const pk = (readJSON('pending', {}).batches || []).flatMap((b) => (b.items || []).map((i) => i.key));
        res.domPendingBad = pk.filter((k) => BAD.includes(k));
        res.domPending = pk.length;
        await snap('restart');
      } else {
        res.page = await js(`({title:document.title,cards:document.querySelectorAll('#grid .card').length,count:document.getElementById('count').textContent,desktop:!!window.favStore})`);
        if (process.env.FAV_SELFTEST_CLICK) {
          res.clicked = await js(`(function(){var b=document.querySelector('#grid .card .status button[data-s="todo"]');var t=b.closest('.card').querySelector('.title').textContent;b.click();return t;})()`);
          await sleep(500);
        }
        res.after = readJSON('status', null);
        await snap('main');
      }
      res.dataDir = dataDir();
    } catch (e) { res.error = String(e && e.stack || e); }
    fs.writeFileSync(out, JSON.stringify(res, null, 1));
    try { await h.syncMgr().flush(); } catch (e) {}
    require('electron').app.exit(0);
  });
};

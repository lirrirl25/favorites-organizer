// 模拟 RedNote / 抖音（只用于本地测试同步流程）
// 除了正常的收藏页，还故意加了“干扰”：推荐流接口、侧栏推荐链接、没有收藏标记的卡片、页面自己调用 window.close()、
// 重定向（ERR_ABORTED）、同步中途页面被跳转到首页 —— 这些内容都不能进入收藏。
const http = require('http');
const fs = require('fs');
module.exports = function start({ makeData, coverFile, captchaOnPage = 2, noise = true }) {
  let rnNotes = [], dyAwemes = [], feedAwemes = [], feedNotes = [];
  const jpg = fs.readFileSync(coverFile);
  const log = [];
  let rnCaptchaShown = false, dyJumped = false;
  const page = (body, script) => `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:sans-serif} .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:10px}
    .note-item,li{height:300px;border:1px solid #ddd;list-style:none} img{width:100%;height:200px;object-fit:cover}
    #captcha_container{position:fixed;left:30%;top:30%;width:340px;height:220px;background:#fff;border:2px solid red;z-index:9;display:none}
    aside{position:fixed;right:0;top:0;width:200px;background:#fafafa}
  </style></head><body>${body}<script>${script}</script></body></html>`;
  const json = (res, o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  const ck = (name, v) => `${name}=${v}; Path=/; Max-Age=31536000`;
  const rn = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); log.push('rn ' + req.method + ' ' + u.pathname + u.search);
    if (u.pathname === '/explore') {
      res.setHeader('Set-Cookie', ck('web_session', 'fake_web_session_for_tests'));
      // 重定向：第一次打开会 location.replace（loadURL 返回 ERR_ABORTED，不能当成失败）
      res.end(page('<nav class="side-bar"><a href="/user/profile/fakeuser001">我</a></nav><div class="feeds">' +
        feedNotes.map((n) => `<section class="note-item"><a href="/explore/${n.note_id}?xsec_token=FAKE_XSEC_FEED&xsec_source=pc_feed"><img src="/img/sample-feed.jpg"></a><a class="title">${n.display_title}</a></section>`).join('') + '</div>',
        `if(!location.search)location.replace('/explore?channel_id=homefeed_recommend');
         fetch('/api/sns/web/v2/user/me').then(r=>r.json());
         fetch('/api/sns/web/v1/homefeed',{method:'POST'}).then(r=>r.json());`));
    } else if (u.pathname === '/api/sns/web/v2/user/me') json(res, { code: 0, data: { user_id: 'fakeuser001', nickname: '示例用户' } });
    else if (u.pathname === '/api/sns/web/v1/homefeed') json(res, { code: 0, data: { items: feedNotes.map((n) => ({ id: n.note_id, note_card: n })) } });
    else if (u.pathname.startsWith('/user/profile/fakeuser001')) {
      res.end(page(`<div class="tabs"><span class="reds-tab-item">笔记</span><span class="reds-tab-item">收藏</span></div><div class="grid" id="g"></div>
        <aside>${noise ? feedNotes.map((n) => `<a href="/explore/${n.note_id}">${n.display_title}</a>`).join('<br>') : ''}</aside>
        <div id="captcha_container">请完成下列验证 <button id="cap-ok">拖动滑块</button></div><div id="end" style="height:200px"></div>`,
        `var cursor='',loading=false,done=false;
        ${noise ? "setTimeout(function(){try{window.close();}catch(e){}},300);" : ''}
        function card(n){return '<section class="note-item"><a href="/explore/'+n.note_id+'?xsec_token='+n.xsec_token+'&xsec_source=pc_collect"><img src="'+n.cover.url_default+'"></a><div class="footer"><a class="title"><span>'+n.display_title+'</span></a><div class="author"><span class="name">'+n.user.nickname+'</span></div><span class="like-wrapper"><span class="count">'+n.interact_info.liked_count+'</span></span></div></section>';}
        function load(){if(loading||done)return;loading=true;
          fetch('/api/sns/web/v2/note/collect/page?num=30&cursor='+cursor+'&user_id=fakeuser001').then(r=>r.json()).then(j=>{loading=false;
            if(j.code!==0){document.getElementById('captcha_container').style.display='block';return;}
            j.data.notes.forEach(n=>document.getElementById('g').insertAdjacentHTML('beforeend',card(n)));cursor=j.data.cursor;
            if(!j.data.has_more){done=true;document.getElementById('end').textContent='- THE END -';}});}
        document.getElementById('cap-ok').onclick=function(){document.getElementById('captcha_container').style.display='none';load();};
        window.addEventListener('scroll',function(){var se=document.scrollingElement;if(se.scrollTop+innerHeight>se.scrollHeight-500)load();});
        load();`));
    } else if (u.pathname === '/api/sns/web/v2/note/collect/page') {
      const start = u.searchParams.get('cursor') ? rnNotes.findIndex((n) => n.note_id === u.searchParams.get('cursor')) + 1 : 0;
      const pg = Math.floor(start / 30) + 1;
      if (captchaOnPage && pg === captchaOnPage && !rnCaptchaShown) { rnCaptchaShown = true; json(res, { code: 300013, success: false, msg: '访问频次异常，请勿频繁操作' }); return; }
      const notes = rnNotes.slice(start, start + 30);
      json(res, { code: 0, success: true, data: { notes, cursor: notes.length ? notes[notes.length - 1].note_id : '', has_more: start + 30 < rnNotes.length } });
    } else if (u.pathname.startsWith('/img/')) { res.setHeader('Content-Type', 'image/jpeg'); res.end(jpg); }
    else { res.statusCode = 404; res.end('nf'); }
  });
  const dyFeedCard = (a) => `<li><a href="/video/${a.aweme_id}"><img alt="${a.desc}" src="/img/${a.aweme_id}.jpeg?s=PackSourceEnum_FEED"></a><p>${a.desc}</p></li>`;
  const dy = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); log.push('dy ' + req.method + ' ' + u.pathname + u.search);
    if (u.pathname === '/') {
      res.setHeader('Set-Cookie', ck('sessionid', 'dy_session_abcdef'));
      // 首页 = 推荐流：卡片 + 推荐接口
      res.end(page('<ul class="grid">' + feedAwemes.map(dyFeedCard).join('') + '</ul>',
        `fetch('/aweme/v1/web/tab/feed/?count=10').then(r=>r.json());fetch('/aweme/v1/web/module/feed/').then(r=>r.json());`));
    } else if (u.pathname === '/aweme/v1/web/tab/feed/' || u.pathname === '/aweme/v1/web/module/feed/' || u.pathname === '/aweme/v1/web/mix/listcollection/') {
      json(res, { status_code: 0, aweme_list: feedAwemes, has_more: 1 });
    } else if (u.pathname === '/user/self') {
      res.setHeader('Set-Cookie', ck('sessionid', 'dy_session_abcdef'));
      const jump = noise && !dyJumped;
      res.end(page(`<div id="sc" style="height:100vh;overflow-y:auto"><ul class="grid" id="g"></ul><div id="end"></div></div>
        <aside>${noise ? feedAwemes.map((a) => `<a href="/video/${a.aweme_id}">${a.desc}</a>`).join('<br>') : ''}</aside>`,
        `var cursor=0,loading=false,done=false,sc=document.getElementById('sc'),pages=0,jump=${jump};
        ${noise ? `fetch('/aweme/v1/web/mix/listcollection/?cursor=0').then(r=>r.json());fetch('/aweme/v1/web/module/feed/').then(r=>r.json());
          document.getElementById('g').insertAdjacentHTML('beforeend',${JSON.stringify(feedAwemes.slice(0, 2).map(dyFeedCard).join(''))});` : ''}
        function card(a){var note=a.aweme_type===68;var img=note?a.images[0].url_list[0]:a.video.cover.url_list[0];
          return '<li><a href="/'+(note?'note':'video')+'/'+a.aweme_id+'"><img alt="'+a.desc+'" src="'+img+'"></a><p>'+a.desc+'</p><span>'+a.statistics.digg_count+'</span></li>';}
        function load(){if(loading||done)return;loading=true;
          fetch('/aweme/v1/web/aweme/listcollection/',{method:'POST',body:'count=18&cursor='+cursor}).then(r=>r.json()).then(j=>{loading=false;pages++;
            j.aweme_list.forEach(a=>document.getElementById('g').insertAdjacentHTML('beforeend',card(a)));cursor=j.cursor;
            if(!j.has_more){done=true;document.getElementById('end').textContent='暂时没有更多了';}
            if(jump&&pages===2){jump=false;fetch('/__jumped');setTimeout(function(){location.href='/?recommend=1';},200);}});}
        sc.addEventListener('scroll',function(){if(sc.scrollTop+sc.clientHeight>sc.scrollHeight-500)load();});load();`));
    } else if (u.pathname === '/__jumped') { dyJumped = true; res.end('ok'); }
    else if (u.pathname === '/aweme/v1/web/aweme/listcollection/') {
      let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
        const cur = +(new URLSearchParams(body).get('cursor') || 0);
        const list = dyAwemes.slice(cur, cur + 18);
        json(res, { status_code: 0, aweme_list: list, cursor: cur + list.length, has_more: cur + 18 < dyAwemes.length ? 1 : 0 });
      });
    } else if (u.pathname.startsWith('/img/')) { res.setHeader('Content-Type', 'image/jpeg'); res.end(jpg); }
    else { res.statusCode = 404; res.end('nf'); }
  });
  return new Promise((resolve) => rn.listen(0, '127.0.0.1', () => dy.listen(0, '127.0.0.1', () => {
    const rnBase = 'http://127.0.0.1:' + rn.address().port, dyBase = 'http://127.0.0.1:' + dy.address().port;
    const d = makeData(rnBase, dyBase); rnNotes = d.rnNotes; dyAwemes = d.dyAwemes; feedAwemes = d.feedAwemes || []; feedNotes = d.feedNotes || [];
    resolve({ rnBase, dyBase, log, close: () => { rn.close(); dy.close(); } });
  })));
};

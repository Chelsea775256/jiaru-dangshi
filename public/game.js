/* 本回答仅供参考 · AVG 引擎 v0
   剧情 JSON 驱动，改文案不动代码；线索值 + 选择回响 + 结局图鉴 */
const $ = id => document.getElementById(id);
const state = { story:null, sceneId:1, lineIdx:0, clue:0, lastChoice:-1, typing:false, queue:[],
  coverUrl:'', lib:null };

/* ---------- 图库：场景 6 类 + 刘看山 8 个 costume ---------- */
async function lib(){ if(!state.lib) state.lib = await fetch('/assets/library.json').then(r=>r.json()); return state.lib; }
function pick(text, arr, fallbackId){
  let best = arr.find(x=>x.id===fallbackId) || arr[0], bs = 0;
  for(const it of arr){
    let s = 0;
    for(const k of it.keywords) if(text.includes(k)) s += k.length;
    if(s > bs){ bs = s; best = it; }
  }
  return best;
}

/* ---------- 分层渲染：背景层 / 立绘层 / 名牌层 ---------- */
function setBg(url, fade){
  const bg = $('bg'), nx = $('bgNext');
  if(!url){ bg.className='bg none'; bg.style.backgroundImage=''; nx.style.opacity=0; return; }
  bg.className = 'bg';
  if(!fade){ bg.style.backgroundImage = `url(${url})`; nx.style.opacity = 0; return; }
  nx.style.backgroundImage = `url(${url})`;
  nx.style.opacity = 1;
  setTimeout(()=>{ bg.style.backgroundImage = `url(${url})`; nx.style.opacity = 0; }, 950);
}
function setNameplate(role, item){
  const np = $('nameplate');
  if(!role || !item){ np.classList.remove('on'); return; }
  $('npIcon').textContent = item.icon || '';
  $('npName').textContent = role;
  $('npRole').textContent = item.label || '';
  np.classList.add('on');
}
function badge(text, sticky){
  const b = $('sceneBadge');
  if(!text){ b.classList.remove('on'); return; }
  b.textContent = text; b.classList.add('on');
  if(!sticky) setTimeout(()=>b.classList.remove('on'), 4000);
}

/* ---------- 路由 ---------- */
function show(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); $(id).classList.add('active'); }

/* ---------- 首页 ---------- */
async function loadHome(){
  const list = await fetch('/api/stories').then(r=>r.json());
  $('storyList').innerHTML = list.filter(s=>!s.id.startsWith('hot-')).map(s=>`
    <div class="story" data-id="${s.id}">
      <div class="cover"></div>
      <div class="body">
        <h3>${s.title}</h3><p>${s.source}</p>
        <div class="tags"><span class="tag">${s.template}</span><span class="tag">约 3 分钟</span><span class="tag">3 结局</span></div>
      </div>
      <div class="go">›</div>
    </div>`).join('');
  document.querySelectorAll('.story').forEach(el=>el.onclick=()=>start(el.dataset.id));
  await renderHotList();
  renderGallery();
}
async function renderHotList(){
  const hot = await fetch('/api/hot').then(r=>r.json());
  $('hotList').innerHTML = hot.items.map(it=>{
    const clickable = it.adapted || it.debate || it.title; // 任何有标题的热榜都可点：剧情/预生成辩论/实时辩论
    const tag = it.adapted ? '进入 ›' : '观点对撞 ›';
    return `
    <div class="hot-item ${clickable?'on':'off'}">
      <span class="rank">${it.rank}</span><span class="ht">${it.title}</span>
      <span class="ad ${clickable?'go':''}">${tag}</span>
    </div>`;
  }).join('');
  document.querySelectorAll('.hot-item').forEach((el,i)=>{
    el.onclick = ()=>{
      const it = hot.items[i];
      if(it.adapted) start(it.storyId);
      else startDebate(it); // 预生成辩论 或 实时LLM辩论
    };
  });
}

/* 刷新按钮逻辑 */
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.refresh-btn').forEach(btn=>{
    btn.onclick = async ()=>{
      const target = btn.dataset.target;
      btn.classList.add('spin');
      try{
        if(target === 'stories'){
          await loadHome(); // 重新加载故事列表
        } else if(target === 'hot'){
          // 调用刷新 API（会尝试拉取知乎实时数据）
          await fetch('/api/hot/refresh');
          await renderHotList();
        }
      }catch(e){ console.error('刷新失败:',e); }
      setTimeout(()=>btn.classList.remove('spin'),300);
    };
  });
});
/* 热榜实时刷新：每 60 秒自动拉取最新热榜（仅首页可见时更新，不打断用户当前操作） */
setInterval(()=>{
  const home = document.querySelector('.screen.active');
  if(home && home.id === 'home') renderHotList().catch(()=>{});
}, 60000);
function renderGallery(){
  const got = JSON.parse(localStorage.getItem('endingGallery')||'{}');
  if(!Object.keys(got).length) return;
  const names = Object.values(got).flat();
  const html = `<div class="pill ${names.length>=3?'got':''}">结局图鉴 ${names.length}/5</div>`+
    names.map(n=>`<div class="pill got">${n}</div>`).join('');
  $('gallery').innerHTML = html; $('galleryEnd').innerHTML = html;
}

/* ---------- 开始 ---------- */
async function start(id){
  const s = await fetch('/api/story/'+id).then(r=>r.json());
  state.story = s; state.sceneId = s.scenes[0].id; state.lineIdx = 0;
  state.clue = 0; state.lastChoice = -1; state.queue = []; state.coverUrl = '';
  show('play'); await renderScene();
}

/* ---------- 场景渲染 ---------- */
function scene(){ return state.story.scenes.find(x=>x.id===state.sceneId); }

async function renderScene(){
  const sc = scene();
  const L = await lib();
  /* 场景图：生成模式首屏用"为这个问题现画"的图，其余按当前幕文本的关键词匹配图库 */
  const ctx = `${state.story.title} ${state.story.source} ${sc.narration||''} ${(sc.dialogues||[]).map(d=>d.line).join(' ')}`;
  const isFirst = state.story.scenes[0].id === sc.id;

  /* 聊天记录场景：手机/微信/朋友圈类情节 → 渲染聊天界面，不用场景图 */
  const chatHit = CHAT_RE.test(ctx);
  $('chatLayer').classList.toggle('on', chatHit);
  if(chatHit){
    await renderChat(sc, L);
  }else if(isFirst && state.coverUrl){
    setBg(state.coverUrl, false);
  }else{
    setBg('/assets/' + pick(ctx, L.scenes, L.fallback.scene).file, false);
  }

  /* 立绘：聊天模式下收起（聊天界面本身就是画面主角） */
  const speaker = (sc.dialogues[0]||{}).role || '';
  const item = await charFor(speaker);
  if(item && !chatHit){ $('charImg').src = '/assets/' + item.file; $('charImg').style.display='block'; }
  else $('charImg').style.display='none';
  setNameplate(speaker && !isNarrator(speaker) ? speaker : '', item);
  $('echo').textContent=''; $('choices').innerHTML=''; $('talk').innerHTML='';
  const idx = state.story.scenes.findIndex(x=>x.id===sc.id)+1;
  $('sceneTag').textContent = `第 ${idx} 幕 / 共 ${state.story.scenes.length} 幕`;
  $('progress').textContent = `${state.story.title} · ${idx}/${state.story.scenes.length}`;
  state.queue = [];
  if(sc.narration) state.queue.push({name:'', text:sc.narration});
  (sc.dialogues||[]).forEach(d=>state.queue.push(d));
  state.lineIdx = 0; nextLine();
}
/* 立绘匹配：角色名命中 > 故事级 charMap > 当前幕上下文 > 学生兜底 */
function isNarrator(role){
  return !role || /旁白|消息|群|系统|所有人|通知/.test(role);
}
/* 聊天类情节识别：朋友圈/微信/短信/私信等手机场景 */
const CHAT_RE = /朋友圈|微信|消息|短信|聊天|私信|好友申请|点赞|群聊|对话框|聊天框|发来一条/;
async function renderChat(sc, L){
  const dlg = (sc.dialogues||[]);
  const role = (dlg[0]||{}).role || '对方';
  const item = (await charFor(role)) || L.chars.find(c=>c.id===L.fallback.char);
  const av = '/assets/' + (item ? item.file : 'char-student.png');
  $('chatAvatar').src = av;
  $('chatName').textContent = role;
  const body = $('chatBody');
  const time = (sc.narration||'').replace(/\s+/g,' ').slice(0,30);
  let html = `<div class="chat-time">${time}</div>`;
  dlg.slice(0,5).forEach(d=>{
    html += `<div class="bubble"><img src="${av}" alt=""><div class="bx">${d.line}</div></div>`;
  });
  body.innerHTML = html;
  body.scrollTop = body.scrollHeight;
}
async function charFor(role){
  if(isNarrator(role)) return null;
  const L = await lib();
  const map = (state.story && state.story.charMap) || {};
  if(map[role] && L.chars.find(c=>c.id===map[role])) return L.chars.find(c=>c.id===map[role]);
  const byName = pick(role, L.chars, '');
  if(byName && role.split('').some(ch=>role.includes(ch))) {
    // 名字里直接带身份词（如"王老师"）才信任，否则继续走上下文
    const hit = L.chars.find(c=>c.keywords.some(k=>role.includes(k)));
    if(hit) return hit;
  }
  const sc = scene();
  const ctx = `${state.story.title} ${state.story.source} ${sc?.narration||''} ${(sc?.dialogues||[]).map(d=>d.line).join(' ')}`;
  return pick(ctx, L.chars, L.fallback.char);
}

/* ---------- 打字机 ---------- */
let typeTimer=null;
async function nextLine(){
  clearInterval(typeTimer);
  if(state.lineIdx < state.queue.length){
    const l = state.queue[state.lineIdx++];
    const role = l.role || '';
    $('name').textContent = role;
    /* 说话人切换：立绘 + 名牌跟着换（旁白时保留立绘，只收起名牌；聊天模式下不显示立绘） */
    if(role){
      const chatOn = $('chatLayer').classList.contains('on');
      const item = await charFor(role);
      if(item && !chatOn){ $('charImg').src = '/assets/' + item.file; $('charImg').style.display = 'block'; }
      else $('charImg').style.display = 'none';
      setNameplate(isNarrator(role) ? '' : role, item);
    }else{
      $('nameplate').classList.remove('on');
    }
    typeText(l.line || l.text, ()=>{ $('next').style.display='block'; });
    return;
  }
  $('next').style.display='none';
  afterDialogues();
}
function typeText(str, done){
  state.typing = true; let i=0; $('text').textContent='';
  typeTimer = setInterval(()=>{
    $('text').textContent = str.slice(0,++i);
    if(i>=str.length){ clearInterval(typeTimer); state.typing=false; done&&done(); }
  }, 24);
}
$('next').onclick = ()=>{ if(!state.typing) nextLine(); };
/* 点击画面推进对话；点按钮/选项时不触发（避免选项点击冒泡导致跳句）。
   聊天界面也允许点击推进（滚轮查看记录不受影响，click 与 wheel 是两个事件） */
$('stage').onclick = (e)=>{
  if(e.target.closest('button')) return;
  if(!state.typing && $('choices').innerHTML==='') nextLine();
};

/* ---------- 实时场景生成：先出图库图，AI 画完再淡入替换 ---------- */
const sleep = ms => new Promise(s=>setTimeout(s,ms));
async function requestScene(text){
  try{
    const r = await fetch('/api/scene?text=' + encodeURIComponent(text)).then(r=>r.json());
    if(!r.ok || !r.url) return;
    state.coverUrl = r.url;
    setBg(r.url, false);
    if(r.status === 'generating' && r.taskId){
      badge('正在为这个问题画一张图…', true);
      for(let i=0;i<30;i++){
        await sleep(3000);
        const d = await fetch('/api/scene/poll?task=' + r.taskId).then(r=>r.json());
        if(d.status === 'ready'){
          state.coverUrl = d.url;
          setBg(d.url, true);                       // 交叉淡入
          badge('已为这个问题生成专属场景');
          return;
        }
        if(d.status === 'failed'){ badge(''); return; }
      }
      badge('');
    }
  }catch(e){ /* 静默失败：图库图已经在了，不影响游玩 */ }
}

/* ---------- 对话后：自由追问 / 选项 ---------- */
function afterDialogues(){
  const sc = scene();
  if(!sc) return end();
  const ft = state.story.freeTalk;
  if(ft && ft.scene === sc.id && !sc._talked && Array.isArray(ft.preset) && ft.preset.length){
    sc._talked = true;
    const box = $('talk');
    box.innerHTML = '<div class="pill">你可以追问他任何一句话</div>';
    ft.preset.forEach(p=>{
      if(!p || !p.q) return;
      const b = document.createElement('button');
      b.className='talk-q'; b.textContent = p.q;
      b.onclick = ()=>{ box.innerHTML = `<div class="talk-q" style="color:#e9ecf3">${p.a || ''}</div>
        <button class="talk-q" id="talkBack">（问完了）</button>`;
        $('talkBack').onclick = showChoice; };
      box.appendChild(b);
    });
    return;
  }
  showChoice();
}
function showChoice(){
  const sc = scene();
  /* LLM 可能漏生成 choice 或 options；兜底直接走结局，避免卡住无按钮 */
  if(!sc || !sc.choice || !Array.isArray(sc.choice.options) || !sc.choice.options.length){ return end(); }
  const box = $('choices'); box.innerHTML='';
  sc.choice.options.forEach((o,i)=>{
    if(!o || !o.text) return;
    const b = document.createElement('button');
    b.className='choice'; b.textContent = o.text;
    b.onclick = ()=>{
      state.clue += (o.weight && o.weight['线索']) || 0;
      state.lastChoice = i;
      $('choices').innerHTML='';
      $('echo').textContent = o.echo || '';
      setTimeout(async ()=>{ if(o.goto===0) return end(); state.sceneId=o.goto; await renderScene(); }, 900);
    };
    box.appendChild(b);
  });
}

/* 结局条件解析：支持"线索>=N / 线索<=N / last=摊牌|沉默|0|1|2"，可自由组合
   空 condition 返回 false（不视作"通配"），避免无 condition 的结局意外吞掉所有匹配 */
function matchCond(cond, clue, last){
  const c = String(cond || '').trim();
  if(!c) return false;
  let ok = true;
  const ge = c.match(/线索\s*>=\s*(-?\d+)/); if(ge) ok = ok && clue >= Number(ge[1]);
  const le = c.match(/线索\s*<=\s*(-?\d+)/); if(le) ok = ok && clue <= Number(le[1]);
  const eq = c.match(/线索\s*==?\s*(-?\d+)/); if(eq) ok = ok && clue === Number(eq[1]);
  const la = c.match(/last\s*=\s*([^\s&|]+)/);
  if(la){
    const v = la[1];
    if(/^(举报|摊牌|第一个|A)$/.test(v)) ok = ok && last === 0;
    else if(/^(沉默|第二个|B)$/.test(v)) ok = ok && last === 1;
    else if(/^(第三个|C)$/.test(v)) ok = ok && last === 2;
    else if(/^\d+$/.test(v)) ok = ok && last === Number(v);
  }
  return ok;
}

/* 从结局的 name/text 里识别"积极/消极"调性，用于兜底匹配 */
function endingTone(e){
  const s = `${e.name||''} ${e.text||''}`.toLowerCase();
  if(/he|好结局|圆满|光|向阳|独立|上岸|成长|释然|和解|破局|新生|浴火|逆风|光明|稳|有光|成全|收束|终章|稳了|成了|找到|走出来了|走出来了|走出来了|走出来|远方|星辰|峰|山顶|更好|转机|希望/.test(s)) return 1;
  if(/be|坏结局|虐|崩塌|坠|困在|走不出|错位|代价|失去|断|裂|失|落|困|窒|凉|寒|孤|碎|悔|悔恨|走不出|沉沦|妥协|混|阴|暗|坠落|毁灭|失控|完蛋|分裂|撕裂/.test(s)) return -1;
  return 0;
}

/* 按"线索 + last"挑最贴的结局；四层兜底：
   1) condition 严格匹配 clue & last；2) 仅匹配 clue 阈值；3) lastChoice 索引直映射；4) 用线索符号推断调性 */
function pickEnding(endings, clue, last){
  if(!Array.isArray(endings) || !endings.length) return null;
  /* 1. condition 严格匹配 */
  const strict = endings.find(e => matchCond(e.condition, clue, last));
  if(strict) return strict;
  /* 2. condition 只约束线索阈值（不管 last），挑阈值最贴近 clue 的 */
  const clueOnly = [];
  endings.forEach(e => {
    const c = String(e.condition||'');
    const hasLast = /last\s*=/.test(c);
    if(hasLast) return;
    const ge = c.match(/线索\s*>=\s*(-?\d+)/);
    const le = c.match(/线索\s*<=\s*(-?\d+)/);
    if(ge) clueOnly.push({ e, diff: Math.abs(clue - Number(ge[1])) });
    else if(le) clueOnly.push({ e, diff: Math.abs(clue - Number(le[1])) });
  });
  if(clueOnly.length){
    clueOnly.sort((a,b)=>a.diff-b.diff);
    return clueOnly[0].e;
  }
  /* 3. 【新增】lastChoice 索引直映射：如果刚好有 N 个结尾且 last 在范围内，优先对应索引 */
  if(last >= 0 && last < endings.length){
    return endings[last];
  }
  /* 4. 用线索符号推断调性（积极走 HE 类，消极走 BE 类） */
  if(clue > 0){
    const he = endings.find(e => endingTone(e) > 0);
    if(he) return he;
  }else if(clue < 0){
    const be = endings.find(e => endingTone(e) < 0);
    if(be) return be;
  }else{
    const mid = endings.find(e => endingTone(e) === 0) || endings[0];
    if(mid) return mid;
  }
  return endings[endings.length-1];
}

/* ---------- 结局 ---------- */
function end(){
  const st = state.story, clue = state.clue, last = state.lastChoice;
  let match = pickEnding(st.endings, clue, last);
  /* LLM 可能漏生成 endings；兜底一个默认结局，避免 JS 报错卡住 */
  if(!match) match = { id:'E0', name:'未完待续', text:'你在这个路口停下了脚步。', cardTail:'' };
  state.ending = match;
  $('endName').textContent = '结局 · ' + (match.name || '结局');
  $('endText').textContent = match.text || '';
  drawCard(match);
  const got = JSON.parse(localStorage.getItem('endingGallery')||'{}');
  const arr = got[st.id]||[]; if(!arr.includes(match.name)) arr.push(match.name);
  got[st.id]=arr; localStorage.setItem('endingGallery', JSON.stringify(got));
  renderGallery(); show('ending');
}

/* ---------- 结局卡（canvas，可保存） ---------- */
function drawCard(e){
  const c = $('card'), x = c.getContext('2d');
  const g = x.createLinearGradient(0,0,0,1180);
  g.addColorStop(0,'#151b28'); g.addColorStop(1,'#0a0c12');
  x.fillStyle=g; x.fillRect(0,0,750,1180);
  x.fillStyle='#6f8cff'; x.font='24px "PingFang SC",sans-serif';
  x.fillText('本回答仅供参考',60,110);
  x.fillStyle='#e9ecf3'; x.font='bold 54px "PingFang SC",sans-serif';
  x.fillText(e.name,60,220);
  x.strokeStyle='#2a3142'; x.beginPath(); x.moveTo(60,265); x.lineTo(690,265); x.stroke();
  x.fillStyle='#c9cfdd'; x.font='30px "PingFang SC",sans-serif';
  wrap(x, e.text, 60, 350, 630, 52);
  x.fillStyle='#8b93a7'; x.font='26px "PingFang SC",sans-serif';
  const y = wrap(x, e.cardTail||'', 60, 700, 630, 44);
  x.fillStyle='#5a6072'; x.font='22px "PingFang SC",sans-serif';
  x.fillText('—— 你在知乎写下的第 1 条回答',60,y+60);
  x.fillText('知乎黑客松 · 互动叙事赛道',60,1120);
}
function wrap(x,text,px,py,maxW,lh){
  let line='', y=py;
  for(const ch of text){
    if(x.measureText(line+ch).width > maxW){ x.fillText(line,px,y); line=ch; y+=lh; }
    else line+=ch;
  }
  if(line) x.fillText(line,px,y);
  return y+lh;
}
$('saveCard').onclick = ()=>{
  const a = document.createElement('a');
  a.download = `结局-${state.ending.name}.png`;
  a.href = $('card').toDataURL('image/png'); a.click();
};

/* ---------- 生成模式（异步轮询，避免网关 60s 截断） ---------- */
async function pollGenerate(taskId){
  for(let i=0;i<60;i++){
    await new Promise(r=>setTimeout(r,2000));
    const p = await fetch('/api/generate/poll?task='+taskId).then(r=>r.json());
    if(p.ready) return p;
  }
  throw new Error('生成超时，请重试');
}

$('genBtn').onclick = async ()=>{
  const t = $('genInput').value.trim();
  if(!t) return;
  const st = $('genStatus'); $('genBtn').disabled = true;
  const lines = ['正在读取这个问题下的回答…','正在判断它适合怎么演…','正在生成你的第一个选择…'];
  let i=0; const timer = setInterval(()=>{ st.textContent = lines[i++ % lines.length]; }, 1400);
  st.textContent = lines[0];
  try{
    const start = await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:t})}).then(r=>r.json());
    if(!start.taskId) throw new Error(start.error||'生成失败');
    const final = await pollGenerate(start.taskId);
    clearInterval(timer);
    if(!final.story) throw new Error(final.error||'生成失败');
    st.textContent = final.fallback ? `（已切换内置剧情库${final.error ? '：'+final.error : ''}）` : '生成完成，开始';
    state.story = final.story; state.sceneId = final.story.scenes[0].id; state.lineIdx=0;
    state.clue=0; state.lastChoice=-1; state.coverUrl='';
    show('play'); await renderScene();
    requestScene(t);          // 不阻塞：文字先玩起来，图在后面追上来
  }catch(err){
    clearInterval(timer); st.textContent = '生成失败：'+err.message+'（可重试）';
  }finally{ $('genBtn').disabled=false; }
};

/* ---------- 杂项 ---------- */
$('again').onclick = ()=>start(state.story.id);
$('backHome').onclick = ()=>{ show('home'); loadHome(); };

/* 首屏那张"知乎问题卡"：点它直接进第一个故事 */
$('feedCard').onclick = ()=>start('b-cheat');

/* ---------- 观点对撞模式（议论型热榜：正方看山 vs 反方看山，你当裁判） ----------
   策略：先尝试调用实时 LLM 生成辩论内容；失败则使用预生成的 debate 数据作为兜底 */

/* 模板兜底：当 LLM 不可用且无预生成数据时，为任意话题生成通用辩论内容 */
function templateDebate(question){
  // 从标题中提取关键词，用于生成更相关的通用观点
  const short = question.length > 20 ? question.slice(0, 20) + '…' : question;
  return {
    pro: { name: '支持方', char: 'char-goodstudent.png', lines: [
      `从积极角度看，「${short}」有其合理性和必然性`,
      `这一趋势反映了社会发展的客观需求，不应一味否定`,
      `长远来看，适度推进有利于整体利益最大化`
    ]},
    con: { name: '反对方', char: 'char-officeworker.png', lines: [
      `但问题在于，「${short}」存在不可忽视的隐患`,
      `实际执行中可能带来负面效应，需要谨慎对待`,
      `综合考虑，当前条件下不宜贸然推进`
    ]},
    outcomes: {
      pro: { name: '倾向支持', text: `关于「${question}」，我认为应该持开放态度。任何新事物都有其发展过程，关键在于如何引导和规范。从长远看，只要方向正确、措施得当，其积极作用会逐渐显现。当然，过程中也需要及时发现问题、动态调整。`, cardTail: '' },
      mid: { name: '中立看待', text: `「${question}」是一个复杂议题，不能简单用对错来评判。支持方和反对方都有各自的道理，关键在于具体情境和执行方式。建议在充分调研、广泛听取各方意见的基础上，审慎决策、稳步推进。`, cardTail: '' },
      con: { name: '倾向反对', text: `对于「${question}」，我持保留态度。虽然理论上听起来有一定道理，但现实中的风险和成本不容忽视。在相关问题得到有效解决之前，我认为应该保持警惕，不要盲目跟风。`, cardTail: '' }
    }
  };
}

async function startDebate(item){
  const d = item.debate;
  show('debate');
  $('dbQ').textContent = item.title;

  // 先尝试实时 LLM
  let realtimeData = null;
  if(!d || true){ // 始终尝试实时（即使有预生成数据也优先用实时）
    try{
      $('dbQ').textContent = item.title + ' （正在生成观点对撞…）';
      const res = await fetch('/api/debate',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({question:item.title})});
      const result = await res.json();
      if(result.realtime && result.debate){
        realtimeData = result.debate;
        console.log('辩论：使用实时 LLM 生成');
      }
    }catch(e){ console.log('辩论 LLM 失败，使用预生成数据:', e.message); }
  }

  // 使用实时数据或回退到预生成；若都没有则用模板兜底
  let final = realtimeData || d;
  if(!final) final = templateDebate(item.title); // 任何话题都能对撞，不显示空白

  $('dbQ').textContent = item.title;
  $('dbProName').textContent = final.pro.name;
  $('dbConName').textContent = final.con.name;
  $('dbProFace').src = '/assets/' + (final.pro.char || 'char-goodstudent.png');
  $('dbConFace').src = '/assets/' + (final.con.char || 'char-officeworker.png');
  const chat = $('dbChat'); chat.innerHTML = '';
  $('dbPick').innerHTML = '';
  // 三轮交替：pro / con / pro / con / pro / con
  const rounds = [];
  for(let i=0;i<3;i++){
    rounds.push({ side:'pro', text:final.pro.lines[i] });
    rounds.push({ side:'con', text:final.con.lines[i] });
  }
  let idx = 0;
  const pushRound = ()=>{
    if(idx >= rounds.length){ renderDebatePick(final); return; }
    const r = rounds[idx++];
    const b = document.createElement('div');
    b.className = 'bubble' + (r.side==='con' ? ' me' : '');
    const bx = document.createElement('div'); bx.className = 'bx'; bx.textContent = r.text;
    b.appendChild(bx); chat.appendChild(b);
    chat.scrollTop = chat.scrollHeight;
    setTimeout(pushRound, 750);
  };
  setTimeout(pushRound, 350);
}
function renderDebatePick(d){
  const box = $('dbPick'); box.innerHTML = '';
  const mk = (label, key)=>{
    const bt = document.createElement('button'); bt.className='choice db-pick-btn'; bt.textContent = label;
    bt.onclick = ()=>finishDebate(d.outcomes[key], label);
    box.appendChild(bt);
  };
  mk('我倾向正方 · '+d.pro.name, 'pro');
  mk('中立，两边各有道理', 'mid');
  mk('我倾向反方 · '+d.con.name, 'con');
}
function finishDebate(o, pickLabel){
  if(!o) o = { name:'未完待续', text:'你在这个路口停下了脚步。' };
  state.ending = o;
  $('endName').textContent = '你的立场 · ' + (o.name || '立场');
  $('endText').textContent = o.text || '';
  drawCard(o);
  show('ending');
}

$('dbBackHome').onclick = ()=>{ show('home'); loadHome(); };

loadHome();

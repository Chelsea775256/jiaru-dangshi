import http from 'node:http';
import https from 'node:https';
import { URL as NodeURL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const assetDir = path.join(publicDir, 'assets');
const genDir = path.join(assetDir, 'gen');
const config = { host: '0.0.0.0', port: Number(process.env.PORT || 4173), projectName: 'ben-huida-jin-gong-kao' };
const types = new Map([['.html','text/html; charset=utf-8'],['.css','text/css; charset=utf-8'],
  ['.js','text/javascript; charset=utf-8'],['.json','application/json; charset=utf-8'],
  ['.png','image/png'],['.jpg','image/jpeg'],['.webp','image/webp']]);

const CACHE_FILE = path.join(dataDir, 'cache.json');
const STORY_FILES = { 'b-cheat':'story-b.json', 'a-betray':'story-a.json', 'hot-132':'story-hot.json' };

const HARDCODED_WANX_KEY = '';
const HARDCODED_LLM_KEY = '';

/* ---------------- 知乎热榜 API ---------------- */
const ZHIHU_KEY_FILE = path.join(root, 'zhihu_key.local.txt');
const zhihuKey = process.env.ZHIHU_ACCESS_SECRET || (existsSync(ZHIHU_KEY_FILE) ? (await readFile(ZHIHU_KEY_FILE,'utf8')).trim() : '');

/* 热榜缓存（避免频繁调用 API） */
let hotCache = null;
let hotCacheTime = 0;
const HOT_CACHE_TTL = 10 * 60 * 1000; // 10 分钟

async function fetchZhihuHot(){
  if(!zhihuKey) { console.log('[zhihu] 未配置 key，使用静态热榜'); return null; }
  const ts = Math.floor(Date.now()/1000);
  const ep = 'https://developer.zhihu.com/api/v1/content/hot_list?Limit=10';
  try {
    const data = await new Promise((resolve, reject)=>{
      const u = new NodeURL(ep);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname:u.hostname, path:u.pathname + u.search, method:'GET',
        headers:{
          'Authorization':`Bearer ${zhihuKey}`,
          'X-Request-Timestamp':String(ts),
          'Content-Type':'application/json',
          'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Connection':'close'
        }
      }, res=>{
        let cs=[]; res.on('data',c=>cs.push(c));
        res.on('end',()=>{
          const body = Buffer.concat(cs).toString('utf8');
          if(res.statusCode>=200 && res.statusCode<300){
            try{ resolve(JSON.parse(body)); }catch(e){ reject(new Error('JSON解析失败: '+body.slice(0,80))); }
          } else { reject(new Error('HTTP '+res.statusCode)); }
        });
      }).setTimeout(12000, ()=>reject(new Error('知乎API超时'))).on('error', reject);
      req.end();
    });
    // 官方响应结构: { Code, Message, Data:{ Total, Items:[{Title,Url,ThumbnailUrl,Summary}] } }
    if(data.Code !== 0){
      console.error(`[zhihu] API 返回错误码 ${data.Code}: ${data.Message}`);
      return null;
    }
    const rawList = (data.Data && data.Data.Items) || [];
    if(!rawList.length) { console.log('[zhihu] 返回空列表'); return null; }
    // 读现有 hot.json，保留已适配/辩论标记
    let existing = { items: [] };
    try { existing = JSON.parse(await readFile(path.join(dataDir,'hot.json'),'utf8')); } catch(e){}
    const knownMap = {};
    (existing.items||[]).forEach(it => { if(it.title) knownMap[it.title] = it; });
    const items = rawList.slice(0,10).map((it,idx)=>{
      const title = it.Title || '';
      const known = knownMap[title] || {};
      return {
        rank: idx + 1, title,
        url: it.Url || '',
        summary: it.Summary || '',
        thumb: it.ThumbnailUrl || '',
        // 已知条目保留原配置；新话题默认可走实时辩论（debate=null 由前端实时生成）
        adapted: Boolean(known.adapted),
        storyId: known.storyId || '',
        template: known.template || (known.debate ? '观点对撞' : '观点对撞'),
        debate: known.debate || null
      };
    }).filter(it => it.title);
    const result = { items, fetchedAt:new Date().toISOString(), source:'zhihu_api' };
    hotCache = result; hotCacheTime = Date.now();
    // 写回 hot.json 作为新基准（保留已知条目的 debate 内容）
    const merged = { items: items.map(it=>{
      const k = knownMap[it.title];
      return k ? { ...k, rank:it.rank, url:it.url, summary:it.summary, thumb:it.thumb } : it;
    }), fetchedAt:result.fetchedAt, source:'zhihu_api' };
    writeFile(path.join(dataDir,'hot.json'), JSON.stringify(merged,null,2), 'utf8').catch(()=>{});
    console.log(`[zhihu] 拉取成功，共 ${items.length} 条热榜`);
    return result;
  } catch(e){
    console.error('[zhihu] API 调用失败，使用静态数据:', e.message);
    return null;
  }
}

/* ---------------- 通义万相：实时场景生成 ---------------- */
const WANX_BASE = 'https://ws-0zrzl9eutp3np12f.cn-beijing.maas.aliyuncs.com/api/v1';
const KEY_FILE = path.join(root, 'api_key.local.txt');
const LLM_KEY_FILE = path.join(root, 'llm_key.txt');
const LLM_KEY_FILE_LOCAL = path.join(root, 'llm_key.local.txt');
const wanxKey = process.env.WANX_API_KEY || HARDCODED_WANX_KEY || (existsSync(KEY_FILE) ? (await readFile(KEY_FILE,'utf8')).trim() : '');
const wanxEnabled = Boolean(wanxKey);

/* 读取 LLM key：优先环境变量 > llm_key.txt（可部署）> llm_key.local.txt（仅本地） */
async function readLLMKey(){
  return process.env.LLM_API_KEY || HARDCODED_LLM_KEY ||
    (existsSync(LLM_KEY_FILE) ? (await readFile(LLM_KEY_FILE,'utf8')).trim() : '') ||
    (existsSync(LLM_KEY_FILE_LOCAL) ? (await readFile(LLM_KEY_FILE_LOCAL,'utf8')).trim() : '');
}

/* 每种场景类型的结构描述 —— 正确性优先：布局逐条写死，杜绝 AI 自由发挥导致的结构错误 */
const SCENE_PROMPT = {
  classroom: '中国大学教室内部，画面最前方正中是黑板，黑板前有讲台，课桌椅成排整齐排列全部朝向黑板，两侧有过道，教室结构正确合理，简单透视',
  dorm: '中国大学宿舍内景，视点从房门望向室内，房间左右两侧沿墙各放两组上床下桌组合床，每组上层是单人床铺带护栏，下层正对过道的是书桌和椅子，中间一条过道，房间尽头有一扇门',
  office: '现代办公室内景，多张工位成排摆放，每张工位有电脑显示器和办公椅，工位之间有隔断，远处有会议室玻璃墙和文件柜',
  livingroom: '普通人家客厅，有一张沙发和茶几，旁边有落地灯和书架，墙上有一台电视，靠近窗户的位置有绿植',
  street: '城市街道场景，有斑马线、行道树、路灯，沿街有商铺和居民楼，天空留白',
  rooftop: '居民楼天台，地面平坦铺着水泥，四周有一圈齐腰高的护栏围墙，天台上有几个空调外机和一根晾衣杆，远处可以看见城市楼群的天际线轮廓，天空大面积留白',
  hospital: '中国医院病房内景，房间左右两侧沿墙各放两张病床，每张病床旁有床头柜和带轮子的输液架，病床头有床头牌，房间尽头是护士站柜台和一扇门，天花板有长方形日光灯管，地面平整',
  cafe: '街边咖啡店内景，画面左侧是吧台柜台，柜台后有咖啡机和写着菜单的小黑板，柜台前有两三张圆形小桌，每张桌上有一杯咖啡和一把椅子，右侧是落地玻璃窗和一扇门，窗外有一条街道'
};

const MOODS = [['深夜','深夜'],['凌晨','深夜'],['夜晚','夜晚'],['晚上','夜晚'],['夜里','夜晚'],
  ['清晨','清晨'],['早上','清晨'],['黄昏','黄昏'],['傍晚','黄昏'],['下雨','雨天'],['雨天','雨天']];

function detectMood(text){
  for(const [k,v] of MOODS) if(text.includes(k)) return v + '的';
  return '';
}
const tasks = new Map();          // taskId -> {key, sceneId, done, url}
const inFlight = new Set();       // 正在生成的 cacheKey，去重
const MAX_CONCURRENT = 2;

function wanxPost(p, body){
  return fetch(WANX_BASE + p, {
    method:'POST',
    headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${wanxKey}`, 'X-DashScope-Async':'enable' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  }).then(r=>r.json());
}
function wanxGet(p){
  return fetch(WANX_BASE + p, { headers:{ Authorization:`Bearer ${wanxKey}` }, signal: AbortSignal.timeout(20000) })
    .then(r=>r.json());
}
async function download(url, dest){
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if(!r.ok) throw new Error('download failed ' + r.status);
  await writeFile(dest, Buffer.from(await r.arrayBuffer()));
}
/* 提交任务后在后台轮询，完成后落盘到 assets/gen/{key}.png —— OSS 链接会过期，必须立刻本地化 */
async function runGenerate(taskId, cacheKey, sceneId, mood){
  try{
    const prompt = `${detectMood(mood)}简笔线稿示意图，${SCENE_PROMPT[sceneId] || SCENE_PROMPT.classroom}，干净的黑色细线条，轻微手绘抖动感，纯白背景，无上色无阴影无灰度，极简，无人物，横版构图`;
    const res = await wanxPost('/services/aigc/text2image/image-synthesis', {
      model:'wanx2.0-t2i-turbo',
      input:{ prompt },
      parameters:{ size:'1280*720', n:1 }
    });
    if(!res.output?.task_id) throw new Error('no task_id');
    const tid = res.output.task_id;
    let done = false, url = '';
    for(let i=0;i<40 && !done;i++){
      await new Promise(r=>setTimeout(r,3000));
      const st = await wanxGet(`/tasks/${tid}`);
      if(st.output?.task_status==='SUCCEEDED'){
        done = true; url = st.output.results?.[0]?.url || '';
      }else if(st.output?.task_status==='FAILED'){
        throw new Error(st.output.message || 'gen failed');
      }
    }
    if(!url) throw new Error('timeout');
    await download(url, path.join(genDir, cacheKey + '.png'));
    tasks.set(taskId, { done:true, ok:true, url:`/assets/gen/${cacheKey}.png` });
  }catch(e){
    tasks.set(taskId, { done:true, ok:false, error:e.message });
  } finally {
    inFlight.delete(cacheKey);
  }
}

const readJson = async f => JSON.parse(await readFile(f, 'utf8'));

const llmTasks = new Map();   // taskId -> {done, story, error, fallback}

/* 后台跑豆包 LLM；部署沙箱网关 60s 会截断，所以做成异步任务 */
async function runLLMGenerate(taskId, text){
  const key = await readLLMKey();
  const base = (process.env.LLM_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/,'');
  const model = process.env.LLM_MODEL || 'doubao-seed-2-1-pro-260628';

  const fallback = async () => {
    const cache = await readJson(CACHE_FILE);
    const hit = cache.stories.find(s => s.keywords.some(k => text.includes(k)));
    // 有关键词匹配则用匹配项，否则随机选一个（避免永远是同一个故事）
    const story = hit || cache.stories[Math.floor(Math.random() * cache.stories.length)];
    return { story, fallback:true };
  };

  if(!key){
    llmTasks.set(taskId, { done:true, ...(await fallback()) });
    return;
  }

  const sys = '把用户输入的知乎问题改编为当事人扮演型互动剧。只输出 JSON，不要 markdown。' +
    'JSON: {"title":"标题","source":"原问题","hook":"开场",' +
    '"scenes":[{"id":1,"narration":"场景","dialogues":[{"role":"名","line":"台词"}],' +
    '"choice":{"prompt":"提示","options":[{"text":"A（主动/面对→HE向）","goto":2,"weight":{"线索":1},"echo":"选A后的正向反馈文案"},{"text":"B（回避/妥协→BE向）","goto":3,"weight":{"线索":-1},"echo":"选B后的消极反馈文案"}]}},' +
    '{"id":2,...},{"id":3,...}],' +
    '"endings":[{"id":"E1","name":"好结局名（如：破局/上岸/释然）","condition":"线索>0 && last=0","text":"100-150字HE正文，必须与选项A的主动 facing 方向一致","cardTail":"你当时没有——"},{"id":"E2","name":"坏结局名（如：泥潭/困局/代价）","condition":"线索<0 && last=1","text":"100-150字BE正文，必须与选项B的回避方向一致","cardTail":""},{"id":"E3","name":"普通结局名","condition":"last>=0","text":"50字中性结局","cardTail":""}]}' +
    '核心规则：\n' +
    '1. 选项A=主动/面对/积极行动→给+1线索→走向HE（E1条件 线索>0 && last=0）\n' +
    '2. 选项B=回避/妥协/消极应对→给-1线索→走向BE（E2条件 线索<0 && last=1）\n' +
    '3. E3是安全兜底，任何情况都能接住\n' +
    '4. 【关键】每个选项的echo文案调性必须与它导向的结局一致！A的echo要让人感到希望，B的echo要让人感到不安或遗憾\n' +
    '5. 忠于原问题，3幕2选择点，人物≤3，台词≤30字。';
  const payload = JSON.stringify({ model, temperature:0.85, max_tokens:1500, thinking:{type:'disabled'},
    messages:[{role:'system',content:sys},{role:'user',content:`输入内容：${text.slice(0,4000)}`}] });
  const u = new NodeURL(base + '/chat/completions');
  let lastErr;
  for(let attempt=1; attempt<=2; attempt++){
    try{
      const data = await new Promise((resolve, reject)=>{
        const lib = u.protocol === 'http:' ? http : https;
        const r = lib.request({
          hostname:u.hostname, port:u.port || 443, path:u.pathname, method:'POST',
          headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${key}`,
            'Content-Length':Buffer.byteLength(payload), 'Connection':'close' }
        }, res=>{
          let cs=[]; res.on('data',c=>cs.push(c));
          res.on('end',()=>{
            const body = Buffer.concat(cs).toString('utf8');
            if(res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP '+res.statusCode+' '+body.slice(0,200)));
            try{ resolve(JSON.parse(body)); }catch(e){ reject(new Error('JSON parse '+body.slice(0,200))); }
          });
        });
        const to = attempt === 1 ? 55000 : 70000;
        r.setTimeout(to, ()=>{ r.destroy(new Error('https timeout '+to+'ms')); });
        r.on('error', reject);
        r.write(payload); r.end();
      });
      if(!data.choices?.[0]?.message?.content) throw new Error('empty content');
      let content = data.choices[0].message.content.replace(/```json?/g,'').replace(/```/g,'').trim();
      const story = JSON.parse(content);
      if(!story.scenes?.length) throw new Error('empty scenes');
      llmTasks.set(taskId, { done:true, story, fallback:false });
      return;
    }catch(e){ lastErr = e; console.error('LLM生成第'+attempt+'次失败:', e.message || e); }
  }
  console.error('LLM生成失败最终:', lastErr?.message);
  llmTasks.set(taskId, { done:true, ...(await fallback()) });
}

/* 把 LLM 返回的 debate 对象规整为前端所需结构（缺字段补默认，避免崩溃）
   立绘锁定：正方=char-goodstudent.png / 反方=char-officeworker.png（仅用 game/新的看山立绘） */
function normalizeDebate(d){
  if(!d || typeof d!=='object') return null;
  const PRO_CHAR = 'char-goodstudent.png';
  const CON_CHAR = 'char-officeworker.png';
  const side = (obj, name, char) => ({
    name: (obj && obj.name) || name,
    char,
    lines: Array.isArray(obj?.lines) ? obj.lines.slice(0,3).map(String) : ['（暂无观点）','（暂无观点）','（暂无观点）']
  });
  const outcomes = d.outcomes && typeof d.outcomes==='object' ? d.outcomes : {};
  const mkOutcome = (key,name) => {
    const o = outcomes[key] || {};
    return { name: o.name||name, text: o.text || '（观点生成中…）', cardTail: o.cardTail||'' };
  };
  return {
    pro: side(d.pro, '正方', PRO_CHAR),
    con: side(d.con, '反方', CON_CHAR),
    outcomes: { pro: mkOutcome('pro','正方胜'), mid: mkOutcome('mid','折中'), con: mkOutcome('con','反方胜') }
  };
}

/* 实时辩论生成（抽自 /api/debate，供前端与热榜预热共用）：调用 LLM 生成正反方观点，失败返回 null */
async function generateDebate(question){
  const key = await readLLMKey();
  if(!key) return null;
  try{
    const base = (process.env.LLM_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/,'');
    const model = process.env.LLM_MODEL || 'doubao-seed-2-1-pro-260628';
    const SYS1 = `你是一个中立辩论引擎。针对用户给出的议论型话题，生成正反双方各3轮观点交锋 + 3种立场的"知乎回答体"结局。
只输出JSON，不要markdown。格式：
{"pro":{"name":"正方立场名","lines":["正方第1轮观点(30字内)","正方第2轮","正方第3轮"]},"con":{"name":"反方立场名","lines":["反方第1轮观点(30字内)","反方第2轮","反方第3轮"]},"outcomes":{"pro":{"name":"正方胜","text":"站在正方角度写的知乎回答体结论(100-150字)"},"con":{"name":"反方胜","text":"..."},"mid":{"name":"折中","text":"..."}}}
规则：正反方观点要有具体论据和数据感，不要空洞；结局卡要像真的知乎高赞回答，有个人视角和思考深度。char字段由系统自动填充，不要在JSON里写char。`;
    const SYS2 = `你是严格的JSON生成器。用户给一个议论型话题，你必须只输出一个合法JSON对象，禁止任何解释文字、禁止markdown代码块。
JSON结构：{"pro":{"name":String,"lines":[String,String,String]},"con":{"name":String,"lines":[String,String,String]},"outcomes":{"pro":{"name":String,"text":String},"con":{"name":String,"text":String},"mid":{"name":String,"text":String}}}
只输出这一个JSON，不要括号外任何字符。`;
    const callLLM = async (sysPrompt) => {
      const pbody = JSON.stringify({ model, temperature:0.85, max_tokens:1200, thinking:{type:'disabled'},
        messages:[{role:'system',content:sysPrompt},{role:'user',content:`话题：${question}`}] });
      const u = new NodeURL(base + '/chat/completions');
      const data = await new Promise((resolve,reject)=>{
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request({
          hostname:u.hostname, port:u.port||443, path:u.pathname, method:'POST',
          headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${key}`,
            'Content-Length':Buffer.byteLength(pbody), 'Connection':'close' }
        }, res=>{
          let cs=[]; res.on('data',c=>cs.push(c));
          res.on('end',()=>{
            const b=Buffer.concat(cs).toString('utf8');
            if(res.statusCode<200||res.statusCode>=300) return reject(new Error('HTTP '+res.statusCode));
            try{ resolve(JSON.parse(b)); }catch(e){ reject(e); }
          });
        }).setTimeout(30000, ()=>req.destroy(new Error('debate llm timeout')));
        req.on('error', reject);
        req.write(pbody); req.end();
      });
      let content = data.choices?.[0]?.message?.content||'';
      content = content.replace(/```json?/g,'').replace(/```/g,'').trim();
      const s = content.indexOf('{'); const e = content.lastIndexOf('}');
      if(s>=0 && e>s) content = content.slice(s, e+1);
      let debate = null;
      try { debate = JSON.parse(content); }
      catch(_){
        try {
          const fixed = content
            .replace(/'([^']*)'/g,'"$1"')
            .replace(/([\{,]\s*)(\w+)(\s*:)/g,'$1"$2"$3');
          debate = JSON.parse(fixed);
        } catch(_){ debate = null; }
      }
      return debate;
    };
    let raw = await callLLM(SYS1);
    if(!raw) raw = await callLLM(SYS2);
    return normalizeDebate(raw) || null;
  }catch(e){ console.error('辩论LLM失败:', e.message); return null; }
}

/* 热榜预热：每次热榜刷新后，为新出现且尚无辩论内容的话题自动生成辩论并写回 hot.json（去重，每个话题仅一次）
   默认关闭（省 LLM 额度）：需显式设 ZHIHU_HOT_WARMUP=1 才开启；设 0 或不设均为关闭 */
const warmedHot = new Set();
async function warmupHotDebates(){
  if(process.env.ZHIHU_HOT_WARMUP !== '1') return;
  try{
    const hot = JSON.parse(await readFile(path.join(dataDir,'hot.json'),'utf8'));
    for(const it of (hot.items||[])){
      if(it.debate || warmedHot.has(it.title)) continue;
      warmedHot.add(it.title);
      generateDebate(it.title).then(deb=>{
        if(!deb) return;
        (async()=>{
          try{
            const h = JSON.parse(await readFile(path.join(dataDir,'hot.json'),'utf8'));
            const t = (h.items||[]).find(x=>x.title===it.title);
            if(t){ t.debate = deb; await writeFile(path.join(dataDir,'hot.json'), JSON.stringify(h,null,2),'utf8'); console.log('[zhihu] 预热辩论成功:', it.title.slice(0,16)); }
          }catch(_){}
        })();
      }).catch(()=>{});
    }
  }catch(e){}
}

/* 生成模式：立刻返回 taskId，后台跑豆包，前端轮询 /api/generate/poll */
function generate(text){
  const taskId = crypto.randomUUID();
  llmTasks.set(taskId, { done:false });
  runLLMGenerate(taskId, text);
  return { taskId };
}

/* 关键词打分（与前端共用 library.json 的 keywords） */
function pickByKeywords(text, lib, fallbackId){
  let best = fallbackId, bestScore = 0;
  for(const item of lib){
    let score = 0;
    for(const k of item.keywords) if(text.includes(k)) score += k.length;   // 长词权重高
    if(score > bestScore){ bestScore = score; best = item.id; }
  }
  return best;
}

function json(res, status, obj){
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store, no-cache, must-revalidate' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req,res)=>{
  const url = new URL(req.url, `http://${config.host}:${config.port}`);
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  if(req.method==='OPTIONS') return res.writeHead(204).end();

  if(req.method==='GET' && url.pathname==='/api/health')
    return json(res,200,{ ok:true, project:config.projectName, oauthEnabled:false,
      llmConfigured: Boolean(await readLLMKey()),
      zhihuApi: Boolean(process.env.ZHIHU_ACCESS_SECRET),
      wanxEnabled });
  if(req.method==='GET' && url.pathname==='/api/stories'){
    const out = [];
    const seen = new Set();
    for(const [id,f] of Object.entries(STORY_FILES)){
      const s = await readJson(path.join(dataDir,f));
      out.push({ id, title:s.title, source:s.source, template:s.template });
      seen.add(id);
    }
    const c = await readJson(CACHE_FILE);
    c.stories.forEach(s=>{
      if(!seen.has(s.id)){
        out.push({ id:s.id, title:s.title, source:s.source, template:'生成模式' });
        seen.add(s.id);
      }
    });
    return json(res,200,out);
  }
  // 热榜只读静态缓存，不消耗每日 100 次的接口额度
  if(req.method==='GET' && url.pathname==='/api/hot'){
    const hot = await readJson(path.join(dataDir,'hot.json'));
    return json(res,200,hot);
  }
  if(req.method==='GET' && url.pathname.startsWith('/api/story/')){
    const id = url.pathname.split('/').pop();
    if(STORY_FILES[id]) return json(res,200, await readJson(path.join(dataDir,STORY_FILES[id])));
    const c = await readJson(CACHE_FILE);
    const hit = c.stories.find(s=>s.id===id);
    return hit ? json(res,200,hit) : json(res,404,{ error:'NOT_FOUND' });
  }

  /* 场景图：先看本地缓存 → 命中直接返回；未命中返回库图 + 后台起万相任务 */
  if(req.method==='GET' && url.pathname==='/api/scene'){
    const text = String(url.searchParams.get('text') || '').slice(0,2000);
    const lib = await readJson(path.join(assetDir,'library.json'));
    const sceneId = pickByKeywords(text, lib.scenes, lib.fallback.scene);
    const libItem = lib.scenes.find(s=>s.id===sceneId);
    const fallbackUrl = '/assets/' + libItem.file;
    if(!wanxEnabled || !text) return json(res,200,{ ok:true, sceneId, status:'static', url:fallbackUrl, label:libItem.label });
    const cacheKey = crypto.createHash('md5').update(`${sceneId}|${detectMood(text)}|${text}`).digest('hex').slice(0,16);
    const cached = path.join(genDir, cacheKey + '.png');
    if(existsSync(cached))
      return json(res,200,{ ok:true, sceneId, status:'ready', url:`/assets/gen/${cacheKey}.png`,
        label:libItem.label, taskId:'' });
    if(inFlight.has(cacheKey))
      return json(res,200,{ ok:true, sceneId, status:'generating', url:fallbackUrl,
        label:libItem.label, taskId:'' });
    if(inFlight.size >= MAX_CONCURRENT)
      return json(res,200,{ ok:true, sceneId, status:'busy', url:fallbackUrl,
        label:libItem.label, taskId:'' });
    const taskId = crypto.randomUUID();
    inFlight.add(cacheKey);
    runGenerate(taskId, cacheKey, sceneId, text);       // 不 await，异步跑
    return json(res,200,{ ok:true, sceneId, status:'generating', url:fallbackUrl,
      label:libItem.label, taskId });
  }
  if(req.method==='GET' && url.pathname==='/api/scene/poll'){
    const taskId = url.searchParams.get('task');
    const t = tasks.get(taskId);
    if(!t) return json(res,200,{ ready:false });
    return json(res,200,{ ready:t.done, ok:t.ok, url:t.url || '', error:t.error || '' });
  }

  if(req.method==='POST' && url.pathname==='/api/generate'){
    let body = '';
    for await(const chunk of req) body += chunk;
    let payload = {};
    try{ payload = JSON.parse(body); }catch(_){}
    const result = generate(String(payload.text || '').slice(0,4000));
    return json(res,200, result);
  }
  if(req.method==='GET' && url.pathname==='/api/generate/poll'){
    const taskId = url.searchParams.get('task');
    const task = llmTasks.get(taskId);
    if(!task) return json(res,200,{ ready:false });
    return json(res,200,{
      ready: task.done,
      story: task.story || null,
      fallback: task.fallback || false,
      error: task.error || ''
    });
  }

  /* 热榜刷新：优先调知乎 API，失败则返回静态 hot.json */
  if(req.method==='GET' && url.pathname==='/api/hot/refresh'){
    // 如果缓存未过期，直接返回缓存
    if(hotCache && (Date.now() - hotCacheTime < HOT_CACHE_TTL))
      return json(res,200,hotCache);
    const fresh = await fetchZhihuHot();
    return json(res,200,fresh || await readJson(path.join(dataDir,'hot.json')));
  }

  /* 实时辩论：调用 LLM 生成正方/反方观点，失败则前端用预生成兜底 */
  if(req.method==='POST' && url.pathname==='/api/debate'){
    let body = '';
    for await(const chunk of req) body += chunk;
    let payload = {};
    try{ payload = JSON.parse(body); }catch(_){}
    const question = String(payload.question || '').slice(0,500);
    if(!question) return json(res,400,{ error:'missing question' });
    const debate = await generateDebate(question);
    if(!debate) return json(res,200,{ realtime:false, debate:null, error:'no_llm_or_unparseable' });
    return json(res,200,{ realtime:true, debate, error:null });
  }

  /* 静态文件服务 */
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const safe = path.normalize(path.join(publicDir, file));
  if(!safe.startsWith(publicDir)) return json(res,403,{ error:'FORBIDDEN' });
  const target = existsSync(safe) && (await readFile(safe)).length ? safe : path.join(publicDir,'index.html');
  const ext = path.extname(target);
  res.writeHead(200, { 'Content-Type': types.get(ext) || 'application/octet-stream',
    'Cache-Control':'no-store, no-cache, must-revalidate' });
  res.end(await readFile(target));
});

await mkdir(genDir, { recursive:true });
server.listen(config.port, config.host, ()=>{
  process.stdout.write(`本回答仅供参考 → http://${config.host}:${config.port}/\n`);
  process.stdout.write(`实时场景生成：${wanxEnabled ? '已启用（通义万相 wanx2.0-t2i-turbo）' : '未启用（缺 api_key.local.txt，仅用图库）'}\n`);
  /* 实时热榜刷新服务：启动预热一次 + 定时刷新（间隔=HOT_CACHE_TTL，避免频繁消耗知乎额度） */
  console.log(`[zhihu] 热榜定时刷新服务已启用，间隔 ${HOT_CACHE_TTL/1000}s`);
  fetchZhihuHot().then(warmupHotDebates).catch(e=>console.error('[zhihu] 启动预热失败:', e.message));
  setInterval(()=>{
    fetchZhihuHot().then(warmupHotDebates).catch(e=>console.error('[zhihu] 定时刷新热榜失败:', e.message));
  }, HOT_CACHE_TTL);
});
for(const s of ['SIGINT','SIGTERM']) process.on(s, ()=>server.close(()=>process.exit(0)));

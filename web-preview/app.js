/* Vitals · 生息 — 生物样本动态管理库
   核心逻辑：数据管理 / 条形码 / 串口连接 / 实时图表 / 打印 */
'use strict';

/* ==================== 构建指纹 ==================== */
// 构建指纹：每次更新递增，用于核对界面实际加载的代码是否为新版（若非新版则说明入口缓存）
const BUILD = 'v25-1009';

/* ==================== 工具 ==================== */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
/*$   → 找一个元素  $$  → 找一组元素*/
const uid = () => 'SB-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2,5).toUpperCase();
/*SB- + 时间戳36进制 + 3位随机字符*/
/*esc():在把用户输入拼进 innerHTML 时，对特殊 HTML 字符进行转义，降低 XSS 风险。*/
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const FMT = {
  now() { const d=new Date(); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; },
  time(s){ if(!s) return '—'; const t=s.replace('T',' '); return t.includes(':')?(t.length<=16?t:t.slice(0,16)):t; }
};
/*FMT.now()当前时间，并格式化成 YYYY-MM-DD HH:mm
FMT.time(s): 整理已有时间字符串*/

/* ==================== 存储 ==================== */
let state = Store.load();
// 迁移：旧数据补齐入库状态
Object.values(state.s.samples||{}).forEach(x => { if(!x.status) x.status = 'in'; });
// 迁移：补齐二维码快照（二维码内容在创建时冻结；老样本补一次并持久化）
let qrBackfilled = false;
Object.values(state.s.samples||{}).forEach(x => {
  if(!x.qrSnap && x.id){ x.qrSnap = sampleInfoCard(x); qrBackfilled = true; }
});
if(qrBackfilled) Store.save(state);
recomputeStats();

/* ==================== 状态汇总 ==================== */
function recomputeStats(){
  const s = state.s;
  const samp = Object.values(s.samples);
  s.total = samp.length; /*样本总数*/
  s.active = samp.filter(x => x.monitor).length;/*开始检测的样本数*/
  s.alert = samp.filter(x => x.alert==='warn' || x.alert==='bad').length;/*异常样本数*/
  s.online = s.online || 0;/*在线数量*/
}

/* ==================== 首次运行示例数据 ====================（后续自己录入数据可以删除） */
function seedIfNew(){
  if(state.s.samplesSeeded) return;
  // 已有真实样本则不再注入示例数据（标记已种子，避免覆盖用户数据）
  if(Object.keys(state.s.samples||{}).length > 0){ state.s.samplesSeeded = true; saveAll(); return; }
  state.s.samplesSeeded = true;
  const now = Date.now();
  const mk = (i, temp, name, type, loc, alert) => ({
    id: 'SB-' + (10000+i),
    name, code: 'SB-' + (90000+i), type, loc,
    timeRaw:'', timeTxt: FMT.now(), temp,
    note:'示例数据（可删除）', photo:null,
    createdAt: now+i, updatedAt: now+i,
    monitor: i < 2, lastTemp: temp, alert: alert||'good', lastUpdate: null, status:'in'
  });
  state.s.samples['SB-10000'] = mk(0, 5.2, '血清样本-01', '血清', 'A-01-03', 'good');
  state.s.samples['SB-10001'] = mk(1, -78.5, 'DNA样本-02', 'DNA', 'B-02-01', 'warn');
  state.s.samples['SB-10002'] = mk(2, 4.1, '全血样本-03', '全血', 'C-01-02', 'good');
  // 每个样本生成 20 点演示环境历史（围绕其采集温度波动）
  Object.values(state.s.samples).forEach(s => {
    if(!s.qrSnap) s.qrSnap = sampleInfoCard(s);
    if(!s.env) s.env = [];
    const base = s.temp != null ? s.temp : 4;
    for(let k=0;k<20;k++){
      s.env.push({ time:'', temp: +(base + Math.sin(k/3)*2 + (Math.random()*2-1)).toFixed(2) });
    }
  });
  // 注入示例记录
  state.rec.push({ time: FMT.now(), sample:'系统', type:'初始化', detail:'已载入 3 个示例样本用于演示（可在设置中清空）', ...recordMeta('初始化','system') });
  saveAll();
}

/* ==================== 记录 ====================
   输入addRecord('血清样本-01', '入库', '存放至 A-01-03');
   创建一条记录;插入state.rec 最前面;调用saveAll()保存
   同时写入原生 records 的 source / type_code 三列（source 受 CHECK 约束，type_code 供分页筛选）。 */
/* 与原生 records.source CHECK IN ('manual','hardware','scanner','system') 完全一致 */
const RECORD_SOURCES = Object.freeze({manual:'manual', hardware:'hardware', scanner:'scanner', system:'system'});
/* 中文动作 → 英文 type_code（下拉筛选用同一套枚举） */
const RECORD_TYPE_CODES = Object.freeze({
  '录入':'create','编辑':'edit','删除':'delete','入库':'in','出库':'out','槽位绑定':'bind',
  '任务取消':'cancel','任务状态':'task','初始化':'system','系统':'system',
  '告警':'alert','恢复':'recover','连接':'connect','断开':'disconnect'
});
const RECORD_TYPE_LABELS = Object.freeze(Object.fromEntries(Object.entries(RECORD_TYPE_CODES).map(([cn,code])=>[code,cn])));
/* 单机场景不采集操作人：operator 统一写 NULL（列在记录页按“有值才显示”的规则隐藏） */
function recordMeta(type, source){
  return {source: RECORD_SOURCES[source]||'manual', typeCode: RECORD_TYPE_CODES[type]||null, operator: null};
}
/* 本地记录镜像上限与原生 DB 留存（5000 行）保持一致，避免本地截断触发误删库内记录 */
const RECORD_LOCAL_MAX = 5000;
/* 扫码枪把编号填进表单后，紧接着的一次保存记为 scanner 来源（30 秒内有效） */
function takeScanSource(){
  const mark = window.__vitalsScanSource;
  window.__vitalsScanSource = null;
  if(!mark || Date.now()-mark.at > 30000) return 'manual';
  return 'scanner';
}

function addRecord(sampleName, type, detail, sampleId=null, persist=true, source='manual'){
  const sample=sampleId ? state.s.samples[sampleId] : null;
  const record={time:FMT.now(),sample:sampleName,type,detail,sampleId,...recordMeta(type,source)};
  if(sample){record.code=sample.code||null;record.slot=sample.slot||null;record.status=sample.status;}
  state.rec.unshift(record);
  if(state.rec.length>RECORD_LOCAL_MAX)state.rec.length=RECORD_LOCAL_MAX;
  return !persist || saveAll();
}

/* ==================== 导航 ==================== */
const VIEW_TITLES = {
  dashboard:'概览', library:'样本库', devices:'设备连接', monitor:'实时监测', records:'动态记录', settings:'设置'
};/*页面名称映射：英文转中文*/
$$('.nav-item[data-view]').forEach(btn => {
  btn.addEventListener('click', () => goView(btn.dataset.view));
});
function goView(name){
  if(name==='inventory'){
    name='library';
    switchLibraryPane('inventory');
  }
  $$('.nav-item[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $('#pageTitle').textContent = VIEW_TITLES[name] || '';
  closeSidebar();
  if(name==='dashboard'){ renderLibChart(); renderFeed(); }
  if(name==='library') renderLibrary();
  if(name==='devices'&&window.refreshExternalDevices)window.refreshExternalDevices();
  if(name==='records') renderRecords();
  if(name==='settings') fillSettings();
  if(name==='monitor'){ ensureMonitorRefresh(); ensureMonitorSel(); renderRack(); renderMonitorCharts(); }
}
function switchLibraryPane(name){
  const selected=name==='inventory'?'inventory':'list';
  $$('.library-tab').forEach(tab=>{
    const active=tab.dataset.libraryPane===selected;
    tab.classList.toggle('active',active);
    tab.setAttribute('aria-selected',String(active));
  });
  $$('.library-pane').forEach(pane=>{
    const active=pane.id===(selected==='inventory'?'libraryInventoryPane':'libraryListPane');
    pane.classList.toggle('active',active);
    pane.hidden=!active;
  });
  if(selected==='list')renderLibrary();
  if(selected==='inventory'&&window.renderTask)window.renderTask();
}
$$('.library-tab').forEach(tab=>tab.addEventListener('click',()=>switchLibraryPane(tab.dataset.libraryPane)));
$$('.text-btn[data-go]').forEach(b => b.addEventListener('click', () => goView(b.dataset.go)));
$('#deviceOnlineCard').addEventListener('click',()=>goView('devices'));
$('#deviceOnlineCard').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();goView('devices');}});
$('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
function closeSidebar(){ $('#sidebar').classList.remove('open'); }

/* ==================== 概览图表 ==================== */
let libChart = null;

function renderLibChart(){
  const ctx = $('#chartLib');
  if(!ctx) return;
  const s = state.s;
  const samp = Object.values(s.samples);
  const normal = samp.filter(x=>x.alert!=='warn' && x.alert!=='bad').length;
  const warn = samp.filter(x=>x.alert==='warn').length;
  const bad = samp.filter(x=>x.alert==='bad').length;
  const empty = samp.length === 0;
  const cap = { total: samp.length, normal, warn, bad };
  const capEls = { total: $('#capTotal'), normal: $('#capNormal'), warn: $('#capWarn'), bad: $('#capBad') };
  capEls.total && (capEls.total.textContent = cap.total);
  capEls.normal && (capEls.normal.textContent = cap.normal);
  capEls.warn && (capEls.warn.textContent = cap.warn);
  capEls.bad && (capEls.bad.textContent = cap.bad);
  if(empty){
    if(libChart){ libChart.destroy(); libChart = null; }
    drawEmptyOn(ctx, '暂无样本');
    return;
  }
  clearEmptyOn(ctx);
  const data = [normal, warn, bad];
  if(libChart){
    libChart.data.datasets[0].data = data;
    libChart.update('none');
    return;
  }
  libChart = new Chart(ctx, {
    type:'doughnut',
    data:{ labels:['正常','预警','异常'], datasets:[{ data, backgroundColor:['#34c759','#ffb340','#ff5f57'], borderWidth:0, hoverOffset:6 }]},
    options:{ responsive:true, aspectRatio:1.4, cutout:'68%', plugins:{ legend:{ position:'bottom', labels:{ usePointStyle:true, pointStyle:'circle', padding:16, font:{size:12}, color:'#6e6e73' } } } }
  });
}

function drawEmptyOn(canvas, txt){
  canvas.dataset.empty = txt;
  canvas.style.filter = 'opacity(0.4)';
}

function clearEmptyOn(canvas){
  if(!canvas.dataset.empty) return;
  delete canvas.dataset.empty;
  canvas.style.filter = '';
}

function renderFeed(){
  const box = $('#feedRecent');
  const recs = state.rec.slice(0,6);
  if(!recs.length){ box.innerHTML = '<div class="empty">暂无样本动态</div>'; return; }
  box.innerHTML = recs.map(r => `
    <div class="feed-item">
      <span class="feed-dot"></span>
      <div class="fd-main"><div class="fd-text">${esc(r.detail)}</div><div class="fd-time">${esc(r.time)} · ${esc(r.sample)}</div></div>
    </div>`).join('');
}

/* ==================== 照片：缩略图优先，详情按需取全图 ====================
   新原生把全图外置到文件系统，启动快照里只有 thumb（小图 data URL）与 photoPath。
   列表/详情一律先用 thumb；进入详情弹窗时再调 getSamplePhoto(id,true) 取全图替换。
   老版本原生 / 预览桥没有 getSamplePhoto 时，退回样本对象里的 photo 字段。 */
function sampleThumbSrc(x){
  if(!x) return '';
  return x.thumb || x.photo || '';
}
function setPhotoImg(node, src, alt){
  if(!node) return;
  if(src){ node.innerHTML = `<img style="width:100%;height:100%;object-fit:cover;border-radius:inherit" src="${src}" alt="${esc(alt||'样本照片')}">`; }
}
/* 详情弹窗照片：先渲染缩略图/骨架，再同步补全图（Android 桥是同步的） */
function renderDetailPhoto(x){
  const ph = $('#detailPhoto');
  if(!ph || !x) return;
  const thumb = sampleThumbSrc(x);
  if(thumb){
    setPhotoImg(ph, thumb, '样本照片');
  } else if(Store.canGetPhoto() && (x.photoPath || x.photoHash)){
    ph.innerHTML = '<div class="photo-loading">加载照片…</div>';
  } else {
    ph.innerHTML = '无照片';
    return;
  }
  if(!Store.canGetPhoto()) return;
  const info = Store.samplePhoto(x.id, true);
  if(!info || detailId !== x.id) return;
  if(info.thumb && !thumb) setPhotoImg(ph, info.thumb, '样本照片');
  if(info.missing || !info.photo){ if(!thumb && !info.thumb) ph.innerHTML = '<div class="photo-loading">照片文件缺失</div>'; return; }
  setPhotoImg(ph, info.photo, '样本照片');
}

/* ==================== 样本库 ==================== */
let editingId = null;

function addSampleBtnInit(){
  $('#addSampleBtn').addEventListener('click', () => openModal(null));
}

/* ==================== 样本库 · 类别检索 ====================
   按样本类别（全血 / 血清 / 血浆 + 数据中出现的其它类别）筛选样本列表。
   无障碍要点（HIG）：单选组语义 role=radiogroup/radio、44pt 触控高度、≥4.5:1 对比、
   选中态除配色外另有勾号（不单靠颜色传达含义）、支持 ←/→ 与 Home/End 键切换。 */
let libTypeFilter = 'all';
const LIB_TYPE_ORDER = ['全血','血清','血浆'];
function libTypeOptions(){
  const counts = new Map();
  Object.values(state.s.samples||{}).forEach(x=>{
    const t = (x && x.type) ? String(x.type) : '未分类';
    counts.set(t,(counts.get(t)||0)+1);
  });
  const rest = [...counts.keys()].filter(t=>!LIB_TYPE_ORDER.includes(t))
    .sort((a,b)=> (a==='未分类'?1:0)-(b==='未分类'?1:0) || a.localeCompare(b,'zh'));
  const options = [{value:'all',label:'全部',count:Object.keys(state.s.samples||{}).length}];
  LIB_TYPE_ORDER.concat(rest).forEach(t=>{
    // 三个标准类别即使当前为 0 也保留入口（槽位固定，便于确认「确实没有」而不是「筛不出来」）
    if(counts.has(t) || LIB_TYPE_ORDER.includes(t)) options.push({value:t,label:t,count:counts.get(t)||0});
  });
  return options;
}
function renderTypeFilter(){
  const mount = $('#libTypeFilter');
  if(!mount) return;
  const options = libTypeOptions();
  if(!options.some(o=>o.value===libTypeFilter)) libTypeFilter = 'all';
  const check = '<svg class="lib-chip-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 6.4 2.6 2.6L10 3.4"/></svg>';
  mount.innerHTML = options.map(o=>{
    const on = o.value===libTypeFilter;
    const label = o.value==='all' ? `全部 ${o.count}` : `${esc(o.label)} ${o.count}`;
    return `<button type="button" class="lib-chip" role="radio" data-type="${esc(o.value)}" data-index="${options.indexOf(o)}"`
      + ` aria-checked="${on?'true':'false'}" tabindex="${on?'0':'-1'}" aria-label="${esc(label)}">`
      + check + `<span class="lib-chip-label">${esc(o.label)}</span>`
      + `<span class="lib-chip-count" aria-hidden="true">${o.count}</span></button>`;
  }).join('');
}
function setLibTypeFilter(value, moveFocus){
  libTypeFilter = value || 'all';
  renderLibrary();
  if(moveFocus){
    const chip = document.querySelector(`#libTypeFilter .lib-chip[data-type="${libTypeFilter}"]`);
    if(chip) chip.focus();
  }
}
function bindLibraryFilter(){
  const mount = $('#libTypeFilter');
  if(!mount) return;
  mount.addEventListener('click', (e)=>{
    const chip = e.target.closest('.lib-chip');
    if(chip) setLibTypeFilter(chip.dataset.type, false);
  });
  mount.addEventListener('keydown', (e)=>{
    const keys = ['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','End'];
    if(!keys.includes(e.key)) return;
    const chips = Array.from(mount.querySelectorAll('.lib-chip'));
    if(!chips.length) return;
    e.preventDefault();
    const current = chips.findIndex(c=>c.getAttribute('aria-checked')==='true');
    let next = current < 0 ? 0 : current;
    if(e.key==='ArrowRight'||e.key==='ArrowDown') next = (current + 1 + chips.length) % chips.length;
    else if(e.key==='ArrowLeft'||e.key==='ArrowUp') next = (current - 1 + chips.length) % chips.length;
    else if(e.key==='Home') next = 0;
    else if(e.key==='End') next = chips.length - 1;
    setLibTypeFilter(chips[next].dataset.type, true);
  });
}
function clearLibraryFilters(){
  libTypeFilter = 'all';
  const input = $('#searchInput');
  if(input) input.value = '';
  renderLibrary();
}
function bindLibraryFilterOnce(){
  if(bindLibraryFilterOnce.done) return;
  bindLibraryFilterOnce.done = true;
  bindLibraryFilter();
  const clearBtn = $('#clearTypeFilter');
  if(clearBtn) clearBtn.addEventListener('click', clearLibraryFilters);
}
bindLibraryFilterOnce();

function renderLibrary(){
  const box = $('#sampleList');
  const q = ($('#searchInput').value||'').trim().toLowerCase();
  const total = Object.keys(state.s.samples||{}).length;
  const filtered = Object.values(state.s.samples).filter(x => {
    if(libTypeFilter!=='all' && String(x.type||'未分类')!==libTypeFilter) return false;
    if(!q) return true;
    return (x.name+' '+x.code+' '+x.type+' '+x.loc).toLowerCase().includes(q);
  }).sort((a,b)=> (b.createdAt||0)-(a.createdAt||0));

  renderTypeFilter();
  const countEl = $('#libCount');
  if(countEl) countEl.textContent = `共 ${total} 个样本 · 显示 ${filtered.length}`;
  const clearBtn = $('#clearTypeFilter');
  if(clearBtn) clearBtn.hidden = (libTypeFilter==='all' && !q);

  const samp = filtered;
  if(!samp.length){
    const activeFilter = libTypeFilter!=='all' ? `「${esc(libTypeFilter)}」` : '';
    box.innerHTML = (activeFilter||q)
      ? `<div class="empty">没有符合${activeFilter}${q?'与搜索关键词':''}的样本</div>`
      : '<div class="empty">点击右上角“录入样本”开始创建</div>';
    return;
  }
  box.innerHTML = samp.map(x => {
    const cls = x.alert==='bad'?'bad':(x.alert==='warn'?'warn':'good');
    const lbl = x.alert==='bad'?'异常':(x.alert==='warn'?'预警':'正常');
    const st = x.status==='out' ? 'out' : 'in';
    const stLbl = x.pendingIntake ? '待入库' : (x.status==='out' ? '已出库' : '已入库');
    const tempTxt = x.lastTemp != null ? x.lastTemp.toFixed(1)+'℃' : (x.temp!=null?x.temp+'℃':'—');
    const thumbSrc = sampleThumbSrc(x);
    const thumb = thumbSrc ? `<img class="sample-thumb" src="${thumbSrc}" alt="">` : `<div class="sample-thumb no"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7 12 4l8 3-8 3-8-3z"/><path d="M4 7v10l8 3 8-3V7"/><path d="M4 7l8 3 8-3"/></svg></div>`;
    const btnIn = st==='in' ? '<button class="mini-btn btn-on" data-act="in" disabled>已入库</button>'
                            : '<button class="mini-btn in" data-act="in">入库</button>';
    const btnOut = st==='out' ? '<button class="mini-btn btn-on" data-act="out" disabled>'+ (x.pendingIntake?'待入库':'已出库') +'</button>'
                              : '<button class="mini-btn out" data-act="out">出库</button>';
    return `<div class="sample-row" data-id="${x.id}">
      ${thumb}
      <div class="sample-mid">
        <div class="sample-name">${esc(x.name)}</div>
        <div class="sample-sub">${esc(x.code)} · ${esc(x.type)} · ${esc(x.loc||'未定位')}</div>
      </div>
      <div class="sample-right">
        <span class="badge ${cls}">${lbl}</span>
        <span class="badge ${st}">${stLbl}</span>
        <span class="sample-temp">${tempTxt}</span>
      </div>
      <div class="barcode-mini"></div>
      <div class="sample-actions">${btnOut}${btnIn}</div>
    </div>`;
  }).join('');

  box.querySelectorAll('.sample-row').forEach(row => {
    const id = row.dataset.id;
    row.addEventListener('click', (e)=>{if(!e.target.closest('button'))openDetail(id);});
    // 双击样本行弹出样本详情窗口（含二维码与打印标签），避免单击误触
    const mini = row.querySelector('.barcode-mini');
    // 双击打开样本详情：双击必然选中文本，不能再用"文本选中"判断来拦截（否则永远打不开）
    row.addEventListener('dblclick', () => {
      if(window.getSelection) window.getSelection().removeAllRanges();
      openDetail(id);
    });
    // 右键单条删除样本
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteSample(id);
    });
    // 样本行二维码编码完整样本信息（手机扫码可看到该样本的具体详情）
    renderQR(mini, sampleQRText(state.s.samples[id]), 1, 2);
    row.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); setSampleStatus(id, btn.dataset.act); });
    });
  });
}
/* 右键删除单条样本 */
function deleteSample(id){
  if(state.set.motionTask){ toast("请先处理当前出入库任务"); return; }
  const x = state.s.samples[id];
  if(!x) return;
  confirmDialog('删除样本', `确定删除样本「${x.name}」（${x.code||'无编号'}）？此操作不可撤销。`, ()=>{
    delete state.s.samples[id];
    delete state.set['templog:'+id];
    if(editingId === id) editingId = null;
    // 若该样本详情窗口正打开则一并关闭
    const dm = $('#detailModal');
    if(dm) dm.classList.remove('open');
    addRecord(x.name, '删除', '删除样本「'+x.name+'」', null, false);
    state.rec[0].code=x.code||null;
    if(!saveAll())return;
    recomputeStats(); refreshStats();
    renderLibrary();
    toast('已删除：'+x.name);
  });
}
$('#searchInput').addEventListener('input', renderLibrary);
$('#clearSearch').addEventListener('click', ()=>{ $('#searchInput').value=''; renderLibrary(); });
/* ==================== 二维码（手机扫码查看样本信息） ==================== */
// qrcode-generator 默认 stringToBytes 按 charCodeAt 截断（非 UTF-8），中文扫码会乱码；
// 注入 UTF-8 编码器，扫描器按 UTF-8 解码即可正常显示中文。
if(window.qrcode && !qrcode._utf8OK){
  qrcode.stringToBytes = function(s){
    if(typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(s));
    const b = [];
    for(let i=0;i<s.length;i++){
      let c = s.charCodeAt(i);
      if(c<0x80) b.push(c);
      else if(c<0x800) b.push(0xc0|(c>>6),0x80|(c&0x3f));
      else if(c<0xd800||c>=0xe000) b.push(0xe0|(c>>12),0x80|((c>>6)&0x3f),0x80|(c&0x3f));
      else { c = 0x10000+(((c&0x3ff)<<10)|(s.charCodeAt(++i)&0x3ff)); b.push(0xf0|(c>>18),0x80|((c>>12)&0x3f),0x80|((c>>6)&0x3f),0x80|(c&0x3f)); }
    }
    return b;
  };
  qrcode._utf8OK = true;
}

// 二维码内容 = 纯文本"样本信息卡"：微信扫一扫直接显示这段文本，无需任何网络/端口/同一 Wi-Fi。
// 内容在样本创建时冻结为快照(qrSnap)，后续编辑、实时温度或传感器变化都不会改动二维码。
function sampleInfoCard(x){
  const L = [];
  L.push('Vitals·生息 生物样本');
  L.push('名称：' + (x.name || '—'));
  L.push('编号：' + (x.code || x.id || '—'));
  L.push('类别：' + (x.type || '—'));
  L.push('位置：' + (x.loc || '未定位'));
  L.push('状态：' + (x.pendingIntake ? '待入库' : (x.status === 'out' ? '已出库' : '已入库')));
  if(x.temp != null) L.push('温度：' + (x.temp) + ' ℃');
  if(x.timeTxt) L.push('录入：' + x.timeTxt);
  if(x.note){ const n = String(x.note); L.push('备注：' + (n.length > 30 ? n.slice(0,30) + '…' : n)); }
  return L.join('\n');
}
// 扫码枪只需要稳定的 ASCII 编号。避免把中文详情写入二维码后被部分串口扫码枪
// 转码为 GBK，导致 Android 按 UTF-8 接收时出现乱码并无法匹配样本。
function sampleQRText(x){
  if(!x) return '';
  return String(x.code || x.id || '').trim();
}

function renderQR(el, text, cell, m){
  if(!el || !window.qrcode || !text) return;
  el.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag(cell||3, m||6);
  } catch(e){ }
}

/* ==================== 采集时间默认值 ==================== */
function setDefaultTime(){
  const d = new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset());
  $('#fTime').value = d.toISOString().slice(0,16);
}

/* ==================== 录入弹窗 ==================== */
let modalPhoto = null;
// 用户是否在本次弹窗里改过照片。未改过时保存绝不发送 photo 字段，
// 否则会把原生已经外置的 photo_path/photo_hash 覆盖成空。
let modalPhotoChanged = false;

function sampleSlotTaken(type,slot,exceptId=null){
  return Object.values(state.s.samples).some(x=>x.id!==exceptId&&x.type===type&&(
    x.status!=='out'&&x.slot===slot || x.status==='out'&&x.plannedSlot===slot
  ));
}
function refreshSampleSlotOptions(preferred){
  const select=$('#fSlot');if(!select)return;
  const type=$('#fType').value,current=editingId&&state.s.samples[editingId];
  const desired=Number(preferred??(current?.status==='in'?current.slot:current?.plannedSlot));
  const available=[];select.replaceChildren();
  for(let slot=1;slot<=5;slot++){
    const taken=sampleSlotTaken(type,slot,editingId),option=document.createElement('option');
    option.value=slot;option.disabled=taken;option.textContent=slot+' 号 · '+(taken?'已占用或已预选':'空闲');
    select.append(option);if(!taken)available.push(slot);
  }
  select.value=String(available.includes(desired)?desired:available[0]||'');
  select.disabled=current?.status==='in'||!available.length;
  if(!available.length){const option=document.createElement('option');option.value='';option.textContent='暂无空余位置';option.disabled=true;select.replaceChildren(option);}
  updateBarcodePreview($('#fCode').value);
}

function openModal(id){
  if(state.set.motionTask){toast("请先处理当前出入库任务");return;}
  editingId = id || null;
  $('#modalTitle').textContent = id ? '编辑样本' : '录入样本';
  $('#sampleModal').classList.add('open');
  setDefaultTime();
  if(id){
    const x = state.s.samples[id];
    if(x){
      $('#fName').value = x.name || '';
      $('#fCode').value = x.code || '';
      $('#fType').value = x.type || '全血';
      refreshSampleSlotOptions(x.status==='in'?x.slot:x.plannedSlot);
      $('#fTime').value = x.timeRaw || (x.time?dateToLocal(x.time): '');
      $('#fTemp').value = x.temp != null ? x.temp : '';
      $('#fNote').value = x.note || '';
      modalPhotoChanged = false;
      // 已有外置照片时先用 thumb 预览（老库可能还留着 photo 全图）
      modalPhoto = sampleThumbSrc(x) || null;
      setPhotoPreview();
      if(!modalPhoto && Store.canGetPhoto() && (x.photoPath || x.photoHash)){
        const info = Store.samplePhoto(id, false);
        if(info && !info.missing && info.thumb && editingId === id){ modalPhoto = info.thumb; setPhotoPreview(); }
      }
      updateBarcodePreview(x.code);
    }
  } else {
    $('#fCode').value = '';
    $('#fTemp').value = '';
    $('#fName').value=''; $('#fNote').value=''; $('#fType').value='全血';
    refreshSampleSlotOptions();
    modalPhoto = null; modalPhotoChanged = false; setPhotoPreview();
    updateBarcodePreview('');
  }
  setTimeout(()=> $('#fName').focus(), 120);
}

function dateToLocal(s){
  if(!s) return '';
  const d = new Date(s);
  if(isNaN(d)) return '';
  const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

$('#closeModal').addEventListener('click', ()=> $('#sampleModal').classList.remove('open'));
$('#modalCancel').addEventListener('click', ()=> $('#sampleModal').classList.remove('open'));
$('#sampleModal').addEventListener('click', e => { if(e.target===e.currentTarget) $('#sampleModal').classList.remove('open'); });

/* 编号自动生成 */
$('#fName').addEventListener('input', () => {
  const name = $('#fName').value.trim();
  const code = $('#fCode').value.trim();
  if(!code && name){
    let slug = name.toUpperCase().replace(/\s+/g,'-').slice(0,12).replace(/[^\w-]/g,'');
    if(!slug) slug = Date.now().toString(36).toUpperCase(); // 中文名回退为时间戳编号
    $('#fCode').value = 'SB-' + slug;
    updateBarcodePreview($('#fCode').value);
  }
});
$('#fCode').addEventListener('input', ()=> updateBarcodePreview($('#fCode').value));
$('#fType').addEventListener('change', ()=>refreshSampleSlotOptions());
$('#fSlot').addEventListener('change', ()=>updateBarcodePreview($('#fCode').value));

function updateBarcodePreview(code){
  const box = $('#barcodePreview');
  box.innerHTML='';
  if(code){
    box.classList.add('show');
    // 用当前表单内容实时预览"样本信息卡"二维码（未保存前先不冻结，保存时才冻结快照）
    const tempVal = $('#fTemp').value;
    renderQR(box, sampleInfoCard({
      name: $('#fName').value.trim(), code, type: $('#fType').value,
      loc: Number($('#fSlot').value)?MotionCore.slotLabel($('#fType').value,Number($('#fSlot').value)):'待分配', status:'in',
      temp: tempVal !== '' ? parseFloat(tempVal) : null,
      timeTxt: FMT.now(), note: $('#fNote').value.trim()
    }), 2, 2);
  } else {
    box.classList.remove('show');
  }
}

/* ===== 照片上传 ===== */
const photoDrop = $('#photoDrop'), photoInput = $('#photoInput');
photoDrop.addEventListener('click', ()=> photoInput.click());
photoDrop.addEventListener('dragover', e=>{ e.preventDefault(); photoDrop.classList.add('drag'); });
photoDrop.addEventListener('dragleave', ()=> photoDrop.classList.remove('drag'));
photoDrop.addEventListener('drop', e=>{
  e.preventDefault(); photoDrop.classList.remove('drag');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if(f && f.type.startsWith('image/')) readPhoto(f);
});
photoInput.addEventListener('change', ()=>{
  const f = photoInput.files && photoInput.files[0];
  if(f) readPhoto(f);
});
function readPhoto(file){
  // 压缩为 JPEG data URL 后再交给原生：新原生会把它落盘成 photos/<hash>.jpg 并生成 thumb。
  compressPhoto(file, dataUrl => {
    modalPhoto = dataUrl;
    modalPhotoChanged = true;
    setPhotoPreview();
  });
}
function compressPhoto(file, cb){
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const MAX = 640;
    let w = img.width, h = img.height;
    if(w > MAX || h > MAX){ const r = Math.min(MAX/w, MAX/h); w = Math.round(w*r); h = Math.round(h*r); }
    try {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(cv.toDataURL('image/jpeg', 0.82));
    } catch(e){ cb(null); }
  };
  img.onerror = () => { URL.revokeObjectURL(url); cb(null); };
  img.src = url;
}
function setPhotoPreview(){
  const img = $('#photoPreview'), ph = $('#photoPlaceholder'), rm = $('#removePhoto');
  if(modalPhoto){ img.src = modalPhoto; img.hidden=false; ph.style.display='none'; rm.hidden=false; }
  else { img.hidden=true; img.src=''; ph.style.display='flex'; rm.hidden=true; }
}
$('#removePhoto').addEventListener('click', e=>{ e.stopPropagation(); modalPhoto=null; modalPhotoChanged=true; setPhotoPreview(); });

/* 保存 */
$('#modalSave').addEventListener('click', ()=>{
  if(state.set.motionTask){toast('请先处理当前出入库任务');return;}
  if(Object.values(state.s.samples).some(x=>x.id!==editingId && x.code===$('#fCode').value.trim())){toast('样本编号重复');return;}
  const name = $('#fName').value.trim();
  let code = $('#fCode').value.trim();
  const type = $('#fType').value;
  const plannedSlot = Number($('#fSlot').value);
  const timeRaw = $('#fTime').value;
  const timeTxt = timeRaw ? FMT.time(timeRaw) : FMT.now();
  const temp = $('#fTemp').value !== '' ? parseFloat($('#fTemp').value) : null;
  const note = $('#fNote').value.trim();
  if(!name){ shakeField('#fName'); $('#fName').focus(); return; }
  if(!MotionCore.storageTypes.includes(type)){toast('当前只支持全血、血清、血浆三类样本');return;}
  const current=editingId&&state.s.samples[editingId],currentIn=current?.status==='in';
  if(!currentIn&&(!Number.isInteger(plannedSlot)||plannedSlot<1||plannedSlot>5||sampleSlotTaken(type,plannedSlot,editingId))){toast('该圆盘没有可用位置，请先完成出库或选择其他空位');refreshSampleSlotOptions();return;}
  const effectiveSlot=currentIn?current.slot:plannedSlot;
  const loc=MotionCore.slotLabel(type,effectiveSlot);
  if(!code){ code = 'SB-' + Date.now().toString(36).toUpperCase(); }
  // 编号唯一性
  const dup = Object.values(state.s.samples).find(x => x.code===code && x.id!==editingId);
  if(dup){ $('#fCode').focus(); toast('样本编号已存在：' + code); return; }

  const now = Date.now();
  let savedId = editingId;
  // 来源：扫码枪填入的编号 → scanner；其余界面操作 → manual
  const saveSource = takeScanSource();
  if(editingId){
    const x = state.s.samples[editingId];
    if(x.status==='in'&&x.type!==type){toast('在库样本不能更换圆盘类型，请先完成出库');return;}
    Object.assign(x, { name, code, type, loc, timeRaw, timeTxt, temp, note, updatedAt: now });
    applyModalPhoto(x);
    if(x.status==='out')x.plannedSlot=plannedSlot;else delete x.plannedSlot;
    addRecord(name, '编辑', `更新样本「${name}」信息`, editingId, false, saveSource);
  } else {
    const id = uid();
    savedId = id;
    const sample = {
      id, name, code, type, loc, timeRaw, timeTxt, temp, note,
      photo: modalPhoto, createdAt: now, updatedAt: now,
      monitor: false, lastTemp: temp, alert:'good', lastUpdate:null, status:'out', pendingIntake:true, plannedSlot
    };
    sample.qrSnap = sampleInfoCard(sample); // 创建时冻结二维码快照，此后编辑/温度变化不再改动
    state.s.samples[id] = sample;
    addRecord(name, '录入', `新增样本「${name}」（${code}）`, id, false, saveSource);
  }
  if(!saveThrowState()){ toast('保存失败，数据库保持原状态，请先导出备份'); return; }
  if(modalPhotoChanged && modalPhoto) refreshSavedThumb(savedId);
  recomputeStats();
  $('#sampleModal').classList.remove('open');
  toast('样本已保存');
  renderLibrary();
  // 如果当前在概览刷新统计
  refreshStats();
});
function shakeField(el){
  $(el).style.borderColor = 'var(--red)';
  setTimeout(()=> $(el).style.borderColor = 'var(--border)', 1200);
}
/* 只有用户真的换过照片才写 photo；未换图时不发送该字段，原生会保留已外置的照片文件。 */
function applyModalPhoto(x){
  if(!modalPhotoChanged) return false;
  x.photo = modalPhoto || null;
  delete x.thumb; delete x.photoPath; delete x.photoHash;
  return true;
}
/* 原生落盘并生成 thumb 后，用 thumb 替换本地的全图 base64，避免后续提交反复上传照片。 */
function refreshSavedThumb(id){
  const x = state.s.samples[id];
  if(!x || !Store.canGetPhoto()) return;
  const info = Store.samplePhoto(id, false);
  if(!info || info.missing || !info.thumb) return;
  x.thumb = info.thumb;
  if(info.hash) x.photoHash = info.hash;
  delete x.photo;
  if(typeof Store.capture === 'function') Store.capture(state);
}
function saveThrowState(){ return saveAll(); }
function refreshStats(){
  if(window.refreshMotionPanel)window.refreshMotionPanel();
  $('#statTotal').textContent = state.s.total;
  $('#statActive').textContent = state.s.active;
  if(window.renderDeviceStats)window.renderDeviceStats();else $('#statOnline').textContent = state.s.online;
  $('#statAlert').textContent = state.s.alert;
  if($('#view-dashboard').classList.contains('active')) renderLibChart();
}

/* ==================== 标签信息过期提示 ====================
   qrSnap 是创建标签时冻结的样本信息卡（位置/状态）。打印成功后重新冻结并记 labelPrintedAt，
   之后只要样本没有被移动/改状态，就不再重复提示「标签信息已过期」。 */
function qrSnapField(x, label){
  if(!x || !x.qrSnap) return null;
  const m = String(x.qrSnap).match(new RegExp('^'+label+'：(.+)$','m'));
  return m ? m[1].trim() : null;
}
function currentStatusText(x){
  return x && x.pendingIntake ? '待入库' : (x && x.status==='out' ? '已出库' : '已入库');
}
function labelFreshness(x){
  const snapLoc = qrSnapField(x,'位置'), snapStatus = qrSnapField(x,'状态');
  if(snapLoc==null && snapStatus==null) return {stale:false, detail:''};
  const changed = [];
  if(snapLoc!=null && snapLoc !== (x.loc||'未定位')) changed.push('位置');
  if(snapStatus!=null && snapStatus !== currentStatusText(x)) changed.push('状态');
  if(!changed.length) return {stale:false, detail:''};
  const printed = x.labelPrintedAt ? '（上次打印 '+x.labelPrintedAt+'）' : '';
  return {stale:true, detail:'标签冻结的'+changed.join('、')+'与当前记录不一致，建议重新打印'+printed};
}
/* 打印成功后由 printer.js 调用：重新冻结信息卡并记录打印时间。 */
window.markLabelPrinted = function(id){
  const x = state.s.samples[id];
  if(!x) return false;
  x.qrSnap = sampleInfoCard(x);
  x.labelPrintedAt = FMT.now();
  const ok = saveAll();
  if(ok && detailId === id){
    const stale = $('#diBadges .label-stale');
    if(stale) stale.remove();
    if($('#printWarn')) $('#printWarn').classList.add('hidden');
  }
  return ok;
};

/* ==================== 详情弹窗 ==================== */
let detailId = null;
function openDetail(id){
  detailId = id;
  const x = state.s.samples[id];
  if(!x) return;
  $('#detailTitle').textContent = '样本详情';
  $('#diName').textContent = x.name;
  $('#diCode').textContent = x.code;
  $('#diType').textContent = x.type;
  $('#diLoc').textContent = x.loc || '未定位';
  $('#diTime').textContent = x.timeTxt || '—';
  $('#diTemp').textContent = x.temp != null ? x.temp+' ℃' : '—';
  const cls = x.alert==='bad'?'bad':(x.alert==='warn'?'warn':'good');
  const lbl = x.alert==='bad'?'状态异常':(x.alert==='warn'?'温度预警':'正常');
  $('#diState').textContent = x.status==='out' ? '已出库' : '已入库';
  const lastTxt = x.lastTemp != null ? x.lastTemp.toFixed(2)+' ℃' : '—';
  const lastT = x.lastUpdate ? x.lastUpdate : '';
  $('#diLast').textContent = lastTxt + (lastT ? '  @'+esc(lastT.slice(-8)) : '');
  renderDetailPhoto(x);
  const fresh = labelFreshness(x);
  $('#diBadges').innerHTML = `<span class="badge ${cls}">${lbl}</span>` +
    (x.monitor?`<span class="badge info">实时</span>`:'') +
    (fresh.stale?`<span class="badge warn label-stale" title="${esc(fresh.detail)}">标签信息已过期，建议重新打印</span>`:'');
  const printWarn = $('#printWarn');
  if(printWarn){
    printWarn.classList.toggle('hidden', !fresh.stale);
    printWarn.title = fresh.detail;
  }
  renderQR($('#diQR'), sampleQRText(x));
  $('#detailModal').classList.add('open');
}
$('#closeDetail').addEventListener('click', ()=> $('#detailModal').classList.remove('open'));
$('#detailModal').addEventListener('click', e=>{ if(e.target===e.currentTarget) $('#detailModal').classList.remove('open'); });
$('#detailEdit').addEventListener('click', ()=>{ $('#detailModal').classList.remove('open'); openModal(detailId); });

/* ==================== 打印 ==================== */
$('#printBtn').addEventListener('click', ()=>{
  const x = state.s.samples[detailId];
  if(!x) return;
  const area = $('#printArea');
  area.innerHTML = layoutPrintLabel(x);
  renderQR(area.querySelector('.lp-qr'), sampleQRText(x), 2, 3);
  if(window.openUsbLabelPrint) window.openUsbLabelPrint(x);
  else AndroidHost.printLabel();
});

function layoutPrintLabel(x){
  return `<div class="label-print">
    <div class="lp-top"><span>生息 · VITALS</span><span>${esc(x.code)}</span></div>
    <div class="lp-type">样本类型：${esc(x.type)}　位置：${esc(x.loc||'—')}</div>
    <div class="lp-qr"></div>
    <div class="lp-info">样本：${esc(x.name)}　采集温度：${x.temp!=null?x.temp:''}℃</div>
    <div class="lp-time">采集时间：${esc(x.timeTxt||'—')}</div>
  </div>`;
}

/* ==================== 数据库持久化与统计 ==================== */
function saveAll(){
  try { Store.save(state); return true; }
  catch(e){
    console.warn('SAVE_FAIL',e);
    try{state=Store.load();queueMicrotask(()=>{reloadUI();fillSettings();if(typeof renderTask==='function')renderTask();});}catch(loadError){console.error(loadError);}
    toast('保存失败，数据库保持原状态：'+e.message);return false;
  }
}
function statsToEls(){
  $('#statTotal').textContent = state.s.total;
  $('#statActive').textContent = state.s.active;
  if(window.renderDeviceStats)window.renderDeviceStats();else $('#statOnline').textContent = state.s.online;
  $('#statAlert').textContent = state.s.alert;
}

/* ==================== 记录页 ====================
   原生有 recordsPage() 时走数据库分页（默认 200 条 + 加载更多），
   没有该桥方法（老原生 / 网页预览桥）时对启动快照里的记录做同样的筛选与切片。 */
const RECORD_PAGE_SIZE = 200;
let recordView = {rows:[], total:0, hasMore:false, offset:0, degraded:false};

const RECORD_SOURCE_LABELS = {manual:'人工', hardware:'硬件', scanner:'扫码枪', system:'系统'};
function recordSourceLabel(source){
  if(source==null || source==='') return '—';
  return RECORD_SOURCE_LABELS[source] || String(source);
}
function recordTypeCode(r){ return (r && (r.typeCode || r.type_code)) || ''; }

function recordFilterIso(){
  const fromEl = $('#recordFrom'), toEl = $('#recordTo');
  const from = fromEl ? fromEl.value : '', to = toEl ? toEl.value : '';
  return {from: from ? from+'T00:00' : '', to: to ? to+'T23:59' : ''};
}
function recordTypeFilterValue(){
  const el = $('#recordType');
  return el ? el.value : '';
}
function recordMatchesFilter(r, filter, typeValue){
  const time = String(r.time||'').replace(' ','T').slice(0,16);
  if(filter.from && time && time < filter.from) return false;
  if(filter.to && time && time > filter.to) return false;
  if(typeValue){
    if(typeValue.indexOf('code:')===0){ if(recordTypeCode(r)!==typeValue.slice(5)) return false; }
    else if(typeValue.indexOf('text:')===0){ if(String(r.type||'')!==typeValue.slice(5)) return false; }
  }
  return true;
}
/* 类型下拉：使用与 records.type_code 相同的英文枚举（中文只作展示），
   同时兼容老库/旧桥里只有中文 type、没有 type_code 的记录。 */
function refreshRecordTypeOptions(){
  const sel = $('#recordType');
  if(!sel) return;
  const extras = new Set(), types = new Set();
  for(const r of state.rec.concat(recordView.rows)){
    const code = recordTypeCode(r);
    if(code){ if(!RECORD_TYPE_LABELS[code]) extras.add(code); }
    else if(r.type) types.add(String(r.type));
  }
  const options = ['<option value="">全部类型</option>'];
  const seen = new Set();
  Object.values(RECORD_TYPE_CODES).concat(Array.from(extras)).forEach(code=>{
    if(seen.has(code)) return;
    seen.add(code);
    options.push(`<option value="code:${esc(code)}">${esc(RECORD_TYPE_LABELS[code]||code)}</option>`);
  });
  Array.from(types).sort().forEach(type=>options.push(`<option value="text:${esc(type)}">${esc(type)}</option>`));
  const current = sel.value;
  sel.innerHTML = options.join('');
  if(Array.from(sel.options).some(option=>option.value===current)) sel.value = current;
}
function recordColumnVisible(name, visible){
  const table = $('#recordTable');
  if(!table) return;
  table.querySelectorAll('th.col-'+name).forEach(th=>th.classList.toggle('hidden', !visible));
}
function paintRecords(){
  const body = $('#recordBody');
  if(!body) return;
  const rows = recordView.rows, total = Math.max(recordView.total, rows.length);
  const count = $('#recordCount');
  if(count) count.textContent = total + ' 条' + (rows.length < total ? '（已载入 '+rows.length+'）' : '');
  const empty = $('#recordEmpty');
  if(empty) empty.style.display = rows.length ? 'none' : 'block';
  const hasSource = rows.some(r=>recordSourceLabel(r.source)!=='—');
  const hasOperator = rows.some(r=>r.operator);
  recordColumnVisible('source', hasSource);
  recordColumnVisible('operator', hasOperator);
  body.innerHTML = rows.map(r => {
    const sourceCell = hasSource ? `<td class="col-source">${esc(recordSourceLabel(r.source))}</td>` : '';
    const operatorCell = hasOperator ? `<td class="col-operator">${esc(r.operator||'—')}</td>` : '';
    return `<tr><td>${esc(r.time)}</td><td>${esc(r.sample)}</td><td>${esc(r.type)}</td><td>${esc(r.detail)}</td>${sourceCell}${operatorCell}</tr>`;
  }).join('');
  const more = $('#recordMore');
  if(more) more.classList.toggle('hidden', !recordView.hasMore);
  const hint = $('#recordMoreHint');
  if(hint){
    if(recordView.degraded) hint.textContent = '当前版本不支持数据库分页，仅显示已载入的记录';
    else if(recordView.hasMore) hint.textContent = '还有更多记录';
    else if(total) hint.textContent = '已显示全部记录';
    else hint.textContent = '';
  }
}
function renderRecords(reset){
  const body = $('#recordBody');
  if(!body) return;
  if(reset !== false){ recordView = {rows:[], total:0, hasMore:false, offset:0, degraded:recordView.degraded}; refreshRecordTypeOptions(); }
  const filter = recordFilterIso(), typeValue = recordTypeFilterValue();
  let page = Store.recordsPage(filter.from, filter.to, recordTypeValueForBridge(typeValue), RECORD_PAGE_SIZE, recordView.offset);
  if(page){
    recordView.degraded = false;
  } else {
    // 降级：无 recordsPage 桥方法，用启动快照里的记录在本地筛选/切片
    const all = state.rec.filter(r=>recordMatchesFilter(r, filter, typeValue));
    page = {records: all.slice(recordView.offset, recordView.offset+RECORD_PAGE_SIZE),
            total: all.length,
            hasMore: all.length > recordView.offset + RECORD_PAGE_SIZE};
    recordView.degraded = true;
  }
  recordView.rows = recordView.rows.concat(page.records);
  recordView.total = page.total;
  recordView.hasMore = page.hasMore;
  recordView.offset = recordView.rows.length;
  paintRecords();
}
/* typeCode 走桥；下拉里的 text: 前缀是老库中文类型的本地过滤标记，不能传给原生 */
function recordTypeValueForBridge(value){
  return value && value.indexOf('code:')===0 ? value.slice(5) : '';
}
/* 记录页筛选控件只绑定一次；缺控件时安静跳过（兼容旧 index.html 缓存）。 */
function bindRecordFilters(){
  const on = (sel, evt, fn) => { const el = $(sel); if(el) el.addEventListener(evt, fn); };
  on('#recordFrom','change', ()=>renderRecords(true));
  on('#recordTo','change', ()=>renderRecords(true));
  on('#recordType','change', ()=>renderRecords(true));
  on('#recordRefresh','click', ()=>renderRecords(true));
  on('#recordMore','click', ()=>renderRecords(false));
}

/* ==================== 设置 ==================== */
function fillSettings(){
  $('#setHi').value = state.set.hi;
  $('#setLo').value = state.set.lo;
}
function saveTemperatureLimit(key, input){
  const value=Number(input.value);
  if(input.value.trim()===''||!Number.isFinite(value)){fillSettings();toast('请输入有效温度');return;}
  const hi=key==='hi'?value:Number(state.set.hi),lo=key==='lo'?value:Number(state.set.lo);
  if(hi<=lo){fillSettings();toast('上限必须高于下限');return;}
  state.set[key]=value;
  if(saveAll())toast('已保存');
}
$('#setHi').addEventListener('change', e=>saveTemperatureLimit('hi',e.target));
$('#setLo').addEventListener('change', e=>saveTemperatureLimit('lo',e.target));
$('#exportBtn').addEventListener('click', exportData);
$('#importBtn').addEventListener('click', ()=> AndroidHost.importJson());
$('#importFile').addEventListener('change', importData);
$('#resetBtn').addEventListener('click', ()=>{
  confirmDialog('清空全部数据', '确定清空全部样本与记录？此操作不可撤销，且清空后不会重新生成示例数据。', ()=>{
    if(state.set.motionTask){toast('请先处理当前任务');return;}
    // 行级差分清空：新原生的 replace 只允许空库，这里用增删差分，非空库也能清空。
    try{state=Store.clearAll({hi:8,lo:-88});}
    catch(e){toast('清空失败：'+e.message);return;}
    unloadSim();reloadUI();fillSettings();
    toast('已清空全部数据');
  });
});

/* ==================== 导出落盘 ==================== */
/* Android 走 exportJson；Electron 走主进程；网页预览回退浏览器下载。 */
function saveTextFile(name, content, mime, okMessage){
  if(window.AndroidHost){ AndroidHost.exportJson(name, content); return; }
  if(window.api && typeof window.api.saveJson === 'function'){
    window.api.saveJson(name, content).then(r=>{
      if(!r){ toast('导出失败：无响应'); return; }
      if(r.cancel){ toast('已取消导出'); return; }
      if(r.ok){ toast('已导出：'+r.path); return; }
      toast('导出失败：'+(r.error||'未知错误'));
    });
    return;
  }
  if(!URL.createObjectURL){ toast('当前环境不支持导出，请使用桌面安装版'); return; }
  const blob = new Blob([content], {type:mime||'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
  toast(okMessage||'已导出');
}
/* 侧边栏「导出」：完整备份（保留含照片的旧语义） */
function exportData(){
  if(!saveAll())return;
  let content;try{content=Store.exportBackupText(true);}catch(e){toast('导出失败：'+e.message);return;}
  saveTextFile('vitals_backup_'+Date.now()+'.json', content, 'application/json', '数据已导出备份');
}

/* ==================== 设置：数据导出卡片 ==================== */
function installExportCard(){
  const view = $('#view-settings');
  if(!view || $('#exportCard')) return;
  const hasBackup = Store.canExportBackup(), hasCsv = Store.canExportCsv();
  const card = document.createElement('section');
  card.className = 'panel glass'; card.id = 'exportCard';
  card.innerHTML = '<div class="panel-head"><h3>数据导出</h3><span class="pill" id="exportPill">'+
      (hasBackup ? (hasCsv?'JSON / CSV':'JSON') : (hasCsv?'JSON（兼容）/ CSV':'JSON（兼容）'))+'</span></div>'+
    '<p class="muted">备份自带 schema 版本与校验和，可在其他设备导入恢复。默认不含照片，体积更小。</p>'+
    '<label class="setting-row export-toggle"><span>备份包含样本照片</span><input type="checkbox" id="exportPhotos"></label>'+
    '<div class="set-actions">'+
      '<button class="btn primary" id="exportBackupBtn">导出完整备份（JSON）</button>'+
      '<button class="btn ghost" id="exportRecordsCsv">导出记录 CSV</button>'+
      '<button class="btn ghost" id="exportSamplesCsv">导出样本 CSV</button>'+
    '</div>'+
    '<p class="muted">CSV 导出范围可留空（全部）；结束日期含当天。</p>'+
    '<div class="export-range">'+
      '<label class="field"><span>起始日期</span><input class="input" type="date" id="csvFrom"></label>'+
      '<label class="field"><span>结束日期</span><input class="input" type="date" id="csvTo"></label>'+
    '</div>';
  view.appendChild(card);
  $('#exportBackupBtn').onclick = exportBackupWithPhotos;
  if(hasCsv){
    $('#exportRecordsCsv').onclick = ()=>exportCsvFile('records');
    $('#exportSamplesCsv').onclick = ()=>exportCsvFile('samples');
  } else {
    const disable = btn => { btn.disabled = true; btn.title = '当前版本原生不支持 CSV 导出'; };
    disable($('#exportRecordsCsv')); disable($('#exportSamplesCsv'));
  }
}
function exportBackupWithPhotos(){
  if(!saveAll())return;
  const includePhotos = !!($('#exportPhotos') && $('#exportPhotos').checked);
  let content;try{content=Store.exportBackupText(includePhotos);}catch(e){toast('导出失败：'+e.message);return;}
  saveTextFile('vitals_backup_'+Date.now()+'.json', content, 'application/json',
    includePhotos?'备份已导出（含照片）':'备份已导出（不含照片）');
}
function exportCsvFile(kind){
  if(!Store.canExportCsv()){ toast('当前版本不支持 CSV 导出'); return; }
  const options = {};
  const from = $('#csvFrom') ? $('#csvFrom').value : '', to = $('#csvTo') ? $('#csvTo').value : '';
  if(from) options.fromIso = from+'T00:00';
  if(to) options.toIso = to+'T23:59';
  const typeValue = recordTypeFilterValue();
  if(typeValue.indexOf('code:')===0) options.typeCode = typeValue.slice(5);
  let csv;try{csv=Store.exportCsvText(kind,options);}catch(e){toast('导出失败：'+e.message);return;}
  if(!csv){ toast('导出失败：内容为空'); return; }
  const label = kind==='samples' ? '样本' : (kind==='env' ? '温度曲线' : '记录');
  saveTextFile('vitals_'+kind+'_'+Date.now()+'.csv', csv, 'text/csv', label+' CSV 已导出');
}
function confirmDialog(title, msg, onOk){
  const m = $('#confirmModal');
  if(!m) { if(typeof confirm === 'function' && confirm(msg)) onOk(); return; }
  $('#confirmTitle').textContent = title;
  $('#confirmMsg').textContent = msg;
  const yes = $('#confirmYes'), no = $('#confirmNo');
  const done = ok => { m.classList.remove('open'); yes.onclick = null; no.onclick = null; if(ok && onOk) onOk(); };
  yes.onclick = ()=> done(true);
  no.onclick = ()=> done(false);
  m.classList.add('open');
}
/* ==================== 导入：先预览差异，用户确认后再合并/替换 ====================
   新原生 importBackupEx 支持 preview；老原生与网页预览桥没有该桥方法时退回一次性替换。 */
let importState = {payload:'', mode:'merge', filterJson:''};

function databaseIsEmpty(){
  if(Object.keys(state.s.samples||{}).length) return false;
  if(state.rec.length) return false;
  return !(recordView.total > 0);
}
function currentImportMode(){ return databaseIsEmpty() ? 'replace' : 'merge'; }
function importModeHint(){
  return databaseIsEmpty()
    ? '本机数据库为空：确认后按「替换」写入整份备份。'
    : '本机已有数据：确认后按「合并」导入，不会清空现有样本与记录。';
}
function closeImportModal(){ const m = $('#importModal'); if(m) m.classList.remove('open'); }
function openImportPreview(text){
  const modal = $('#importModal');
  if(!modal){ legacyImportFlow(text); return; }
  importState = {payload:text, mode:currentImportMode(), filterJson:''};
  const filter = $('#importFilter');
  if(filter) filter.value = '';
  const body = $('#importBody');
  if(body) body.innerHTML = '<p class="muted">正在校验备份…</p>';
  const confirmBtn = $('#importConfirm');
  if(confirmBtn){ confirmBtn.disabled = true; confirmBtn.textContent = '确认导入'; }
  modal.classList.add('open');
  requestImportPreview('');
}
function requestImportPreview(filterJson){
  const result = Store.importPreview(importState.payload, filterJson);
  if(result === null){ closeImportModal(); legacyImportFlow(importState.payload); return; }
  importState.filterJson = filterJson || '';
  paintImportPreview(result);
}
function paintImportPreview(result){
  const body = $('#importBody');
  const confirmBtn = $('#importConfirm');
  if(!body) return;
  if(!result || result.ok === false || result.dryRun !== true){
    body.innerHTML = '<div class="import-error"><b>无法导入该备份</b><p>'+
        esc((result && result.error) || '预览失败')+'</p></div>'+
      '<p class="muted">预览阶段不会改动本机数据，请检查备份文件后重试。</p>';
    if(confirmBtn) confirmBtn.disabled = true;
    return;
  }
  const diff = result.diff || {}, counts = result.counts || {};
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const conflicts = Array.isArray(diff.conflictCodes) ? diff.conflictCodes : [];
  const shown = conflicts.slice(0,5), rest = conflicts.length - shown.length;
  const mode = currentImportMode();
  importState.mode = mode;
  const num = v => esc(String(v==null?0:v));
  const noChange = !diff.newSamples && !diff.updatedSamples && !diff.newRecords && !conflicts.length;
  body.innerHTML =
    '<p class="muted">预览未改动本机数据。'+esc(importModeHint())+'</p>'+
    '<div class="import-grid">'+
      '<div><span>备份样本</span><b>'+esc(counts.samples==null?'—':String(counts.samples))+'</b></div>'+
      '<div><span>备份记录</span><b>'+esc(counts.records==null?'—':String(counts.records))+'</b></div>'+
      '<div><span>新增样本</span><b>'+num(diff.newSamples)+'</b></div>'+
      '<div><span>更新样本</span><b>'+num(diff.updatedSamples)+'</b></div>'+
      '<div><span>新增记录</span><b>'+num(diff.newRecords)+'</b></div>'+
      '<div><span>重复记录</span><b>'+num(diff.duplicateRecords)+'</b></div>'+
    '</div>'+
    (conflicts.length ? '<div class="import-conflict"><b>条码冲突 '+conflicts.length+' 条</b><p>'+
      esc(shown.join('、'))+(rest>0?' 等 '+conflicts.length+' 条':'')+'</p>'+
      '<p class="muted">冲突样本不会被导入；可在下方按条码做子集恢复。</p></div>' : '')+
    (warnings.length ? '<div class="import-warn"><b>提示</b><ul>'+
      warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></div>' : '')+
    (noChange ? '<div class="empty">该备份与当前数据没有差异</div>' : '');
  if(confirmBtn){ confirmBtn.disabled = false; confirmBtn.textContent = mode==='replace' ? '替换导入' : '合并导入'; }
}
function importFilterJsonFromInput(){
  const el = $('#importFilter');
  const codes = String(el?el.value:'').split(/[\s,，;；]+/).map(x=>x.trim()).filter(Boolean);
  return codes.length ? JSON.stringify({onlyCodes:codes}) : '';
}
function confirmImport(){
  if(state.set.motionTask){ toast('请先处理当前任务'); return; }
  const mode = currentImportMode();
  let result;
  try{ result = Store.importBackup(importState.payload, mode, importState.filterJson); }
  catch(e){ paintImportPreview({ok:false, error:(e&&e.message)||'导入失败'}); return; }
  if(!result || result.ok === false){ paintImportPreview({ok:false, error:(result&&result.error)||'导入失败'}); return; }
  closeImportModal();
  try{ state = Store.load(); }
  catch(e){ toast('导入已完成，但重新载入失败：'+e.message); return; }
  if(simTimer){ clearInterval(simTimer); simTimer=null; }
  renderDeviceStats();
  reloadUI(); fillSettings(); if(typeof renderTask==='function') renderTask();
  toast('导入完成（'+(mode==='replace'?'替换':'合并')+'）');
}
/* 老原生 / 预览桥：整库替换，保持原有交互 */
function legacyImportFlow(text){
  if(state.set.motionTask){toast('当前有未完成任务，不能导入覆盖');return;}
  try{
    const data=MotionCore.validateBackup(JSON.parse(text.replace(/^\uFEFF/,'')));
    confirmDialog('导入并替换本机数据',`备份包含 ${Object.keys(data.samples).length} 个样本。将替换本机样本和记录，建议先导出当前备份。`,()=>{
      if(state.set.motionTask){toast('请先处理当前任务');return;}
      try{state=Store.replace(text);}catch(e){toast('导入失败，原数据已保留：'+e.message);return;}
      if(simTimer){clearInterval(simTimer);simTimer=null;}
      renderDeviceStats();
      reloadUI();fillSettings();if(typeof renderTask==='function')renderTask();toast('导入成功');
    });
  }catch(e){toast('导入失败：'+e.message);}
}
function bindImportUI(){
  const on=(sel,evt,fn)=>{const el=$(sel);if(el)el.addEventListener(evt,fn);};
  on('#importClose','click',closeImportModal);
  on('#importCancel','click',closeImportModal);
  on('#importConfirm','click',confirmImport);
  on('#importFilterBtn','click',()=>requestImportPreview(importFilterJsonFromInput()));
  const modal=$('#importModal');
  if(modal)modal.addEventListener('click',e=>{if(e.target===e.currentTarget)closeImportModal();});
}
function importData(e){
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if(!f) return;
  const reader = new FileReader();
  reader.onload=()=>receiveImport(String(reader.result));
  reader.readAsText(f);
}
function reloadUI(){
  recomputeStats();
  refreshStats();
  renderLibrary();
  renderRecords();
  unloadMonitor();
  refreshBuildTag();
}
function refreshBuildTag(){
  const bt = $('#buildTag');
  if(!bt) return;
  bt.textContent = `Android 1.6.2 · 圆槽编号不补零 · 样本 ${state.s.total||0}`;
}

/* ==================== 弹窗 toast 分流（无覆盖） ==================== */
function toast(msg){
  // 用侧边小徽标提示，避免遮挡编辑界面
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(()=> t.classList.add('in'));
  setTimeout(()=>{ t.classList.add('out'); setTimeout(()=>t.remove(), 350); }, 1600);
}

/* ==================== 单片机串口连接 ==================== */
let port = null, reader = null;
let monitorActive = false;
let simTimer = null;
let serialBuf = '';  // HC09 LoRa 无线链路可能分片/断续，跨数据块缓冲残缺行
let tempLogCount = 0;

$('#serialBtn').addEventListener('click', ()=> goView('devices'));
$('#connectBtn').addEventListener('click', connectSerial);
$('#disconnectBtn').addEventListener('click', disconnectSerial);
$('#simStartBtn').addEventListener('click', toggleSim);
$('#tempLogClear').addEventListener('click', ()=>{
  tempLogCount=0;
  $('#tempSerialLog').innerHTML='<div class="empty-line">日志已清空，等待新数据…</div>';
});

const bridge = $('#bridgePanel');

function briLog(text, cls=''){
  const log = $('#simLog');
  const div = document.createElement('div');
  if(cls) div.className = cls;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  // 限制行数
  while(log.children.length > 300) log.removeChild(log.firstChild);
}

function tempSerialLog(raw,kind='rec'){
  const log=$('#tempSerialLog');
  if(!log)return;
  if(!tempLogCount)log.textContent='';
  const row=document.createElement('div');
  row.className=kind;
  row.textContent='['+new Date().toLocaleTimeString('zh-CN',{hour12:false})+'] '+raw;
  log.appendChild(row);tempLogCount++;
  while(log.children.length>100)log.removeChild(log.firstChild);
  log.scrollTop=log.scrollHeight;
}

/* ==================== 传感器噪声处理（EMA 平滑 + 去抖 + 告警记录冷却） ==================== */
const EMA_ALPHA = 0.3;
const DEBOUNCE_MS = 3000;
const ALERT_COOLDOWN_MS = 3000;
const sensorRt = new Map();
const channelSmooth = new Map();

function emaSmooth(prev,next,alpha){
  if(next==null||!Number.isFinite(next))return prev;
  if(prev==null||!Number.isFinite(prev))return next;
  return alpha*next+(1-alpha)*prev;
}
function rtOf(id){
  let runtime=sensorRt.get(id);
  if(!runtime){runtime={smooth:null,pendTarget:null,pendSince:0,lastLogAt:0};sensorRt.set(id,runtime);}
  return runtime;
}
function logAlertChange(sample,previous,next,temp,id){
  if(next===previous)return;
  const runtime=rtOf(id),now=Date.now();
  let type='告警',detail=null;
  if(next==='bad'&&previous!=='bad')detail=`样本「${sample.name}」温度 ${temp!=null?temp.toFixed(2):'--'}℃ 异常`;
  else if(next==='warn'&&previous==='good')detail=`样本「${sample.name}」温度 ${temp!=null?temp.toFixed(2):'--'}℃ 预警`;
  else if(next==='good'&&previous==='bad'){type='恢复';detail=`样本「${sample.name}」温度 ${temp!=null?temp.toFixed(2):'--'}℃ 恢复正常`;}
  else return;
  if(now-runtime.lastLogAt<ALERT_COOLDOWN_MS)return;
  runtime.lastLogAt=now;
  // 告警/恢复由温度板数据触发
  addRecord(sample.name,type,detail,id,false,'hardware');
}

function updateTemperatureLive(d,format='串口'){
  if(!d||!Number.isFinite(Number(d.t)))return;
  const value=Number(d.t);
  const now=new Date().toLocaleTimeString('zh-CN',{hour12:false}),channel=MotionCore.temperatureChannels[d.channel];
  const count=channel?Object.values(state.s.samples).filter(x=>x.status!=='out'&&MotionCore.categoryCodes[x.type]===channel.category).length:0;
  $('#tempLiveSample').textContent=channel?`${d.channel} → ${channel.category}类（${channel.type}）· ${count}个在库样本`:d.id||'未绑定';
  $('#tempLiveTime').textContent=now;
  $('#tempLiveFormat').textContent=format;
  if(channel){
    const smooth=emaSmooth(channelSmooth.get(d.channel),value,EMA_ALPHA);
    channelSmooth.set(d.channel,smooth);
    const hi=channel.hi!=null?channel.hi:Number(state.set.hi);
    const lo=channel.lo!=null?channel.lo:Number(state.set.lo);
    const bad=smooth>hi||smooth<lo;
    const warn=!bad&&(smooth>hi-2.5||smooth<lo+2.5);
    const valueNode=$('#temp'+d.channel),timeNode=$('#tempTime'+d.channel),card=$('#tempCard'+d.channel);
    if(valueNode)valueNode.textContent=smooth.toFixed(2);
    if(timeNode)timeNode.textContent=now+' · '+count+'个在库样本';
    if(card)card.className='temp-channel-card '+(bad?'bad':warn?'warn':'good');
  }
}

async function connectSerial(){
  if(window.AndroidHost){ AndroidHost.connect('sensor',Number($('#baudSelect').value)); return; }
  if(!('serial' in navigator)){
    toast('当前环境不支持 Web Serial');
    $(bridge).classList.remove('hidden');
    return;
  }
  try {
    $('#connectBtn').disabled = true;
    port = await navigator.serial.requestPort();
    const baud = parseInt($('#baudSelect').value, 10);
    await port.open({ baudRate: baud });
    state.s.online = 1; state.set.online = 1;
    saveAll(); refreshStats();
    $('#connectBtn').classList.add('hidden');
    $('#disconnectBtn').classList.remove('hidden');
    $('#serialBtn').classList.add('on');
    $('#rackPill').textContent = '在线';
    $('#rackPill').classList.add('on');
    serialBuf = '';
    if(port.readable) readLoop();
    toast('设备已连接 · '+baud+' baud');
    addRecord('系统','连接','设备已通过串口连接');
    monitorActive = true;
    if(state.set.simOn){ $('#simStartBtn').textContent='关闭模拟'; }
  } catch(e){
    toast('连接失败或已取消');
  } finally {
    $('#connectBtn').disabled = false;
  }
}

async function disconnectSerial(){
  if(window.AndroidHost){ AndroidHost.disconnect('sensor'); return; }
  try{
    if(reader){ try{ await reader.cancel(); }catch(e){} reader.releaseLock(); reader=null; }
    if(port){ try{ await port.close(); }catch(e){} port=null; }
  }catch(e){ /* ignore */ }
  serialBuf = '';
  // 复位 UI 状态
  $('#connectBtn').classList.remove('hidden');
  $('#disconnectBtn').classList.add('hidden');
  $('#serialBtn').classList.remove('on');
  $('#rackPill').textContent = '离线';
  $('#rackPill').classList.remove('on');
  state.s.online = 0;
  saveAll(); refreshStats();
  toast('已断开设备');
  briLog('■ 设备已断开','err');
}

async function readLoop(){
  const textDecoder = new TextDecoderStream();
  const stream = port.readable.pipeThrough(textDecoder);
  reader = stream.getReader();
  try {
    while(true){
      const {value, done} = await reader.read();
      if(done) break;
      if(value) parseIncoming(value);
    }
  } catch(e){ }
  finally {
    reader.releaseLock();
  }
}

function parseIncoming(chunk){
  // HC09 LoRa 透明串口：数据按任意分片到达，先把残缺尾段积到下个数据块再按行解析。
  // 期望格式 JSON 行： {"t":25.3,"l":320,"id":"SB-xxx","alert":"warn"}
  serialBuf += chunk;
  let idx;
  while((idx = serialBuf.indexOf('\n')) >= 0){
    const line = serialBuf.slice(0, idx).trim();
    serialBuf = serialBuf.slice(idx + 1);
    if(!line) continue;
    briLog('▶ ' + line, 'rec');
    tempSerialLog('RX ◀ '+line);
    try {
      const decoded=JSON.parse(line);
      const parsed=typeof decoded==='number'?{t:decoded}:decoded;
      if(parsed.temp!=null&&parsed.t==null)parsed.t=Number(parsed.temp);
      updateTemperatureLive(parsed,typeof decoded==='number'?'数值':'JSON');
      applySensorData(parsed);
    } catch(e){
      parseKV(line);  // 非 JSON，尝试简单 k=v 解析
    }
  }
  // 无线信道噪声可能产生无换行的乱码，超限强制丢弃，避免缓冲无限增长
  if(serialBuf.length > 4096) serialBuf = '';
}

function parseKV(s){
  const channelMatch=s.trim().match(/^(B[123])\s+T\s*=\s*(-?\d+(?:\.\d+)?)$/i);
  const m = s.match(/(?:temp(?:erature)?|t)\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  const plain = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:°?c)?$/i);
  const l = s.match(/light\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  const idm = s.match(/id\s*[:=]\s*([\w-]+)/i);
  const obj = {};
  if(channelMatch){obj.channel=channelMatch[1].toUpperCase();obj.t=parseFloat(channelMatch[2]);}
  else if(m||plain) obj.t = parseFloat((m||plain)[1]);
  if(l) obj.l = parseFloat(l[1]);
  if(idm) obj.id = idm[1];
  if(Object.keys(obj).length){updateTemperatureLive(obj,channelMatch?'类别通道':m?'键值':plain?'数值':'串口');applySensorData(obj);}
  else tempSerialLog('无法解析温度数据','err');
}

function applySensorData(d){
  if(!d || typeof d!=='object' || Array.isArray(d))return;
  if(d.temp!=null&&d.t==null)d={...d,t:Number(d.temp)};
  if(['t','l'].some(k=>d[k]!=null && (typeof d[k]!=='number'||!Number.isFinite(d[k])))){briLog('传感器数值无效，已忽略','err');return;}
  if(!['t','l'].some(k=>d[k]!=null))return;
  const channel=MotionCore.temperatureChannels[d.channel];
  if(channel){
    const targets=Object.values(state.s.samples).filter(x=>x.status!=='out'&&MotionCore.categoryCodes[x.type]===channel.category);
    targets.forEach(x=>{updateSampleSensor(x.id,d);appendTempPoint(x.id,d.t,x.alert==='warn'||x.alert==='bad');});
    renderRack();refreshStats();return;
  }
  let tid = null;
  if(d.id && state.s.samples[d.id]) tid = d.id;
  else if(!d.id){ const m = Object.values(state.s.samples).find(x=>x.monitor); if(m) tid = m.id; }
  if(tid){updateSampleSensor(tid,d);const sample=state.s.samples[tid];appendTempPoint(tid,d.t,sample.alert==='warn'||sample.alert==='bad');}
  renderRack();
  refreshStats();
}

let sensorSaveTimer=null;
function scheduleSensorSave(){if(!sensorSaveTimer)sensorSaveTimer=setTimeout(()=>{sensorSaveTimer=null;saveAll();},2000);}
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(sensorSaveTimer);sensorSaveTimer=null;saveAll();}});

/* ==================== 温度追溯：原始点 + 时间窗降采样 ==================== */
const TEMP_RAW_WINDOW_MS=30*60*1000;
const TEMP_BUCKET_MS=60*1000;
const TEMP_RETENTION_MS=7*24*60*60*1000;
const TEMP_RAW_MAX=4000;
const TEMP_ABNORMAL_MAX=130000;
function ensureTemp(id){
  let series=state.set['templog:'+id];
  if(!series){series={raw:[],agg:[]};state.set['templog:'+id]=series;}
  return series;
}
function rollTemp(id,now){
  const series=ensureTemp(id),rawCut=now-TEMP_RAW_WINDOW_MS,retain=now-TEMP_RETENTION_MS;
  let i=0;
  while(i<series.raw.length&&series.raw[i].ts<rawCut){
    const point=series.raw[i],minute=Math.floor(point.ts/TEMP_BUCKET_MS)*TEMP_BUCKET_MS;
    const last=series.agg.length?series.agg[series.agg.length-1]:null;
    if(last&&last.ts===minute&&typeof last.n==='number'){last.t=(last.t*last.n+point.t)/(last.n+1);last.n++;if(point.ab)last.ab=1;}
    else series.agg.push({ts:minute,t:point.t,n:1,ab:point.ab?1:0});
    i++;
  }
  if(i>0)series.raw=series.raw.slice(i);
  if(series.agg.some(point=>point.ts<retain&&!point.ab))series.agg=series.agg.filter(point=>point.ab||point.ts>=retain);
  if(series.agg.length>TEMP_ABNORMAL_MAX)series.agg=series.agg.slice(-TEMP_ABNORMAL_MAX);
}
function appendTempPoint(id,temp,abnormal=false){
  if(temp==null||!Number.isFinite(temp))return;
  const series=ensureTemp(id),now=Date.now();
  series.raw.push({ts:now,t:temp,ab:abnormal?1:0});
  if(series.raw.length>TEMP_RAW_MAX)series.raw=series.raw.slice(-TEMP_RAW_MAX);
  rollTemp(id,now);
  if($('#view-monitor').classList.contains('active') && id === monitorSelId) renderMonitorCharts();
}
function tempSeriesPoints(id){
  const series=state.set['templog:'+id];
  if(!series)return [];
  return (series.agg||[]).map(point=>({ts:point.ts,t:point.t})).concat((series.raw||[]).map(point=>({ts:point.ts,t:point.t})));
}

function updateSampleSensor(id, d){
  const x = state.s.samples[id];
  if(!x) return;
  const runtime=rtOf(id),raw=d.t!=null?d.t:null;
  runtime.smooth=emaSmooth(runtime.smooth,raw,EMA_ALPHA);
  const t=runtime.smooth;
  x.lastTemp=t!=null?t:x.lastTemp;
  x.lastUpdate = FMT.now();
  x.monitor = true;
  const threshold=MotionCore.thresholdFor(MotionCore.categoryCodes[x.type]);
  const hi=threshold?threshold.hi:Number(state.set.hi),lo=threshold?threshold.lo:Number(state.set.lo);
  let target='good';
  if(t != null){
    if(t>hi||t<lo)target='bad';
    else if(t>hi-2.5||t<lo+2.5)target='warn';
  }
  const current=x.alert||'good';
  if(target===current){runtime.pendTarget=null;runtime.pendSince=0;}
  else if(runtime.pendTarget!==target){runtime.pendTarget=target;runtime.pendSince=Date.now();}
  const fire=runtime.pendTarget!=null&&Date.now()-runtime.pendSince>=DEBOUNCE_MS;
  if(fire){
    const previous=current;x.alert=runtime.pendTarget;runtime.pendTarget=null;runtime.pendSince=0;
    logAlertChange(x,previous,x.alert,t,id);saveAll();
  }else scheduleSensorSave();
  recomputeStats();
}

// 报警状态打到 概览
function renderChartFromAlerts(){ if($('#view-dashboard').classList.contains('active')) renderLibChart(); }

/* ==================== 模拟器 ==================== */
function toggleSim(){
  if(state.set.simOn){
    unloadSim();
    $('#simStartBtn').textContent = '开始模拟';
    return;
  }
  state.set.simOn = true;
  $('#simStartBtn').textContent = '关闭模拟';
  briLog('★ 串口桥模拟已开启，每 1.5s 推送一条传感器数据','rec');
  if(!state.s.samples || !Object.keys(state.s.samples).length){
    briLog('提示：先录入至少一个样本并设为监控，才能接收数据。','err');
  }
  simTimer = setInterval(simTick, 1500);
}
function unloadSim(){
  state.set.simOn = false;
  if(simTimer){ clearInterval(simTimer); simTimer=null; }
  $('#simStartBtn').textContent = '开始模拟';
}
let simIdx = 0;
function simTick(){
  const keys = Object.keys(state.s.samples||{}).filter(id => state.s.samples[id].status !== 'out');
  if(!keys.length){ return; }
  const id = keys[simIdx % keys.length];
  simIdx++;
  const base = state.s.samples[id].temp != null ? state.s.samples[id].temp : 4;
  const t = +(base + (Math.random()-0.5)*6).toFixed(2);
  const l = Math.round(200 + Math.random()*300);
  const payload = { t, l, id };
  const line = JSON.stringify(payload);
  briLog('▶ ' + line, 'rec');
  applySensorData(payload);
}
function unloadMonitor(){
  if(simTimer){ clearInterval(simTimer); simTimer=null; }
}

/* ==================== 排架实时 ==================== */
let monitorSelId = null;
function ensureMonitorSel(){
  const x = state.s.samples[monitorSelId];
  if(x && x.status !== 'out') return;
  const first = Object.values(state.s.samples).find(s => s.status !== 'out');
  monitorSelId = first ? first.id : null;
}
function updateMonitorSelUI(){
  const pill = $('#monSelPill');
  if(!pill) return;
  const x = state.s.samples[monitorSelId];
  pill.textContent = x ? x.name : '未选择';
}
function renderRack(){
  if(window.refreshMotionPanel)window.refreshMotionPanel();
  const grid = $('#rackGrid');
  if(!grid) return;
  const keys = Object.keys(state.s.samples||{});
  if(!keys.length){ grid.innerHTML='<div class="empty">暂无样本，录入后可在此查看排架状态</div>'; return; }
  grid.innerHTML = keys.map(id => {
    const x = state.s.samples[id];
    const t = x.lastTemp != null ? x.lastTemp.toFixed(1) : '—';
    const cls = x.alert==='bad'?'bad':(x.alert==='warn'?'warn':'good');
    const st = x.status==='out' ? '已出库' : '已入库';
    const warnTxt = x.alert==='bad' ? '异常' : (x.alert==='warn' ? '预警' : '');
    const stateTxt = warnTxt ? st + ' · ' + warnTxt : st;
    const sel = x.status!=='out' && id === monitorSelId ? ' selected' : '';
    const out = x.status==='out' ? ' out' : '';
    return `<div class="rack-cell ${cls}${sel}${out}" data-id="${id}" onclick="pickSample('${id}')">
      <div class="rc-name">${esc(x.name)}</div>
      <div class="rc-temp">${t}℃</div>
      <div class="rc-state">${stateTxt}</div>
    </div>`;
  }).join('');
}
window.pickSample = function(id){
  const x = state.s.samples[id];
  if(!x) return;
  if(x.status === 'out'){ toast('样本「'+x.name+'」已出库，无法查看实时数据'); return; }
  if(monitorSelId === id) return;
  monitorSelId = id;
  renderRack();
  renderMonitorCharts();
};

/* ==================== 温度图表（监测页） ==================== */
let tempChart=null;
function renderMonitorCharts(){
  const ctx1 = $('#chartTemp');
  if(!ctx1) return;
  updateMonitorSelUI();
  const x = state.s.samples[monitorSelId];
  const hist = x ? tempSeriesPoints(x.id) : [];
  const labels = hist.map((h,i)=>i);
  const temps = hist.map(h=>h.t);
  // fill 到数据下界而非 y=0，避免全负数据（如 -80℃ 低温样本）填充整个图表
  const tempFloor = Math.min(0, ...temps.filter(v=>v!=null));
  const fillTo = v => ({ target: { value: v } });
  if(tempChart){
    tempChart.data.labels = labels;
    tempChart.data.datasets[0].data = temps;
    tempChart.data.datasets[0].fill = fillTo(tempFloor);
    tempChart.update('none');
  } else {
    tempChart = new Chart(ctx1, { type:'line', data:{labels, datasets:[{data:temps,borderColor:'#0a69ff',backgroundColor:'rgba(10,105,255,0.08)',fill:fillTo(tempFloor),tension:.4,pointRadius:0,borderWidth:2}]},
      options:{responsive:true,aspectRatio:2.4,plugins:{legend:{display:false}},scales:{x:{display:false},y:{grid:{color:'rgba(0,0,0,0.05)'},ticks:{font:{size:11},color:'#6e6e73'}}}} });
  }

}

/* ==================== 后台实时刷新监测图表 ==================== */
let monitorRefreshTimer = null;
function ensureMonitorRefresh(){
  if(monitorRefreshTimer) return;
  monitorRefreshTimer = setInterval(()=>{
    if($('#view-monitor').classList.contains('active')) renderMonitorCharts();
  }, 3000);
}

/* ==================== HTTP 数据桥（经 server.js 方式 B） ==================== */
let httpBridgeTimer = null;
function startHttpBridge(){
  // 仅由本服务器(server.js)提供页面时才启用轮询；file: 或静态预览(无 vitals-backend 标记)时不轮询，
  // 否则对不存在的 /api/stream 每 1.8s 触发一次 ERR_CONNECTION_REFUSED 刷屏
  if(location.protocol === 'file:') return;
  if(!document.querySelector('meta[name="vitals-backend"]')) return;
  if(httpBridgeTimer) return;
  httpBridgeTimer = setInterval(async ()=>{
    try{
      const r = await fetch('/api/stream', {cache:'no-store'});
      if(!r.ok) return;
      const j = await r.json();
      const arr = j.data || [];
      if(!arr.length) return;
      const last = arr[arr.length-1];
      if(window.__lastBridge && Date.now() - window.__lastBridge.time < 600) return;
      window.__lastBridge = { time: last.time };
      applySensorData(last);
    }catch(e){
      // 后端运行中断开：停止轮询，避免持续打 ERR_CONNECTION_REFUSED
      if(httpBridgeTimer){ clearInterval(httpBridgeTimer); httpBridgeTimer = null; }
    }
  }, 1800);
}

function renderTemperatureRanges(){
  Object.entries(MotionCore.temperatureChannels).forEach(([channel,config])=>{
    const element=$('#tempRange'+channel);
    if(element)element.textContent=`适宜存储温度 ${config.lo}℃ ~ ${config.hi}℃`;
  });
}

/* ==================== 全局初始化 ==================== */
function init(){
  // 安卓首次启动保持空库，不自动生成示例样本。
  addSampleBtnInit();
  bindRecordFilters();
  bindImportUI();
  installExportCard();
  recomputeStats(); refreshStats();
  renderLibrary();
  renderRecords();
  fillSettings();
  renderFeed();
  renderTemperatureRanges();
  startHttpBridge();
  refreshBuildTag();
  // 定期刷新概览图表
  setInterval(()=>{ if($('#view-dashboard').classList.contains('active')) renderLibChart(); }, 5000);
  goView('dashboard');
}

document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    if($('#importModal') && $('#importModal').classList.contains('open')) closeImportModal();
    else if($('#detailModal').classList.contains('open')) $('#detailModal').classList.remove('open');
    else if($('#sampleModal').classList.contains('open')) $('#sampleModal').classList.remove('open');
  }
});

// 初始化
document.addEventListener('DOMContentLoaded', init);

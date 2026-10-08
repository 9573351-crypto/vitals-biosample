// One-off transformation of the independent Android copy, using exact audited anchors.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),web=path.join(root,'app/src/main/assets/web');
const p=path.join(web,'app.js');let s=fs.readFileSync(p,'utf8');
s=s.slice(0,s.indexOf('const Store = {'))+s.slice(s.indexOf('let state = Store.load();'));
s=s.replace(`function addRecord(sampleName, type, detail){
  state.rec.unshift({ time: FMT.now(), sample: sampleName, type, detail });
  if (state.rec.length > 500) state.rec.length = 500;
  saveAll();
}`,`function addRecord(sampleName, type, detail, sampleId=null, persist=true){
  const sample=sampleId ? state.s.samples[sampleId] : null;
  const record={time:FMT.now(),sample:sampleName,type,detail,sampleId};
  if(sample){record.code=sample.code||null;record.slot=sample.slot||null;record.status=sample.status;}
  state.rec.unshift(record);
  if(state.rec.length>500)state.rec.length=500;
  return !persist || saveAll();
}`);
const start=s.indexOf('function legacySetSampleStatus('),end=s.indexOf('/* 右键删除单条样本 */',start);
s=s.slice(0,start)+s.slice(end);
s=s.replace(`    saveAll(); recomputeStats(); refreshStats();
    addRecord(x.name, '删除', '删除样本「'+x.name+'」');`, `    addRecord(x.name, '删除', '删除样本「'+x.name+'」', null, false);
    state.rec[0].code=x.code||null;
    if(!saveAll())return;
    recomputeStats(); refreshStats();`);
s=s.replace("addRecord(name, '编辑', `更新样本「${name}」信息`);", "addRecord(name, '编辑', `更新样本「${name}」信息`, editingId, false);");
s=s.replace("addRecord(name, '录入', `新增样本「${name}」（${code}）`);", "addRecord(name, '录入', `新增样本「${name}」（${code}）`, id, false);");
s=s.replace("  catch(e){ try{ console.warn('SAVE_FAIL', e); }catch(_){} return false; }",`  catch(e){
    console.warn('SAVE_FAIL',e);
    try{state=Store.load();queueMicrotask(()=>{reloadUI();fillSettings();if(typeof renderTask==='function')renderTask();});}catch(loadError){console.error(loadError);}
    toast('保存失败，数据库保持原状态：'+e.message);return false;
  }`);
const resetStart=s.indexOf('    // 先直接删除持久化键'),resetEnd=s.indexOf("    toast('已清空全部数据');",resetStart);
s=s.slice(0,resetStart)+`    if(state.set.motionTask){toast('请先处理当前任务');return;}
    try{state=Store.replace(JSON.stringify({samples:{},records:[],settings:{hi:8,lo:-88,simOn:false}}));}
    catch(e){toast('清空失败：'+e.message);return;}
    unloadSim();reloadUI();fillSettings();
`+s.slice(resetEnd);
const expStart=s.indexOf('  const backup = {',s.indexOf('function exportData()')),expEnd=s.indexOf('  const content = ',expStart);
s=s.slice(0,expStart)+`  if(!saveAll())return;
  let backup;try{backup=Store.backup();}catch(e){toast('导出失败：'+e.message);return;}
`+s.slice(expEnd);
const importStart=s.indexOf('  reader.onload = () => {',s.indexOf('function importData(')),importEnd=s.indexOf('  reader.readAsText(f);',importStart);
s=s.slice(0,importStart)+`  reader.onload=()=>receiveImport(String(reader.result));
`+s.slice(importEnd);
s=s.replace(`  let kb = 0;
  try{ kb = Math.round((localStorage.getItem(Store.key)||'').length/1024); }catch(e){}
  bt.textContent = \`构建 \${BUILD} · 样本 \${state.s.total||0} · 存储 \${kb}KB\`;`,"  bt.textContent = `Android 1.1 · SQLite 分表 · 样本 ${state.s.total||0}`;");
s=s.replace("  saveThrowState();\n  if($('#view-monitor')", "  if($('#view-monitor')");
s=s.replace("if(changed && alert !== 'good') addRecord(x.name, '告警', `样本「${x.name}」温度 ${t.toFixed(2)}℃ ${alert==='bad'?'异常':'预警'}`);\n  saveThrowState();", "if(changed && alert !== 'good') addRecord(x.name, '告警', `样本「${x.name}」温度 ${t.toFixed(2)}℃ ${alert==='bad'?'异常':'预警'}`, id, false);\n  if(changed)saveAll();else scheduleSensorSave();");
s=s.replace('function pushSampleEnv(id, d){',`let sensorSaveTimer=null;
function scheduleSensorSave(){if(!sensorSaveTimer)sensorSaveTimer=setTimeout(()=>{sensorSaveTimer=null;saveAll();},2000);}
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(sensorSaveTimer);sensorSaveTimer=null;saveAll();}});
function pushSampleEnv(id, d){`);
fs.writeFileSync(p,s);
let html=fs.readFileSync(path.join(web,'index.html'),'utf8').replace('<script src="app.js?v=24" defer></script>','<script src="persistence.js" defer></script><script src="app.js?v=24" defer></script>');fs.writeFileSync(path.join(web,'index.html'),html);

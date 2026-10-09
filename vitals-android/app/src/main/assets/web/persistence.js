'use strict';
/* 持久化适配层。
   - 业务数据只存放在原生 SQLite（Android）或浏览器 localStorage（网页预览桥）；
     页面不再用 localStorage 缓存业务数据，也没有 QuotaExceeded 分支。
   - 启动加载：优先 snapshot() 单事务一致性读（契约 B）；老版本原生 / 网页预览桥没有该桥方法时，
     回退到 getDatabaseInfo+getSamples+getRecords+getSettings 四次调用 + revision 三次重试。
   - 保存：始终是行级差分 commitChanges（增改删样本 / 增删记录 / 增删设置），不会整库重写。
   - 契约 A–G 的新桥方法在这里统一做能力探测，缺失时返回 null / 抛业务错误，由界面层降级。 */
const Store = {
  baseline:null, revision:0,

  /* ==================== 桥能力探测 ==================== */
  has(name){return typeof AndroidHost!=='undefined'&&AndroidHost&&typeof AndroidHost[name]==='function';},
  // 契约 A–G 随同一版本原生一起发布，以 snapshot()+exportBackup() 作为“新桥”整体标记
  get modernBridge(){return this.has('snapshot')&&this.has('exportBackup');},
  canGetPhoto(){return this.has('getSamplePhoto');},
  canPageRecords(){return this.has('recordsPage');},
  canExportCsv(){return this.has('exportCsv');},
  canExportBackup(){return this.has('exportBackup');},
  // @JavascriptInterface 不支持同名重载，新导入入口是独立方法 importBackupEx
  canPreviewImport(){return this.has('importBackupEx');},

  defaults(){return {total:0,active:0,online:0,alert:0,samples:{},samplesSeeded:true};},

  result(json){const x=JSON.parse(json);if(x&&x.ok===false)throw Error(x.error||'数据库操作失败');return x;},

  capture(data){
    this.baseline={samples:Object.fromEntries(Object.entries(data.s.samples).map(([id,x])=>[id,JSON.stringify(x)])),records:new Set(data.rec.map(r=>r.recordId).filter(Boolean)),settings:Object.fromEntries(Object.entries(data.set).map(([k,v])=>[k,JSON.stringify(v)]))};
  },

  /* snapshot()：单事务一致读（契约 B）。桥不存在或读取失败时返回 null，由 load() 回退。 */
  readSnapshot(){
    if(!this.has('snapshot'))return null;
    let raw;
    try{ raw=JSON.parse(AndroidHost.snapshot()); }
    catch(e){ console.warn('SNAPSHOT_FALLBACK',e); return null; }
    if(!raw||typeof raw!=='object'||raw.ok===false){
      if(raw&&raw.error)console.warn('SNAPSHOT_FALLBACK',raw.error);
      return null;
    }
    // 兼容两种形状：{"s":{samples:...}} 与 {"s":{id:样本}}（后者是历史 getSamples() 的形状）
    const inner=raw.s, stateful=inner&&typeof inner==='object'&&inner.samples&&typeof inner.samples==='object';
    const samples=stateful?inner.samples:(inner&&typeof inner==='object'?inner:{});
    const data={s:{...this.defaults(),...(stateful?inner:{}),samples},
      rec:Array.isArray(raw.rec)?raw.rec:[],
      set:{hi:8,lo:-88,...(raw.set&&typeof raw.set==='object'?raw.set:{}),simOn:false,online:0}};
    this.revision=Number(raw.revision)||0;
    this.capture(data);
    return data;
  },

  load(){
    const snapshot=this.readSnapshot();
    if(snapshot)return snapshot;
    if(!this.has('getDatabaseInfo'))throw Error('未检测到数据库桥，请使用 Android 应用或网页预览版打开');
    // 回退路径（老版本原生 / 预览桥）：revision 重试保证多次读取之间没有并发写入
    for(let attempt=0;attempt<3;attempt++){
      const start=this.result(AndroidHost.getDatabaseInfo()).revision;
      const samples=this.result(AndroidHost.getSamples()),rec=this.result(AndroidHost.getRecords('')),set=this.result(AndroidHost.getSettings());
      const end=this.result(AndroidHost.getDatabaseInfo()).revision;if(start!==end)continue;
      const data={s:{...this.defaults(),samples},rec,set:{hi:8,lo:-88,...set,simOn:false,online:0}};
      this.revision=end;this.capture(data);return data;
    }
    throw Error('数据库正被修改，请重新打开页面');
  },

  save(data){
    if(!this.baseline)throw Error('数据库尚未加载');
    const b=this.baseline;
    const adds=data.rec.filter(r=>!r.recordId);
    const currentIds=new Set(data.rec.map(r=>r.recordId));
    const delta={expectedRevision:this.revision,
      upsertSamples:Object.entries(data.s.samples).filter(([id,x])=>b.samples[id]!==JSON.stringify(x)).map(([,x])=>x),
      deleteSamples:Object.keys(b.samples).filter(id=>!Object.prototype.hasOwnProperty.call(data.s.samples,id)),
      addRecords:adds,
      deleteRecords:[...b.records].filter(id=>!currentIds.has(id)),
      setSettings:Object.fromEntries(Object.entries(data.set).filter(([k,v])=>b.settings[k]!==JSON.stringify(v))),
      deleteSettings:Object.keys(b.settings).filter(k=>!Object.prototype.hasOwnProperty.call(data.set,k))};
    if(!delta.upsertSamples.length&&!delta.deleteSamples.length&&!adds.length&&!delta.deleteRecords.length&&!Object.keys(delta.setSettings).length&&!delta.deleteSettings.length)return;
    const result=this.result(AndroidHost.commitChanges(JSON.stringify(delta)));
    if(!result.ok)throw Error('事务提交失败');
    adds.forEach((r,i)=>r.recordId=result.recordIds[i]);
    // Mirror ON DELETE SET NULL without losing historical name/code snapshots.
    for(const r of data.rec)if(delta.deleteSamples.includes(r.sampleId))r.sampleId=null;
    this.revision=result.revision;this.capture(data);
  },

  /* ==================== 契约 A：照片按需读取 ==================== */
  samplePhoto(id,full=false){
    if(!this.canGetPhoto())return null;
    try{
      const info=this.result(AndroidHost.getSamplePhoto(String(id),!!full));
      return info&&typeof info==='object'?info:null;
    }catch(e){ console.warn('PHOTO_READ_FAIL',e); return null; }
  },

  /* ==================== 契约 C：记录分页 ==================== */
  recordsPage(fromIso,toIso,typeCode,limit,offset){
    if(!this.canPageRecords())return null;
    try{
      const page=this.result(AndroidHost.recordsPage(String(fromIso||''),String(toIso||''),String(typeCode||''),Number(limit)||200,Number(offset)||0));
      if(!page||!Array.isArray(page.records))return null;
      return {records:page.records,total:Number(page.total)||0,hasMore:!!page.hasMore};
    }catch(e){ console.warn('RECORDS_PAGE_FAIL',e); return null; }
  },

  /* ==================== 契约 F：备份导出 / 校验 / 合并导入 ==================== */
  exportBackup(includePhotos){
    if(this.canExportBackup()){
      const backup=this.result(AndroidHost.exportBackup(!!includePhotos));
      if(backup&&typeof backup==='object')return backup;
    }
    // 老版本只有 getBackup()（含全图，体积大）
    return this.backup();
  },
  exportBackupText(includePhotos){
    return JSON.stringify(this.exportBackup(includePhotos),null,2);
  },
  /* 统一导入入口：新原生用 importBackupEx(payload,mode,filterJson)；老原生/预览桥只有 1 参 importBackup（整库替换）。 */
  importBackup(payload,mode,filterJson){
    if(this.has('importBackupEx')){
      const args=[String(payload),String(mode||'merge')];
      if(filterJson)args.push(String(filterJson));
      const result=this.result(AndroidHost.importBackupEx(...args));
      return result&&typeof result==='object'?result:{ok:true};
    }
    if(!this.has('importBackup'))throw Error('当前版本不支持导入备份');
    const result=this.result(AndroidHost.importBackup(String(payload)));
    return {...(result&&typeof result==='object'?result:{}),ok:true,mode:'replace',legacy:true};
  },
  /* 预览不改库；桥不支持预览时返回 null，由界面层退回一次性替换流程。 */
  importPreview(payload,filterJson){
    if(!this.has('importBackupEx'))return null;
    try{
      const result=this.result(AndroidHost.importBackupEx(String(payload),'preview',filterJson?String(filterJson):''));
      return result&&typeof result==='object'?result:{ok:false,error:'预览结果无效'};
    }catch(e){ return {ok:false,error:e&&e.message?e.message:'预览失败'}; }
  },
  /* 强制整库替换：走契约保留的 1 参兼容入口（新原生 = replaceBackup，老原生同义）。
     需要“按库是否为空自动选择 replace/merge”的场景请用 importBackup(payload,mode)。 */
  replace(text){
    if(!this.has('importBackup'))throw Error('当前版本不支持导入备份');
    this.result(AndroidHost.importBackup(String(text)));
    return this.load();
  },
  backup(){return this.result(AndroidHost.getBackup());},

  /* ==================== 契约 G：CSV 导出 ==================== */
  exportCsvText(kind,options){
    if(!this.canExportCsv())throw Error('当前版本不支持 CSV 导出');
    const raw=AndroidHost.exportCsv(String(kind),options==null?'':JSON.stringify(options));
    const text=String(raw==null?'':raw);
    const probe=text.replace(/^\uFEFF/,'').trim();
    if(probe.startsWith('{')){
      let parsed=null;try{parsed=JSON.parse(probe);}catch(e){/* 真 CSV 不会以 { 开头 */}
      if(parsed&&parsed.ok===false)throw Error(parsed.error||'导出失败');
    }
    return text;
  },

  /* ==================== 清空：行级差分，非空库同样可用 ==================== */
  clearAll(settings){
    const empty={s:this.defaults(),rec:[],set:{hi:8,lo:-88,...(settings||{}),simOn:false,online:0}};
    this.save(empty);
    return this.load();
  }
};

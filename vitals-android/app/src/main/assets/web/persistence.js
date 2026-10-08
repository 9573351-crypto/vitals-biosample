'use strict';
// Rendering compatibility adapter. No full state is sent to SQLite on ordinary saves.
// Each changed sample / appended record / changed setting becomes a row-level change.
const Store = {
  baseline:null, revision:0,
  defaults(){return {total:0,active:0,online:0,alert:0,samples:{},samplesSeeded:true};},
  defaultsShort(){return {s:this.defaults(),rec:[],set:{hi:8,lo:-88,simOn:false}};},
  result(json){const x=JSON.parse(json);if(x&&x.ok===false)throw Error(x.error||'数据库操作失败');return x;},
  capture(data){
    this.baseline={samples:Object.fromEntries(Object.entries(data.s.samples).map(([id,x])=>[id,JSON.stringify(x)])),records:new Set(data.rec.map(r=>r.recordId).filter(Boolean)),settings:Object.fromEntries(Object.entries(data.set).map(([k,v])=>[k,JSON.stringify(v)]))};
  },
  load(){
    // A revision check keeps this multi-query startup snapshot consistent with native CRUD.
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
  replace(text){this.result(AndroidHost.importBackup(text));return this.load();},
  backup(){return this.result(AndroidHost.getBackup());}
};

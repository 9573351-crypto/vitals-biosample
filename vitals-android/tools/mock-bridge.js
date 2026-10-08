// Browser UI test double only. Native SQLite constraints are tested by DatabaseInstrumentation.
(()=>{
const read=()=>JSON.parse(localStorage.getItem('test-native')||'{"samples":{},"records":[],"settings":{},"revision":0,"nextId":1}');
const store=x=>localStorage.setItem('test-native',JSON.stringify(x));
window.nativeCalls=[];
const methods={
 getDatabaseInfo:()=>({revision:read().revision,version:3}),getSamples:()=>read().samples,
 getExternalDevices:()=>({scanner:1,printer:1}),
 getRecords:id=>read().records.filter(r=>!id||r.sampleId===id),getSettings:()=>read().settings,
 getSample:id=>read().samples[id]||null,getSampleByBarcode:code=>Object.values(read().samples).find(s=>s.code===code)||null,
 getBackup:()=>({app:'vitals-biosample',version:2,samples:read().samples,records:read().records,settings:read().settings}),
 getBackupStatus:()=>({configured:false,lastSuccess:0}),
 commitChanges:json=>{
  if(window.failCommit){window.failCommit=false;throw Error('测试注入：磁盘写入失败');}
  const d=JSON.parse(json),db=read();if(d.expectedRevision!==db.revision)throw Error('revision conflict');
  db.records=db.records.filter(r=>!d.deleteRecords.includes(r.recordId));
  for(const id of d.deleteSamples){delete db.samples[id];for(const r of db.records)if(r.sampleId===id)r.sampleId=null;}
  for(const x of d.upsertSamples)db.samples[x.id]=x;
  const codes=new Set(),slots=new Set();for(const s of Object.values(db.samples)){
   if(s.code&&codes.has(s.code))throw Error('条码重复');codes.add(s.code);
   if(s.slot!=null){const key=s.type+'\u0000'+s.slot;if(s.slot<1||s.slot>5||!MotionCore.storageTypes.includes(s.type)||slots.has(key))throw Error('圆盘槽位冲突');slots.add(key);}
  }
  const ids=new Array(d.addRecords.length);for(let i=d.addRecords.length-1;i>=0;i--){const r={...d.addRecords[i],recordId:db.nextId++};if(r.sampleId&&!db.samples[r.sampleId])throw Error('FK');db.records.unshift(r);ids[i]=r.recordId;}
  Object.assign(db.settings,d.setSettings);for(const k of d.deleteSettings)delete db.settings[k];db.revision++;store(db);return {ok:true,revision:db.revision,recordIds:ids};
 },
 importBackup:json=>{
  if(read().settings.motionTask)throw Error('未完成任务');
  const b=MotionCore.validateBackup(JSON.parse(json)),db=read();
  db.samples=b.samples;db.records=[];for(let i=b.records.length-1;i>=0;i--)db.records.unshift({...b.records[i],recordId:db.nextId++});db.settings=b.settings;db.revision++;store(db);return {ok:true};
 }
};
window.AndroidHost={};for(const [name,fn] of Object.entries(methods))AndroidHost[name]=(...args)=>{nativeCalls.push({name,args});try{return JSON.stringify(fn(...args));}catch(e){return JSON.stringify({ok:false,error:e.message});}};
Object.assign(AndroidHost,{connect:()=>{},disconnect:()=>{},send:()=>{},importJson:()=>{},exportJson:(n,c)=>window.lastExport=JSON.parse(c),printLabel:()=>{window.printCalled=true;},chooseBackupDirectory:()=>{},backupNow:()=>{},disableAutoBackup:()=>{}});
})();

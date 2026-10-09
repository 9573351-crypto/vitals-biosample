const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
// Playwright 的安装位置因机器而异，且本测试只是可选回归项：
// 依次尝试 PLAYWRIGHT_PATH → 正常 require → 常见缓存/全局目录 → NODE_PATH 与向上查找 node_modules；
// 全部失败时打印可读提示并以退出码 0 跳过，不阻塞其他测试。
function loadChromium(){
 const tried=[];
 const attempt=spec=>{try{const mod=require(spec);if(mod&&mod.chromium)return mod.chromium;tried.push(spec+' → 未导出 chromium');}catch(e){tried.push(spec+' → '+((e&&e.code)||(e&&e.message)||String(e)));}return null;};
 if(process.env.PLAYWRIGHT_PATH){const c=attempt(process.env.PLAYWRIGHT_PATH);if(c)return c;}
 for(const spec of ['playwright','playwright-core']){try{const c=attempt(require.resolve(spec));if(c)return c;}catch(e){tried.push(spec+' → '+((e&&e.code)||String(e)));}}
 const candidates=[
  path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright'),
  path.join(os.homedir(),'AppData','Roaming','npm','node_modules','playwright'),
  path.join(os.homedir(),'.npm-global','lib','node_modules','playwright'),
  '/usr/local/lib/node_modules/playwright',
  '/usr/lib/node_modules/playwright'
 ];
 for(const root of [process.cwd(),__dirname]){
  let dir=root;
  for(let i=0;i<6;i++){candidates.push(path.join(dir,'node_modules','playwright'));const parent=path.dirname(dir);if(parent===dir)break;dir=parent;}
 }
 for(const entry of (process.env.NODE_PATH||'').split(path.delimiter).filter(Boolean))candidates.push(path.join(entry,'playwright'));
 for(const candidate of [...new Set(candidates)]){const c=attempt(candidate);if(c)return c;}
 console.log('SKIP: 未找到 playwright 模块，跳过界面回归测试（退出码 0，不阻塞其他测试）。');
 console.log('      处理方式：设置 PLAYWRIGHT_PATH 指向 playwright 目录，或在仓库执行 npm i -D playwright / npm i -g playwright。');
 for(const line of tried)console.log('      已尝试 '+line);
 return null;
}
const chromium=loadChromium();
if(!chromium)process.exit(0);
const root=path.resolve(__dirname,'../app/src/main/assets/web');
(async()=>{
const server=http.createServer((req,res)=>{try{let name=decodeURIComponent(req.url.split('?')[0]);if(name==='/')name='/index.html';const p=path.join(root,name);if(!p.startsWith(root))throw Error();res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.endsWith('.html')?'text/html':'image/png');res.end(fs.readFileSync(p));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript({path:path.resolve(__dirname,'mock-bridge.js')});
await page.goto('http://127.0.0.1:'+server.address().port);await page.addScriptTag({content:'var module=undefined,exports=undefined,define=undefined;'+fs.readFileSync(path.join(root,'vendor/jsQR.js'),'utf8')});await page.waitForTimeout(500);
assert.equal(await page.locator('#backupCard').count(),1);
assert.equal(await page.locator('#backupPill').innerText(),'未设置');
assert.equal(await page.locator('#backupNow').isDisabled(),true);
assert.equal(await page.locator('#statTotal').innerText(),'0');
assert.equal(await page.locator('#statOnline').innerText(),'2');
assert.equal(await page.locator('#statOnlineDetail').innerText(),'温控 0 · 机械 0 · 扫码枪 1 · 打印机 1');
await page.evaluate(()=>onAndroidEvent('devices','external','{"scanner":2,"printer":0}'));
assert.equal(await page.locator('#statOnline').innerText(),'2');
assert.equal(await page.locator('#statOnlineDetail').innerText(),'温控 0 · 机械 0 · 扫码枪 2 · 打印机 0');
await page.evaluate(()=>onAndroidEvent('devices','external','{"scanner":1,"printer":1}'));
await page.locator('#deviceOnlineCard').click();
assert.equal(await page.locator('#view-devices').evaluate(el=>el.classList.contains('active')),true);
assert.equal(await page.locator('#pageTitle').innerText(),'设备连接');
assert.equal(await page.locator('#sensorDevicePanel').count(),1);
assert.equal(await page.locator('#scannerDeviceActions').count(),1);
assert.equal(await page.locator('#scannerQuery').count(),1);
assert.equal(await page.locator('#scannerNew').count(),0);
assert.equal(await page.locator('#scannerFillCode').count(),1);
assert.equal(await page.locator('#motionDeviceMount .android-motion').count(),1);
assert.equal(await page.locator('#motionDeviceMount .inventory-operations').count(),0);
assert.equal(await page.locator('#motionOperationMount .inventory-operations').count(),1);
assert.equal(await page.locator('#printerDeviceCard').count(),1);
assert.equal(await page.locator('[data-view="inventory"]').count(),0);
await page.locator('[data-view="library"]').click();await page.locator('#addSampleBtn').click();
assert.deepEqual(await page.locator('#fSlot option').allInnerTexts(),['1 号 · 空闲','2 号 · 空闲','3 号 · 空闲','4 号 · 空闲','5 号 · 空闲']);
assert.equal(await page.locator('#fSlot').inputValue(),'1');
await page.locator('#fName').fill('安卓测试血清');await page.locator('#fCode').fill('TEST-001');await page.locator('#modalSave').click();
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'out');
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].plannedSlot),1);
const id=await page.evaluate(()=>Object.keys(state.s.samples)[0]);
assert.equal(await page.evaluate(()=>state.rec[0].sampleId),id);
await page.evaluate(()=>{nativeCalls.length=0;saveAll();});
assert.equal(await page.evaluate(()=>nativeCalls.filter(c=>c.name==='commitChanges').length),0);
await page.evaluate(id=>{openModal(id);$('#fName').value='已编辑样本';$('#modalSave').click();},id);
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].name),'已编辑样本');
await page.locator('[data-view="monitor"]').click();
await page.evaluate(()=>parseIncoming('{"temp":6.25,"id":"TEST-001"}\n'));
assert.equal(await page.locator('#tempLiveFormat').innerText(),'JSON');
await page.evaluate(()=>parseIncoming('T:7.5\n'));
assert.equal(await page.locator('#tempLiveFormat').innerText(),'键值');
await page.evaluate(()=>parseIncoming('-18.75\n'));
assert.equal(await page.locator('#tempLiveFormat').innerText(),'数值');
assert.equal(await page.locator('#tempLiveValue,#tempLiveQuality,.temp-live-reading').count(),0);
await page.evaluate(()=>parseIncoming('B1 T=27.50\nB2 T=27.00\nB3 T=26.75\n'));
assert.equal(await page.locator('#tempB1').innerText(),'27.50');
assert.equal(await page.locator('#tempB2').innerText(),'27.00');
assert.equal(await page.locator('#tempB3').innerText(),'26.75');
assert.equal(await page.evaluate(()=>emaSmooth(10,20,EMA_ALPHA)),13);
await page.evaluate(()=>parseIncoming('B1 T=37.50\n'));
assert.equal(await page.locator('#tempB1').innerText(),'30.50');
assert.equal(await page.locator('#tempLiveFormat').innerText(),'类别通道');
assert.deepEqual(await page.locator('.temp-range').allInnerTexts(),['适宜存储温度 30℃ ~ 65℃','适宜存储温度 25℃ ~ 65℃','适宜存储温度 25℃ ~ 60℃']);
// Zero is a valid limit; invalid bounds and failed saves must not report success.
await page.evaluate(()=>{$('#setHi').value='0';$('#setHi').dispatchEvent(new Event('change'));});
assert.equal(await page.evaluate(()=>Store.result(AndroidHost.getSettings()).hi),0);
await page.evaluate(()=>{$('#setLo').value='1';$('#setLo').dispatchEvent(new Event('change'));});
assert.equal(await page.evaluate(()=>state.set.lo),-88);
assert.equal(await page.locator('#setLo').inputValue(),'-88');
const settingToasts=await page.evaluate(()=>{
 const original=toast,messages=[];toast=message=>messages.push(message);
 try{window.failCommit=true;$('#setHi').value='5';$('#setHi').dispatchEvent(new Event('change'));}finally{toast=original;}
 return messages;
});
assert.ok(settingToasts.some(x=>x.startsWith('保存失败')));
assert.ok(!settingToasts.includes('已保存'));
assert.equal(await page.evaluate(()=>state.set.hi),0);
await page.evaluate(()=>{window.failCommit=true;state.s.samples[Object.keys(state.s.samples)[0]].name='不能保存';saveAll();});
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].name),'已编辑样本');
await page.evaluate(id=>setSampleStatus(id,'in'),id);await page.locator('#confirmYes').click();
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'out');
// A concurrent native update must remain authoritative after a rejected UI write.
await page.evaluate(()=>{
 const task=state.set.motionTask;
 const delta={expectedRevision:Store.revision,upsertSamples:[],deleteSamples:[],addRecords:[],deleteRecords:[],setSettings:{motionTask:{...task,phase:'uncertain',error:'数据库中的最新反馈'}},deleteSettings:[]};
 Store.result(AndroidHost.commitChanges(JSON.stringify(delta)));
 if(persistTask({...task,phase:'arrived'}))throw Error('Expected revision conflict');
});
assert.equal(await page.evaluate(()=>state.set.motionTask.phase),'uncertain');
assert.equal(await page.evaluate(()=>state.set.motionTask.error),'数据库中的最新反馈');
await page.locator('#positionChecked').check();
await page.evaluate(()=>{
 const sample=Object.values(state.s.samples)[0];
 Store.result(AndroidHost.commitChanges(JSON.stringify({expectedRevision:Store.revision,upsertSamples:[{...sample,note:'数据库最新备注'}],deleteSamples:[],addRecords:[],deleteRecords:[],setSettings:{},deleteSettings:[]})));
 finishTask();
});
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'out');
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].note),'数据库最新备注');
assert.ok(await page.evaluate(()=>state.set.motionTask));
await page.locator('#positionChecked').check();await page.locator('#finishTask').click();
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'in');
await page.reload();await page.waitForTimeout(200);
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].slot),1);
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].plannedSlot),undefined);
await page.evaluate(id=>setSampleStatus(id,'out'),id);await page.locator('#confirmYes').click();
assert.equal(await page.locator('#scannerVerifyOut,#scannerVerifyStatus').count(),0);
assert.match(await page.locator('.android-check').innerText(),/样本已取出/);
await page.locator('#positionChecked').check();await page.locator('#finishTask').click();
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].slot),undefined);
await page.evaluate(()=>exportData());assert.equal((await page.evaluate(()=>window.lastExport)).samples[id].status,'out');
await page.evaluate(id=>{openDetail(id);$('#printBtn').click();$('#systemPrint').click();$('#closeDetail').click();},id);
assert.equal(await page.evaluate(()=>window.printCalled),true);
// Preview must preserve the complete Chinese QR payload; no USB job without paper confirmation.
await page.addScriptTag({content:'var module=undefined,exports=undefined,define=undefined;'+fs.readFileSync(path.join(root,'vendor/jsQR.js'),'utf8')});
await page.evaluate(id=>openUsbLabelPrint(state.s.samples[id]),id);
assert.equal(await page.locator('#usbPrintSend').isDisabled(),true);
await page.locator('#labelWidth').fill('60');await page.locator('#labelHeight').fill('60');await page.locator('#labelGap').fill('2');
assert.equal(await page.evaluate(()=>{
 const c=document.querySelector('#labelPreview canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height);
 return jsQR(p.data,c.width,c.height).data===sampleQRText(Object.values(state.s.samples)[0]);
}),true);
assert.equal(await page.locator('#usbPrintSend').isDisabled(),true);
await page.evaluate(()=>{window.usbJobs=[];AndroidHost.printUsbLabel=p=>usbJobs.push(JSON.parse(p));});
await page.locator('#labelPaperReady').check();await page.locator('#usbPrintSend').click();
assert.equal(await page.evaluate(()=>usbJobs.length),1);
assert.equal(await page.locator('#usbPrintSend').isDisabled(),true);
await page.evaluate(()=>onAndroidEvent('sent','printer','已发送 1 张标签，请检查实际出纸结果'));
assert.equal(await page.locator('#labelPaperReady').isChecked(),false);
await page.locator('#labelWidth').fill('81');assert.equal(await page.locator('#usbPrintSend').isDisabled(),true);
await page.locator('#labelWidth').fill('20');await page.locator('#labelHeight').fill('20');
assert.match(await page.locator('#labelLayoutStatus').innerText(),/自动排版/);
const sizes=await page.evaluate(()=>{
 const sample=Object.values(state.s.samples)[0];
 return [[30,20],[20,30],[20,20],[40,30],[60,40],[80,100]].map(([w,h])=>{
  const c=renderUsbLabel(sample,w,h),pixels=c.getContext('2d').getImageData(0,0,c.width,c.height);
  const result=jsQR(pixels.data,c.width,c.height);
  return {w:c.width,h:c.height,expectedW:w*8,expectedH:h*8,decoded:result?.data===sampleQRText(sample),module:Number(c.dataset.moduleDots),layout:c.dataset.layout};
 });
});
for(const size of sizes){assert.equal(size.decoded,true,JSON.stringify(size));assert.equal(size.w,size.expectedW);assert.equal(size.h,size.expectedH);assert.ok(size.module>=2);}
assert.equal(sizes[0].layout,'side');
await page.locator('#usbPrintClose').click();
// Exercise hardware feedback routing without pretending to have a real USB board.
await page.evaluate(()=>{window.motionSends=[];AndroidHost.send=(role,line)=>motionSends.push({role,line});hardware.motion=true;$('#motionMode').value='hardware';});
await page.evaluate(id=>setSampleStatus(id,'in'),id);await page.locator('#confirmYes').click();
const taskId=await page.evaluate(()=>state.set.motionTask.taskId);
const motionSend=await page.evaluate(()=>({sent:motionSends,slot:state.set.motionTask.slot}));
 assert.deepEqual(motionSend.sent,[{role:'motion',line:`IN,A-${motionSend.slot-1}`}]);
await page.evaluate(id=>onAndroidEvent('line','motion',`ACCEPTED,${id}`),id);
assert.equal(await page.locator('#finishTask').isDisabled(),true);
await page.evaluate(id=>onAndroidEvent('line','motion',`ARRIVED,${id}`),id);
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'out');
await page.reload();await page.waitForTimeout(200);
assert.equal(await page.evaluate(()=>state.set.motionTask.phase),'uncertain');
await page.locator('[data-view="library"]').click();await page.locator('[data-library-pane="inventory"]').click();
assert.equal(await page.locator('#libraryInventoryPane').isVisible(),true);
assert.equal(await page.locator('#storageVisual .storage-disc').count(),3);
assert.equal(await page.locator('#storageVisual .storage-slot').count(),15);
assert.deepEqual(await page.locator('#storageVisual .storage-disc-name').allInnerTexts(),['A\n全血','B\n血清','C\n血浆']);
assert.deepEqual(await page.locator('#storageVisual .storage-disc').first().locator('.storage-slot-number').allInnerTexts(),['1','2','3','4','5']);
await page.screenshot({path:path.resolve(__dirname,'../docs/screenshots/storage-transparent-preview.png'),fullPage:true});
await page.evaluate(()=>{
 const sample=Object.values(state.s.samples)[0];
 Store.result(AndroidHost.commitChanges(JSON.stringify({expectedRevision:Store.revision,upsertSamples:[{...sample,note:'取消任务前数据库最新备注'}],deleteSamples:[],addRecords:[],deleteRecords:[],setSettings:{},deleteSettings:[]})));
});
await page.locator('#abortTask').click();await page.locator('#confirmYes').click();
assert.ok(await page.evaluate(()=>state.set.motionTask));
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].note),'取消任务前数据库最新备注');
await page.locator('#abortTask').click();await page.locator('#confirmYes').click();
assert.equal(await page.evaluate(()=>state.set.motionTask),null);
// Manual intake restores the sample, then hardware OK must complete outbound automatically.
await page.evaluate(()=>{$('#motionMode').value='manual';});
await page.evaluate(id=>setSampleStatus(id,'in'),id);await page.locator('#confirmYes').click();
await page.locator('#positionChecked').check();await page.locator('#finishTask').click();
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'in');
await page.evaluate(()=>{window.motionSends=[];AndroidHost.send=(role,line)=>motionSends.push({role,line});$('#motionMode').value='hardware';hardware.motion=true;});
await page.evaluate(id=>setSampleStatus(id,'out'),id);await page.locator('#confirmYes').click();
assert.match(await page.locator('#motionTask').innerText(),/等待机械板返回 OK/);
await page.evaluate(()=>onAndroidEvent('line','motion','OK,OTHER'));
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'in');
await page.evaluate(()=>onAndroidEvent('line','motion','OK'));
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'out');
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].slot),undefined);
assert.equal(await page.evaluate(()=>state.set.motionTask),null);
assert.match(await page.evaluate(()=>state.rec[0].detail),/机械板返回 OK/);
assert.equal(await page.locator('#chartHumi').count(),0);
assert.equal(await page.locator('#scanInput,#scanFind,#scanNew,#verifyCode').count(),0);
const scannerChecks=await page.evaluate(()=>{
 const savedSamples=state.s.samples,savedTask=state.set.motionTask,savedHardware=hardware.motion;
 try {
  state.set.motionTask=null;state.s.samples={a:{id:'a',code:'A-1',name:'甲',type:'全血',status:'in',slot:1},b:{id:'b',code:'B-1',name:'乙',type:'血清',status:'in',slot:1}};hardware.motion=false;$('#motionType').value='全血';renderTask();
  const slots=Array.from($('#motionSlot').options).map(o=>({value:o.value,disabled:o.disabled,text:o.textContent}));
  const freeSlots=slots.filter(o=>!o.disabled).map(o=>o.value).join(',');
  const disconnectedHidden=$('#motionDisconnect').classList.contains('hidden');
  $('#motionType').value='血清';$('#motionSlot').value='5';refreshMotionPanel(true);
  const autoPicked=$('#motionSlot').value==='2';
  $('#motionType').value='全血';refreshMotionPanel();
  const fresh=processScannerCode('Vitals·生息 生物样本\n编号：NEW-2','new',null);
  const filled=$('#fCode').value==='NEW-2'&&Object.keys(state.s.samples).length===2;
  $('#fName').value='未保存草稿';
  const duplicate=processScannerCode('A-1','fill',editingId);
  const draftKept=$('#fName').value==='未保存草稿'&&$('#fCode').value==='NEW-2';
  $('#closeModal').click();
  const existing=processScannerCode('A-1','new',null);
  const existingOpened=detailId==='a'&&!$('#sampleModal').classList.contains('open');$('#closeDetail').click();
  const corruptKnown=scanCode('\uFFFD\uFFFD\uFFFDA-1\n\uFFFD\uFFFD')==='A-1';
  const corruptGenerated=scanCode('\uFFFD\uFFFD\uFFFDSB-MU0YGYPJ')==='SB-MU0YGYPJ';
  const qrIsAsciiId=sampleQRText(state.s.samples.a)==='A-1';
  state.set.motionTask={taskId:'CAM-1',sampleId:'a',action:'out',slot:1,phase:'verify',mode:'manual'};renderTask();
  const wrong=processScannerCode('OTHER','verify','CAM-1');
  const stale=processScannerCode('A-1','verify','OLD');
  const correct=processScannerCode('编号：A-1','verify','CAM-1');
  const notAutoOut=state.s.samples.a.status==='in';
  state.set.motionTask={...state.set.motionTask,taskId:'CAM-2'};renderTask();
  const oldVerificationCleared=scannerVerification===null;
  state.set.motionTask=null;state.s.samples=Object.fromEntries([1,2,3,4,5].map(slot=>['s'+slot,{id:'s'+slot,name:'样本'+slot,type:'全血',status:'in',slot}]));$('#motionType').value='全血';refreshMotionPanel();
  const fullDisabled=$('#motionSlot').disabled&&$('#motionSlot').value==='';
  state.s.samples.s3.status='out';delete state.s.samples.s3.slot;refreshMotionPanel();
  return {freeSlots,slotLabels:slots.map(x=>x.text.split(' ')[0]).join(','),autoPicked,disconnectedHidden,fresh:fresh.ok,filled,duplicateRejected:!duplicate.ok,draftKept,existing:existing.ok,existingOpened,corruptKnown,corruptGenerated,qrIsAsciiId,wrongRejected:!wrong.ok,staleRejected:!stale.ok,correct:correct.ok,notAutoOut,oldVerificationCleared,fullDisabled,releasedSelected:$('#motionSlot').value==='3'};
 } finally {state.s.samples=savedSamples;state.set.motionTask=savedTask;hardware.motion=savedHardware;renderTask();}
});
assert.equal(scannerChecks.freeSlots,'2,3,4,5');
assert.equal(scannerChecks.slotLabels,'1,2,3,4,5');
for(const [key,value] of Object.entries(scannerChecks))if(!['freeSlots','slotLabels'].includes(key))assert.equal(value,true,key);
assert.equal(await page.evaluate(id=>{
 const sample=state.s.samples[id],before=JSON.stringify(sample);
 applySensorData({id,h:60});
 const ignored=before===JSON.stringify(sample);
 applySensorData({id,t:4,l:200,h:'legacy ignored'});
 rtOf(id).pendSince=Date.now()-DEBOUNCE_MS-1;
 applySensorData({id,t:4,l:200,h:'legacy ignored'});
 const current=state.s.samples[id],series=state.set['templog:'+id];
 series.raw[0].ab=1;series.raw[0].ts=Date.now()-31*60*1000;rollTemp(id,Date.now());
 series.agg[0].ts=Date.now()-8*24*60*60*1000;rollTemp(id,Date.now());
 return ignored&&current.lastTemp===4&&current.alert==='bad'&&series.raw.length===1&&series.raw[0].ab===1&&series.agg.length===1&&series.agg[0].ab===1&&series.agg[0].t===4;
},id),true);
fs.mkdirSync(path.resolve(__dirname,'../docs/screenshots'),{recursive:true});
await page.screenshot({path:path.resolve(__dirname,'../docs/screenshots/tablet.png'),fullPage:true});
await page.setViewportSize({width:1024,height:600});await page.screenshot({path:path.resolve(__dirname,'../docs/screenshots/panel-1024.png'),fullPage:true});
assert.deepEqual(errors,[]);console.log('PASS: UI auto-backup card, create/edit, write failure recovery, revision conflicts during task feedback/completion/cancellation, zero temperature limit, invalid bounds, no false save success, record FK, unchanged rows not written, manual in/out, wrong scan, restart, export/print, hardware ACK/arrival separation, task recovery; no JS errors.');
}finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1);});


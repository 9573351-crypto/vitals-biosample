// Runs only against an already-running emulator, never selects a physical device.
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const adb='D:/android-studio/SDK/platform-tools/adb.exe';
const cmd=(...args)=>execFileSync(adb,['-s','emulator-5554',...args],{encoding:'utf8'}).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function connect(){
  const pid=cmd('shell','pidof','com.vitals.android');cmd('forward','tcp:9223','localabstract:webview_devtools_remote_'+pid);
  let pages=[];for(let i=0;i<30;i++){try{pages=await(await fetch('http://127.0.0.1:9223/json')).json();if(pages.length)break;}catch{}await sleep(300);}
  const ws=new WebSocket(pages[0].webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0;const waiting=new Map();ws.onmessage=e=>{const msg=JSON.parse(e.data);if(waiting.has(msg.id)){waiting.get(msg.id)(msg);waiting.delete(msg.id);}};
  return {close:()=>ws.close(),eval:async expression=>{
    const seq=++id,p=new Promise(r=>waiting.set(seq,r));ws.send(JSON.stringify({id:seq,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
    const result=await Promise.race([p,sleep(10000).then(()=>{throw Error('CDP timeout');})]);if(result.result.exceptionDetails)throw Error(JSON.stringify(result.result.exceptionDetails));return result.result.result.value;
  }};
}
(async()=>{
cmd('install','-r',path.resolve(__dirname,'../app/build/outputs/apk/debug/app-debug.apk'));
cmd('shell','am','force-stop','com.vitals.android');cmd('shell','am','start','-n','com.vitals.android/.MainActivity');await sleep(1500);
let page=await connect();
await page.eval(`new Promise(resolve=>{if(document.readyState==='complete')resolve();else window.addEventListener('load',resolve,{once:true});})`);
assert.equal(await page.eval('typeof AndroidHost.saveState'),'function');
assert.equal(await page.eval("typeof goView"),'function');
await page.eval(`goView('library');openModal();$('#fName').value='模拟器验证样本';$('#fCode').value='EMULATOR-'+Date.now();$('#modalSave').click();`);
const sample=await page.eval('Object.values(state.s.samples).sort((a,b)=>b.createdAt-a.createdAt)[0]');assert.equal(sample.name,'模拟器验证样本');
const stored=await page.eval('JSON.parse(AndroidHost.loadState())');assert.equal(stored.s.samples[sample.id].name,sample.name);
// Exercise the actual installed Android app's in/out UI and SQLite commits.
await page.eval(`setSampleStatus(${JSON.stringify(sample.id)},'in');$('#confirmYes').click();`);
assert.equal(await page.eval(`state.s.samples[${JSON.stringify(sample.id)}].status`),'out');
await page.eval(`$('#positionChecked').checked=true;$('#finishTask').click();`);
assert.equal(await page.eval(`JSON.parse(AndroidHost.loadState()).s.samples[${JSON.stringify(sample.id)}].slot`),1);
await page.eval(`setSampleStatus(${JSON.stringify(sample.id)},'out');$('#confirmYes').click();$('#positionChecked').checked=true;$('#verifyCode').value='WRONG';$('#finishTask').click();`);
assert.equal(await page.eval(`state.s.samples[${JSON.stringify(sample.id)}].status`),'in');
await page.eval(`$('#verifyCode').value=${JSON.stringify(sample.code)};$('#finishTask').click();`);
assert.equal(await page.eval(`state.s.samples[${JSON.stringify(sample.id)}].status`),'out');
// Synthetic feedback tests the receive path only, without claiming USB hardware coverage.
await page.eval(`persistTask({taskId:'EMULATOR-FEEDBACK',sampleId:${JSON.stringify(sample.id)},action:'in',slot:1,mode:'hardware',phase:'sent',createdAt:Date.now()});onAndroidEvent('line','motion',JSON.stringify({taskId:'EMULATOR-FEEDBACK',type:'accepted'}));`);
assert.equal(await page.eval(`$('#finishTask').disabled`),true);
await page.eval(`onAndroidEvent('line','motion',JSON.stringify({taskId:'EMULATOR-FEEDBACK',type:'arrived',feedback:'position'}));`);
assert.equal(await page.eval(`state.s.samples[${JSON.stringify(sample.id)}].status`),'out');
await page.eval(`$('#positionChecked').checked=true;$('#finishTask').click();onAndroidEvent('line','sensor',JSON.stringify({id:${JSON.stringify(sample.id)},t:4.2,h:45,l:320}));`);
assert.equal(await page.eval(`state.s.samples[${JSON.stringify(sample.id)}].lastTemp`),4.2);
await page.eval(`onAndroidEvent('line','sensor',JSON.stringify({id:${JSON.stringify(sample.id)},t:'bad'}));`);
assert.equal(await page.eval(`state.s.samples[${JSON.stringify(sample.id)}].lastTemp`),4.2);
await page.eval(`persistTask({taskId:'EMULATOR-RESTART',sampleId:${JSON.stringify(sample.id)},action:'out',slot:1,mode:'hardware',phase:'sent',createdAt:Date.now()});`);
await page.eval(`goView('monitor');AndroidHost.connect('sensor',115200);`);await sleep(300);
assert.equal(await page.eval("document.body.textContent.includes('未找到可用 USB 串口')"),true);
page.close();cmd('shell','am','force-stop','com.vitals.android');cmd('shell','am','start','-n','com.vitals.android/.MainActivity');await sleep(1500);page=await connect();
assert.equal(await page.eval(`state.s.samples[${JSON.stringify(sample.id)}].name`),'模拟器验证样本');
assert.equal(await page.eval('state.set.motionTask.phase'),'uncertain');
assert.equal(await page.eval(`state.s.samples[${JSON.stringify(sample.id)}].status`),'in');
await page.eval(`goView('monitor');$('#abortTask').click();$('#confirmYes').click();`);
// Import through the actual native event handler; validation and SQLite commit occur in app code.
const backup={samples:{MIGRATION1:{id:'MIGRATION1',code:'MIG-001',name:'迁移验证样本',status:'in',temp:4}},records:[],settings:{hi:8,lo:-88}};
await page.eval(`onAndroidEvent('import','',${JSON.stringify(JSON.stringify(backup))});$('#confirmYes').click();`);
assert.equal(await page.eval('JSON.parse(AndroidHost.loadState()).s.samples.MIGRATION1.code'),'MIG-001');
await page.eval(`goView('library');`);
await sleep(700); // let view transition finish before visual inspection
cmd('shell','screencap','-p','/sdcard/vitals-test.png');cmd('pull','/sdcard/vitals-test.png',path.resolve(__dirname,'../docs/screenshots/android-emulator.png'));
// Optional interactive session: clearly marked emulator-only data, never packaged in APK.
if(process.argv.includes('--keep-demo')){
 await page.eval(`state.s.samples.MIGRATION1.name='模拟器演示 · 血清';state.s.samples.MIGRATION1.note='仅用于虚拟机调试，非真实样本';state.s.samples.MIGRATION1.slot=1;state.s.samples.MIGRATION1.loc='圆盘-1';saveAll();reloadUI();goView('library');`);
}else await page.eval(`state=Store.defaultsShort();state.s.samplesSeeded=true;saveAll();reloadUI();`);
page.close();console.log('PASS: Android startup, SQLite, manual in/out, wrong-scan rejection, simulated ACK/arrival, sensor validation, unfinished-task recovery, import, no-device feedback.');
})().catch(e=>{console.error(e);process.exitCode=1;});

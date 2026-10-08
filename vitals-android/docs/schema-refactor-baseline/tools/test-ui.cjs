const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'C:/Users/lvyiy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(__dirname,'../app/src/main/assets/web');
(async()=>{
const server=http.createServer((req,res)=>{try{let name=decodeURIComponent(req.url.split('?')[0]);if(name==='/')name='/index.html';const p=path.join(root,name);if(!p.startsWith(root))throw Error();res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':p.endsWith('.html')?'text/html':'image/png');res.end(fs.readFileSync(p));}catch{res.statusCode=404;res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{window.AndroidHost={loadState:()=>localStorage.getItem('test-native')||'null',saveState:s=>{localStorage.setItem('test-native',s);return true;},connect:()=>{},disconnect:()=>{},send:()=>{},importJson:()=>{},exportJson:(n,c)=>window.lastExport=JSON.parse(c),printLabel:()=>{}};});
await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForTimeout(500);
assert.equal(await page.locator('#statTotal').innerText(),'0');
await page.locator('[data-view="library"]').click();await page.locator('#addSampleBtn').click();
await page.locator('#fName').fill('安卓测试血清');await page.locator('#fCode').fill('TEST-001');await page.locator('#modalSave').click();
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'out');
const id=await page.evaluate(()=>Object.keys(state.s.samples)[0]);
await page.evaluate(id=>setSampleStatus(id,'in'),id);await page.locator('#confirmYes').click();
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'out');
await page.locator('#positionChecked').check();await page.locator('#finishTask').click();
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'in');
await page.reload();await page.waitForTimeout(200);
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].slot),1);
await page.evaluate(id=>setSampleStatus(id,'out'),id);await page.locator('#confirmYes').click();
await page.locator('#positionChecked').check();await page.locator('#verifyCode').fill('WRONG');await page.locator('#finishTask').click();
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'in');
await page.locator('#verifyCode').fill('TEST-001');await page.locator('#finishTask').click();
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].slot),undefined);
await page.evaluate(()=>exportData());assert.equal((await page.evaluate(()=>window.lastExport)).samples[id].status,'out');
// Exercise hardware feedback routing without pretending to have a real USB board.
await page.evaluate(()=>{hardware.motion=true;$('#motionMode').value='hardware';});
await page.evaluate(id=>setSampleStatus(id,'in'),id);await page.locator('#confirmYes').click();
const taskId=await page.evaluate(()=>state.set.motionTask.taskId);
await page.evaluate(taskId=>onAndroidEvent('line','motion',JSON.stringify({type:'accepted',taskId})),taskId);
assert.equal(await page.locator('#finishTask').isDisabled(),true);
await page.evaluate(taskId=>onAndroidEvent('line','motion',JSON.stringify({type:'arrived',feedback:'position',taskId})),taskId);
assert.equal(await page.evaluate(()=>Object.values(state.s.samples)[0].status),'out');
await page.reload();await page.waitForTimeout(200);
assert.equal(await page.evaluate(()=>state.set.motionTask.phase),'uncertain');
await page.locator('[data-view="monitor"]').click();
fs.mkdirSync(path.resolve(__dirname,'../docs/screenshots'),{recursive:true});
await page.screenshot({path:path.resolve(__dirname,'../docs/screenshots/tablet.png'),fullPage:true});
await page.setViewportSize({width:1024,height:600});await page.screenshot({path:path.resolve(__dirname,'../docs/screenshots/panel-1024.png'),fullPage:true});
assert.deepEqual(errors,[]);console.log('PASS: UI create, manual in/out, wrong scan, restart, export, hardware ACK/arrival separation, task recovery; no JS errors.');
}finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1);});

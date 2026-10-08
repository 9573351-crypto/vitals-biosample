// Run once against the independent copy; never writes to the Windows project.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),web=path.join(root,'app/src/main/assets/web');
let js=fs.readFileSync(path.join(web,'app.js'),'utf8');
js=js.replace('})/*;', '});');
js=js.replace("s.online = s.online || 0;/*在线数量*/", "s.online = s.online || 0;/*在线数量*/\n}");
js=js.replace("let state = Store.load();", `Store.load = function(){
  const raw = AndroidHost.loadState();
  if(raw === 'null') return this.defaultsShort();
  const data = JSON.parse(raw);
  data.s.online = 0; data.set.online = 0; data.set.simOn = false;
  return data;
};
Store.save = function(data){
  if(!AndroidHost.saveState(JSON.stringify(data))) throw new Error('本机数据库写入失败');
};
let state = Store.load();`);
js=js.replace('  seedIfNew();','  // 安卓首次启动保持空库，不自动生成示例样本。');
js=js.replace("status:'in'\n    };", "status:'out'\n    };");
js=js.replace("if(window.api && typeof window.api.saveJson === 'function'){", "if(window.AndroidHost){ AndroidHost.exportJson(defName,content); return; }\n  if(window.api && typeof window.api.saveJson === 'function'){");
js=js.replace("()=> $('#importFile').click()", "()=> AndroidHost.importJson()");
js=js.replace('window.print();','AndroidHost.printLabel();');
js=js.replace("async function connectSerial(){", "async function connectSerial(){\n  if(window.AndroidHost){ AndroidHost.connect('sensor',Number($('#baudSelect').value)); return; }");
js=js.replace("async function disconnectSerial(){", "async function disconnectSerial(){\n  if(window.AndroidHost){ AndroidHost.disconnect('sensor'); return; }");
js=js.replace('function setSampleStatus(id, st){','function legacySetSampleStatus(id, st){');
js=js.replace('function deleteSample(id){','function deleteSample(id){\n  if(state.set.motionTask){ toast("请先处理当前出入库任务"); return; }');
js=js.replace("$('#modalSave').addEventListener('click', ()=>{", "$('#modalSave').addEventListener('click', ()=>{\n  if(state.set.motionTask){toast('请先处理当前出入库任务');return;}\n  if(Object.values(state.s.samples).some(x=>x.id!==editingId && x.code===$('#fCode').value.trim())){toast('样本编号重复');return;}");
js=js.replace("$('#detailEdit').", "$('#detailEdit').");
// During a running transaction no edits or destructive operations are allowed.
js=js.replace('function openModal(id){', 'function openModal(id){\n  if(state.set.motionTask){toast("请先处理当前出入库任务");return;}');
fs.writeFileSync(path.join(web,'app.js'),js);
let html=fs.readFileSync(path.join(web,'index.html'),'utf8');
html=html.replace('assets/logo.jpg','assets/logo.png').replace('<link rel="stylesheet" href="styles.css?v=23">','<link rel="stylesheet" href="styles.css?v=23"><link rel="stylesheet" href="android.css">');
html=html.replace('<script src="app.js?v=24" defer></script>', '<script src="motion-core.js" defer></script><script src="app.js?v=24" defer></script><script src="android.js" defer></script>');
html=html.replace('通过 Web Serial 连接单片机 HC09 无线串口模块（LoRa 433MHz），实时采集温度、湿度、光照等传感器数据，默认波特率 115200。','通过 USB 串口连接温控板或无线串口适配器。选择与控制板一致的波特率，8 数据位、无校验、1 停止位。');
html=html.replace('手机扫码可查看样本信息','二维码为录入时的信息快照；当前库存以本机记录为准');
html=html.replace('创建</div>','创建</div>');
fs.writeFileSync(path.join(web,'index.html'),html);

'use strict';
const hardware={sensor:false,motion:false,scanner:0,scannerConnected:false,printer:0};
let taskTimer=null;
let scannerVerification=null;
const stm32LogLines=[];

function stm32Command(){
  const action=$('#stm32Action')?.value||'IN';
  const category=$('#stm32Category')?.value||'A';
  const position=$('#stm32Position')?.value||'0';
  return `${action},${category}-${position}`;
}
function refreshStm32Console(){
  const preview=$('#stm32CommandPreview'),send=$('#stm32Send'),status=$('#stm32Status');
  if(!preview)return;
  preview.textContent=stm32Command();
  if(send)send.disabled=!hardware.motion;
  if(status){status.textContent=hardware.motion?'CH340 已连接':'CH340 未连接';status.classList.toggle('on',hardware.motion);}
}
function stm32Log(direction,text,kind=''){
  const time=new Date().toLocaleTimeString('zh-CN',{hour12:false});
  stm32LogLines.push({time,direction,text:String(text),kind});
  if(stm32LogLines.length>100)stm32LogLines.shift();
  const el=$('#stm32Log');if(!el)return;
  el.innerHTML=stm32LogLines.map(x=>`<div class="${esc(x.kind)}">[${esc(x.time)}] ${esc(x.direction)} ${esc(x.text)}</div>`).join('');
  el.scrollTop=el.scrollHeight;
}

function renderDeviceStats(){
  const total=Number(hardware.sensor)+Number(hardware.motion)+Number(hardware.scanner||0)+Number(hardware.printer||0);
  state.s.online=total;
  const totalEl=$('#statOnline'),detail=$('#statOnlineDetail');
  if(totalEl)totalEl.textContent=total;
  if(detail)detail.textContent=`温控 ${Number(hardware.sensor)} · 机械 ${Number(hardware.motion)} · 扫码枪 ${Number(hardware.scanner||0)} · 打印机 ${Number(hardware.printer||0)}`;
  const pageSummary=$('#devicePageSummary');if(pageSummary)pageSummary.textContent=total+' 个设备在线';
}
window.renderDeviceStats=renderDeviceStats;
function applyExternalDevices(value){
  try {
    const data=typeof value==='string'?JSON.parse(value):value;
    hardware.scanner=Math.max(0,Number(data.scanner)||0);
    hardware.printer=Math.max(0,Number(data.printer)||0);
  } catch(_) {hardware.scanner=0;hardware.printer=0;}
  if(window.refreshScannerConnection)refreshScannerConnection();
  renderDeviceStats();
}
function refreshExternalDevices(){
  if(window.AndroidHost&&AndroidHost.getExternalDevices)applyExternalDevices(AndroidHost.getExternalDevices());
  else renderDeviceStats();
}

function refreshMotionPanel(){
  const select=$('#motionSlot');if(!select)return;
  const selected=Number(select.value),task=state.set.motionTask;
  const slots=[1,2,3,4,5].map(slot=>({slot,sample:Object.values(state.s.samples).find(x=>x.status!=='out'&&x.slot===slot)}));
  select.replaceChildren();
  slots.forEach(({slot,sample})=>{const option=document.createElement('option');option.value=slot;option.textContent=MotionCore.position(slot)+' 号 · '+(sample?'已占用：'+sample.name:task&&task.slot===slot?'任务处理中':'空闲');option.disabled=!!sample||!!(task&&task.slot===slot);select.append(option);});
  const free=slots.filter(x=>!x.sample&&(!task||task.slot!==x.slot));
  select.value=String(free.some(x=>x.slot===selected)?selected:free[0]?.slot||'');
  select.disabled=!!task||!free.length;
  $('#slotSummary').textContent=slots.map(x=>MotionCore.position(x.slot)+'号：'+(x.sample?x.sample.name:task&&task.slot===x.slot?'任务处理中':'空闲')).join('；')+(free.length?'':'。当前没有可用槽位，请先完成出库或处理当前任务。');
  $('#motionDisconnect').classList.toggle('hidden',!hardware.motion);
  $('#motionConnect').classList.toggle('hidden',hardware.motion);
  $('#motionMode').disabled=!!task;
  $('#motionConnection').textContent=hardware.motion?'机械板已连接':'机械板未连接';
}
window.refreshMotionPanel=refreshMotionPanel;

function verifyOutboundScanner(raw,taskId){
  const t=state.set.motionTask,x=t&&state.s.samples[t.sampleId];
  scannerVerification=null;
  if(!t||t.taskId!==taskId||t.action!=='out'||!x||['sent','accepted'].includes(t.phase))return {ok:false,message:'出库任务已变化，请关闭扫码窗口后重新核对'};
  const code=scanCode(raw);
  if(code!==x.code&&code!==x.id){renderTask();return {ok:false,message:'二维码与本次出库样本不符，请扫描“'+x.name+'”的二维码'};}
  scannerVerification={taskId:t.taskId,sampleId:x.id,code};renderTask();
  return {ok:true,message:'二维码核对通过，请确认已取出样本，再完成出库'};
}

function persistTask(task){
  state.set.motionTask=task;
  if(!saveAll())return false; // saveAll reloads the authoritative database state.
  renderTask();return true;
}
function setSampleStatus(id,action){
  if(state.set.motionTask){toast('请先处理当前任务');return;}
  const x=state.s.samples[id];
  if(!x || !['in','out'].includes(action) || x.status===action)return;
  const slot=action==='in'?Number($('#motionSlot').value):x.slot;
  if(!Number.isInteger(slot)||slot<1||slot>5){toast(action==='in'?'没有可用入库槽位，请查看槽位占用或先完成出库':'该样本尚未绑定实际槽位，请先核实并绑定');goView('inventory');return;}
  if(!MotionCore.slotFree(state.s.samples,slot,id)){toast('该槽位已被其他样本占用');return;}
  const mode=$('#motionMode').value;
  if(mode==='hardware'&&!hardware.motion){toast('请先连接机械控制板');goView('devices');return;}
  confirmDialog(action==='in'?'准备入库':'准备出库',
    `样本：${x.name}；槽位：${MotionCore.position(slot)}。${mode==='hardware'?'将发送机械指令：'+MotionCore.command(x,action,slot)+'。':'人工模式：不会发送机械指令。'}${action==='in'?'请确认已按机械组约定放好样本。':''}`,
    ()=>{
      const task={taskId:'T-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),sampleId:id,action,slot,mode,phase:mode==='hardware'?'sent':'verify',createdAt:Date.now()};
      if(!persistTask(task))return;
      if(mode==='hardware'){
        AndroidHost.send('motion',MotionCore.command(x,action,slot));
        taskTimer=setTimeout(()=>{const t=state.set.motionTask;if(t&&t.taskId===task.taskId&&['sent','accepted'].includes(t.phase))persistTask({...t,phase:'uncertain',error:'30 秒未收到到位反馈；不自动重发，请人工核实'});},30000);
      }
      goView('inventory');
    });
}
function renderTask(){
  refreshMotionPanel();
  const t=state.set.motionTask, el=$('#motionTask');if(!el)return;
  if(!t||scannerVerification?.taskId!==t.taskId)scannerVerification=null;
  if(!t){el.textContent='暂无任务。新录入样本处于待入库状态；完成操作后才更新库存。';return;}
  const labels={sent:'指令已提交，等待硬件响应',accepted:'硬件已接收，等待到位',arrived:'硬件报告位置到位，仍需人工确认样本',verify:'需要人工确认位置及样本',uncertain:'结果待核实，库存保持原状态'};
  const waitingOk=t.action==='out'&&t.mode==='hardware'&&['sent','accepted'].includes(t.phase);
  const controls=waitingOk
    ? `<p class="hardware-ok-wait">等待机械板返回 <code>OK</code>；收到后将自动出库并释放槽位。</p><div class="android-actions"><button class="btn ghost" id="abortTask">核实未完成，保留原库存</button></div>`
    : `<label class="android-check"><input type="checkbox" id="positionChecked">我已核实机械位置正确，样本已${t.action==='in'?'放好':'取出'}</label>${t.action==='out'?'<button class="btn primary" id="scannerVerifyOut">扫码枪核对出库样本</button><p id="scannerVerifyStatus">'+(scannerVerification?'二维码核对通过':'尚未核对，请使用扫码枪扫描本次出库样本')+'</p>':''}<div class="android-actions"><button class="btn primary" id="finishTask">人工确认完成</button><button class="btn ghost" id="abortTask">核实未完成，保留原库存</button></div>`;
  el.innerHTML=`<b>${esc(t.action==='in'?'入库':'出库')} · 槽位 ${esc(MotionCore.position(t.slot))} · ${esc(state.s.samples[t.sampleId]?.name||t.sampleId)}</b><p>${esc(labels[t.phase]||t.phase)}</p><p>${esc(t.error||'')}</p>${controls}`;
  if(!waitingOk){
    if(t.action==='out'){$('#scannerVerifyOut').disabled=['sent','accepted'].includes(t.phase);$('#scannerVerifyOut').onclick=()=>window.openVitalsScanner('verify',t.taskId);}
    $('#finishTask').disabled=['sent','accepted'].includes(t.phase);
    $('#finishTask').onclick=finishTask;
  }
  $('#abortTask').onclick=()=>confirmDialog('人工核实后结束任务','这不会停止电机。请先确认机械已停止，样本已恢复到操作前的位置；否则取消并继续保留待核实任务。',()=>{
    state.set.motionTask=null;
    state.rec.unshift({time:FMT.now(),sample:state.s.samples[t.sampleId]?.name||t.sampleId,sampleId:t.sampleId,code:state.s.samples[t.sampleId]?.code||null,slot:t.slot,taskId:t.taskId,type:'任务取消',detail:'人工确认恢复原状态：'+t.taskId});
    if(!saveAll())return;
    clearTimeout(taskTimer);reloadUI();renderTask();
  });
}
function finishTask(){
  const t=state.set.motionTask;if(!t||['sent','accepted'].includes(t.phase))return;
  const x=state.s.samples[t.sampleId];if(!x)return;
  if(!$('#positionChecked').checked){toast('请先核实位置和样本');return;}
  if(t.action==='out'){
    if(!scannerVerification||scannerVerification.taskId!==t.taskId||scannerVerification.sampleId!==x.id||![x.code,x.id].includes(scannerVerification.code)){toast('请先使用扫码枪核对出库样本');return;}
  }
  if(!MotionCore.slotFree(state.s.samples,t.slot,x.id)){toast('槽位冲突，请核实');return;}
  x.status=t.action;x.pendingIntake=false;x.updatedAt=Date.now();
  if(t.action==='in'){x.slot=t.slot;x.loc='圆盘-'+MotionCore.position(t.slot);}else{x.lastSlot=t.slot;delete x.slot;x.loc='已出库';}
  state.set.motionTask=null;
  state.rec.unshift({time:FMT.now(),sample:x.name,sampleId:x.id,code:x.code||null,slot:t.slot,status:t.action,taskId:t.taskId,type:t.action==='in'?'入库':'出库',detail:`人工确认完成，槽位 ${MotionCore.position(t.slot)}，任务 ${t.taskId}`});
  state.rec=state.rec.slice(0,500);
  if(!saveAll())return;
  clearTimeout(taskTimer);reloadUI();renderTask();toast('库存已更新');
}
function finishHardwareOutbound(t){
  if(!t||t!==state.set.motionTask||t.action!=='out'||t.mode!=='hardware'||!['sent','accepted'].includes(t.phase))return false;
  const x=state.s.samples[t.sampleId];if(!x||x.status==='out')return false;
  x.status='out';x.pendingIntake=false;x.updatedAt=Date.now();x.lastSlot=t.slot;delete x.slot;x.loc='已出库';
  state.set.motionTask=null;scannerVerification=null;
  state.rec.unshift({time:FMT.now(),sample:x.name,sampleId:x.id,code:x.code||null,slot:t.slot,status:'out',taskId:t.taskId,type:'出库',detail:`机械板返回 OK，自动完成出库并释放槽位 ${MotionCore.position(t.slot)}，任务 ${t.taskId}`});
  state.rec=state.rec.slice(0,500);
  if(!saveAll())return false;
  clearTimeout(taskTimer);reloadUI();renderTask();toast('机械板返回 OK，样本已出库');return true;
}
function scanCode(text){
  const raw=String(text||'').trim(),match=raw.match(/(?:^|\n)编号[：:]\s*([^\r\n]+)/);
  if(match)return match[1].trim();
  // Some scanners transcode Chinese to GBK before sending it over USB serial. Match a known
  // identifier inside the damaged text first, then accept the app's generated ASCII ID shape.
  const known=Object.values(state.s.samples||{}).flatMap(x=>[x.code,x.id]).filter(Boolean).sort((a,b)=>String(b).length-String(a).length).find(code=>raw.includes(String(code)));
  if(known)return String(known);
  const generated=raw.match(/(?:^|[^A-Za-z0-9])((?:SB-)[A-Za-z0-9._-]+)(?=$|[^A-Za-z0-9._-])/i);
  return generated?generated[1]:raw;
}
function receiveImport(text){
  if(state.set.motionTask){toast('当前有未完成任务，不能导入覆盖');return;}
  try{
    const data=MotionCore.validateBackup(JSON.parse(text.replace(/^\uFEFF/,'')));
    confirmDialog('导入并替换本机数据',`备份包含 ${Object.keys(data.samples).length} 个样本。将替换本机样本和记录，建议先导出当前备份。`,()=>{
      if(state.set.motionTask){toast('请先处理当前任务');return;}
      // Native helper validates again, then replaces all three tables in one transaction.
      try{state=Store.replace(text);}catch(e){toast('导入失败，原数据已保留：'+e.message);return;}
      if(simTimer){clearInterval(simTimer);simTimer=null;}
      renderDeviceStats();
      reloadUI();fillSettings();renderTask();toast('导入成功');
    });
  }catch(e){toast('导入失败：'+e.message);}
}
window.onAndroidEvent=(type,role,text)=>{
  if(type==='devices'&&role==='external'){applyExternalDevices(text);return;}
  if(role==='printer'){if(window.onPrinterEvent)window.onPrinterEvent(type,text);return;}
  if(type==='import'){receiveImport(text);return;}
  if(type==='line'){
    if(role==='scanner'){
      if(window.onVitalsScannerData)window.onVitalsScannerData(text);
    }else if(role==='sensor')parseIncoming(text+'\n');
    else {
      stm32Log('RX ◀',text,'rx');
      briLog('机械 ◀ '+text);
      try{
        const t=state.set.motionTask,message=MotionCore.parseFeedback(text,t);
        if(message.type==='ok'&&message.taskId===t?.taskId&&finishHardwareOutbound(t))return;
        const next=MotionCore.next(t,message);
        if(next!==t){if(persistTask(next)&&!['sent','accepted'].includes(next.phase))clearTimeout(taskTimer);}
      }catch(e){briLog('机械反馈格式无效','err');}
    }
    return;
  }
  if(type==='connected'||type==='disconnected'){
    if(role==='scanner')hardware.scannerConnected=type==='connected';
    else hardware[role]=type==='connected';
    if(role==='sensor'){
      serialBuf='';monitorActive=hardware.sensor;
      if(hardware.sensor&&simTimer){clearInterval(simTimer);simTimer=null;state.set.simOn=false;$('#simStartBtn').textContent='开始模拟';}
      $('#connectBtn').classList.toggle('hidden',hardware.sensor);
      $('#disconnectBtn').classList.toggle('hidden',!hardware.sensor);
      $('#rackPill').textContent=hardware.sensor?'温控在线':'温控离线';
      $('#serialBtn').classList.toggle('on',hardware.sensor);
      const deviceStatus=$('#sensorDeviceStatus');if(deviceStatus){deviceStatus.textContent=hardware.sensor?'已连接':'未连接';deviceStatus.classList.toggle('on',hardware.sensor);}
      const tempStatus=$('#tempSerialStatus');
      if(tempStatus){tempStatus.textContent=hardware.sensor?'温度串口已连接':'温度串口未连接';tempStatus.classList.toggle('on',hardware.sensor);}
      if(!hardware.sensor&&type==='disconnected')tempSerialLog('SYS × 温度串口已断开','err');
      if(hardware.sensor)tempSerialLog('SYS ✓ '+text,'sys');
    }
    if(role==='scanner'&&window.refreshScannerConnection)window.refreshScannerConnection();
    refreshMotionPanel();
    if(role==='motion')stm32Log(type==='connected'?'SYS ✓':'SYS ×',text,type==='connected'?'rx':'err');
    refreshStm32Console();
    renderDeviceStats();refreshStats();
  }
  if((type==='disconnected'||type==='error')&&role==='motion'&&state.set.motionTask){
    const t=state.set.motionTask;if(['sent','accepted'].includes(t.phase))persistTask({...t,phase:'uncertain',error:text});
  }
  if(role==='motion'&&type==='sent')stm32Log('TX ▶',text,'tx');
  if(role==='motion'&&type==='error')stm32Log('ERR !',text,'err');
  if(type!=='sent')toast(text);
  briLog((role==='motion'?'机械':role==='scanner'?'扫码枪':'系统')+' · '+text,type==='error'?'err':'');
};
window.androidBack=()=>{
  const modal=document.querySelector('.modal-mask.open');
  if(modal)modal.classList.remove('open');else goView('dashboard');
};
document.addEventListener('DOMContentLoaded',()=>{
  refreshExternalDevices();
  const panel=document.createElement('div');panel.className='panel glass android-motion';
  panel.innerHTML=`<div class="panel-head"><h3>机械控制板连接</h3><span class="pill" id="motionConnection">机械板未连接</span></div><p class="muted">机械板使用独立 USB 串口。断开连接只关闭通讯，不会停止电机或改变库存。</p><div class="android-actions"><select class="select" id="motionBaud"><option>115200</option><option>9600</option><option>57600</option></select><button class="btn primary" id="motionConnect">连接机械板</button><button class="btn ghost" id="motionDisconnect">断开机械板连接</button></div><div class="stm32-console"><div class="stm32-console-head"><h4>STM32 串口调试</h4><span class="pill" id="stm32Status">CH340 未连接</span></div><p class="muted">手动调试发送动作和样本种类／圆槽位置两段信息。串口参数为 8N1，发送时追加换行符。</p><div class="stm32-fields"><label>动作<select class="select" id="stm32Action"><option value="IN">IN · 入库</option><option value="OUT">OUT · 出库</option></select></label><label>样本种类<select class="select" id="stm32Category">${'ABCDEFGH'.split('').map(x=>`<option value="${x}">${x}</option>`).join('')}</select></label><label>圆槽位置<select class="select" id="stm32Position">${[0,1,2,3,4].map(x=>`<option value="${x}">${x} 号</option>`).join('')}</select></label></div><div class="stm32-command"><code id="stm32CommandPreview">IN,A-0</code><button class="btn primary" id="stm32Send" disabled>发送到 STM32</button><button class="btn ghost" id="stm32ClearLog">清空日志</button></div><div class="stm32-log" id="stm32Log"><div>等待连接 CH340…</div></div></div>`;
  $('#motionDeviceMount').append(panel);
  const operations=document.createElement('div');operations.className='panel glass inventory-operations';
  operations.innerHTML=`<div class="panel-head"><h3>五槽位出入库（0—4）</h3><span class="pill">库存操作</span></div><p class="muted">人工模式由操作人员确认。硬件模式发送机械指令；出库收到机械板 OK 后自动更新库存并释放槽位，入库仍需人工确认样本已放好。</p><div class="android-actions"><select class="select" id="motionMode"><option value="manual">人工模式（不驱动机械）</option><option value="hardware">硬件联调模式</option></select><label>入库目标槽位 <select class="select" id="motionSlot">${[1,2,3,4,5].map(n=>'<option value="'+n+'">'+(n-1)+'</option>').join('')}</select></label><button class="btn ghost" id="bindSlot">绑定已有在库样本槽位</button></div><p id="slotSummary" class="muted"></p><div id="motionTask" class="android-task"></div>`;
  $('#motionOperationMount').append(operations);
  $('#stm32Action').value='IN';
  $('#stm32Category').value='A';
  $('#stm32Position').value='0';
  $('#motionConnect').onclick=()=>AndroidHost.connect('motion',Number($('#motionBaud').value));
  $('#motionDisconnect').onclick=()=>{if(state.set.motionTask)confirmDialog('断开机械板连接','断开连接不会停止电机；当前任务将保留待核实。请先确认实物状态。',()=>AndroidHost.disconnect('motion'));else AndroidHost.disconnect('motion');};
  for(const id of ['stm32Action','stm32Category','stm32Position'])$('#'+id).addEventListener('input',refreshStm32Console);
  $('#stm32Send').onclick=()=>{
    const command=stm32Command();
    if(!hardware.motion){toast('请先连接 CH340 串口');return;}
    if(!/^(IN|OUT),[A-H]-[0-4]$/.test(command)){toast('机械指令格式无效');return;}
    AndroidHost.send('motion',command);
  };
  $('#stm32ClearLog').onclick=()=>{stm32LogLines.length=0;$('#stm32Log').innerHTML='<div>日志已清空</div>';};
  $('#bindSlot').onclick=()=>{
    if(state.set.motionTask){toast('请先处理当前任务');return;}
    if(!Number($('#motionSlot').value)){toast('没有空闲槽位');return;}
    const list=Object.values(state.s.samples).filter(x=>x.status==='in');
    if(!list.length){toast('暂无在库样本');return;}
    const dialog=document.createElement('div');dialog.className='modal-mask open';
    dialog.innerHTML=`<div class="modal"><div class="modal-head"><h3>绑定实际槽位</h3></div><div class="modal-body"><p>用于迁移的已有在库样本。请人工核对实际位置。</p><select class="select" id="bindSample">${list.map(x=>`<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.code)}</option>`).join('')}</select><p>将绑定到槽位 ${MotionCore.position(Number($('#motionSlot').value))}</p></div><div class="modal-foot"><button class="btn ghost" id="bindCancel">取消</button><button class="btn primary" id="bindConfirm">已核实，绑定</button></div></div>`;
    document.body.append(dialog);$('#bindCancel').onclick=()=>dialog.remove();
    $('#bindConfirm').onclick=()=>{
      const id=$('#bindSample').value,slot=Number($('#motionSlot').value);
      if(!MotionCore.slotFree(state.s.samples,slot,id)){toast('槽位已被占用');return;}
      state.s.samples[id].slot=slot;state.s.samples[id].loc='圆盘-'+MotionCore.position(slot);
      state.rec.unshift({time:FMT.now(),sample:state.s.samples[id].name,sampleId:id,code:state.s.samples[id].code||null,slot,status:'in',type:'槽位绑定',detail:'人工核实：圆盘-'+MotionCore.position(slot)});
      if(!saveAll())return;
      dialog.remove();reloadUI();toast('已绑定');
    };
  };
  const scannerActions=document.createElement('div');scannerActions.className='scanner-actions';scannerActions.id='scannerActions';$('#view-library').prepend(scannerActions);
  for(const id of ['resetBtn','importBtn'])$('#'+id).addEventListener('click',e=>{if(state.set.motionTask){e.preventDefault();e.stopImmediatePropagation();toast('请先处理当前出入库任务');}},true);
  $('#simStartBtn').addEventListener('click',e=>{if(hardware.sensor){e.stopImmediatePropagation();toast('请先断开真实温控设备再模拟');}},true);
  $('#buildTag').textContent='Android 1.10.0 · 出入库独立';
  if(state.set.motionTask)persistTask({...state.set.motionTask,phase:'uncertain',error:'应用重新启动，请人工核实上次操作；不会自动重发指令'});
  renderTask();
  refreshStm32Console();
});

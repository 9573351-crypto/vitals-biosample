'use strict';
const hardware={sensor:false,motion:false};
let taskTimer=null;

function persistTask(task){
  const previous=state.set.motionTask;
  state.set.motionTask=task;
  if(!saveAll()){state.set.motionTask=previous;return false;}
  renderTask();return true;
}
function setSampleStatus(id,action){
  if(state.set.motionTask){toast('请先处理当前任务');return;}
  const x=state.s.samples[id];
  if(!x || !['in','out'].includes(action) || x.status===action)return;
  const slot=action==='in'?Number($('#motionSlot').value):x.slot;
  if(!Number.isInteger(slot)||slot<1||slot>5){toast('请先在设备面板绑定实际槽位（1—5）');goView('monitor');return;}
  if(!MotionCore.slotFree(state.s.samples,slot,id)){toast('该槽位已被其他样本占用');return;}
  const mode=$('#motionMode').value;
  if(mode==='hardware'&&!hardware.motion){toast('请先连接机械控制板');goView('monitor');return;}
  confirmDialog(action==='in'?'准备入库':'准备出库',
    `样本：${x.name}；槽位：${slot}。${mode==='hardware'?'将发送机械运动指令。':'人工模式：不会发送机械指令。'}${action==='in'?'请确认已按机械组约定放好样本。':''}`,
    ()=>{
      const task={taskId:'T-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),sampleId:id,action,slot,mode,phase:mode==='hardware'?'sent':'verify',createdAt:Date.now()};
      if(!persistTask(task))return;
      if(mode==='hardware'){
        AndroidHost.send('motion',JSON.stringify({type:'move',taskId:task.taskId,action,slot}));
        taskTimer=setTimeout(()=>{const t=state.set.motionTask;if(t&&t.taskId===task.taskId&&['sent','accepted'].includes(t.phase))persistTask({...t,phase:'uncertain',error:'30 秒未收到到位反馈；不自动重发，请人工核实'});},30000);
      }
      goView('monitor');
    });
}
function renderTask(){
  const t=state.set.motionTask, el=$('#motionTask');if(!el)return;
  if(!t){el.textContent='暂无任务。新录入样本处于待入库状态；完成操作后才更新库存。';return;}
  const labels={sent:'指令已提交，等待硬件响应',accepted:'硬件已接收，等待到位',arrived:'硬件报告位置到位，仍需人工确认样本',verify:'需要人工确认位置及样本',uncertain:'结果待核实，库存保持原状态'};
  el.innerHTML=`<b>${esc(t.action==='in'?'入库':'出库')} · 槽位 ${esc(t.slot)} · ${esc(state.s.samples[t.sampleId]?.name||t.sampleId)}</b><p>${esc(labels[t.phase]||t.phase)}</p><p>${esc(t.error||'')}</p><label class="android-check"><input type="checkbox" id="positionChecked">我已核实机械位置正确，样本已${t.action==='in'?'放好':'取出'}</label>${t.action==='out'?'<input id="verifyCode" class="input" placeholder="扫码或输入取出样本编号进行核对">':''}<div class="android-actions"><button class="btn primary" id="finishTask">人工确认完成</button><button class="btn ghost" id="abortTask">核实未完成，保留原库存</button></div>`;
  $('#finishTask').disabled=['sent','accepted'].includes(t.phase);
  $('#finishTask').onclick=finishTask;
  $('#abortTask').onclick=()=>confirmDialog('人工核实后结束任务','这不会停止电机。请先确认机械已停止，样本已恢复到操作前的位置；否则取消并继续保留待核实任务。',()=>{
    const before=JSON.parse(JSON.stringify(state));
    state.set.motionTask=null;
    state.rec.unshift({time:FMT.now(),sample:state.s.samples[t.sampleId]?.name||t.sampleId,type:'任务取消',detail:'人工确认恢复原状态：'+t.taskId});
    if(!saveAll()){state=before;return;}
    clearTimeout(taskTimer);reloadUI();renderTask();
  });
}
function finishTask(){
  const t=state.set.motionTask;if(!t||['sent','accepted'].includes(t.phase))return;
  const x=state.s.samples[t.sampleId];if(!x)return;
  if(!$('#positionChecked').checked){toast('请先核实位置和样本');return;}
  if(t.action==='out'){
    const code=scanCode($('#verifyCode').value);
    if(code!==x.code&&code!==x.id){toast('扫码编号与任务样本不符');return;}
  }
  if(!MotionCore.slotFree(state.s.samples,t.slot,x.id)){toast('槽位冲突，请核实');return;}
  const previous=JSON.parse(JSON.stringify(state));
  x.status=t.action;x.pendingIntake=false;x.updatedAt=Date.now();
  if(t.action==='in'){x.slot=t.slot;x.loc='圆盘-'+t.slot;}else{x.lastSlot=t.slot;delete x.slot;x.loc='已出库';}
  state.set.motionTask=null;
  state.rec.unshift({time:FMT.now(),sample:x.name,type:t.action==='in'?'入库':'出库',detail:`人工确认完成，槽位 ${t.slot}，任务 ${t.taskId}`});
  state.rec=state.rec.slice(0,500);
  if(!saveAll()){state=previous;toast('保存失败，任务仍待确认');return;}
  clearTimeout(taskTimer);reloadUI();renderTask();toast('库存已更新');
}
function scanCode(text){
  const raw=text.trim(),match=raw.match(/(?:^|\n)编号[：:]\s*([^\r\n]+)/);
  return match?match[1].trim():raw;
}
function receiveImport(text){
  if(state.set.motionTask){toast('当前有未完成任务，不能导入覆盖');return;}
  try{
    const data=MotionCore.validateBackup(JSON.parse(text.replace(/^\uFEFF/,'')));
    confirmDialog('导入并替换本机数据',`备份包含 ${Object.keys(data.samples).length} 个样本。将替换本机样本和记录，建议先导出当前备份。`,()=>{
      if(state.set.motionTask){toast('请先处理当前任务');return;}
      const old=state;
      state={s:{...Store.defaults(),samples:data.samples,samplesSeeded:true},rec:data.records,set:data.settings};
      if(!saveAll()){state=old;toast('导入失败，原数据已保留');return;}
      if(simTimer){clearInterval(simTimer);simTimer=null;}
      state.s.online=Number(hardware.sensor)+Number(hardware.motion);
      reloadUI();renderTask();toast('导入成功');
    });
  }catch(e){toast('导入失败：'+e.message);}
}
window.onAndroidEvent=(type,role,text)=>{
  if(type==='import'){receiveImport(text);return;}
  if(type==='line'){
    if(role==='sensor')parseIncoming(text+'\n');
    else {
      briLog('机械 ◀ '+text);
      try{
        const t=state.set.motionTask,next=MotionCore.next(t,JSON.parse(text));
        if(next!==t){if(persistTask(next)&&!['sent','accepted'].includes(next.phase))clearTimeout(taskTimer);}
      }catch(e){briLog('机械反馈不是有效 JSON','err');}
    }
    return;
  }
  if(type==='connected'||type==='disconnected'){
    hardware[role]=type==='connected';
    if(role==='sensor'){
      serialBuf='';monitorActive=hardware.sensor;
      if(hardware.sensor&&simTimer){clearInterval(simTimer);simTimer=null;state.set.simOn=false;$('#simStartBtn').textContent='开始模拟';}
      $('#connectBtn').classList.toggle('hidden',hardware.sensor);
      $('#disconnectBtn').classList.toggle('hidden',!hardware.sensor);
      $('#rackPill').textContent=hardware.sensor?'温控在线':'温控离线';
      $('#serialBtn').classList.toggle('on',hardware.sensor);
    }
    $('#motionConnection').textContent=hardware.motion?'机械已连接':'机械未连接';
    state.s.online=Number(hardware.sensor)+Number(hardware.motion);saveAll();refreshStats();
  }
  if((type==='disconnected'||type==='error')&&role==='motion'&&state.set.motionTask){
    const t=state.set.motionTask;if(['sent','accepted'].includes(t.phase))persistTask({...t,phase:'uncertain',error:text});
  }
  if(type!=='sent')toast(text);
  briLog((role==='motion'?'机械':'系统')+' · '+text,type==='error'?'err':'');
};
window.androidBack=()=>{
  const modal=document.querySelector('.modal-mask.open');
  if(modal)modal.classList.remove('open');else goView('dashboard');
};
document.addEventListener('DOMContentLoaded',()=>{
  const panel=document.createElement('div');panel.className='panel glass android-motion';
  panel.innerHTML=`<div class="panel-head"><h3>五槽位出入库</h3><span class="pill" id="motionConnection">机械未连接</span></div><p class="muted">样本库按钮发起任务；硬件到位与样本操作分别确认。机械协议为联调草案，需与第二组约定后启用。</p><div class="android-actions"><select class="select" id="motionMode"><option value="manual">人工模式（不驱动机械）</option><option value="hardware">硬件联调模式</option></select><select class="select" id="motionBaud"><option>115200</option><option>9600</option><option>57600</option></select><button class="btn primary" id="motionConnect">连接机械板</button><button class="btn ghost" id="motionDisconnect">断开机械板</button></div><div class="android-actions"><label>入库目标槽位 <select class="select" id="motionSlot">${[1,2,3,4,5].map(n=>'<option>'+n+'</option>').join('')}</select></label><button class="btn ghost" id="bindSlot">绑定已有在库样本槽位</button></div><div id="motionTask" class="android-task"></div>`;
  $('#view-monitor').prepend(panel);
  $('#motionConnect').onclick=()=>AndroidHost.connect('motion',Number($('#motionBaud').value));
  $('#motionDisconnect').onclick=()=>AndroidHost.disconnect('motion');
  $('#bindSlot').onclick=()=>{
    if(state.set.motionTask){toast('请先处理当前任务');return;}
    const list=Object.values(state.s.samples).filter(x=>x.status==='in');
    if(!list.length){toast('暂无在库样本');return;}
    const dialog=document.createElement('div');dialog.className='modal-mask open';
    dialog.innerHTML=`<div class="modal"><div class="modal-head"><h3>绑定实际槽位</h3></div><div class="modal-body"><p>用于迁移的已有在库样本。请人工核对实际位置。</p><select class="select" id="bindSample">${list.map(x=>`<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.code)}</option>`).join('')}</select><p>将绑定到槽位 ${$('#motionSlot').value}</p></div><div class="modal-foot"><button class="btn ghost" id="bindCancel">取消</button><button class="btn primary" id="bindConfirm">已核实，绑定</button></div></div>`;
    document.body.append(dialog);$('#bindCancel').onclick=()=>dialog.remove();
    $('#bindConfirm').onclick=()=>{
      const id=$('#bindSample').value,slot=Number($('#motionSlot').value);
      if(!MotionCore.slotFree(state.s.samples,slot,id)){toast('槽位已被占用');return;}
      const before=JSON.parse(JSON.stringify(state));
      state.s.samples[id].slot=slot;state.s.samples[id].loc='圆盘-'+slot;
      state.rec.unshift({time:FMT.now(),sample:state.s.samples[id].name,type:'槽位绑定',detail:'人工核实：圆盘-'+slot});
      if(!saveAll()){state=before;return;}
      dialog.remove();reloadUI();toast('已绑定');
    };
  };
  const scan=document.createElement('div');scan.className='android-scan';
  scan.innerHTML='<input class="input" id="scanInput" placeholder="点击此处后扫码，或输入样本编号"><button class="btn ghost" id="scanFind">查询样本</button><button class="btn primary" id="scanNew">扫码录入</button>';
  $('#view-library').prepend(scan);
  $('#scanFind').onclick=()=>{$('#searchInput').value=scanCode($('#scanInput').value);renderLibrary();};
  $('#scanInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#scanFind').click();}});
  $('#scanNew').onclick=()=>{if(state.set.motionTask){toast('请先处理当前任务');return;}const code=scanCode($('#scanInput').value);openModal();if(code){$('#fCode').value=code;updateBarcodePreview(code);}};
  for(const id of ['resetBtn','importBtn'])$('#'+id).addEventListener('click',e=>{if(state.set.motionTask){e.preventDefault();e.stopImmediatePropagation();toast('请先处理当前出入库任务');}},true);
  $('#simStartBtn').addEventListener('click',e=>{if(hardware.sensor){e.stopImmediatePropagation();toast('请先断开真实温控设备再模拟');}},true);
  $('#setHi').addEventListener('change',()=>{if(Number(state.set.hi)<=Number(state.set.lo)){state.set.hi=Number(state.set.lo)+1;fillSettings();saveAll();toast('上限必须高于下限，已修正');}});
  $('#buildTag').textContent='Android 1.0 · 本机 SQLite';
  if(state.set.motionTask)persistTask({...state.set.motionTask,phase:'uncertain',error:'应用重新启动，请人工核实上次操作；不会自动重发指令'});
  renderTask();
});

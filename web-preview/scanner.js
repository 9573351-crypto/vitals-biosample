'use strict';
function processScannerCode(raw,mode,context){
  const code=scanCode(raw);
  if(!code||code.length>128||/[\r\n\x00-\x1f]/.test(code)||/^https?:\/\//i.test(code))return {ok:false,message:'扫码内容不是有效的样本编号'};
  if(mode==='verify')return verifyOutboundScanner(raw,context);
  const sample=Object.values(state.s.samples).find(x=>x.code===code||x.id===code);
  if(mode==='scan'){
    if(!sample)return {ok:false,message:'未找到编号“'+code+'”对应的样本，请使用“扫码枪录入样本”'};
    openDetail(sample.id);return {ok:true,message:'已识别样本：'+sample.name};
  }
  if(state.set.motionTask)return {ok:false,message:'请先处理当前出入库任务，再录入样本'};
  if(sample){
    if(mode==='new'){openDetail(sample.id);return {ok:true,message:'该编号已存在，已打开原样本；未重复录入'};}
    if(sample.id!==editingId)return {ok:false,message:'该编号已被“'+sample.name+'”使用，请扫描其他标签'};
  }
  if(mode==='new')openModal();
  else if(mode!=='fill'||!$('#sampleModal').classList.contains('open')||editingId!==context)return {ok:false,message:'录入表单已变化，请关闭扫码窗口后重试'};
  $('#fCode').value=code;updateBarcodePreview(code);
  return {ok:true,message:'编号已填入，请补全样本信息后保存'};
}

document.addEventListener('DOMContentLoaded',()=>{
  let mode=null,context=null;
  const panel=document.createElement('div');panel.id='scannerPanel';panel.className='scanner-panel';
  panel.innerHTML='<div class="scanner-dialog"><div class="scanner-head"><strong id="scannerTitle">扫码枪</strong><span class="pill" id="scannerDialogState">等待扫码</span></div><div class="scanner-symbol">▥</div><p id="scannerPrompt">请使用得力 AA307 扫描样本标签</p><div id="scannerStatus" role="status">等待扫码数据…</div><button class="btn ghost" id="scannerCancel">取消</button></div>';
  document.body.append(panel);
  const status=$('#scannerStatus');
  function close(){mode=null;context=null;panel.classList.remove('open');}
  function open(nextMode,nextContext=null){
    if(!hardware.scannerConnected){toast('请先连接得力 AA307 扫码枪');goView('devices');return;}
    if(['new','fill'].includes(nextMode)&&state.set.motionTask){toast('请先处理当前出入库任务');return;}
    if(nextMode==='verify'){
      const task=state.set.motionTask;
      if(!task||task.taskId!==nextContext||task.action!=='out'||['sent','accepted'].includes(task.phase)){toast('当前任务暂不能进行出库核对');return;}
      scannerVerification=null;renderTask();
    }
    mode=nextMode;context=nextContext;
    $('#scannerTitle').textContent={scan:'扫码枪查询样本',new:'扫码枪录入样本',fill:'扫描样本编号',verify:'扫码枪核对出库样本'}[mode];
    $('#scannerPrompt').textContent=mode==='verify'?'请扫描本次出库样本标签；核对后仍需人工确认取出。':mode==='scan'?'请扫描样本标签，识别后将打开样本详情。':'请扫描样本标签，识别编号后补全信息并保存。';
    status.textContent='等待扫码数据…';panel.classList.add('open');
  }
  window.openVitalsScanner=open;window.closeVitalsScanner=close;
  window.onVitalsScannerData=raw=>{
    if(!mode){toast('扫码枪已读取：'+scanCode(raw)+'；请先选择扫码功能');return;}
    const outcome=processScannerCode(raw,mode,context);
    if(outcome.ok){close();toast(outcome.message);}else status.textContent=outcome.message;
  };
  window.refreshScannerConnection=()=>{
    const connected=!!hardware.scannerConnected,detected=Number(hardware.scanner)>0;
    const stateEl=$('#scannerConnection'),connect=$('#scannerConnect'),disconnect=$('#scannerDisconnect');
    if(stateEl){stateEl.textContent=connected?'扫码枪已连接':detected?'已检测，等待连接':'未检测到扫码枪';stateEl.classList.toggle('on',connected);}
    if(connect)connect.classList.toggle('hidden',connected);
    if(disconnect)disconnect.classList.toggle('hidden',!connected);
    if(!connected&&mode)close();
  };
  const previousBack=window.androidBack;window.androidBack=()=>{if(panel.classList.contains('open'))close();else if(previousBack)previousBack();};
  $('#scannerCancel').onclick=close;

  const deviceActions=$('#scannerDeviceActions'),actions=$('#scannerActions');
  deviceActions.innerHTML='<div class="scanner-connect glass"><div><b>得力 AA307 二维条码扫描器</b><p>USB 虚拟串口模式 · 自动按一次完整扫描接收数据</p></div><span class="pill" id="scannerConnection">未检测到扫码枪</span><button class="btn primary" id="scannerConnect">连接扫码枪</button><button class="btn ghost hidden" id="scannerDisconnect">断开扫码枪</button></div>';
  actions.innerHTML='<div class="scanner-buttons"><button class="btn ghost" id="scannerQuery">扫码枪查询样本</button><button class="btn primary" id="scannerNew">扫码枪录入样本</button></div>';
  $('#scannerConnect').onclick=()=>AndroidHost.connect('scanner',115200);
  $('#scannerDisconnect').onclick=()=>AndroidHost.disconnect('scanner');
  $('#scannerQuery').onclick=()=>open('scan');$('#scannerNew').onclick=()=>open('new');
  const fill=document.createElement('button');fill.id='scannerFillCode';fill.type='button';fill.className='btn ghost';fill.textContent='扫码枪扫描编号';fill.onclick=()=>open('fill',editingId);$('#fCode').after(fill);
  refreshScannerConnection();
});

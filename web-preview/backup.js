(function(){
  'use strict';
  const el=id=>document.getElementById(id);
  const native=()=>window.AndroidHost&&typeof AndroidHost.getBackupStatus==='function';
  const parse=value=>{try{const data=JSON.parse(value||'{}');if(data&&data.ok===false)throw Error(data.error||'读取失败');return data||{};}catch(error){return {configured:false,error:error.message};}};
  const time=value=>value?new Date(Number(value)).toLocaleString('zh-CN',{hour12:false}):'尚未生成';

  function install(){
    const view=el('view-settings');
    if(!view||el('backupCard'))return;
    const card=document.createElement('section');
    card.className='panel glass';card.id='backupCard';
    card.innerHTML='<div class="panel-head"><h3>一体机内部自动备份</h3><span class="pill" id="backupPill">未设置</span></div>'+
      '<p class="muted">数据库始终保存在本机。首次选择内部存储目录后，数据变更会自动生成 JSON 备份，并保留最近 30 份；不需要 U 盘。</p>'+
      '<div class="setting-row"><label>备份目录</label><strong id="backupDirectory">未选择</strong></div>'+
      '<div class="setting-row"><label>最近成功备份</label><strong id="backupLast">尚未生成</strong></div>'+
      '<div class="set-actions"><button class="btn primary" id="backupChoose">选择内部存储目录</button><button class="btn ghost" id="backupNow">立即备份</button><button class="btn ghost" id="backupDisable">关闭自动备份</button></div>';
    view.appendChild(card);
    el('backupChoose').onclick=()=>{if(native())AndroidHost.chooseBackupDirectory();};
    el('backupNow').onclick=()=>{if(native())AndroidHost.backupNow();};
    el('backupDisable').onclick=()=>{if(!native())return;confirmDialog('关闭自动备份','只关闭后续自动备份，不会删除已保存在一体机内部的文件。',()=>AndroidHost.disableAutoBackup());};
    refresh();
  }

  function refresh(){
    const available=native(),status=available?parse(AndroidHost.getBackupStatus()):{configured:false};
    const configured=!!status.configured&&status.writable!==false;
    if(el('backupPill')){el('backupPill').textContent=configured?'已启用':'未设置';el('backupPill').classList.toggle('on',configured);}
    if(el('backupDirectory'))el('backupDirectory').textContent=status.error?'读取失败':status.configured?(status.directory||'已选择目录'):'内部存储/Documents/生息样本库/备份';
    if(el('backupLast'))el('backupLast').textContent=time(status.lastSuccess);
    if(el('backupNow'))el('backupNow').disabled=!configured;
    if(el('backupDisable'))el('backupDisable').disabled=!status.configured;
    if(el('backupChoose'))el('backupChoose').disabled=!available;
  }

  window.onVitalsBackupEvent=(role,message)=>{
    refresh();
    if(typeof toast==='function'&&role!=='cancelled')toast(message);
  };
  document.addEventListener('DOMContentLoaded',install);
})();

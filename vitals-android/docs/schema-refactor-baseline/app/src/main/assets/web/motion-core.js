/* Pure protocol/state helpers shared with meaningful node tests. */
(function(root){
  const api={
    next(task,message){
      if(!task || !message || message.taskId!==task.taskId) return task;
      if(!['sent','accepted'].includes(task.phase))return task;
      const t={...task};
      if(message.type==='accepted') t.phase='accepted';
      else if(message.type==='arrived') t.phase=message.feedback==='position'?'arrived':'verify';
      else if(message.type==='estimated') t.phase='verify';
      else if(message.type==='failed'){t.phase='uncertain';t.error=String(message.error||'硬件报告失败');}
      return t;
    },
    slotFree(samples,slot,id){return !Object.values(samples).some(x=>x.id!==id && x.status!=='out' && x.slot===slot);},
    validateBackup(data){
      if(!data || typeof data!=='object' || Array.isArray(data))throw Error('备份格式不正确');
      const source=data.samples || data;
      if(!source || typeof source!=='object')throw Error('缺少样本');
      const samples=Object.create(null),codes=new Set(),slots=new Set();
      for(const [key,item] of Object.entries(source)){
        if(!item || typeof item!=='object' || Array.isArray(item) || typeof item.name!=='string')throw Error('存在无效样本');
        const x=JSON.parse(JSON.stringify(item));
        x.id=x.id||key;
        if(typeof x.id!=='string'||!/^[-a-zA-Z0-9_]+$/.test(x.id)||['__proto__','constructor','prototype'].includes(x.id)||samples[x.id])throw Error('样本内部 ID 无效或重复');
        if(x.code && (typeof x.code!=='string'||codes.has(x.code)))throw Error('条码重复或无效');
        if(x.code)codes.add(x.code);
        x.status=x.status||'in';
        if(!['in','out'].includes(x.status))throw Error('库存状态无效');
        if(x.photo && !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=\s]+$/.test(x.photo))throw Error('照片格式不支持');
        for(const k of ['name','code','type','loc','timeRaw','timeTxt','note','qrSnap']) if(x[k]!=null && typeof x[k]!=='string')throw Error('样本字段无效');
        for(const k of ['temp','lastTemp','lastHum','lastLight','createdAt','updatedAt']) if(x[k]!=null && (typeof x[k]!=='number'||!Number.isFinite(x[k])))throw Error('样本数值字段无效');
        if(x.env!=null && (!Array.isArray(x.env)||x.env.some(e=>!e||typeof e!=='object'||['temp','hum'].some(k=>e[k]!=null&&(typeof e[k]!=='number'||!Number.isFinite(e[k]))))))throw Error('历史曲线无效');
        if(x.slot!=null){
          if(!Number.isInteger(x.slot)||x.slot<1||x.slot>5)throw Error('槽位必须是 1—5');
          if(x.status==='in'){if(slots.has(x.slot))throw Error('多个样本占用同一槽位');slots.add(x.slot);}
        }
        samples[x.id]=x;
      }
      const records=data.records||[];
      if(!Array.isArray(records)||records.some(r=>!r||typeof r!=='object'||['time','sample','type','detail'].some(k=>r[k]!=null&&typeof r[k]!=='string')))throw Error('记录格式无效');
      const settings=data.settings||{};
      if(typeof settings!=='object'||Array.isArray(settings))throw Error('设置格式无效');
      const outSettings={simOn:false,hi:8,lo:-88};
      for(const k of ['hi','lo'])if(settings[k]!=null){if(typeof settings[k]!=='number'||!Number.isFinite(settings[k]))throw Error('阈值无效');outSettings[k]=settings[k];}
      if(outSettings.hi<=outSettings.lo)throw Error('温度上限必须高于下限');
      if(settings.motionTask)throw Error('备份含未完成机械任务，请在原设备人工核实处理后重新导出');
      return {samples,records,settings:outSettings};
    }
  };
  root.MotionCore=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);

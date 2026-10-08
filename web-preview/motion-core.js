/* Pure protocol/state helpers shared with meaningful node tests. */
(function(root){
  const categoryCodes=Object.freeze({'全血':'A','血清':'B','血浆':'C','DNA':'D','RNA':'E','尿液':'F','组织切片':'G','其他':'H'});
  const temperatureChannels=Object.freeze({B1:{category:'A',type:'全血',lo:30,hi:65},B2:{category:'B',type:'血清',lo:25,hi:65},B3:{category:'C',type:'血浆',lo:25,hi:60}});
  const storageTypes=Object.freeze(['全血','血清','血浆']);
  const api={
    categoryCodes,
    temperatureChannels,
    storageTypes,
    thresholdFor(category){
      if(!category)return null;
      const channel=Object.values(temperatureChannels).find(c=>c.category===category);
      return channel?{lo:channel.lo,hi:channel.hi}:null;
    },
    disc(type){
      if(!storageTypes.includes(type))throw Error('当前只支持全血、血清、血浆三个存储圆盘');
      return {type,category:categoryCodes[type],name:type+'圆盘'};
    },
    slotKey(type,slot){api.disc(type);api.position(slot);return type+'\u0000'+slot;},
    slotLabel(type,slot){api.position(slot);return api.disc(type).name+' '+slot+'号';},
    position(slot){
      if(!Number.isInteger(slot)||slot<1||slot>5)throw Error('圆槽位置无效');
      return slot-1;
    },
    command(sample,action,slot){
      if(!sample)throw Error('缺少样本');
      api.disc(sample.type);
      if(!['in','out'].includes(action))throw Error('出入库指示无效');
      const position=api.position(slot);
      return `${action==='in'?'IN':'OUT'},${categoryCodes[sample.type]}-${position}`;
    },
    parseFeedback(line,task){
      const raw=String(line||'').trim();
      if(!raw)throw Error('机械反馈为空');
      if(raw[0]==='{'){
        const message=JSON.parse(raw),ok=message.ok===true||message.ok===1||String(message.ok||'').toLowerCase()==='ok';
        if(ok)return {...message,taskId:message.taskId||task?.taskId||'',type:'ok'};
        return message;
      }
      const okMatch=raw.match(/^ok(?:\s*[:=]\s*(?:1|true))?(?:,\s*([^,]+))?$/i);
      if(okMatch){
        if(!task||okMatch[1]&&okMatch[1]!==task.sampleId)return {taskId:'',type:'ok'};
        return {taskId:task.taskId,type:'ok'};
      }
      const parts=raw.split(','),type=String(parts.shift()||'').trim().toLowerCase(),sampleId=String(parts.shift()||'').trim();
      if(!['accepted','arrived','estimated','failed'].includes(type)||!sampleId)throw Error('机械反馈格式无效');
      if(!task||sampleId!==task.sampleId)return {taskId:'',type};
      const message={taskId:task.taskId,type};
      if(type==='arrived')message.feedback='position';
      if(type==='failed')message.error=parts.join(',').trim()||'硬件报告失败';
      return message;
    },
    next(task,message){
      if(!task || !message || message.taskId!==task.taskId) return task;
      if(!['sent','accepted'].includes(task.phase))return task;
      const t={...task};
      if(message.type==='accepted') t.phase='accepted';
      else if(message.type==='ok') t.phase=task.action==='out'?'confirmed':'arrived';
      else if(message.type==='arrived') t.phase=message.feedback==='position'?'arrived':'verify';
      else if(message.type==='estimated') t.phase='verify';
      else if(message.type==='failed'){t.phase='uncertain';t.error=String(message.error||'硬件报告失败');}
      return t;
    },
    slotFree(samples,type,slot,id){
      api.slotKey(type,slot);
      return !Object.values(samples).some(x=>x.id!==id && x.status!=='out' && x.type===type && x.slot===slot);
    },
    validateBackup(data){
      if(!data || typeof data!=='object')throw Error('备份格式不正确');
      if(data.s && data.s.samples)data={samples:data.s.samples,records:data.rec||data.s.records||[],settings:data.set||data.s.settings||{}};
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
          if(x.status==='in'){
            const slotKey=api.slotKey(x.type,x.slot);
            if(slots.has(slotKey))throw Error('同一圆盘内有多个样本占用同一槽位');
            slots.add(slotKey);
          }
          else{x.lastSlot=x.slot;delete x.slot;}
        }
        samples[x.id]=x;
      }
      const records=data.records||[];
      if(!Array.isArray(records)||records.some(r=>!r||typeof r!=='object'||['time','sample','type','detail'].some(k=>r[k]!=null&&typeof r[k]!=='string')))throw Error('记录格式无效');
      const settings=data.settings||{};
      if(typeof settings!=='object'||Array.isArray(settings))throw Error('设置格式无效');
      const outSettings={hi:8,lo:-88,...settings,simOn:false,online:0};
      for(const k of ['hi','lo'])if(settings[k]!=null){if(typeof settings[k]!=='number'||!Number.isFinite(settings[k]))throw Error('阈值无效');outSettings[k]=settings[k];}
      if(outSettings.hi<=outSettings.lo)throw Error('温度上限必须高于下限');
      if(settings.motionTask)throw Error('备份含未完成机械任务，请在原设备人工核实处理后重新导出');
      return {samples,records,settings:outSettings};
    }
  };
  root.MotionCore=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window!=='undefined'?window:globalThis);

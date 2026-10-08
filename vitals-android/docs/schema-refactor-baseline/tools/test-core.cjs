const {test}=require('node:test');const assert=require('node:assert/strict');
const core=require('../app/src/main/assets/web/motion-core.js');
test('receipt is not arrival; timed completion is not position feedback',()=>{
 const t={taskId:'A',phase:'sent'};
 assert.equal(core.next(t,{taskId:'B',type:'arrived',feedback:'position'}),t);
 assert.equal(core.next(t,{taskId:'A',type:'accepted'}).phase,'accepted');
 assert.equal(core.next(t,{taskId:'A',type:'arrived'}).phase,'verify');
 assert.equal(core.next(t,{taskId:'A',type:'arrived',feedback:'position'}).phase,'arrived');
 assert.equal(core.next(t,{taskId:'A',type:'estimated'}).phase,'verify');
});
test('uncertain tasks do not accept delayed replies automatically',()=>{
 const t={taskId:'A',phase:'uncertain'};assert.equal(core.next(t,{taskId:'A',type:'arrived',feedback:'position'}),t);
});
test('occupied slots cannot be allocated twice',()=>{
 assert.equal(core.slotFree({a:{id:'a',slot:1,status:'in'}},1,'b'),false);
 assert.equal(core.slotFree({a:{id:'a',slot:1,status:'out'}},1,'b'),true);
});
test('imports preserve sample identity and strip stale connection state',()=>{
 const data=core.validateBackup({samples:{a:{id:'a',code:'C1',name:'血清',status:'in'}},settings:{online:1,simOn:true}});
 assert.equal(data.samples.a.name,'血清');assert.equal(data.settings.simOn,false);assert.equal(data.settings.online,undefined);
});
test('invalid imports cannot overwrite good records',()=>{
 for(const data of [null,{samples:{a:null}},{samples:{a:{name:'a',code:'x'},b:{name:'b',code:'x'}}},{samples:{a:{name:'a',photo:'javascript:evil()'}}},{samples:{a:{name:'a',slot:6}}},{samples:{a:{name:'a',slot:1},b:{name:'b',slot:1}}},{samples:{},settings:{motionTask:{taskId:'A'}}}])assert.throws(()=>core.validateBackup(data));
});

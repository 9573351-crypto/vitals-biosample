const {test}=require('node:test');const assert=require('node:assert/strict');
const core=require('../app/src/main/assets/web/motion-core.js');
test('mechanical command has operation and category-slot only',()=>{
 assert.equal(core.command({id:'SB-001',type:'全血'},'in',1),'IN,A-0');
 assert.equal(core.command({id:'SERUM',type:'血清'},'out',5),'OUT,B-4');
 assert.equal(core.command({id:'PLASMA',type:'血浆'},'in',3),'IN,C-2');
 assert.equal(core.slotLabel('全血',1),'全血圆盘 1号');
 assert.equal(core.slotLabel('血浆',5),'血浆圆盘 5号');
 assert.throws(()=>core.command({id:'DNA_9',type:'DNA'},'out',5));
 assert.throws(()=>core.command({id:'SB-001',type:'未知'},'in',1));
});
test('temperature board channels map to sample categories',()=>{
 assert.deepEqual(core.temperatureChannels.B1,{category:'A',type:'全血',lo:30,hi:65});
 assert.deepEqual(core.temperatureChannels.B2,{category:'B',type:'血清',lo:25,hi:65});
 assert.deepEqual(core.temperatureChannels.B3,{category:'C',type:'血浆',lo:25,hi:60});
 assert.deepEqual(core.thresholdFor('B'),{lo:25,hi:65});
 assert.equal(core.thresholdFor('H'),null);
});
test('plain mechanical feedback is correlated by sample id',()=>{
 const task={taskId:'T-1',sampleId:'SB-001',phase:'sent'};
 assert.equal(core.next(task,core.parseFeedback('ACCEPTED,SB-001',task)).phase,'accepted');
 assert.equal(core.next(task,core.parseFeedback('ARRIVED,SB-001',task)).phase,'arrived');
 assert.equal(core.next(task,core.parseFeedback('ARRIVED,OTHER',task)),task);
 assert.equal(core.next(task,core.parseFeedback('FAILED,SB-001,电机未回零',task)).error,'电机未回零');
});
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
test('mechanical OK completes only a correlated active task',()=>{
 const out={taskId:'T',sampleId:'S',action:'out',phase:'sent'};
 assert.equal(core.next(out,core.parseFeedback('OK',out)).phase,'confirmed');
 assert.equal(core.next(out,core.parseFeedback('{"ok":true}',out)).phase,'confirmed');
 assert.equal(core.parseFeedback('OK,OTHER',out).taskId,'');
 const uncertain={...out,phase:'uncertain'};
 assert.equal(core.next(uncertain,core.parseFeedback('OK',uncertain)),uncertain);
 const incoming={...out,action:'in'};
 assert.equal(core.next(incoming,core.parseFeedback('ok=1',incoming)).phase,'arrived');
});
test('slots are unique inside each sample disc',()=>{
 const samples={a:{id:'a',type:'全血',slot:1,status:'in'}};
 assert.equal(core.slotFree(samples,'全血',1,'b'),false);
 assert.equal(core.slotFree(samples,'血清',1,'b'),true);
 assert.equal(core.slotFree({a:{...samples.a,status:'out'}},'全血',1,'b'),true);
});
test('imports preserve sample identity and strip stale connection state',()=>{
 const data=core.validateBackup({samples:{a:{id:'a',code:'C1',name:'血清',status:'in'}},settings:{online:1,simOn:true}});
 assert.equal(data.samples.a.name,'血清');assert.equal(data.settings.simOn,false);assert.equal(data.settings.online,0);
});
test('legacy state, bare arrays and extension settings remain compatible',()=>{
 const d=core.validateBackup({s:{samples:{a:{id:'a',name:'a',status:'out',slot:2,photo:'data:image/jpeg;base64,YWJj',env:[]}}},rec:[],set:{hi:8,lo:-88,custom:{value:1}}});
 assert.equal(d.samples.a.slot,undefined);assert.equal(d.samples.a.lastSlot,2);assert.deepEqual(d.settings.custom,{value:1});
 assert.equal(core.validateBackup([{id:'a',name:'a'}]).samples.a.name,'a');
});
test('imports allow matching slot numbers on different discs and reject collisions inside one disc',()=>{
 const valid=core.validateBackup({samples:{a:{name:'a',type:'全血',status:'in',slot:1},b:{name:'b',type:'血清',status:'in',slot:1}}});
 assert.equal(valid.samples.a.slot,1);assert.equal(valid.samples.b.slot,1);
 for(const data of [null,{samples:{a:null}},{samples:{a:{name:'a',code:'x'},b:{name:'b',code:'x'}}},{samples:{a:{name:'a',photo:'javascript:evil()'}}},{samples:{a:{name:'a',type:'全血',status:'in',slot:6}}},{samples:{a:{name:'a',type:'全血',status:'in',slot:1},b:{name:'b',type:'全血',status:'in',slot:1}}},{samples:{a:{name:'a',type:'DNA',status:'in',slot:1}}},{samples:{},settings:{motionTask:{taskId:'A'}}}])assert.throws(()=>core.validateBackup(data));
});

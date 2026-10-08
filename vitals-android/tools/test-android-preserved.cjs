// Back up/restore simulator vitals.db around interactive tests; physical devices are never selected.
const fs=require('node:fs'),path=require('node:path'),{execFileSync,spawnSync}=require('node:child_process');
const adb='D:/android-studio/SDK/platform-tools/adb.exe',root=path.resolve(__dirname,'..');
const cmd=(...a)=>execFileSync(adb,['-s','emulator-5554',...a],{encoding:'utf8'}).trim();
const save=path.join(root,'docs/schema-refactor-baseline/emulator-before-ui.db');
cmd('shell','am','force-stop','com.vitals.android');
const data=execFileSync(adb,['-s','emulator-5554','exec-out','run-as','com.vitals.android','cat','databases/vitals.db']);
fs.writeFileSync(save,data);
let code=1;
try{
 const result=spawnSync(process.execPath,[path.join(__dirname,'test-android.cjs')],{encoding:'utf8'});
 fs.writeFileSync(path.join(root,'docs/android-ui-test-results.txt'),(result.stdout||'')+(result.stderr||''));
 process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');code=result.status===null?1:result.status;
}finally{
 cmd('shell','am','force-stop','com.vitals.android');
 cmd('push',save,'/data/local/tmp/vitals-restore.db');
 cmd('shell','run-as','com.vitals.android','cp','/data/local/tmp/vitals-restore.db','databases/vitals.db');
 cmd('shell','am','start','-n','com.vitals.android/.MainActivity');
}
process.exitCode=code;

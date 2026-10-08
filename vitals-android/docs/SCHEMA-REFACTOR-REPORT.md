# 数据库规范化修改报告

## 1. 范围与审计

实际 app.js：`D:\sx\system\vitals-android\app\src\main\assets\web\app.js`。

只修改独立安卓工程。原 Windows 目录单独做 SHA256 比对；视觉样式 styles.css/android.css 不修改，index.html 仅增加 persistence.js 脚本。应用包名仍为 `com.vitals.android`，版本升至 1.1.0（versionCode 2），测试签名与原安装包一致。

先完成 [SCHEMA-AUDIT.md](SCHEMA-AUDIT.md)，再实现：旧模型为 `state.s.samples`（id→样本）、`state.rec`（最新在前的记录数组）、`state.set`（设置及单个 motionTask）。旧 SQLite 只在 `app_state(id=1,payload)` 保存整个 state。

真实条码字段是 `code`，不是 barcode；status 只有 in/out，pendingIntake 表示待入库；slot/lastSlot 为 1—5。photo 是 data URL，createdAt/updatedAt 为毫秒整数；lastUpdate 是显示时间字符串。旧 records 只有 time/sample/type/detail，sample 是名字，不是 ID。

## 2. 最终 schema

### samples

| 列 | SQLite 类型／约束 | JS 字段 |
|---|---|---|
| sample_id | TEXT PRIMARY KEY NOT NULL | id |
| name | TEXT NOT NULL | name |
| barcode | TEXT UNIQUE，可空；空 code 规范成 NULL | code |
| status | TEXT NOT NULL CHECK IN ('in','out') | status |
| slot | INTEGER UNIQUE，NULL 或整数 1—5；out 时必须 NULL | slot |
| last_slot | INTEGER，NULL 或整数 1—5 | lastSlot |
| pending_intake | INTEGER NOT NULL DEFAULT 0，CHECK 0/1 | pendingIntake |
| type / location | TEXT | type / loc |
| collected_at / collected_time_text | TEXT | timeRaw / timeTxt |
| temperature | REAL | temp |
| note / photo | TEXT | note / photo |
| created_at / updated_at | INTEGER | createdAt / updatedAt |
| monitor | INTEGER NOT NULL DEFAULT 0，CHECK 0/1 | monitor |
| last_temperature / last_humidity / last_light | REAL | lastTemp / lastHum / lastLight |
| last_update | TEXT | lastUpdate |
| alert | TEXT，NULL 或 good/warn/bad | alert |
| qr_snapshot | TEXT | qrSnap |
| extra_json | TEXT NOT NULL DEFAULT '{}' | env、旧 time、其他未映射字段 |

可选 NULL 字段读取时允许省略，boolean 缺省为 false；这些规范化不改变界面空值含义。旧 out+slot 转为 lastSlot，避免已经出库的样本占着当前槽位。Base64 照片保持 TEXT，未改成 URI。

### records

`id INTEGER PRIMARY KEY AUTOINCREMENT`；`sample_id TEXT NULL`；`sample_name,time,type,detail TEXT NOT NULL DEFAULT ''`；`barcode TEXT`；`slot INTEGER NULL/1—5`；`status TEXT NULL/in/out`；`task_id TEXT`；`extra_json TEXT NOT NULL DEFAULT '{}'`。

外键：`FOREIGN KEY(sample_id) REFERENCES samples(sample_id) ON DELETE SET NULL`。索引 `records_sample_time(sample_id,time)`。

JS 输出兼容字段 time/sample/type/detail，并增加 recordId、sampleId 及可选 code/slot/status/taskId。新增操作立即使用真实内部 ID；旧记录只在名称唯一且不是“系统”时补关系。不能定位的旧记录保持 NULL。删除样本保留记录及名字／条码快照；不是 CASCADE 删除历史。告警原来只在 detail 内记录温度，因此没有虚构 records.temperature 列。

### settings 与元信息

`settings(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)`；每个 value 是独立 JSON 值，允许 motionTask、扩展配置等复杂对象。hi/lo、bool、任务字段在 Java 再校验。

另有内部 `db_meta(key,value)`，用于 legacy_migration、legacy_migrated_at、revision、legacy_s_extra。最后一项仅保留旧 s 的扩展／历史统计信息，不含样本集合，不是日常业务整库存储。前端统计由样本重算。

## 3. MainActivity 与 Bridge

移除 Activity 直接 openOrCreateDatabase、CREATE app_state、SELECT payload、INSERT OR REPLACE payload；新增 dbHelper，打开数据库和可能耗时的升级在 IO executor 中完成，再加载页面。升级失败显示提示，保留旧数据，不清库。

数据库调用通过统一错误结果 `{ok:false,error}` 返回。保留 WebView、CSP、本机资源拦截、USB 权限／设备选择／读写／广播、文件选择器、打印和返回键逻辑。onDestroy 关闭 helper。

Bridge API：

| API | 用途 |
|---|---|
| getSamples / getSample(id) / getSampleByBarcode(code) | 样本集合、按内部 ID、按条码查询 |
| getRecords(sampleId) | 全部记录或按样本筛选，最新在前 |
| getSettings / setSetting(key,jsonValue) | 设置读写 |
| saveSample(payload,record) / deleteSample(id,record) | 样本操作，可同事务附加记录 |
| addRecord(payload) | 新增记录；FK 验证 |
| commitChanges(delta) | 前端增量批量事务：样本新增修改删除、记录追加及旧记录裁剪、设置变化 |
| importBackup(payload) / getBackup() | 原子全量导入／从正式表重组兼容 JSON |
| getDatabaseInfo() | schema 版本、revision、迁移完成状态 |
| loadState() | 只读兼容诊断，从正式表重组；不读取 legacy payload |

删除 saveState 写整库接口。槽位绑定、入库、出库不堆额外同义接口：前端把样本＋记录＋任务变更经 commitChanges 一次提交。所有 SQL 数据输入绑定参数或 ContentValues；动态 SQL 仅含代码内部固定表／列名。

## 4. 前端写入与事务

新增 persistence.js，在原 app.js 前加载。启动调用 getSamples/getRecords/getSettings，检查前后 revision 一致后重建旧 state，保持 renderLibrary、renderRecords、renderRack 和 renderMonitorCharts。

Store.save 比较每个样本／设置和已持久化快照，仅提交变化行；没有变化不调用写接口。新 records 回填数据库 recordId，用于保持顺序和增量裁剪，不重写全部记录。数据库拒绝时从正式表恢复 ViewModel。

新增／编辑／删除样本修正为一次提交样本和对应记录。出入库、绑定槽位、取消任务均在同一 transaction 更新相关表。revision 检查防止原生 CRUD 与旧前端快照相互覆盖。helper 公共数据库方法同步，批量操作使用 beginTransaction/setTransactionSuccessful/endTransaction。

普通采样继续实时显示，合并约 2 秒写一次变化样本；告警变化即时写，env 有界历史保持。没有把 USB 通信迁进 SQLite。默认人工模式、不自动重发、ACK 不等于到位、到位不等于样本完成、断线超时保留库存和单任务约束保持。

## 5. 升级与 JSON 兼容

DB_VERSION=2，文件名仍 vitals.db。onCreate 同样检测 legacy，因为旧 openOrCreateDatabase 默认 user_version=0；onUpgrade 兼容 version 1；onOpen 使用持久化标记兜底。事务中解析、验证、插入三表、设置完成标记，保留旧 app_state 原 payload；失败回滚连同 schema 版本，旧数据可供修复。

迁移完成后不会因为新库清空再次导入 legacy。存在未完成任务的本机升级保留任务，App 恢复时照旧转成 uncertain；外部备份含未完成任务则仍禁止直接覆盖导入。

支持 `{s,rec,set}`、`{samples,records,settings}`（旧 version 1／新 version 2）、纯样本对象／数组。外部导入先做 JS 预检，再由 Java 校验，事务删除／写入三表；坏记录导致写到一半失败也会完整回滚。导出从正式表组装旧字段，未知样本／设置扩展和二维码／照片保留，不要求用户重录。

## 6. 文件变更（git diff 风格摘要）

```diff
+ app/src/main/java/com/vitals/android/VitalsDbHelper.java
+ app/src/main/assets/web/persistence.js
+ app/src/androidTest/java/com/vitals/android/DatabaseInstrumentation.java
+ tools/mock-bridge.js
+ tools/test-db.ps1
+ tools/test-android-preserved.cjs
+ tools/refactor-persistence.cjs
+ docs/SCHEMA-AUDIT.md
+ docs/SCHEMA-REFACTOR-REPORT.md
~ app/src/main/java/com/vitals/android/MainActivity.java
~ app/src/main/assets/web/app.js
~ app/src/main/assets/web/android.js
~ app/src/main/assets/web/motion-core.js
~ app/src/main/assets/web/index.html          # 仅脚本引用
~ app/build.gradle                          # 版本号和测试 runner
~ build-apk.ps1                             # 1.1.0 输出名
~ tools/test-core.cjs
~ tools/test-ui.cjs
~ tools/test-android.cjs
~ README.md
  app/src/main/assets/web/styles.css        # 未改
  app/src/main/assets/web/android.css       # 未改
  app/src/main/AndroidManifest.xml          # 未改，应用身份不变
  D:\sx\system\code                         # 未改
```

`docs/schema-refactor-baseline` 保存修改前源码、旧 APK 与模拟器数据库备份，便于核对；不打包进 APK。测试日志／截图和校验结果也是工程内产物。

## 7. 测试、失败处理与产物

- Node 核心测试 6 项通过，覆盖协议状态、槽位、坏备份、旧 state／数组和扩展字段。
- 浏览器 UI 回归通过：录入编辑、记录关联、无变化不写库、事务失败恢复 ViewModel、出入库、错码拦截、导出／打印入口、任务恢复，页面无 JS 异常。
- Android 原生 SQLite instrumentation 25 项通过：空库、CRUD、唯一性／CHECK、FK、事务回滚、settings、重开、旧库版本 0/1、只迁一次、失败留旧库、未完成任务、旧新备份与往返等。
- 实际 APK 的 Android 14 模拟器流程通过：真实 SQLite 保存／重启，人工入出库、模拟机械 ACK/到位、传感器校验、任务恢复、导入及无设备提示。测试前后备份恢复模拟器原 DB，不以测试清空用户数据。
- 初次编译遇到 Android JSONObject 不公开 valueToString，已改为 Android 支持的 JSONArray 序列化方式并重新通过；没有忽略失败。
- 测试包装脚本一度把通过用例名称中的“failed legacy migration”误判为失败；已改为只匹配行首 FAIL 标记，真实断言未被跳过。
- Lint 无错误，保留旧目标 API、锁定依赖版本、WebView JavaScript 和旧系统备份声明提示（非本次数据库重构引入）。Gradle 另有已有 API／Gradle 10 兼容弃用提示。
- 最终输出：`D:\sx\system\vitals-android\output\Vitals-Android-1.1.0.apk`。为开发测试签名 APK，包名不变，覆盖安装无需卸载。最终构建与 SHA256 见 `schema-verification.json` 和测试日志。

## 8. 目前仍需实机验证

1. 目标 RK3399 / Android 12 一体机的安装升级、系统 WebView、存储速度及空间余量。
2. 真实 USB Host 授权、各串口芯片、双设备同时通信、拔插及供电。
3. 第二组固件、回零／槽位对应、运动反馈、异常与急停；测试中的反馈仅注入，没有真实电机。
4. 第四组温控板数据、长时间采集、断电后数据库恢复；普通合并采样可能丢最后约 2 秒未提交读数。
5. 手机／扫码枪实际输入、厂商内置 DB9 SDK；本版仍未新增摄像头扫码或手机联网同步。
6. 一体机文件选择器、相册权限、实际照片备份量、导入耗时、系统打印服务及标签打印机。

存在重复条码／重复在库槽位／非法字段的历史数据会阻止升级，而不是自动删除冲突项。请保留旧数据并修复后升级。照片规模较大时仍有 TEXT／Bridge 开销，本次按原小规模项目保留兼容格式，没有把它宣称为大规模生产数据库。


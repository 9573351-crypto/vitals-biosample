# 数据字段审计（先于 schema 实现）

2026-09-14。范围仅 `D:\sx\system\vitals-android`，不修改 `D:\sx\system\code`。

## 检查依据

已读取 `app/src/main/assets/web/app.js`、`android.js`、`motion-core.js`、`index.html`，核对所有 state 读写、表单、图表、扫码查询、任务及导入导出；检查 `MainActivity.java` 和现有测试。vendor 为图表／二维码库，不定义业务模型；CSS 不参与持久化。

## 实际字段

`state.s.samples` 是以内部 `id` 为键的对象。样本字段如下：

| 现有字段 | 用途 / 类型 | 数据库映射 |
|---|---|---|
| id | 内部唯一 ID，字符串 | sample_id TEXT PRIMARY KEY NOT NULL |
| name | 样本名称，表单必填 | name TEXT NOT NULL |
| code | 条码／扫码编号，新增编辑检查唯一；不存在 barcode 字段 | barcode TEXT UNIQUE，旧数据缺失允许 NULL |
| type / loc | 样本类型／文字位置 | type / location TEXT |
| status | 仅 in、out | CHECK IN ('in','out') |
| pendingIntake | 新录入尚未入库布尔标志，独立于 status | pending_intake INTEGER 布尔检查 |
| slot / lastSlot | 当前圆盘槽号／出库前槽号 | slot INTEGER UNIQUE，1—5 或 NULL；last_slot 同范围 |
| timeRaw / timeTxt | 表单时间／显示时间字符串 | collected_at / collected_time_text TEXT |
| time | 旧版兼容读取的日期字段，现版不写 | extra_json 保留 |
| temp | 采集温度数值或 null | temperature REAL |
| note / photo | 备注／压缩 JPEG data URL，导入接受 PNG/JPEG/WebP | note / photo TEXT |
| createdAt / updatedAt | JS 毫秒时间戳 | created_at / updated_at INTEGER |
| monitor | 是否监控 | monitor INTEGER 布尔检查 |
| lastTemp / lastHum / lastLight | 最近温湿度、光照 | last_temperature / last_humidity / last_light REAL |
| lastUpdate | 最近读数的显示时间字符串（不是整数时间戳） | last_update TEXT |
| alert | good/warn/bad，温度状态 | alert TEXT，验证已知取值 |
| qrSnap | 录入时冻结的二维码文本 | qr_snapshot TEXT |
| env | 最近最多 60 点，元素 time/temp/hum/light | extra_json 中 env，仍只保留有界历史 |

没有血型、患者 ID、独立 barcode 等字段，不添加。未知旧字段也进入 extra_json，不擅自丢弃。

`state.rec` 真实字段仅 `time, sample, type, detail`。其中 sample 是名称快照，并不是样本 ID；旧数组按最新在前排列，通常限制 500 条，页面显示前 200 条。告警记录的温度嵌在 detail 中，不能凭猜测解析成独立温度列。新版本增加技术 recordId 及明确 sampleId 关联，出入库记录补充来源于任务的 code/slot/status/taskId，保留旧四字段供原界面渲染。

`state.set`：hi、lo（温度阈值）；simOn（模拟开关）；online（旧连接状态）；motionTask（对象或 null）。motionTask 实际字段 taskId、sampleId、action(in/out)、slot、mode(manual/hardware)、phase(sent/accepted/arrived/verify/uncertain)、createdAt、可选 error。未知设置 key-value JSON 保留，避免导入丢扩展配置。

`state.s` 其余字段 total/active/online/alert 是可重算统计／运行状态；settings、records 是 defaults 的历史冗余，当前权威字段在 state.set/state.rec；samplesSeeded 是初始化标志。统计不作为第二份持久化真相。旧 s 的额外字段在迁移元信息中保留，以便兼容导出。

## 一致性决策

- 出库后 slot=NULL，lastSlot 保存历史。旧 out+slot 数据转换为 lastSlot，实际在库槽位才占用 UNIQUE(slot)。旧文字位置不猜测成数字槽位。
- records.sample_id 外键 ON DELETE SET NULL：删除样本仍保留原来的动态记录及名称／编号快照。名称唯一且非“系统”的旧记录可关联；同名、已删除、系统记录保持 NULL，不造假。
- SQLiteOpenHelper DB_VERSION=2；原 openOrCreateDatabase 没设版本，实际可能是 user_version=0，因此 onCreate 和 onUpgrade 都检查 legacy app_state，并在同一个升级事务迁移。保留 app_state；使用独立 db_meta 标记完成，清空后重启也不会复活旧数据。
- 正常写入使用样本／记录／设置增量和事务，不再写 app_state。兼容 loadState 仅从正式表组装，用于诊断旧测试；移除 saveState 写整库接口。
- 多表操作使用 commitChanges 原子提交，新增／编辑／删除样本及其记录不再分两次提交。CRUD Bridge 提供独立查询与原子写入能力。
- 历史 env 和最近读数继续服务图表，普通采样合并约每 2 秒持久化一次；告警／人工操作立即提交，不新增每采样一条 records。
- 全量导入执行独立事务，并在 Bridge 工作线程执行；失败不更新前端 state、不删半库。旧 state、现有备份、纯样本对象／数组均可转换。
- 迁移非法数据不静默清空：抛出错误回滚，并保留旧表原 payload。界面告知启动迁移失败；需要修复冲突备份后再升级，不自动选一个重复条码或槽位。

审计结论：以上映射与实际代码相符，可据此继续实现，无需用户再次确认。修改前源码副本存于 schema-refactor-baseline，供差异核对。

## 生息样本库 1.20.1 · 修复旧库升级缺少归档表

本版修复一个**由设备级测试发现**的真实缺陷，并修正一处测试假设。使用 1.20.0 的设备建议升级。

### 修复

- **旧库升级后缺少 `records_archive` 表**：该表原先只在 `createTables()` 里创建，而旧库升级路径（`onUpgrade` / `onOpen`）不会重新执行全部建表语句。结果是：从 1.18.2 等旧版本升级到 1.20.0 的设备，一旦记录条数超过上限触发留存（把最旧记录搬入归档），就会抛 `no such table: records_archive`，保存失败。现在 `ensureSchema()` 用 `CREATE TABLE IF NOT EXISTS records_archive (...)` 兜底，升级与新装路径一致。
- 修正设备测试中记录归档用例的调用约定：`addRecords` 必须与真实前端一致按「最新在前」下发（前端 `state.rec` 由 `unshift` 维护、`persistence.js` 直接切片下发），并补充断言确认「最旧的两条进归档、最新一条留在 `records`」。此前用例用了相反顺序构造夹具，暴露的是测试假设与调用约定不一致，而非产品缺陷——该约定现已写进 `retainRecords()` 的注释，避免后续误改。

### 验证

- `connectedDebugAndroidTest`（Android 14 / API 34 模拟器，Pixel 5 AVD）：**43/43 通过**，覆盖照片落盘与三态语义、snapshot 一致性、records 新列/ISO/分页/枚举约束、超限归档、env 上限与降采样、WAL 与外键、CSV、备份自校验与合并导入、夹具篡改/截断拒绝、legacyMeta 往返、旧库升级路径。
- 离线回归：`test-core` 10/10、`updater.test` 45/45、`bridge-checksum.test` 11/11、`verify-preview` 46/46、真实 sqlite3 迁移复现 26/26、两份前端副本一致。

### 版本与安装

- 版本：`1.20.1`（versionCode 35），包名 `com.vitals.android`
- 资产：`Vitals-Android-1.20.1.apk`
- SHA-256：`54db8c2842db9f432c8542987ff90409940378f72dae124d980ae3cac63dceb1`
- 从 1.20.0 升级为常规覆盖安装；从 1.18.2 及更早升级会在首次启动执行一次数据库升级（加列 + records 重建 + 照片外置），升级前建议先导出备份。

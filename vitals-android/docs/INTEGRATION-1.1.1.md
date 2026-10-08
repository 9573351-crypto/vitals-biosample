# 1.1.1 后续集成调试报告

日期：2026-09-14。仅修改 `D:\sx\system\vitals-android`。

## 结果

已完成保存失败后的状态一致性修复、温度设置修复、自动测试、模拟器联调和 APK 构建。数据库仍使用 schema 2，不增加表或迁移步骤。此前完整数据库审计及表结构见 `SCHEMA-AUDIT.md`、`SCHEMA-REFACTOR-REPORT.md`、`schema.sql`。

## 发现与修复

1. `saveAll()` 保存失败后会重新读取 SQLite，但 `persistTask`、完成任务、取消任务和绑定槽位的失败分支又恢复旧 ViewModel，覆盖刚读取的数据库结果。已删除这些旧快照回写，保存成功后才继续发送指令或提示操作成功。
2. 回归测试先在未修复代码上复现：原生层已将任务更新为 `uncertain`，旧界面保存被 revision 拒绝后却显示 `verify`。修复后保留数据库的最新任务阶段、错误说明及样本备注。
3. 温度设置原先用 `parseFloat(value) || 默认值`，导致 0 无法保存。现支持有限数值，包括 0；空值和上限不高于下限时提示并恢复原输入，不提交数据库。
4. 温度保存失败原先仍提示“已保存”。现在只在提交成功后提示成功，同时合并重复的上限处理，避免无效上下限先入库再修正。

## 验证

| 检查 | 结果 |
| --- | --- |
| Node 核心逻辑 | 6 项通过 |
| 原生 SQLite instrumentation | 25 项通过，包含 schema、外键、事务回滚、旧版本迁移和并发写入 |
| 浏览器 UI 回归 | 通过；新增任务反馈、完成、取消时的版本冲突，零温度、非法上下限、失败提示测试 |
| Android 模拟器真实 WebView + Bridge + SQLite | 通过；新增原生写入引起的任务反馈/完成冲突恢复及温度设置测试 |
| 出入库、错误扫码编号、模拟到位、温度数据、重启恢复、导入、无设备提示 | 模拟器测试通过 |
| APK 构建与 lintDebug | 成功；lint 保留现有警告，构建仍有 Gradle/API 弃用提示 |
| 原工程文件与样式 | 原目录 13 个基线文件哈希不变；styles.css、android.css 不变 |

模拟器测试前备份数据库，结束后恢复，并重新打开应用；未向 APK 预装测试样本。模拟器为 Android 14 / API 34，不能代替目标 Android 12 一体机验证。

## 修改摘要

```diff
M app/src/main/assets/web/android.js    移除保存失败后的旧状态覆盖及重复温度监听
M app/src/main/assets/web/app.js        温度有效性校验、支持 0、成功后提示
M tools/test-ui.cjs                    保存冲突与设置失败回归
M tools/test-android.cjs               原生 Bridge/SQLite 冲突及设置联调
M app/build.gradle                    versionCode 3，versionName 1.1.1
M build-apk.ps1                       输出 1.1.1 APK
M README.md                           版本、修复和扫码能力说明
A docs/INTEGRATION-1.1.1.md            本报告
A docs/integration-1.1.1-verification.json  原工程/样式/产物哈希核对
```

数据库和 Android UI 测试日志、截图已更新。此前 `schema-verification.json` 与 `schema-changes.patch` 保留为 1.1.0 数据库重构的历史记录。

## 产物

- APK：`D:\sx\system\vitals-android\output\Vitals-Android-1.1.1.apk`
- 大小：1,451,142 字节。
- SHA-256：`0c212bbef3ae2f1a038a3e790f9308bc5cb43a5885b5a6e495e5991dc24145c2`
- 包名：`com.vitals.android`；签名证书与先前 APK 相同。已覆盖安装到 emulator-5554。安装到已有设备时使用覆盖升级，不先卸载。

## 仍需实机验证

目标一体机 Android 12 的触控、USB Host 权限及串口芯片兼容；第二组机械控制板与第四组温控板通信；断线、超时、断电后的人工核实流程；扫码枪 HID 输入、照片选择及实际打印服务。模拟反馈仅验证软件处理路径，不代表舵机或传感器已经联调通过。内置 DB9 尚未接入；手机相机扫码同步尚未实现。

# 生息样本库 · 安卓迁移版

独立工程：`D:\sx\system\vitals-android`。原 `D:\sx\system\code` 未修改。

## 安装与运行

1. 将 `output/Vitals-Android-1.0.0.apk` 复制到安卓设备，允许文件管理器安装此来源的应用，安装“生息样本库”。
2. 支持 Android 8.0 及以上，面向 Android 12 触控一体机。无需原电脑、Node 服务或网络。
3. 此 APK 为开发测试签名版本，适用于本项目联调。后续升级需使用相同签名和包名；卸载或清除应用数据会删除本机数据库，请先导出。
4. 手机扫码枪采用 USB HID 键盘模式；在“样本库”点扫码输入框后扫描。相机扫码不在此版范围内。

## 保留与迁移

- 保留原有概览、样本表单、照片、二维码、温度图表、监控和记录界面。
- 在安卓副本修复原 app.js 缺少闭合括号、导航块被误注释的问题，并补齐原目录缺少的图表与二维码库。
- 数据在应用私有目录 `databases/vitals.db`，SQLite `app_state` 表保存完整 JSON 状态；一次写入原子提交。当前按项目小规模使用设计，不是按样本分表的大型数据库。
- 原程序本机 localStorage 数据不在源代码文件夹中，不能仅复制源码带走真实数据。
- 在原运行程序点击“导出”，把 JSON 复制到安卓设备，在安卓版“导入”中选取文件。支持原版全量备份及旧版样本集合，导入会替换安卓本机数据并要求确认。
- 导入前验证重复条码、槽位冲突、字段类型和照片格式；待处理机械任务备份禁止直接跨设备恢复。
- 初次安装为空库，无虚拟样本。测试图中的数据不会预装到 APK。
- 新录入样本尚未入库（内部 `status: out`）；先录入，再点击入库完成实物流程。

## 五槽位与组间分工

第三组：识别样本、选择槽位、下发任务、展示反馈、人工确认后保存库存。第二组：驱动电机、回零与角度换算、判断到位、反馈异常。

“实时监测”页选择目标槽位（1—5）。旧数据的 `A-01-03` 等位置不会自动猜成圆盘槽位，使用“绑定已有在库样本槽位”进行人工核实绑定。

默认人工模式，不发送电机指令。接好机械板并与第二组确认协议后，可选择“硬件联调模式”。同一圆盘同时只允许一项任务；重启、超时、断线后保持库存不变并要求人工核实，绝不自动重发运动指令。

出库必须核对样本编号并确认拿走；入库必须确认位置及样本放好。任务取消不等于电机停止，须先由操作人员停止机械并恢复操作前的实物状态。

## 设备连接

- 两路 USB 串口连接分别负责温控和机械。支持库识别的 CH340、CP210x、FTDI、CDC/ACM 等设备，实际兼容性需要用具体芯片和固件实测。
- 选择波特率，8N1；点连接时选择设备并允许 USB 权限。同一 USB 设备不同时分配给两个用途。
- 不使用 Web Serial；数据由安卓 USB Host API 及 vendored USB 串口驱动传入界面。
- 内置 DB9/RS232 的设备节点接口尚未接入，需厂家 SDK、引脚和权限资料；不能把板上 TTL 引脚直接当 RS232 接。
- App 前台运行时保持屏幕常亮。未实现开机自动启动、后台长期采集或系统级 kiosk 锁定。
- 打印调用安卓系统打印服务／保存 PDF；USB 标签打印机需要设备自己的兼容打印服务或另外适配。

见 [通信协议](docs/PROTOCOL.md)，目前是可测试的协议草案，不代表硬件已经采用。

## 开发

用 Android Studio 打开本目录。界面代码：`app/src/main/assets/web/`；原生桥接、SQLite、USB、文件操作：`app/src/main/java/com/vitals/android/MainActivity.java`。

本机已配置 JDK 与 Android SDK，可执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\build-apk.ps1
node --test .\tools\test-core.cjs
node .\tools\test-ui.cjs
```

其他电脑请调整 `local.properties` 和构建脚本中的 JDK 路径。Gradle wrapper 9.3.1，AGP 9.1.0，compileSdk 36，targetSdk 34。Google Play 上架不在本次范围。

`tools/migrate.cjs` 仅记录初次复制后的迁移过程，不要在已经修改的安卓副本反复运行。

## 验证边界

自动测试覆盖界面基本操作、扫码不匹配拦截、槽位冲突、导出、任务恢复、ACK／到位区分和备份格式校验。真实电机、传感器、扫码枪、打印机及目标一体机未连接，不可把模拟器测试视为实物验收。

原目录的迁移前 SHA256 清单在 `docs/original-sha256.json`，可核对文件内容保持不变。

## 第三方依赖

- Chart.js 4.4.8（MIT）：https://github.com/chartjs/Chart.js
- qrcode-generator 1.4.4（MIT）：https://github.com/kazuhikoarase/qrcode-generator
- usb-serial-for-android 3.9.0（MIT）：https://github.com/mik3y/usb-serial-for-android

静态依赖随 APK 打包；USB 库源码位于 `com/hoho/`，上游许可证保存在 `docs/licenses/`。

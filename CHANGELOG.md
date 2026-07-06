# Changelog

## v0.3.0 — 2026-07-06

### 修复

* **同步状态选项**：改用 `appendAttributeViewDetachedBlocksWithValues` API 注册选项，解决新数据库无下拉选项的问题
* **版本号**：PLUGIN_VERSION / plugin.json / package.json 统一，statusOptionsVersion 类型化

### 优化

* **开始计时 & 补录条目后台上传**：写本地后立即关闭弹窗，API 异步推送，不再阻塞 UI
* **云端停止自动纠正**：同步时检测到云端无运行计时器但本地还在跑，自动清除状态栏
* **诊断面板**：设置页新增「诊断」区域（网络连接 + 数据库状态 + 修复选项 + 一键复制）
* **字段选项同步**：刷新项目/标签列表时，自动同步选项到数据库字段下拉
* **移除可计费**：免费版不支持 Billable，从 UI 和 API 请求中全部移除

### 文档

* 纠正为「云端优先」定位，新增 TogglID 作用说明和数据流向

## v0.2.6 — 2026-07-06

### 修复：同步状态选项（最终版）

* **根本原因**：`setAttributeViewBlockAttr` 不会把 select 选项注册到 `key.Options`（思源 kernel 源码验证）。
* **修复**：改用 `appendAttributeViewDetachedBlocksWithValues` API，此 API 在 kernel 源码中确认会调用 `key.Options = append()` 注册选项。
* 引入 `statusOptionsVersion` 版本号 + `PluginConfig.statusOptionsVersion` 类型化。

### 优化：开始计时后台上传

* 点「开始」后立即写入本地并关闭弹窗，Toggl API 在后台异步推送，不阻塞 UI。
* API 失败时本地行保持「本地待上传」，下次同步自动推送。

### 新增：诊断面板

* 设置页底部新增「诊断」区域：网络连接诊断 + 数据库状态查看 + 一键复制。

### 修复：版本号

* `PLUGIN_VERSION` / `plugin.json` / `package.json` 统一为 0.2.6。
* 移除 `SKIP_TOGGL_API` 死代码、`console.log` 改为 `console.warn`。

## v0.2.5 — 2026-07-06

### 修复：同步状态选项缺失（未解决，被 v0.2.6 修复）

* **根本原因**：`ensureSyncStatusOptions` 对同一行连续写入 7 个单选值，每次覆盖前一次，最终只剩"失败"；删除种子行后选项全部消失。
* **修复**：改为每个状态值创建独立的种子行（7 行各写 1 次），确保每个选项都被注册到 `key.Options`。
* 思源 3.x 的 select 选项持久化在 `key.Options`，删除行不会清理选项（已验证思源 kernel 源码）。
* 引入 `statusOptionsVersion` 版本号机制，老数据库升级后自动重新注册选项。
* 检查 `key.options` 是否已包含全部选项，避免重复创建。

## v0.2.4 — 2026-07-05

### 架构重构：本地优先

* **开始计时** 改为先写本地行再推送云端，API 失败不阻塞。
* **停止计时** 改为先更新本地行（结束时间+时长）再推送云端，API 失败不阻塞。
* **启动新计时** 时自动给上一个计时器本地行补上停止信息。
* `CurrentTimerState` 新增 `localRowId` / `databaseAvId`，持久化跟踪本地行。
* 运行中的计时器持续时间显示为「进行中」，已完成但只填了时长的条目也正确显示时长。
* 移除开始的 `pendingOp` 队列逻辑，统一由 `pushLocalChanges` 处理未上传行。

### 修复

* 修复 autoStopRunningTimer 在本地优先架构下的行为，确保旧计时器本地行也正确更新停止状态。
* 统一本地行更新时间戳和同步状态辅助方法 `updateLocalTimerStop`。

## v0.2.3 — 2026-06-26

### 根本修复：Toggl 默认项目/标签

* **不选项目时不传 `project_id` 字段**（而非传 `null`），避免 Toggl 自动填充默认项目。
* 同样处理 `tags` 字段，无选中时不传。
* 移除 v0.2.1/v0.2.2 的 `stripEntryDefaults` 等修正逻辑（~160 行）。
* 参考 `frostime/sy-f-misc` 插件的做法。

## v0.2.2 — 2026-06-26

### 交互优化

* 停止计时/开始计时/补录条目/强制同步 均加确认弹窗。
* 状态栏显示当前计时时长（格式 `h:mm:ss`）。
* 开始计时和补录：记住上次选择的项目和标签。
* 补录条目手动模式增加结束时间字段。
* 待上传队列查看器：展示未推送的操作数量和详情。
* 设置页 UI 重排：关于置顶，清除缓存置底。

## v0.2.0 — 2026-06-26

### 代码审查 & 修复

* 修复 3 个 P0 数据丢失 Bug。
* 修复 5 个 P1 问题。
* 4 项 P2 代码质量优化。
* 9 项交互优化。

---

## Historical

* Add controlled two-way sync between Toggl and SiYuan.
* Add the `同步状态` single-select field for local upload, Toggl update, Toggl deletion, and local cleanup workflows.
* Add `本地待上传` so new local rows require an explicit upload marker.
* Seed the `同步状态` single-select options when preparing the SiYuan database.
* Use Toggl incremental sync with `/me/time_entries?since=...` for regular sync.
* Add first/repair sync ranges for historical import and reconciliation.
* Limit first/repair ranges to 7/30/90 days to comply with Toggl `start_date` restrictions.
* Add automatic sync interval settings with a 30-minute default.
* Add local cleanup for rows marked `本地可删除`.
* Move maintenance actions into the settings page.
* Add a settings-only create database action and stop automatic database creation during sync.
* Move project cache refresh next to the timer/manual-entry project picker.
* Add cached Toggl tag suggestions and manual tag refresh in timer/manual-entry dialogs.
* Add customizable status bar idle text.
* Improve target document database creation and mounting.

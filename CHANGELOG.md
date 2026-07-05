# Changelog

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

[English](./README.md)

# Toggl 同步

把 Toggl 时间条目同步到思源笔记数据库，并支持受控的思源到 Toggl 回写。

## 功能

- 可在设置中手动新建或挂载目标文档中的 `Toggl Sync` 数据库。
- 从 Toggl 拉取新增、修改、删除的时间条目。
- 将标记为 `本地待上传` 的思源本地新条目上传到 Toggl。
- 通过 `同步状态` 字段控制更新 Toggl、删除 Toggl、清理本地删除项。
- 状态栏显示本地计时，不持续轮询 Toggl API。
- 支持自动同步周期：关闭、15 分钟、30 分钟、60 分钟，默认 30 分钟。

## 配置

打开插件设置后填写：

- `API Token`：Toggl 个人 API Token。
- `目标文档`：用于存放数据库的思源文档 ID。
- `首次/修复同步范围`：首次导入或手动修复时使用，默认最近 30 天，最多 90 天。
- `自动同步周期`：日常自动同步间隔，免费版建议保持 30 分钟。
- `显示文字`：状态栏空闲时显示的文字，默认 `Toggl`。

顶栏按钮只保留日常高频操作：`立即同步`、开始计时、停止计时和补录条目。`首次/修复同步`、`清理本地可删除项` 放在设置页的数据维护中。项目和标签刷新放在开始计时、补录条目的对应输入旁边。

同步时如果目标文档没有数据库，插件只会提示，不会自动创建。请先在设置页点击 `新建数据库` 创建空白数据库。

## 首次启动

1. 在设置页填入「API Token」和「目标文档 ID」
2. 点击「新建数据库」创建空白数据库
3. 如果「同步状态」字段下拉为空，点击诊断区域的「修复选项」
4. 点击「首次/修复同步」导入历史数据


## 同步逻辑

日常同步使用 Toggl 的增量接口：

```text
/me/time_entries?since=上次成功同步时间
```

`since` 按条目的修改时间判断，不按条目发生日期判断。因此，只要 Toggl 条目在上次同步后被新增、修改或删除，即使它本身发生在很久以前，也会被拉取到。

首次同步或手动修复使用 `start_date/end_date` 时间范围，用来导入历史数据或修复本地状态。Toggl 当前限制 `start_date` 不能早于约 3 个月前，所以插件提供 7/30/90 天范围。这个范围不影响之后的日常增量同步。

## 数据库字段

插件会自动补齐这些字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| 描述 | 文本/主键 | Toggl 条目描述 |
| TogglID | 数字 | Toggl time entry ID |
| 项目 | 文本 | Toggl 项目名称 |
| 标签 | 多选 | Toggl 标签 |
| 开始 | 日期 | 开始时间 |
| 结束 | 日期 | 结束时间 |
| 日期 | 日期 | 开始日期 |
| 时长 | 数字 | 秒数 |
| 时长显示 | 文本 | `h:mm:ss`，运行中显示「进行中」 |
| 同步状态 | 单选 | 同步状态和动作 |

## 同步状态

| 状态 | 含义 |
| --- | --- |
| 正常 | 已与 Toggl 对齐 |
| 未同步 | 本地新增，尚未上传到 Toggl |
| 本地待上传 | 下次同步时上传本地新增条目到 Toggl |
| Toggl 待更新 | 下次同步时用本地内容更新 Toggl |
| Toggl 待删除 | 下次同步时删除 Toggl 条目 |
| 本地可删除 | Toggl 已删除或远端删除完成，本地可清理 |
| 失败 | 本次上传、更新或删除失败 |

本地新增条目没有 `TogglID` 时，插件会默认标记为 `未同步`，但不会自动上传。确认要上传后，请把 `同步状态` 改成 `本地待上传`；上传成功后插件会写回 `TogglID` 并设为 `正常`。

如果 Toggl 删除了某条记录，插件不会立刻硬删除思源行，而是将 `同步状态` 改为 `本地可删除`。确认后可以在设置页点击 `清理本地可删除项`。

## 项目和标签

项目名称会缓存在插件配置中，避免每次同步都请求项目列表。插件会在项目缓存为空、开始计时/补录需要项目列表，或你在开始计时/补录窗口点击 `刷新` 时调用 Toggl 项目 API。

标签会缓存在插件配置中，用于开始计时和补录条目的候选提示。插件会在标签缓存为空，或你在开始计时/补录窗口点击标签旁边的 `刷新` 时调用 `/me/tags`。同步时仍会直接使用 Toggl time entry 返回的 `tags` 字段；本地上传或更新时，则使用思源行里的 `标签` 字段。

## 数据流向

插件的定位是**云端优先**：以 Toggl 为数据源，思源数据库为镜像副本。

**主流程（云端 → 本地）：**

- 同步时从 Toggl 拉取增量数据，覆盖写入思源数据库
- 冲突时以云端为准
- 思源端对条目的修改（标记为「Toggl 待更新」/「Toggl 待删除」）需要在同步周期内手动触发回写

**辅助流程（本地 → 云端）：**

- 启用了同步状态字段控制的上传/更新/删除
- 开始计时、补录条目的「先写本地再推送云端」是一种**缓冲保护**：防止网络中断或 API 配额耗尽导致操作丢失，并非"本地优先"

**TogglID 的作用：**

`TogglID` 是本地数据库行与 Toggl 云端条目绑定的唯一标识。同步时用它判断每条记录的对齐关系：

| 思源本地 | Toggl 云端 | 行为 |
| --- | --- | --- |
| 有 ID | 有同 ID | 匹配成功，云端数据覆盖本地 |
| 无 ID | 有 ID | 云端新增了条目，直接同步到本地并写入 TogglID |
| 有 ID | 无同 ID | 云端已删除，本地标记为「本地可删除」 |
| 无 ID | 无 ID | 本地新增的待上传条目，需改同步状态为「本地待上传」后推送 |

## API 调用策略

Toggl 免费版 API 调用额度较低，因此插件尽量减少请求：

- 日常同步：1 次增量拉取，加上必要的本地上传/更新/删除请求。
- 自动同步：默认 30 分钟一次，且没有变更时不弹提示。
- 首次/修复同步：仅手动触发，用时间范围重新扫描历史条目。
- 状态栏计时：主要本地运行，只在启动、开始、停止或手动刷新时请求 API。

Toggl API 文档：

- [Time entries API](https://engineering.toggl.com/docs/track/api/time_entries/)
- [API rate limits](https://engineering.toggl.com/docs/track/)

## 开发注意事项

以下是在开发过程中踩过的坑，后续修改相关逻辑时务必注意：

### select/mSelect 字段必须显式写入空值

`writeTogglRow` 对空字符串/空数组会调用 `isEmptyCellInput` 跳过写入。但对 `select` 和 `mSelect` 类型字段**不能跳过**，必须显式写入 `{mSelect: []}`。

**原因**：思源 `insertAttrViewBlock` 创建新行时，会自动从 `key.Options` 取第一个选项作为 select/mSelect 字段的默认值。如果写入时跳过空值，这个默认选项会永远残留，导致用户没选项目/标签却出现了项目/标签。

```typescript
// ❌ 错误：select/mSelect 空值被跳过
if (isEmptyCellInput(field.value)) continue;

// ✅ 正确：select/mSelect 空值也写入 {mSelect: []}
if (isEmptyCellInput(field.value) && key.type !== "select" && key.type !== "mSelect") continue;
```

### API 回写不要覆盖整行

`pushTimerToToggl` / `pushManualToToggl` / `pushLocalChanges` 在 Toggl API 成功后，**不要**用 `toDatabaseRow(response.data)` 覆盖整行。Toggl 返回的 response 可能包含 workspace 默认的项目/标签。

改为只写入 `TogglID` 和 `同步状态`，使用 `writeTogglId` + `writeSyncStatus`。

### 重复 TogglID 必须检测，避免孤儿行

`Map` 按 `togglId` 建索引时同 ID 后者覆盖前者，导致多出的行既不会被 `applyRemoteEntries` 更新，也不会被 `markMissingRowsInRepairRange` 标记删除，成为永久孤儿。

读库后必须调用 `detectDuplicateTogglIds`：保留状态为「正常」（或数据最完整）的行，其余标「本地可删除」。并且 `applyRemoteEntries` 构建 `rowsByTogglId` 时要跳过 `syncStatus === "本地可删除"` 的行，否则保留行可能被错误覆盖。

### 停止计时不要重复调云端 API

`stopCurrentTimer` 的云端停止逻辑必须合并为一次：无本地行时直接 `stopTimeEntry`；有本地行时先 `getCurrentTimeEntry` 确认仍在运行再 `stopTimeEntry`。不要对同一个计时器既走「无本地行」分支又走「有本地行」分支，否则会重复消耗免费版配额。

### 同步时不要每次刷新项目/标签

`refreshProjects` / `refreshTags` 已加 10 分钟时间缓存（基于 `projectsRefreshedAt` / `tagsRefreshedAt`）。修改相关逻辑时保持「非 force 且缓存未过期则跳过」的判断，避免每次同步都拉 Toggl API 浪费配额。

## 开发

```bash
npm install
npm run build
```

本地部署到思源插件目录示例：

```bash
ditto dist /path/to/siyuan/data/plugins/siyuan-toggl-sync
```

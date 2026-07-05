# 同步状态说明

## 7 种状态

| 状态 | 用途 | 条件 | 上行（思源→Toggl） | 下行（Toggl→思源） |
|---|---|---|---|---|
| 本地待上传 | 新建条目 | TogglID 为空 | createTimeEntry，成功→正常 | 跳过 |
| 未同步 | 已有条目本地修改 | TogglID 存在 | updateTimeEntry，成功→正常 | 覆盖（以远程为准） |
| 正常 | 与 Toggl 一致 | — | 跳过 | 有更新则覆盖 |
| Toggl 待更新 | 标记待更新 | TogglID 存在 | updateTimeEntry，成功→正常 | **跳过**（本地优先） |
| Toggl 待删除 | 标记待删除 | TogglID 存在 | deleteTimeEntry，成功→本地可删除 | **跳过**（本地优先） |
| 本地可删除 | 云端已删，等待清理 | — | 跳过 | 跳过 |
| 失败 | 上次操作失败 | — | 跳过 | 跳过 |

## 核心规则

- **TogglID 必须唯一**。同一 ID 出现在多行会导致匹配错乱，新建也会被跳过。
- 有 ID 走更新/删除路径，无 ID + 本地待上传走新建路径。
- 想重新上传已有 ID 的条目：先清空 TogglID，再选「本地待上传」。

## 同步流程

```
同步开始
  → flushPendingOps（重试暂存操作）
  → pushLocalChanges（上行：本地待上传/未同步/Toggl待更新/待删除）
  → applyRemoteEntries（下行：Toggl 拉取新数据覆盖本地）
  → refreshTogglTimer（刷新计时器状态）
同步结束
```

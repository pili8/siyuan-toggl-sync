[中文](./README_zh_CN.md)

# Toggl Sync

Sync Toggl time entries into a SiYuan database, with controlled write-back from SiYuan to Toggl.

## Features

* Manually creates or mounts a `Toggl Sync` database in the target document from settings.
* Pulls created, updated, and deleted Toggl time entries.
* Uploads new local SiYuan rows to Toggl only after they are marked `本地待上传`.
* Uses a single `同步状态` field to control Toggl updates, Toggl deletion, and local cleanup.
* Shows a local status bar timer without continuously polling the Toggl API.
* Supports automatic sync intervals: off, 15 minutes, 30 minutes, and 60 minutes. The default is 30 minutes.

## Configuration

Open the plugin settings and fill in:

* `API Token`: your personal Toggl API token.
* `Target Document`: the SiYuan document ID that should contain the database.
* `Initial/Repair Sync Range`: used only for first import or manual repair. The default is the last 30 days, and the maximum is 90 days.
* `Auto Sync Interval`: the regular automatic sync interval. 30 minutes is recommended for free Toggl accounts.
* `Display Text`: the idle text shown in the status bar. The default is `Toggl`.

The top bar menu only keeps frequent actions: `Sync Now`, start/stop a timer, and manual entry creation. `Initial/Repair Sync` and `Clean Local Deletable Rows` live in the settings maintenance area. Project and tag refresh actions are available next to the corresponding inputs in the timer and manual-entry dialogs.

If the target document has no database, sync only shows a prompt and does not create one automatically. Use `Create Database` in settings to create an empty database first.

## Sync Model

Regular sync uses Toggl's incremental time entries endpoint:

```text
/me/time_entries?since=last_successful_sync_time
```

`since` is based on the entry modification time, not the entry start date. If an old Toggl entry is updated or deleted after the last sync, it will still be returned.

First sync and manual repair use a `start_date/end_date` range to import or reconcile historical entries. Toggl currently rejects `start_date` values earlier than about 3 months ago, so the plugin offers 7/30/90 day ranges. This range does not limit later regular incremental sync.

## Database Fields

The plugin automatically ensures these fields exist:

| Field    | Type          | Description             |
| -------- | ------------- | ----------------------- |
| 描述     | text/primary  | Toggl entry description |
| TogglID  | number        | Toggl time entry ID     |
| 项目     | text          | Toggl project name      |
| 标签     | multi-select  | Toggl tags              |
| 开始     | date          | Start time              |
| 结束     | date          | Stop time               |
| 日期     | date          | Start date              |
| 时长     | number        | Duration in seconds     |
| 时长显示 | text          | `h:mm:ss`               |
| 计费     | checkbox      | Billable flag           |
| 同步状态 | single-select | Sync state and action   |

## Sync Status

| Status       | Meaning                                                                            |
| ------------ | ---------------------------------------------------------------------------------- |
| 正常         | Local row is aligned with Toggl                                                    |
| 未同步       | New local row has not been uploaded yet                                            |
| 本地待上传   | Upload a new local row to Toggl on next sync                                       |
| Toggl 待更新 | Update the Toggl entry from the local row on next sync                             |
| Toggl 待删除 | Delete the Toggl entry on next sync                                                |
| 本地可删除   | Toggl has been deleted, or remote deletion has completed; local row can be cleaned |
| 失败         | Upload, update, or deletion failed                                                 |

New local rows without a `TogglID` are marked `未同步` by default. They are uploaded to Toggl only after you change `同步状态` to `本地待上传`; after a successful upload, the plugin writes the returned `TogglID` and sets the row to `正常`.

When a Toggl entry is deleted remotely, the plugin does not immediately hard-delete the SiYuan row. It marks the row as `本地可删除`. Use `Clean Local Deletable Rows` in the settings page when you are ready to remove those rows.

## Projects And Tags

Project names are cached in the plugin configuration to avoid requesting the project list on every sync. The plugin calls the Toggl projects API when the cache is empty, when timer/manual-entry dialogs need project options, or when you click `Refresh` next to the project picker.

Tags are cached for suggestions in the timer and manual-entry dialogs. The plugin calls `/me/tags` when the tag cache is empty or when you click `Refresh` next to the tag input. Pulled entries still use the `tags` returned by Toggl time entries, and local upload/update uses the SiYuan row's `标签` field.

## API Strategy

Toggl's free API quota is limited, so the plugin keeps calls low:

* Regular sync: one incremental pull plus only the required local upload/update/delete requests.
* Auto sync: defaults to every 30 minutes and stays quiet when nothing changed.
* First/repair sync: manual only, using a chosen time range.
* Status bar timer: runs locally and only calls the API on startup, start, stop, or manual refresh.

Toggl API documentation:

* [Time entries API](https://engineering.toggl.com/docs/track/api/time_entries/)
* [API rate limits](https://engineering.toggl.com/docs/track/)

## Development

```bash
npm install
npm run build
```

Deploy to a local SiYuan plugin folder:

```bash
ditto dist /path/to/siyuan/data/plugins/siyuan-toggl-sync
```

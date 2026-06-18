# Changelog

## Unreleased

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

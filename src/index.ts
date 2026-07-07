import {
    Plugin,
    showMessage,
    Dialog,
    confirm,
    Menu,
    fetchSyncPost,
} from "siyuan";
import * as togglApi from "./toggl/api";
import type {
    CreateTimeEntryInput,
    Tag,
    TimeEntry,
    UpdateTimeEntryInput,
} from "./toggl/types";
import "./index.scss";

interface PluginConfig {
    token: string;
    workspaceId: number;
    targetDocId: string;
    initialDays: number;
    lastSyncTime: string;
    autoSyncMinutes: number;
    statusBarTimer: boolean;
    statusBarText: string;
    statusText?: string;
    projectCache: ProjectCacheItem[];
    tagCache: TagCacheItem[];
    currentTimer: CurrentTimerState | null;
    pendingOps: PendingOp[];
    avId?: string;
    statusOptionsPreparedAvId?: string;
    statusOptionsVersion?: number;
    lastProjectId?: number;
    lastTags?: string[];
    apiEnabled?: boolean;
    projectsRefreshedAt?: string;
    tagsRefreshedAt?: string;
}

const DEFAULT_CONFIG: PluginConfig = {
    token: "",
    workspaceId: 0,
    targetDocId: "",
    initialDays: 30,
    lastSyncTime: "",
    autoSyncMinutes: 30,
    statusBarTimer: true,
    statusBarText: "Toggl",
    projectCache: [],
    tagCache: [],
    currentTimer: null,
    pendingOps: [],
    apiEnabled: true,
    projectsRefreshedAt: "",
    tagsRefreshedAt: "",
};

const CONFIG_FILE = "toggl-sync.json";
const PLUGIN_VERSION = "0.4.4";

type AttributeViewKey = {
    id: string;
    name: string;
    type: string;
    options?: {name: string; color?: string;}[];
};

type DatabaseFieldDefinition = {
    name: string;
    type: string;
    aliases: string[];
};

type TargetDatabase = {
    avId: string;
    keys: AttributeViewKey[];
};

type DatabaseCellInput = string | number | boolean | Date | null | undefined;

type TogglDatabaseRow = {
    id: number;
    description: string;
    projectName: string;
    tagNames: string[];
    start: Date;
    stop: Date | null;
    durationSeconds: number;
    billable: boolean;
    syncStatus?: SyncStatus;
};

type SyncStatus = "正常" | "未同步" | "本地待上传" | "本地可删除" | "Toggl 待更新" | "Toggl 待删除" | "失败";

type SyncMode = "regular" | "repair" | "auto";

type LocalDatabaseRow = {
    rowId: string;
    togglId: number | null;
    syncStatus: SyncStatus | "";
    description: string;
    projectName: string;
    tagNames: string[];
    start: Date | null;
    stop: Date | null;
    durationSeconds: number;
    billable: boolean;
};

type LocalUploadResult = {
    created: number;
    updated: number;
    deleted: number;
    failed: number;
};

type RemoteApplyResult = {
    added: number;
    updated: number;
    markedDeleted: number;
    skippedPending: number;
};

const SYNC_STATUS_OPTIONS: SyncStatus[] = [
    "正常",
    "未同步",
    "本地待上传",
    "本地可删除",
    "Toggl 待更新",
    "Toggl 待删除",
    "失败",
];

const TOGGL_DATABASE_FIELDS: DatabaseFieldDefinition[] = [
    {name: "描述", type: "text", aliases: ["描述", "Description"]},
    {name: "持续时间", type: "text", aliases: ["持续时间", "Duration Display", "Duration Text", "时长显示"]},
    {name: "项目", type: "select", aliases: ["项目", "Project"]},
    {name: "标签", type: "mSelect", aliases: ["标签", "Tags", "Tag"]},
    {name: "同步状态", type: "select", aliases: ["同步状态", "Sync Status"]},
    {name: "开始", type: "date", aliases: ["开始", "开始时间", "Start", "Start Time"]},
    {name: "结束", type: "date", aliases: ["结束", "结束时间", "End", "End Time", "Stop", "Stop Time"]},
    {name: "时长", type: "number", aliases: ["时长", "Duration"]},
    {name: "TogglID", type: "number", aliases: ["TogglID", "Toggl ID", "Toggl Id", "toggl-id"]},
    {name: "日期", type: "date", aliases: ["日期", "创建日期", "Date"]},
];

type PendingOp =
    | {type: "start"; description: string; projectId?: number; tags: string[]; billable: boolean; start: string;}
    | {type: "stop"; entryId: number; workspaceId: number;}
    | {
        type: "manual";
        description: string;
        start: string;
        durationSeconds: number;
        projectId?: number;
        tags: string[];
        billable: boolean;
    };

type ProjectCacheItem = {
    id: number;
    name: string;
    workspace_id: number;
};

type TagCacheItem = {
    id: number;
    name: string;
    workspace_id: number;
};

type CurrentTimerState = {
    id: number;
    workspaceId: number;
    description: string;
    start: string;
    projectId?: number;
    tags?: string[];
    localRowId?: string;
    databaseAvId?: string;
};

export default class TogglSyncPlugin extends Plugin {
    private config: PluginConfig = {...DEFAULT_CONFIG};
    private projects: Map<number, string> = new Map();
    private projectsLoadPromise: Promise<void> | null = null;
    private tags: string[] = [];
    private tagsLoadPromise: Promise<void> | null = null;
    private statusBarEl: HTMLElement | null = null;
    private timerInterval: ReturnType<typeof setInterval> | null = null;
    private autoSyncInterval: ReturnType<typeof setInterval> | null = null;
    private syncInProgress = false;
    private lastEntryId: number | null = null;
    private suppressDatabasePrompt = false;
    private workspaceIdPromise: Promise<number | null> | null = null;

    async onload() {
        await this.loadConfig();
        this.addTopBarButton();
    }

    async onLayoutReady() {
        if (this.config.statusBarTimer && this.config.token) {
            await this.startStatusBarTimer(true);
        }
        if (this.config.token && this.config.targetDocId) {
            if (this.config.pendingOps.length > 0) {
                const flushed = await this.flushPendingOps();
                if (flushed > 0) {
                    showMessage(`启动时已重试 ${flushed} 条暂存操作`, 2000, "info");
                }
            }
            await this.syncEntries("auto");
        }
        this.setupAutoSync();
    }

    onunload() {
        this.stopStatusBarTimer();
        this.stopAutoSync();
    }

    private async loadConfig() {
        const data = await this.loadData(CONFIG_FILE);
        if (data) {
            this.config = {...DEFAULT_CONFIG, ...data};
        }
        this.config.initialDays = this.normalizeInitialDays(this.config.initialDays);
        this.config.statusBarText = this.normalizeStatusBarText(this.config.statusBarText || this.config.statusText);
        if (this.config.token) {
            togglApi.setToken(this.config.token);
        }
        this.loadProjectCache();
        this.loadTagCache();
        this.loadCurrentTimerState();
    }

    private async saveConfig() {
        await this.saveData(CONFIG_FILE, this.config);
    }

    private async queuePendingOp(op: PendingOp) {
        this.config.pendingOps.push(op);
        await this.saveConfig();
        showMessage(`API 暂不可用，已暂存本地（${this.config.pendingOps.length} 条待处理）`, 3000, "info");
    }

    private async runButtonAction(
        button: HTMLButtonElement,
        busyText: string,
        action: () => Promise<void>,
    ): Promise<void> {
        const previousText = button.textContent || "";
        button.disabled = true;
        button.textContent = busyText;
        try {
            await action();
        } catch (error) {
            console.error("[TogglSync] button action failed:", error);
            showMessage(`操作失败: ${this.formatUnknownError(error)}`, 6000, "error");
        } finally {
            button.disabled = false;
            button.textContent = previousText;
        }
    }

    private addTopBarButton() {
        this.addTopBar({
            icon: "iconClock",
            title: "Toggl Sync",
            position: "right",
            callback: () => {
                this.showSyncMenu();
            },
        });
    }

    private showSyncMenu(position?: {x: number; y: number;}) {
        const menu = new Menu("togglSyncMenu");
        menu.addItem({
            icon: "iconRefresh",
            label: this.i18n.syncNow,
            click: async () => {
                await this.syncEntries();
            },
        });
        menu.addItem({
            icon: "iconPlay",
            label: this.i18n.startTimer,
            click: async () => {
                await this.openStartTimerDialog();
            },
        });
        menu.addItem({
            icon: "iconPause",
            label: this.i18n.stopTimer,
            click: async () => {
                await this.stopCurrentTimer();
            },
        });
        menu.addItem({
            icon: "iconAdd",
            label: this.i18n.manualEntry,
            click: async () => {
                await this.openManualEntryDialog();
            },
        });
        if (this.config.pendingOps.length > 0) {
            menu.addItem({
                icon: "iconList",
                label: `${this.i18n.viewPending} (${this.config.pendingOps.length})`,
                click: () => {
                    this.showPendingOpsDialog();
                },
            });
        }
        menu.open(position ?? {x: window.innerWidth - 200, y: 32});
    }

    private showPendingOpsDialog() {
        const ops = this.config.pendingOps;
        const rows = ops.map((op, i) => {
            const type = op.type === "start" ? "开始计时" : op.type === "stop" ? "停止计时" : "补录条目";
            const desc = op.type === "start" ? op.description :
                op.type === "manual" ? op.description : `#${op.entryId}`;
            return `<tr>
                <td style="padding:4px 8px;">${i + 1}</td>
                <td style="padding:4px 8px;">${type}</td>
                <td style="padding:4px 8px;">${this.escapeHtml(desc)}</td>
                <td style="padding:4px 8px;color:var(--b3-theme-on-surface-light);font-size:11px;">${op.type === "start" ? op.start : op.type === "manual" ? op.start : "-"}</td>
            </tr>`;
        }).join("");

        const dialog = new Dialog({
            title: `待处理操作（${ops.length} 条）`,
            content: `<div class="b3-dialog__content" style="padding:16px;">
                <p style="margin-bottom:12px;font-size:12px;color:var(--b3-theme-on-surface-light);">
                    以下操作因 API 暂不可用被暂存，将在下次同步时自动重试。
                </p>
                <table style="width:100%;border-collapse:collapse;font-size:13px;">
                    <thead>
                        <tr style="border-bottom:1px solid var(--b3-border-color);">
                            <th style="padding:4px 8px;text-align:left;">#</th>
                            <th style="padding:4px 8px;text-align:left;">类型</th>
                            <th style="padding:4px 8px;text-align:left;">描述</th>
                            <th style="padding:4px 8px;text-align:left;">时间</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div class="b3-dialog__action">
                <button class="b3-button b3-button--cancel" id="ts-pending-close">关闭</button>
            </div>`,
            width: "500px",
        });

        dialog.element.querySelector("#ts-pending-close")!.addEventListener("click", () => dialog.destroy());
    }

    openSetting() {
        const lastSync = this.config.lastSyncTime ?
            new Date(this.config.lastSyncTime).toLocaleString() :
            this.i18n.never;

        const dialog = new Dialog({
            title: "Toggl Sync - " + this.i18n.settings,
            content: `<div class="toggl-sync__settings">
                <div class="toggl-sync__settings-section">
                    <div class="toggl-sync__settings-section-title">连接</div>
                    <div class="toggl-sync__settings-field">
                        <label class="toggl-sync__settings-label">${this.i18n.token}</label>
                        <div class="toggl-sync__settings-row">
                            <input id="ts-token" class="b3-text-field toggl-sync__settings-input" type="password" placeholder="Toggl API Token" value="${
                this.escapeHtml(this.config.token)
            }">
                            <button id="ts-verify" class="b3-button b3-button--outline toggl-sync__settings-action" type="button">${this.i18n.tokenVerify}</button>
                        </div>
                        <div class="toggl-sync__settings-desc">${this.i18n.tokenDesc}</div>
                    </div>
                    <div class="toggl-sync__settings-field">
                        <label class="toggl-sync__settings-switch">
                            <input id="ts-api-enabled" type="checkbox" class="b3-switch" ${
                this.config.apiEnabled !== false ? "checked" : ""
            }>
                            <span>启用 Toggl API</span>
                        </label>
                        <div class="toggl-sync__settings-desc">关闭后所有操作仅在本地数据库运行，不上传也不下拉 Toggl。适合排查问题或离线使用。</div>
                    </div>
                </div>

                <div class="toggl-sync__settings-section">
                    <div class="toggl-sync__settings-section-title">同步</div>
                    <div class="toggl-sync__settings-grid">
                        <div class="toggl-sync__settings-field toggl-sync__settings-field--wide">
                            <label class="toggl-sync__settings-label">${this.i18n.targetDoc}</label>
                            <input id="ts-doc" class="b3-text-field toggl-sync__settings-control" placeholder="Document ID" value="${
                this.escapeHtml(this.config.targetDocId)
            }">
                            <div class="toggl-sync__settings-desc">${this.i18n.targetDocDesc}</div>
                        </div>
                        <div class="toggl-sync__settings-field">
                            <label class="toggl-sync__settings-label">首次/修复范围</label>
                            <select id="ts-days" class="b3-select toggl-sync__settings-control">
                                <option value="7" ${
                this.config.initialDays === 7 ? "selected" : ""
            }>${this.i18n.days7}</option>
                                <option value="30" ${
                this.config.initialDays === 30 ? "selected" : ""
            }>${this.i18n.days30}</option>
                                <option value="90" ${
                this.config.initialDays === 90 ? "selected" : ""
            }>${this.i18n.days90}</option>
                            </select>
                            <div class="toggl-sync__settings-desc">受 API 限制，最多 90 天。</div>
                        </div>
                        <div class="toggl-sync__settings-field">
                            <label class="toggl-sync__settings-label">自动同步周期</label>
                            <select id="ts-auto-sync" class="b3-select toggl-sync__settings-control">
                                <option value="0" ${this.config.autoSyncMinutes === 0 ? "selected" : ""}>关闭</option>
                                <option value="15" ${
                this.config.autoSyncMinutes === 15 ? "selected" : ""
            }>15 分钟</option>
                                <option value="30" ${
                this.config.autoSyncMinutes === 30 ? "selected" : ""
            }>30 分钟</option>
                                <option value="60" ${
                this.config.autoSyncMinutes === 60 ? "selected" : ""
            }>60 分钟</option>
                            </select>
                            <div class="toggl-sync__settings-desc">免费版建议 30 分钟。</div>
                        </div>
                    </div>
                </div>

                <div class="toggl-sync__settings-section">
                    <div class="toggl-sync__settings-section-title">状态栏计时</div>
                    <div class="toggl-sync__settings-grid">
                        <div class="toggl-sync__settings-field toggl-sync__settings-field--wide">
                            <label class="toggl-sync__settings-switch">
                                <input id="ts-statusbar" type="checkbox" class="b3-switch" ${
                this.config.statusBarTimer ? "checked" : ""
            }>
                                <span>${this.i18n.statusBarDesc}</span>
                            </label>
                        </div>
                        <div class="toggl-sync__settings-field toggl-sync__settings-field--wide">
                            <label class="toggl-sync__settings-label">${this.i18n.statusText}</label>
                            <input id="ts-statusbar-text" class="b3-text-field toggl-sync__settings-control" placeholder="Toggl" value="${
                this.escapeHtml(this.config.statusBarText)
            }">
                        </div>
                    </div>
                </div>

                <div class="toggl-sync__settings-section">
                    <div class="toggl-sync__settings-section-title">数据维护</div>
                    <div class="toggl-sync__settings-field">
                        <div class="toggl-sync__settings-meta">
                            <div>
                                <div class="toggl-sync__settings-label">${this.i18n.lastSync}</div>
                                <div id="ts-lastSync" class="toggl-sync__settings-value">${lastSync}</div>
                            </div>
                            <button id="ts-clearSync" class="b3-button b3-button--outline toggl-sync__settings-small-action" type="button">清空</button>
                        </div>
                    </div>
                    <div class="toggl-sync__settings-field">
                        <div class="toggl-sync__settings-button-row">
                            <button id="ts-create-db" class="b3-button b3-button--outline" type="button">新建数据库</button>
                            <button id="ts-repair-sync" class="b3-button b3-button--outline" type="button">首次/修复同步</button>
                            <button id="ts-clean-local" class="b3-button b3-button--outline" type="button">清理本地可删除项</button>
                        </div>
                        <div class="toggl-sync__settings-desc">目标文档为空时，请先手动新建数据库；同步不会自动创建。</div>
                    </div>
                </div>

                <div class="toggl-sync__settings-section">
                    <div class="toggl-sync__settings-section-title">诊断</div>
                    <div class="toggl-sync__settings-field">
                        <div class="toggl-sync__settings-button-row">
                            <button id="ts-diag" class="b3-button b3-button--outline" type="button">网络连接</button>
                            <button id="ts-debug" class="b3-button b3-button--outline" type="button">数据库状态</button>
                            <button id="ts-repair-options" class="b3-button b3-button--outline" type="button">修复选项</button>
                            <button id="ts-debug-copy" class="b3-button b3-button--text" type="button" style="display:none;font-size:12px;">📋 复制</button>
                        </div>
                        <div id="ts-debug-result" class="toggl-sync__settings-desc" style="margin-top:6px;white-space:pre-line;font-family:monospace;font-size:11px;max-height:400px;overflow-y:auto;"></div>
                    </div>
                </div>
            </div>
            <div class="b3-dialog__action toggl-sync__settings-footer">
                <span class="toggl-sync__settings-version">v${PLUGIN_VERSION}</span>
                <button class="b3-button b3-button--cancel" id="ts-cancel">${this.i18n.cancel || "取消"}</button>
                <div class="fn__space"></div>
                <button class="b3-button b3-button--text" id="ts-save">${this.i18n.save || "保存"}</button>
            </div>`,
            width: "560px",
        });

        const el = dialog.element;

        el.querySelector("#ts-verify").addEventListener("click", async () => {
            const btn = el.querySelector("#ts-verify") as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = "...";
            const token = (el.querySelector("#ts-token") as HTMLInputElement).value.trim();
            togglApi.setToken(token);
            const res = await togglApi.getMe();
            btn.disabled = false;
            btn.textContent = this.i18n.tokenVerify;
            if (res.ok) {
                this.config.workspaceId = res.data.default_workspace_id;
                await this.saveConfig();
                showMessage(`${this.i18n.tokenValid}: ${res.data.fullname}`, 3000, "info");
            } else {
                showMessage(this.formatApiError(this.i18n.tokenInvalid, res), 5000, "error");
            }
        });

        el.querySelector("#ts-clearSync").addEventListener("click", async () => {
            const ok = await new Promise<boolean>((resolve) => {
                confirm(
                    "清空同步时间后，下次同步将重新拉取全部数据。确定继续？",
                    "清空同步时间",
                    () => resolve(true),
                    () => resolve(false),
                );
            });
            if (!ok) return;
            this.config.lastSyncTime = "";
            const lastSyncEl = el.querySelector("#ts-lastSync") as HTMLElement;
            lastSyncEl.textContent = this.i18n.never;
            showMessage("已清空同步时间，下次同步将重新拉取数据", 3000, "info");
        });

        el.querySelector("#ts-repair-sync").addEventListener("click", async () => {
            const ok = await new Promise<boolean>((resolve) => {
                confirm(
                    "修复同步会对比本地与 Toggl 数据，本地有但 Toggl 没有的条目将被标记为可删除。确定继续？",
                    "首次/修复同步",
                    () => resolve(true),
                    () => resolve(false),
                );
            });
            if (!ok) return;
            await this.runButtonAction(
                el.querySelector("#ts-repair-sync") as HTMLButtonElement,
                "同步中...",
                async () => {
                    await this.applySettingsFromDialog(el);
                    await this.syncEntries("repair");
                },
            );
        });

        el.querySelector("#ts-clean-local").addEventListener("click", async () => {
            await this.runButtonAction(
                el.querySelector("#ts-clean-local") as HTMLButtonElement,
                "清理中...",
                async () => {
                    await this.applySettingsFromDialog(el);
                    await this.cleanupLocalDeletableRows();
                },
            );
        });

        const diagResultEl = el.querySelector("#ts-debug-result") as HTMLElement;
        const diagCopyBtn = el.querySelector("#ts-debug-copy") as HTMLButtonElement;
        let diagResultText = "";

        const setDiagResult = (text: string) => {
            diagResultText = text;
            diagResultEl.textContent = text;
            diagCopyBtn.style.display = text ? "inline-block" : "none";
        };

        el.querySelector("#ts-diag")!.addEventListener("click", async () => {
            const btn = el.querySelector("#ts-diag") as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = "诊断中...";
            setDiagResult("");
            try {
                const results = await togglApi.runDiagnostics();
                setDiagResult(results.map((r) => `${r.ok ? "✅" : "❌"} ${r.label}: ${r.detail}`).join("\n"));
            } catch (e: any) {
                setDiagResult(`❌ 诊断异常: ${e?.message || String(e)}`);
            } finally {
                btn.disabled = false;
                btn.textContent = "网络连接";
            }
        });

        el.querySelector("#ts-debug")!.addEventListener("click", async () => {
            const btn = el.querySelector("#ts-debug") as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = "诊断中...";
            const lines: string[] = [];
            const append = (s: string) => { lines.push(s); setDiagResult(lines.join("\n")); };

            try {
                append("=== 数据库状态 ===");
                const database = await this.getTargetDatabase();
                if (!database) {
                    append("❌ 未找到目标数据库");
                    return;
                }
                append(`avId: ${database.avId}`);
                append(`字段: ${database.keys.map((k) => `${k.name}(${k.type})`).join(", ")}`);
                append(`数据行数: ${(await this.readLocalDatabaseRows(database)).length}`);

                append("\n=== 同步状态选项 ===");
                const syncKey = this.findKey(database.keys, ["同步状态", "Sync Status"]);
                if (!syncKey) { append("❌ 未找到「同步状态」字段"); return; }
                const freshKeys = await this.loadDatabaseKeys(database.avId);
                const freshKey = freshKeys.find((k) => k.id === syncKey.id);
                const opts = freshKey?.options || [];
                const missing = SYNC_STATUS_OPTIONS.filter((s) => opts.map((o) => o.name).indexOf(s) === -1);
                append(`key.Options(${opts.length}): ${opts.map((o) => o.name).join(", ") || "(空)"}`);
                append(`预期 ${SYNC_STATUS_OPTIONS.length} 个, 缺失 ${missing.length} 个${missing.length > 0 ? ": " + missing.join(", ") : ""}`);
                append(missing.length === 0 ? "✅ 选项完整" : "⚠️ 选项不完整，需要重新创建数据库");

                append("\n=== 运行状态 ===");
                append(`currentTimer: ${this.config.currentTimer ? "有 (" + this.config.currentTimer.description + ")" : "无"}`);
                append(`pendingOps: ${this.config.pendingOps.length} 条`);
                append(`lastSyncTime: ${this.config.lastSyncTime || "(从未同步)"}`);
            } catch (e: any) {
                append(`\n❌ 异常: ${e?.message || String(e)}`);
            } finally {
                btn.disabled = false;
                btn.textContent = "数据库状态";
            }
        });

        diagCopyBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(diagResultText).then(() => {
                showMessage("已复制诊断信息", 1500, "info");
            }).catch(() => {
                showMessage("复制失败，请手动复制", 2000, "error");
            });
        });

        el.querySelector("#ts-repair-options")!.addEventListener("click", async () => {
            const btn = el.querySelector("#ts-repair-options") as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = "修复中...";
            try {
                const database = await this.getTargetDatabase();
                if (!database) {
                    showMessage("未找到目标数据库", 4000, "error");
                    return;
                }
                // 强制重置状态，绕过版本检查
                this.config.statusOptionsPreparedAvId = "";
                delete this.config.statusOptionsVersion;
                await this.saveConfig();
                // 重新加载 keys（avId 没变，需重新获取）
                await this.ensureSyncStatusOptions(database);
                showMessage("选项修复完成，请点「数据库状态」查看结果", 3000, "info");
            } catch (e: any) {
                showMessage(`修复失败: ${e?.message || String(e)}`, 5000, "error");
            } finally {
                btn.disabled = false;
                btn.textContent = "修复选项";
            }
        });

        el.querySelector("#ts-create-db").addEventListener("click", async () => {
            await this.runButtonAction(
                el.querySelector("#ts-create-db") as HTMLButtonElement,
                "创建中...",
                async () => {
                    await this.applySettingsFromDialog(el);
                    await this.createTargetDatabaseFromSettings();
                },
            );
        });

        el.querySelector("#ts-cancel").addEventListener("click", () => {
            dialog.destroy();
        });

        el.querySelector("#ts-save").addEventListener("click", async () => {
            await this.applySettingsFromDialog(el);
            dialog.destroy();
            showMessage(this.i18n.settings + " saved");
        });
    }

    private async applySettingsFromDialog(el: HTMLElement) {
        const oldToken = this.config.token;
        this.config.token = (el.querySelector("#ts-token") as HTMLInputElement).value.trim();
        this.config.targetDocId = (el.querySelector("#ts-doc") as HTMLInputElement).value.trim();
        this.config.initialDays = this.normalizeInitialDays(
            Number((el.querySelector("#ts-days") as HTMLSelectElement).value),
        );
        this.config.autoSyncMinutes = Number((el.querySelector("#ts-auto-sync") as HTMLSelectElement).value);
        this.config.apiEnabled = (el.querySelector("#ts-api-enabled") as HTMLInputElement).checked;
        this.config.statusBarTimer = (el.querySelector("#ts-statusbar") as HTMLInputElement).checked;
        this.config.statusBarText = this.normalizeStatusBarText(
            (el.querySelector("#ts-statusbar-text") as HTMLInputElement).value,
        );
        delete this.config.statusText;
        if (oldToken !== this.config.token) {
            this.config.workspaceId = 0;
            this.config.projectCache = [];
            this.config.tagCache = [];
            this.config.currentTimer = null;
            this.projects.clear();
            this.tags = [];
            this.workspaceIdPromise = null;
            await this.clearCurrentTimer();
        }
        togglApi.setToken(this.config.token);
        await this.saveConfig();
        this.projectsLoadPromise = null;
        this.tagsLoadPromise = null;
        if (this.config.statusBarTimer && this.config.token) {
            await this.startStatusBarTimer(true);
        } else {
            this.stopStatusBarTimer();
            this.renderIdleState();
        }
        this.setupAutoSync();
    }

    // ==================== 思源 -> Toggl ====================

    private async openStartTimerDialog() {
        if (!this.config.token) {
            showMessage("请先配置 Toggl API Token", 4000, "error");
            return;
        }
        await this.refreshProjects();
        await this.refreshTags();

        // 检测当前是否有计时在跑
        const runningWarn = this.lastEntryId !== null && this.lastEntryStart ?
            `<div style="padding:8px 12px;margin-bottom:12px;border-radius:6px;background:var(--b3-card-warning-background);border:1px solid var(--b3-card-warning-border);font-size:12px;color:var(--b3-card-warning-color);">
                ⚠️ 当前正在计时：${this.escapeHtml(this.lastEntryDescription || "无描述")}（已 ${this.formatDuration(Math.floor((Date.now() - new Date(this.lastEntryStart).getTime()) / 1000))}），开始新计时将自动停止当前计时
            </div>` : "";

        const lastProjectSelected = this.config.lastProjectId ? `value="${this.config.lastProjectId}"` : "";
        const lastTagsValue = this.config.lastTags?.length ? this.escapeHtml(this.config.lastTags.join(", ")) : "";

        const dialog = new Dialog({
            title: "开始 Toggl 计时",
            content: `<div class="b3-dialog__content" style="padding:16px;">
                ${runningWarn}
                <div class="fn__flex" style="flex-direction:column;gap:14px;">
                    <div>
                        <label class="b3-label" style="display:block;margin-bottom:4px;font-weight:bold;">描述</label>
                        <input id="ts-start-desc" class="b3-text-field" style="width:100%;" placeholder="正在做什么">
                    </div>
                    <div>
                        <label class="b3-label" style="display:block;margin-bottom:4px;font-weight:bold;">项目</label>
                        <div class="toggl-sync__dialog-row">
                            <select id="ts-start-project" class="b3-select toggl-sync__dialog-control">${this.renderProjectOptions(lastProjectSelected)}</select>
                            <button id="ts-start-refresh-projects" class="b3-button b3-button--outline toggl-sync__dialog-action" type="button">刷新</button>
                        </div>
                    </div>
                    <div>
                        <label class="b3-label" style="display:block;margin-bottom:4px;font-weight:bold;">标签</label>
                        <div class="toggl-sync__dialog-row">
                            <input id="ts-start-tags" class="b3-text-field toggl-sync__dialog-control" list="ts-start-tags-list" placeholder="多个标签用逗号分隔" value="${lastTagsValue}">
                            <datalist id="ts-start-tags-list">${this.renderTagOptions()}</datalist>
                            <button id="ts-start-refresh-tags" class="b3-button b3-button--outline toggl-sync__dialog-action" type="button">刷新</button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="b3-dialog__action">
                <button class="b3-button b3-button--cancel" id="ts-start-cancel">取消</button>
                <div class="fn__space"></div>
                <button class="b3-button b3-button--text" id="ts-start-submit">开始</button>
            </div>`,
            width: "480px",
        });

        const el = dialog.element;
        el.querySelector("#ts-start-cancel").addEventListener("click", () => dialog.destroy());
        el.querySelector("#ts-start-refresh-projects").addEventListener("click", async () => {
            await this.refreshProjectSelect(
                el.querySelector("#ts-start-refresh-projects") as HTMLButtonElement,
                el.querySelector("#ts-start-project") as HTMLSelectElement,
            );
        });
        el.querySelector("#ts-start-refresh-tags").addEventListener("click", async () => {
            await this.refreshTagDatalist(
                el.querySelector("#ts-start-refresh-tags") as HTMLButtonElement,
                el.querySelector("#ts-start-tags-list") as HTMLDataListElement,
            );
        });
        el.querySelector("#ts-start-submit").addEventListener("click", async () => {
            const button = el.querySelector("#ts-start-submit") as HTMLButtonElement;
            button.disabled = true;
            const description = (el.querySelector("#ts-start-desc") as HTMLInputElement).value.trim();
            const projectId = Number((el.querySelector("#ts-start-project") as HTMLSelectElement).value) || undefined;
            const tags = this.parseTags((el.querySelector("#ts-start-tags") as HTMLInputElement).value);

            // 记住上次选择
            this.config.lastProjectId = projectId;
            this.config.lastTags = tags;
            await this.saveConfig();

            // 先把数据写入思源数据库，写成功后再关闭弹窗；联网部分由 startTogglTimer 转入后台
            const started = await this.startTogglTimer({description, projectId, tags});
            button.disabled = false;
            if (started) {
                dialog.destroy();
            } else {
                showMessage("启动计时失败，请重试", 3000, "error");
            }
        });
    }

    private async openManualEntryDialog() {
        if (!this.config.token) {
            showMessage("请先配置 Toggl API Token", 4000, "error");
            return;
        }
        await this.refreshProjects();
        await this.refreshTags();

        const dialog = new Dialog({
            title: "补录 Toggl 条目",
            content: `<div class="b3-dialog__content" style="padding:16px;">
                <div class="fn__flex" style="flex-direction:column;gap:14px;">
                    <div>
                        <label class="b3-label" style="display:block;margin-bottom:4px;font-weight:bold;">描述</label>
                        <input id="ts-manual-desc" class="b3-text-field" style="width:100%;" placeholder="做了什么">
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                        <div>
                            <label class="b3-label" style="display:block;margin-bottom:4px;font-weight:bold;">开始时间</label>
                            <input id="ts-manual-start" class="b3-text-field" type="datetime-local" style="width:100%;" value="${
                this.toDateTimeInputValue(new Date())
            }">
                        </div>
                        <div>
                            <label class="b3-label" style="display:block;margin-bottom:4px;font-weight:bold;">结束时间</label>
                            <input id="ts-manual-end" class="b3-text-field" type="datetime-local" style="width:100%;" placeholder="留空则用时长计算">
                        </div>
                    </div>
                    <div>
                        <label class="b3-label" style="display:block;margin-bottom:4px;font-weight:bold;">时长（分钟）</label>
                        <input id="ts-manual-duration" class="b3-text-field" type="number" min="1" step="1" style="width:100%;" value="30">
                        <div style="margin-top:4px;font-size:11px;color:var(--b3-theme-on-surface-light);">填写结束时间后将自动计算时长</div>
                    </div>
                    <div>
                        <label class="b3-label" style="display:block;margin-bottom:4px;font-weight:bold;">项目</label>
                        <div class="toggl-sync__dialog-row">
                            <select id="ts-manual-project" class="b3-select toggl-sync__dialog-control">${this.renderProjectOptions()}</select>
                            <button id="ts-manual-refresh-projects" class="b3-button b3-button--outline toggl-sync__dialog-action" type="button">刷新</button>
                        </div>
                    </div>
                    <div>
                        <label class="b3-label" style="display:block;margin-bottom:4px;font-weight:bold;">标签</label>
                        <div class="toggl-sync__dialog-row">
                            <input id="ts-manual-tags" class="b3-text-field toggl-sync__dialog-control" list="ts-manual-tags-list" placeholder="多个标签用逗号分隔">
                            <datalist id="ts-manual-tags-list">${this.renderTagOptions()}</datalist>
                            <button id="ts-manual-refresh-tags" class="b3-button b3-button--outline toggl-sync__dialog-action" type="button">刷新</button>
                        </div>
                    </div>
                </div>
            </div>
            <div class="b3-dialog__action">
                <button class="b3-button b3-button--cancel" id="ts-manual-cancel">取消</button>
                <div class="fn__space"></div>
                <button class="b3-button b3-button--text" id="ts-manual-submit">保存</button>
            </div>`,
            width: "480px",
        });

        const el = dialog.element;
        el.querySelector("#ts-manual-cancel").addEventListener("click", () => dialog.destroy());
        el.querySelector("#ts-manual-refresh-projects").addEventListener("click", async () => {
            await this.refreshProjectSelect(
                el.querySelector("#ts-manual-refresh-projects") as HTMLButtonElement,
                el.querySelector("#ts-manual-project") as HTMLSelectElement,
            );
        });
        el.querySelector("#ts-manual-refresh-tags").addEventListener("click", async () => {
            await this.refreshTagDatalist(
                el.querySelector("#ts-manual-refresh-tags") as HTMLButtonElement,
                el.querySelector("#ts-manual-tags-list") as HTMLDataListElement,
            );
        });
        el.querySelector("#ts-manual-submit").addEventListener("click", async () => {
            const button = el.querySelector("#ts-manual-submit") as HTMLButtonElement;
            button.disabled = true;
            const description = (el.querySelector("#ts-manual-desc") as HTMLInputElement).value.trim();
            const startValue = (el.querySelector("#ts-manual-start") as HTMLInputElement).value;
            const endValue = (el.querySelector("#ts-manual-end") as HTMLInputElement).value;
            const durationInput = (el.querySelector("#ts-manual-duration") as HTMLInputElement).value;
            const projectId = Number((el.querySelector("#ts-manual-project") as HTMLSelectElement).value) || undefined;
            const tags = this.parseTags((el.querySelector("#ts-manual-tags") as HTMLInputElement).value);

            const startDate = new Date(startValue);
            let durationSeconds: number;

            // 优先用结束时间算时长
            if (endValue) {
                const endDate = new Date(endValue);
                durationSeconds = Math.round((endDate.getTime() - startDate.getTime()) / 1000);
            } else {
                durationSeconds = Math.round(Number(durationInput) * 60);
            }

            // 弹窗关闭前先做输入校验，便于用户就地修正
            if (!Number.isFinite(startDate.getTime()) || durationSeconds <= 0) {
                showMessage("请填写有效的开始时间和时长", 4000, "error");
                button.disabled = false;
                return;
            }

            // 先把数据写入思源数据库，写成功后再关闭弹窗；传云端由 createManualTogglEntry 转入后台
            const created = await this.createManualTogglEntry({
                description,
                start: startDate,
                durationSeconds,
                projectId,
                tags,
                billable: false,
            });
            button.disabled = false;
            if (created) {
                dialog.destroy();
            }
        });
    }

    private async stopPrevTimerLocal(): Promise<any | null> {
        const prevTimer = this.config.currentTimer;
        if (!prevTimer) return null;

        const stopTime = new Date();
        const elapsed = Math.max(0, Math.round((stopTime.getTime() - new Date(prevTimer.start).getTime()) / 1000));
        const newStatus = prevTimer.id !== 0 ? "Toggl 待更新" : "本地待上传";

        // ① 更新本地行的停止信息（快速，本地 RPC，在关闭弹窗前完成）
        if (prevTimer.localRowId && prevTimer.databaseAvId) {
            await this.updateLocalTimerStop(prevTimer.databaseAvId, prevTimer.localRowId, stopTime, elapsed, newStatus);
        }

        // ② 清空当前计时器（供新计时覆盖），保留 prevTimer 引用供后台云端停止
        await this.clearCurrentTimer();
        return prevTimer;
    }

    private async startTogglTimer(input: {
        description: string;
        projectId?: number;
        tags: string[];
    }): Promise<boolean> {
        const start = new Date();
        const projectName = input.projectId ?
            this.projects.get(input.projectId) || "" : "";

        // ① 先停掉当前运行中的计时器（仅本地标记，云端停止转入后台）
        const prevTimer = await this.stopPrevTimerLocal();

        // ② 写入本地数据库（await，写完后弹窗才会关闭）
        const database = await this.getTargetDatabase();
        let localRowId: string | null = null;
        if (database) {
            localRowId = await this.insertDatabaseRow(database.avId);
            if (localRowId) {
                await this.writeTogglRow(database, localRowId, {
                    id: 0,
                    description: input.description || "无描述",
                    projectName,
                    tagNames: input.tags,
                    start: start,
                    stop: null,
                    durationSeconds: 0,
                    billable: false,
                    syncStatus: "本地待上传",
                });
            }
        }

        // ③ 更新本地计时器状态（currentTimer 先记 workspaceId=0，后台获取后修正）
        this.lastEntryId = 0;
        this.lastEntryDescription = input.description || "";
        this.lastEntryStart = start.toISOString();
        this.config.currentTimer = {
            id: 0,
            workspaceId: 0,
            description: input.description || "",
            start: start.toISOString(),
            projectId: input.projectId,
            tags: input.tags,
            localRowId: localRowId || undefined,
            databaseAvId: database?.avId,
        };

        // ④ 本地数据已落库，返回 true（弹窗随后关闭）；联网部分转入后台
        this.finishStartTogglTimerCloud({input, start, database, localRowId, prevTimer});

        return true;
    }

    private finishStartTogglTimerCloud(ctx: {
        input: {description: string; projectId?: number; tags: string[]};
        start: Date;
        database: TargetDatabase | null;
        localRowId: string | null;
        prevTimer: any | null;
    }) {
        if (this.config.apiEnabled === false) return;
        (async () => {
            const workspaceId = await this.ensureWorkspaceId();
            if (!workspaceId) return;

            // 云端停止之前运行中的计时器
            if (ctx.prevTimer && ctx.prevTimer.id !== 0) {
                try {
                    const current = await togglApi.getCurrentTimeEntry();
                    const runningEntry: any = current.ok ? current.data : null;
                    if (runningEntry && runningEntry.id === ctx.prevTimer.id) {
                        await togglApi.stopTimeEntry(workspaceId, ctx.prevTimer.id);
                    }
                } catch (e) {
                    console.warn("[TogglSync] finishStartTogglTimerCloud: failed to stop cloud timer:", e);
                }
            }

            // 传新计时到云端
            this.pushTimerToToggl({workspaceId, input: ctx.input, start: ctx.start, database: ctx.database, localRowId: ctx.localRowId});
        })().catch((e) => {
            console.warn("[TogglSync] finishStartTogglTimerCloud failed:", e);
        });
    }

    private pushTimerToToggl(params: {
        workspaceId: number;
        input: {description: string; projectId?: number; tags: string[]};
        start: Date;
        database: TargetDatabase | null;
        localRowId: string | null;
    }) {
        const {workspaceId, input, start, database, localRowId} = params;
        (async () => {
            if (this.config.apiEnabled === false) return;
            const createBody: any = {
                workspace_id: workspaceId,
                description: input.description || "无描述",
                start: start.toISOString(),
                duration: -1,
                created_with: "siyuan-toggl-sync",
            };
            if (input.projectId !== undefined) {
                createBody.project_id = input.projectId;
            }
            if (input.tags.length > 0) {
                createBody.tags = input.tags;
                createBody.tag_action = "add";
            }
            const response = await togglApi.createTimeEntry(workspaceId, createBody);

            if (!response.ok) {
                // 失败：本地行保持"本地待上传"，下次同步推送
                showMessage("上传 Toggl 失败，已保留本地记录", 3000, "error");
                return;
            }

            // 成功：只更新 togglId 和同步状态，不覆盖本地已设置的项目/标签
            if (database && localRowId) {
                await this.writeTogglId(database, localRowId, response.data.id);
                await this.writeSyncStatus(database, localRowId, "正常");
            }
            await this.updateCurrentTimerFromEntry(response.data, input.projectId, input.tags);
        })().catch((e) => {
            console.warn("[TogglSync] pushTimerToToggl failed:", e);
        });
    }

    private async createManualTogglEntry(input: {
        description: string;
        start: Date;
        durationSeconds: number;
        projectId?: number;
        tags: string[];
        billable: boolean;
    }): Promise<boolean> {
        if (!Number.isFinite(input.start.getTime()) || input.durationSeconds <= 0) {
            showMessage("请填写有效的开始时间和时长", 4000, "error");
            return false;
        }

        // ① 先写入本地数据库
        const database = await this.getTargetDatabase();
        let seedRowId: string | null = null;
        if (database) {
            const projectName = input.projectId ?
                this.projects.get(input.projectId) || `${input.projectId}` :
                "";
            seedRowId = await this.insertDatabaseRow(database.avId);
            if (seedRowId) {
                await this.writeTogglRow(database, seedRowId, {
                    id: 0,
                    description: input.description || "无描述",
                    projectName,
                    tagNames: input.tags,
                    start: input.start,
                    stop: new Date(input.start.getTime() + input.durationSeconds * 1000),
                    durationSeconds: input.durationSeconds,
                    billable: false,
                    syncStatus: "本地待上传",
                });
            }
        }

        // ② 后台上传 Toggl（不阻塞弹窗关闭）
        this.pushManualToToggl({input, database, seedRowId});

        return true;
    }

    private pushManualToToggl(params: {
        input: {description: string; start: Date; durationSeconds: number; projectId?: number; tags: string[]; billable: boolean};
        database: TargetDatabase | null;
        seedRowId: string | null;
    }) {
        const {input, database, seedRowId} = params;
        (async () => {
            if (this.config.apiEnabled === false) return;
            const workspaceId = await this.ensureWorkspaceId();
            if (!workspaceId) return;

            const stop = new Date(input.start.getTime() + input.durationSeconds * 1000);
            const manualBody: any = {
                workspace_id: workspaceId,
                description: input.description || "无描述",
                start: input.start.toISOString(),
                stop: stop.toISOString(),
                duration: input.durationSeconds,
                created_with: "siyuan-toggl-sync",
            };
            if (input.projectId !== undefined) {
                manualBody.project_id = input.projectId;
            }
            if (input.tags.length > 0) {
                manualBody.tags = input.tags;
                manualBody.tag_action = "add";
            }
            const response = await togglApi.createTimeEntry(workspaceId, manualBody);

            if (!response.ok) {
                showMessage("上传 Toggl 失败，已保留本地记录", 3000, "error");
                return;
            }

            if (database && seedRowId) {
                await this.writeTogglId(database, seedRowId, response.data.id);
                await this.writeSyncStatus(database, seedRowId, "正常");
            } else if (database) {
                await this.addEntries([response.data], database);
            }
        })().catch((e) => {
            console.warn("[TogglSync] pushManualToToggl failed:", e);
        });
    }

    private async stopCurrentTimer() {
        if (this.config.apiEnabled !== false && !this.config.token) {
            showMessage("请先配置 Toggl API Token", 4000, "error");
            return;
        }

        const prevTimer = this.config.currentTimer;
        if (!prevTimer) {
            showMessage("当前没有正在运行的计时", 3000, "info");
            return;
        }

        const stopTime = new Date();
        const elapsed = Math.max(0, Math.round((stopTime.getTime() - new Date(prevTimer.start).getTime()) / 1000));

        const newStatus = prevTimer.id !== 0 ? "Toggl 待更新" : "本地待上传";
        const apiEnabled = this.config.apiEnabled !== false;

        // ① 更新本地行的停止信息（仅当已有本地行）
        if (prevTimer.localRowId && prevTimer.databaseAvId) {
            await this.updateLocalTimerStop(prevTimer.databaseAvId, prevTimer.localRowId, stopTime, elapsed, newStatus);
        }

        // ② 停止云端计时器（只调一次，避免重复消耗配额）
        if (prevTimer.id !== 0 && apiEnabled) {
            const workspaceId = await this.ensureWorkspaceId();
            if (workspaceId) {
                try {
                    if (!prevTimer.localRowId) {
                        // 没有本地行：直接停止，再把停止后的条目写回本地
                        const stopResult = await togglApi.stopTimeEntry(workspaceId, prevTimer.id);
                        if (stopResult.ok && stopResult.data && this.config.targetDocId) {
                            await this.addEntries([stopResult.data]);
                        }
                    } else {
                        // 有本地行：确认仍在运行再停止（一次 getCurrentTimeEntry + 一次 stopTimeEntry）
                        const current = await togglApi.getCurrentTimeEntry();
                        if (current.ok && (current.data as any)?.id === prevTimer.id) {
                            await togglApi.stopTimeEntry(workspaceId, prevTimer.id);
                        }
                    }
                } catch {
                    // API 失败不阻塞，本地已更新，等下次同步
                }
            }
        }

        // ③ 清理 pending 的 start 操作
        this.config.pendingOps = this.config.pendingOps.filter(op => op.type !== "start");
        await this.clearCurrentTimer();

        const msg = elapsed > 0
            ? `计时已停止（${this.formatDuration(elapsed)}）`
            : "计时已停止";
        showMessage(msg, 3000, "info");
    }

    private async flushPendingOps(): Promise<number> {
        if (this.config.pendingOps.length === 0) return 0;

        let flushed = 0;
        const ops = [...this.config.pendingOps];
        const remaining: PendingOp[] = [];

        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            if (op.type === "start") {
                const workspaceId = await this.ensureWorkspaceId();
                if (!workspaceId) {
                    remaining.push(op);
                    remaining.push(...ops.slice(i + 1));
                    break;
                }
                const startBody: any = {
                    workspace_id: workspaceId,
                    description: op.description || "无描述",
                    start: op.start,
                    duration: -1,
                    created_with: "siyuan-toggl-sync",
                };
                if (op.projectId !== undefined) {
                    startBody.project_id = op.projectId;
                }
                if (op.tags.length > 0) {
                    startBody.tags = op.tags;
                    startBody.tag_action = "add";
                }
                const response = await togglApi.createTimeEntry(workspaceId, startBody);
                if (!response.ok) {
                    remaining.push(op);
                    remaining.push(...ops.slice(i + 1));
                    break;
                }
                await this.updateCurrentTimerFromEntry(response.data, op.projectId, op.tags);
                flushed++;
            } else if (op.type === "stop") {
                const response = await togglApi.stopTimeEntry(op.workspaceId, op.entryId);
                if (response.ok) {
                    if (this.config.targetDocId) {
                        await this.addEntries([response.data]);
                    }
                    await this.clearCurrentTimer();
                    flushed++;
                } else if (response.status === 404 || response.status === 409) {
                    flushed++;
                } else {
                    remaining.push(op);
                    remaining.push(...ops.slice(i + 1));
                    break;
                }
            } else if (op.type === "manual") {
                const workspaceId = await this.ensureWorkspaceId();
                if (!workspaceId) {
                    remaining.push(op);
                    remaining.push(...ops.slice(i + 1));
                    break;
                }
                const stop = new Date(new Date(op.start).getTime() + op.durationSeconds * 1000);
                const manualBody: any = {
                    workspace_id: workspaceId,
                    description: op.description || "无描述",
                    start: op.start,
                    duration: op.durationSeconds,
                    created_with: "siyuan-toggl-sync",
                    stop: stop.toISOString(),
                };
                if (op.projectId !== undefined) {
                    manualBody.project_id = op.projectId;
                }
                if (op.tags.length > 0) {
                    manualBody.tags = op.tags;
                    manualBody.tag_action = "add";
                }
                const response = await togglApi.createTimeEntry(workspaceId, manualBody);
                if (!response.ok) {
                    remaining.push(op);
                    remaining.push(...ops.slice(i + 1));
                    break;
                }
                if (this.config.targetDocId) {
                    await this.addEntries([response.data]);
                }
                flushed++;
            }
        }

        this.config.pendingOps = remaining;
        await this.saveConfig();
        return flushed;
    }

    private async getTargetDatabase(): Promise<TargetDatabase | null> {
        const avId = await this.findOrMountTargetDatabase();
        if (!avId) {
            if (!this.suppressDatabasePrompt) {
                showMessage("目标文档没有 Toggl Sync 数据库，请在插件设置中点击“新建数据库”", 5000, "error");
            }
            return null;
        }

        if (this.config.avId !== avId) {
            this.config.avId = avId;
            this.config.statusOptionsPreparedAvId = "";
            delete this.config.statusOptionsVersion;
            await this.saveConfig();
        }

        const keys = await this.ensureDatabaseFields(avId);
        await this.ensureSyncStatusOptions({avId, keys});

        return {avId, keys};
    }

    private async findOrMountTargetDatabase(): Promise<string | null> {
        const targetDocId = this.config.targetDocId;
        const targetId = this.escapeSql(targetDocId);
        const blocks = await this.sql(
            `SELECT * FROM blocks WHERE id = '${targetId}' AND type = 'av'
             UNION ALL
             SELECT * FROM blocks WHERE root_id = '${targetId}' AND type = 'av'
             ORDER BY updated DESC`,
        );
        let avId = this.findConfiguredAvId(blocks || []);

        if (!avId && this.config.avId) {
            const mountedAvId = await this.findDatabaseAvIdInDocument(targetDocId, this.config.avId);
            if (mountedAvId) return mountedAvId;

            avId = this.config.avId;
            showMessage("目标文档没有挂载数据库，正在挂载已有 Toggl Sync 数据库...", 3000, "info");
            const mounted = await this.insertDatabaseBlock(targetDocId, avId);
            if (!mounted) return null;
        }

        return avId;
    }

    private findConfiguredAvId(blocks: any[]): string | null {
        if (!this.config.avId) return null;
        for (const block of blocks) {
            const avId = this.extractAvId(block);
            if (avId === this.config.avId) return avId;
        }
        return null;
    }

    private async createTargetDatabaseFromSettings(): Promise<void> {
        if (!this.config.targetDocId) {
            showMessage("请先配置目标文档 ID", 4000, "error");
            return;
        }

        const existingAvId = await this.findOrMountTargetDatabase();
        if (existingAvId) {
            this.config.avId = existingAvId;
            await this.saveConfig();
            const keys = await this.ensureDatabaseFields(existingAvId);
            await this.ensureSyncStatusOptions({avId: existingAvId, keys});
            showMessage("目标文档已存在 Toggl Sync 数据库", 3000, "info");
            return;
        }

        const avId = await this.createDatabase(this.config.targetDocId);
        if (!avId) return;

        this.config.avId = avId;
        await this.saveConfig();
        const keys = await this.ensureDatabaseFields(avId);
        await this.removeUnwantedKeys(avId);
        await this.ensureSyncStatusOptions({avId, keys});
        showMessage("已新建空白 Toggl Sync 数据库", 3000, "info");
    }

    private async createDatabase(docId: string): Promise<string | null> {
        const avId = this.createSiyuanId();
        showMessage("正在创建 Toggl Sync 数据库...", 2000, "info");
        const createResult = await this.fetchSiyuanPostAllowEmpty("/api/av/createAttributeView", {
            avID: avId,
            name: "Toggl Sync",
        });
        if (!this.isSiyuanOk(createResult)) {
            console.error("[TogglSync] createAttributeView failed:", JSON.stringify(createResult));
            showMessage(`创建数据库失败: ${createResult?.msg ?? this.formatUnknownError(createResult)}`, 5000, "error");
            return null;
        }

        const inserted = await this.insertDatabaseBlock(docId, avId);
        if (!inserted) {
            showMessage("数据库已创建，但挂载到目标文档失败，请查看控制台日志", 5000, "error");
            return null;
        }

        return avId;
    }

    private async insertDatabaseBlock(docId: string, avId: string): Promise<boolean> {
        const viewId = await this.getDatabaseViewId(avId);
        const customViewAttr = viewId ? ` custom-sy-av-view="${viewId}"` : "";
        const domData =
            `<div data-node-id="${this.createSiyuanId()}" data-type="NodeAttributeView"${customViewAttr} data-av-id="${avId}" data-av-type="table"></div>`;
        const domResult = await fetchSyncPost("/api/block/appendBlock", {
            dataType: "dom",
            data: domData,
            parentID: docId,
        });
        if (await this.isDatabaseBlockInserted(docId, avId, domResult)) {
            return true;
        }
        console.warn("[TogglSync] appendBlock dom did not mount database:", JSON.stringify(domResult));

        const markdownResult = await fetchSyncPost("/api/block/insertBlock", {
            dataType: "markdown",
            data: domData,
            parentID: docId,
        });
        if (await this.isDatabaseBlockInserted(docId, avId, markdownResult)) {
            return true;
        }
        console.error("[TogglSync] insertBlock markdown did not mount database:", JSON.stringify(markdownResult));
        return false;
    }

    private async getDatabaseViewId(avId: string): Promise<string> {
        const renderResult = await this.renderDatabase(avId);
        if (renderResult.code === 0) {
            return renderResult.data?.viewID ?? renderResult.data?.view?.id ?? renderResult.data?.view?.viewID ?? "";
        }

        const avResult = await fetchSyncPost("/api/av/getAttributeView", {id: avId});
        if (avResult.code === 0) {
            return avResult.data?.viewID ?? avResult.data?.views?.[0]?.id ?? "";
        }

        return "";
    }

    private async isDatabaseBlockInserted(docId: string, avId: string, result: any): Promise<boolean> {
        if (!this.isSiyuanOk(result)) return false;
        const responseAvId = this.extractAvIdFromBlockApiResponse(result);
        if (responseAvId === avId) return true;
        if (responseAvId) {
            console.warn(
                "[TogglSync] insert database block response included unexpected avId:",
                JSON.stringify(result),
            );
        }

        for (let attempt = 0; attempt < 3; attempt++) {
            await this.sleep(500);
            if (await this.findDatabaseAvIdInDocument(docId, avId) === avId) return true;
        }
        return false;
    }

    private isSiyuanOk(result: any): boolean {
        return result === "" || result?.code === 0;
    }

    private async fetchSiyuanPostAllowEmpty(url: string, data: any): Promise<any> {
        const response = await fetch(url, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(data),
        });
        const text = await response.text();
        if (!response.ok) {
            return {code: -1, msg: text || `HTTP ${response.status}`};
        }
        if (!text.trim()) return "";
        try {
            return JSON.parse(text);
        } catch (error) {
            return {code: -1, msg: this.formatUnknownError(error), data: text};
        }
    }

    private async ensureDatabaseFields(avId: string): Promise<AttributeViewKey[]> {
        let keys = await this.loadDatabaseKeys(avId);
        let previousKeyID = keys[keys.length - 1]?.id ?? "";
        let addedCount = 0;

        for (const field of TOGGL_DATABASE_FIELDS) {
            if (this.findKey(keys, field.aliases)) continue;

            const keyID = this.createSiyuanId();
            const result = await fetchSyncPost("/api/av/addAttributeViewKey", {
                avID: avId,
                keyID,
                keyName: field.name,
                keyType: field.type,
                keyIcon: "",
                previousKeyID,
            });

            if (result.code !== 0) {
                console.error("[TogglSync] addAttributeViewKey failed:", field.name, JSON.stringify(result));
                continue;
            }

            previousKeyID = keyID;
            keys.push({id: keyID, name: field.name, type: field.type});
            addedCount++;
        }

        if (addedCount > 0) {
            showMessage(`已补齐数据库字段 ${addedCount} 个`, 3000, "info");
        }

        const refreshedKeys = await this.loadDatabaseKeys(avId);
        const merged = this.mergeDatabaseKeys(refreshedKeys, keys);
        return this.sortKeysByFieldOrder(merged);
    }

    private async ensureSyncStatusOptions(database: TargetDatabase): Promise<void> {
        const OPTIONS_PREPARED_VERSION = 5;
        if (this.config.statusOptionsPreparedAvId === database.avId
            && this.config.statusOptionsVersion === OPTIONS_PREPARED_VERSION) return;

        await this.syncStatusOptionsForce(database);

        // 验证注册结果，成功才保存版本号
        const verifyKeys = await this.loadDatabaseKeys(database.avId);
        const verifyKey = verifyKeys.find((k) => k.id === this.findKey(database.keys, ["同步状态", "Sync Status"])!.id);
        const verifyOptions = (verifyKey?.options || []).map((o) => o.name);
        const stillMissing = SYNC_STATUS_OPTIONS.filter((s) => verifyOptions.indexOf(s) === -1);
        if (stillMissing.length === 0) {
            this.config.statusOptionsPreparedAvId = database.avId;
            this.config.statusOptionsVersion = OPTIONS_PREPARED_VERSION;
            await this.saveConfig();
        } else {
            console.warn(`[TogglSync] 选项注册失败，仍有 ${stillMissing.length} 个缺失: ${stillMissing.join(", ")}`);
        }
    }

    private async syncStatusOptionsForce(database: TargetDatabase): Promise<void> {
        const key = this.findKey(database.keys, ["同步状态", "Sync Status"]);
        if (!key) return;

        const freshKeys = await this.loadDatabaseKeys(database.avId);
        const freshKey = freshKeys.find((k) => k.id === key.id);
        const existingOptions = (freshKey?.options || []).map((o) => o.name);
        const missingOptions = SYNC_STATUS_OPTIONS.filter((s) => existingOptions.indexOf(s) === -1);
        if (missingOptions.length === 0) return;

        const blocksValues = missingOptions.map((status) => [
            {keyID: key.id, type: "select", mSelect: [{content: status, color: ""}]},
        ]);
        const appendResult = await fetchSyncPost("/api/av/appendAttributeViewDetachedBlocksWithValues", {
            avID: database.avId,
            blocksValues,
        });

        if (appendResult.code === 0) {
            const blockIDs: string[] = appendResult.data?.blockIDs || [];
            if (blockIDs.length > 0) {
                await new Promise((resolve) => setTimeout(resolve, 600));
                await this.requestTransaction([{
                    action: "removeAttrViewBlock", avID: database.avId,
                    srcIDs: blockIDs, removeDest: true,
                }]);
            }
        } else {
            const seedRowIds: string[] = [];
            for (const status of missingOptions) {
                const rowId = await this.insertDatabaseRow(database.avId);
                if (!rowId) continue;
                seedRowIds.push(rowId);
                const value = this.buildCellValue(key, rowId, status);
                if (!value) continue;
                await fetchSyncPost("/api/av/setAttributeViewBlockAttr", {
                    avID: database.avId, keyID: key.id, itemID: rowId, value,
                });
            }
            // 清理种子行
            if (seedRowIds.length > 0) {
                await new Promise((resolve) => setTimeout(resolve, 600));
                await this.requestTransaction([{
                    action: "removeAttrViewBlock", avID: database.avId,
                    srcIDs: seedRowIds, removeDest: true,
                }]);
            }
        }
    }

    private async syncFieldOptions(fieldAliases: string[], newNames: string[]): Promise<void> {
        if (newNames.length === 0) return;
        const database = await this.getTargetDatabase();
        if (!database) return;

        const key = this.findKey(database.keys, fieldAliases);
        if (!key) return;

        const freshKeys = await this.loadDatabaseKeys(database.avId);
        const freshKey = freshKeys.find((k) => k.id === key.id);
        const existing = (freshKey?.options || []).map((o) => o.name);
        const missing = newNames.filter((name) => name && existing.indexOf(name) === -1);
        if (missing.length === 0) return;

        const blocksValues = missing.map((name) => [
            {keyID: key.id, type: key.type, mSelect: [{content: name, color: ""}]},
        ]);
        const result = await fetchSyncPost("/api/av/appendAttributeViewDetachedBlocksWithValues", {
            avID: database.avId,
            blocksValues,
        });
        // 清理种子块（选项已持久化到 key.Options，删除块不影响）
        const blockIDs: string[] = result.code === 0 ? (result.data?.blockIDs || []) : [];
        if (blockIDs.length > 0) {
            await this.requestTransaction([{
                action: "removeAttrViewBlock", avID: database.avId,
                srcIDs: blockIDs, removeDest: true,
            }]);
        }
    }

    private async loadDatabaseKeys(avId: string): Promise<AttributeViewKey[]> {
        const keysResult = await fetchSyncPost("/api/av/getAttributeViewKeysByAvID", {avID: avId});
        let keys = keysResult.code === 0 ? this.normalizeAttributeViewKeys(keysResult.data) : [];
        if (keys.length === 0) {
            const renderResult = await this.renderDatabase(avId);
            if (renderResult.code === 0) {
                keys = this.normalizeAttributeViewKeys(renderResult.data);
            }
        }
        return keys;
    }

    private mergeDatabaseKeys(primary: AttributeViewKey[], fallback: AttributeViewKey[]): AttributeViewKey[] {
        if (primary.length === 0) return fallback;
        const merged = [...primary];
        for (const key of fallback) {
            if (
                !merged.some((item) =>
                    item.id === key.id || this.normalizeKeyName(item.name) === this.normalizeKeyName(key.name)
                )
            ) {
                merged.push(key);
            }
        }
        return merged;
    }

    private sortKeysByFieldOrder(keys: AttributeViewKey[]): AttributeViewKey[] {
        const orderMap = new Map<string, number>();
        TOGGL_DATABASE_FIELDS.forEach((field, index) => {
            orderMap.set(this.normalizeKeyName(field.name), index);
        });
        return [...keys].sort((a, b) => {
            const ai = orderMap.get(this.normalizeKeyName(a.name));
            const bi = orderMap.get(this.normalizeKeyName(b.name));
            if (ai !== undefined && bi !== undefined) return ai - bi;
            if (ai !== undefined) return -1;
            if (bi !== undefined) return 1;
            return 0;
        });
    }

    // 移除思源自动创建的默认字段（不在 TOGGL_DATABASE_FIELDS 中的字段）
    private async removeUnwantedKeys(avId: string): Promise<void> {
        const current = await this.loadDatabaseKeys(avId);
        let removedCount = 0;
        for (const key of current) {
            // 不删除思源必须的 block 类型主键
            if (key.type === "block") continue;

            const isWanted = TOGGL_DATABASE_FIELDS.some((f) =>
                this.normalizeKeyName(f.name) === this.normalizeKeyName(key.name) ||
                f.aliases.some((a) => this.normalizeKeyName(a) === this.normalizeKeyName(key.name))
            );
            if (isWanted) continue;

            try {
                const result = await fetchSyncPost("/api/av/removeAttributeViewKey", {
                    avID: avId,
                    keyID: key.id,
                });
                if (result.code !== 0) {
                    console.warn("[TogglSync] removeAttributeViewKey failed:", key.name, JSON.stringify(result));
                } else {
                    removedCount++;
                }
            } catch (e) {
                console.warn("[TogglSync] removeAttributeViewKey error:", key.name, e);
            }
        }
        if (removedCount > 0) {
            console.warn(`[TogglSync] removed ${removedCount} unwanted keys`);
        }
    }

    private async findDatabaseAvIdInDocument(docId: string, expectedAvId?: string): Promise<string | null> {
        const kramdown = await this.getBlockKramdown(docId);
        for (const avId of this.extractAvIdsFromText(kramdown)) {
            if (!expectedAvId || avId === expectedAvId) return avId;
        }

        const targetId = this.escapeSql(docId);
        const blocks = await this.sql(
            `SELECT * FROM blocks WHERE root_id = '${targetId}' AND type = 'av'
             ORDER BY updated DESC`,
        );

        for (const block of blocks || []) {
            const avId = this.extractAvId(block);
            if (avId && (!expectedAvId || avId === expectedAvId)) return avId;
        }

        return null;
    }

    private async getBlockKramdown(id: string): Promise<string> {
        const result = await fetchSyncPost("/api/block/getBlockKramdown", {id});
        if (result.code !== 0) {
            console.warn("[TogglSync] getBlockKramdown failed:", JSON.stringify(result));
            return "";
        }
        return result.data?.kramdown ?? "";
    }

    private async insertDatabaseRow(avId: string): Promise<string | null> {
        const beforeResult = await this.renderDatabase(avId);
        const before = beforeResult.code === 0 ? this.extractRenderedRowIds(beforeResult.data) : [];
        const srcId = this.createSiyuanId();
        const operation: any = {
            action: "insertAttrViewBlock",
            avID: avId,
            srcs: [{id: srcId, isDetached: true}],
            ignoreFillFilter: true,
        };
        const txResult = await this.requestTransaction([operation]);

        if (!txResult || txResult.code !== 0) {
            console.error("[TogglSync] insertAttrViewBlock failed:", JSON.stringify(txResult));
            return null;
        }

        const after = await this.getRenderedRowIds(avId);
        const inserted = after.find((id) => before.indexOf(id) === -1);
        return inserted ?? after[after.length - 1] ?? srcId;
    }

    private async writeTogglRow(database: TargetDatabase, rowId: string, row: TogglDatabaseRow): Promise<void> {
        // 顺序与 TOGGL_DATABASE_FIELDS 一致
        const fields: {aliases: string[]; value: DatabaseCellInput | string[]; usePrimary?: boolean;}[] = [
            {aliases: ["描述", "Description"], value: row.description || "无描述", usePrimary: true},
            {aliases: ["持续时间", "Duration Display", "Duration Text", "时长显示"], value: (row.stop || row.durationSeconds > 0) ? this.formatDuration(row.durationSeconds) : "进行中"},
            {aliases: ["项目", "Project"], value: row.projectName},
            {aliases: ["标签", "Tags", "Tag"], value: row.tagNames},
            {aliases: ["同步状态", "Sync Status"], value: row.syncStatus || "正常"},
            {aliases: ["开始", "开始时间", "Start", "Start Time"], value: row.start},
            {aliases: ["结束", "结束时间", "End", "End Time", "Stop", "Stop Time"], value: row.stop},
            {aliases: ["时长", "Duration"], value: row.durationSeconds},
            {aliases: ["TogglID", "Toggl ID", "Toggl Id", "toggl-id"], value: row.id},
            {aliases: ["日期", "创建日期", "Date"], value: row.start},
        ];

        const writtenKeyIds = new Set<string>();
        for (const field of fields) {
            let key = this.findKey(database.keys, field.aliases);
            // 描述字段降级到思源默认主文本键
            if (!key && field.usePrimary) {
                key = this.findPrimaryTextKey(database.keys);
            }
            if (!key || writtenKeyIds.has(key.id)) continue;
            // select/mSelect 空值也需显式写入 {mSelect:[]} 来清除思源默认选项
            if (this.isEmptyCellInput(field.value) && key.type !== "select" && key.type !== "mSelect") continue;

            const value = this.buildCellValue(key, rowId, field.value);
            if (!value) continue;

            const result = await fetchSyncPost("/api/av/setAttributeViewBlockAttr", {
                avID: database.avId,
                keyID: key.id,
                itemID: rowId,
                value,
            });
            if (result.code !== 0) {
                console.error("[TogglSync] setAttributeViewBlockAttr failed:", key.name, JSON.stringify(result));
            } else {
                writtenKeyIds.add(key.id);
            }
        }
    }

    private async writeTogglId(database: TargetDatabase, rowId: string, togglId: number): Promise<void> {
        const key = this.findKey(database.keys, ["TogglID", "Toggl ID", "Toggl Id", "toggl-id"]);
        if (!key) return;
        const value = this.buildCellValue(key, rowId, togglId);
        if (!value) return;
        await fetchSyncPost("/api/av/setAttributeViewBlockAttr", {
            avID: database.avId, keyID: key.id, itemID: rowId, value,
        });
    }

    private async writeSyncStatus(database: TargetDatabase, rowId: string, status: SyncStatus): Promise<void> {
        const key = this.findKey(database.keys, ["同步状态", "Sync Status"]);
        if (!key) return;
        const value = this.buildCellValue(key, rowId, status);
        if (!value) return;
        const result = await fetchSyncPost("/api/av/setAttributeViewBlockAttr", {
            avID: database.avId,
            keyID: key.id,
            itemID: rowId,
            value,
        });
        if (result.code !== 0) {
            console.error("[TogglSync] writeSyncStatus failed:", status, JSON.stringify(result));
        }
    }

    private async updateLocalTimerStop(
        databaseAvId: string,
        rowId: string,
        stopTime: Date,
        elapsed: number,
        syncStatus: SyncStatus,
    ): Promise<void> {
        const database = await this.getTargetDatabase();
        if (!database || database.avId !== databaseAvId) return;

        const cells: Array<{ key: AttributeViewKey; value: any }> = [];
        const stopKey = this.findKey(database.keys, ["结束", "结束时间", "End", "End Time", "Stop", "Stop Time"]);
        const durKey = this.findKey(database.keys, ["时长", "Duration"]);
        const displayKey = this.findKey(database.keys, ["持续时间", "Duration Display", "Duration Text", "时长显示"]);
        const statusKey = this.findKey(database.keys, ["同步状态", "Sync Status"]);

        if (stopKey) cells.push({ key: stopKey,
            value: { date: { content: stopTime.getTime(), isNotEmpty: true, isNotTime: false } } });
        if (durKey) cells.push({ key: durKey,
            value: { number: { content: elapsed, isNotEmpty: true } } });
        if (displayKey) cells.push({ key: displayKey,
            value: { text: { content: this.formatDuration(elapsed) } } });
        if (statusKey) cells.push({ key: statusKey,
            value: { mSelect: [{ content: syncStatus, color: "" }] } });

        for (const cell of cells) {
            await fetchSyncPost("/api/av/setAttributeViewBlockAttr", {
                avID: database.avId,
                keyID: cell.key.id,
                itemID: rowId,
                value: { id: this.createSiyuanId(), keyID: cell.key.id, blockID: rowId,
                    type: cell.key.type, ...cell.value },
            });
        }
    }

    // ==================== 同步逻辑 ====================

    private async syncEntries(mode: SyncMode = "regular") {
        if (this.config.apiEnabled === false) return;
        if (this.syncInProgress) {
            showMessage("同步正在进行中，请稍后", 2500, "info");
            return;
        }
        if (!this.config.token) {
            showMessage("请先配置 Toggl API Token", 4000, "error");
            return;
        }
        if (!this.config.targetDocId) {
            showMessage("请先配置目标文档 ID", 4000, "error");
            return;
        }

        this.syncInProgress = true;
        const silent = mode === "auto";
        if (!silent) {
            showMessage(mode === "repair" ? "开始首次/修复同步..." : "开始同步 Toggl 数据...", 2000, "info");
        } else if (this.statusBarEl) {
            // auto 同步时在状态栏短暂显示同步中
            this.statusBarEl.setAttribute("data-syncing", "1");
        }

        try {
            const syncStartedAt = new Date();
            this.suppressDatabasePrompt = silent;
            const database = await this.getTargetDatabase();
            this.suppressDatabasePrompt = false;
            if (!database) {
                return;
            }

            await this.refreshProjects();
            await this.refreshTags();

            if (this.config.pendingOps.length > 0) {
                const flushed = await this.flushPendingOps();
                if (flushed > 0) {
                    showMessage(`已重试 ${flushed} 条暂存操作`, 2000, "info");
                }
            }

            let localRows = await this.readLocalDatabaseRows(database);
            // 回填缺失的同步状态（纯写，不在 read 函数中做）
            await this.backfillSyncStatus(database, localRows);
            // 检测重复 TogglID，避免产生永久孤儿行
            const dupMarked = await this.detectDuplicateTogglIds(database, localRows);
            if (dupMarked > 0) {
                showMessage(`检测到 ${dupMarked} 条重复 TogglID，已标记为「本地可删除」`, 4000, "info");
            }
            const localResult = await this.pushLocalChanges(database, localRows);
            if (localResult.created > 0 || localResult.updated > 0 || localResult.deleted > 0) {
                localRows = await this.readLocalDatabaseRows(database);
            }

            const response = mode === "repair" || !this.config.lastSyncTime ?
                await togglApi.getTimeEntries(this.buildRepairRangeParams()) :
                await togglApi.getTimeEntries({
                    since: Math.floor(new Date(this.config.lastSyncTime).getTime() / 1000),
                });
            if (!response.ok) {
                if (!silent) showMessage(this.formatApiError("同步失败", response), 5000, "error");
                return;
            }

            const remoteResult = await this.applyRemoteEntries(database, response.data || [], localRows);
            if (mode === "repair") {
                remoteResult.markedDeleted += await this.markMissingRowsInRepairRange(
                    database,
                    localRows,
                    response.data || [],
                );
            }
            this.config.lastSyncTime = syncStartedAt.toISOString();
            await this.saveConfig();

            // 同步时顺便刷新计时器状态（感知 Toggl 端的停止操作）
            if (this.config.statusBarTimer) {
                await this.refreshCurrentTimer(true);
            }

            const actionText = [
                localResult.created ? `上传 ${localResult.created}` : "",
                localResult.updated ? `更新 Toggl ${localResult.updated}` : "",
                localResult.deleted ? `删除 Toggl ${localResult.deleted}` : "",
                remoteResult.added ? `新增 ${remoteResult.added}` : "",
                remoteResult.updated ? `更新本地 ${remoteResult.updated}` : "",
                remoteResult.markedDeleted ? `标记本地可删除 ${remoteResult.markedDeleted}` : "",
                localResult.failed ? `失败 ${localResult.failed}` : "",
                remoteResult.skippedPending ? `跳过待处理 ${remoteResult.skippedPending}` : "",
            ].filter(Boolean).join("，");
            if (!silent || actionText || localResult.failed > 0) {
                showMessage(
                    `${actionText || "没有需要同步的变更"}${this.formatQuotaText(response)}`,
                    4000,
                    localResult.failed > 0 ? "error" : "info",
                );
            }
        } finally {
            this.suppressDatabasePrompt = false;
            this.syncInProgress = false;
            if (this.statusBarEl) {
                this.statusBarEl.removeAttribute("data-syncing");
            }
        }
    }

    private loadProjectCache() {
        this.projects.clear();
        for (const project of this.config.projectCache || []) {
            this.projects.set(project.id, project.name);
            if (!this.config.workspaceId && project.workspace_id) {
                this.config.workspaceId = project.workspace_id;
            }
        }
    }

    private loadTagCache() {
        this.tags = [];
        const tagNames = new Set<string>();
        for (const tag of this.config.tagCache || []) {
            if (tag.name) tagNames.add(tag.name);
            if (!this.config.workspaceId && tag.workspace_id) {
                this.config.workspaceId = tag.workspace_id;
            }
        }
        this.tags = Array.from(tagNames).sort((a, b) => a.localeCompare(b));
    }

    private async loadProjects() {
        const workspaceId = await this.ensureWorkspaceId();
        if (!workspaceId) return;

        const res = await togglApi.getWorkspaceProjects(workspaceId);
        if (!res.ok || !res.data) {
            showMessage(this.formatApiError("刷新 Toggl 项目列表失败", res), 5000, "error");
            return;
        }

        this.projects.clear();
        this.config.projectCache = res.data
            .filter((p) => p.active !== false)
            .map((p) => ({
                id: p.id,
                name: p.name,
                workspace_id: p.workspace_id || workspaceId,
            }));
        for (const p of this.config.projectCache) {
            this.projects.set(p.id, p.name);
        }
        this.config.projectsRefreshedAt = new Date().toISOString();
        await this.saveConfig();
        await this.syncFieldOptions(["项目", "Project"], Array.from(this.projects.values()));
        showMessage(`已刷新 Toggl 项目列表: ${this.projects.size} 个${this.formatQuotaText(res)}`, 3000, "info");
    }

    private async loadTags() {
        const workspaceId = await this.ensureWorkspaceId();
        if (!workspaceId) return;

        const res = await togglApi.getTags();
        if (!res.ok || !res.data) {
            showMessage(this.formatApiError("刷新 Toggl 标签列表失败", res), 5000, "error");
            return;
        }

        this.config.tagCache = res.data
            .filter((tag: Tag) => tag.name)
            .map((tag: Tag) => ({
                id: tag.id,
                name: tag.name,
                workspace_id: tag.workspace_id || workspaceId,
            }));
        this.loadTagCache();
        this.config.tagsRefreshedAt = new Date().toISOString();
        await this.saveConfig();
        await this.syncFieldOptions(["标签", "Tags", "Tag"], this.tags);
        showMessage(`已刷新 Toggl 标签列表: ${this.tags.length} 个${this.formatQuotaText(res)}`, 3000, "info");
    }

    private isCacheFresh(ts?: string, maxAgeMs = 10 * 60 * 1000): boolean {
        if (!ts) return false;
        const t = new Date(ts).getTime();
        return Number.isFinite(t) && Date.now() - t < maxAgeMs;
    }

    private refreshProjects(force = false): Promise<void> {
        if (!this.config.token) return Promise.resolve();
        if (!force && this.projects.size > 0 && this.isCacheFresh(this.config.projectsRefreshedAt)) {
            return Promise.resolve();
        }
        if (!force && this.projectsLoadPromise) return this.projectsLoadPromise;

        this.projectsLoadPromise = this.loadProjects().then(() => {
            this.projectsLoadPromise = null;
        }, () => {
            this.projectsLoadPromise = null;
        });
        return this.projectsLoadPromise;
    }

    private refreshTags(force = false): Promise<void> {
        if (!this.config.token) return Promise.resolve();
        if (!force && this.tags.length > 0 && this.isCacheFresh(this.config.tagsRefreshedAt)) {
            return Promise.resolve();
        }
        if (!force && this.tagsLoadPromise) return this.tagsLoadPromise;

        this.tagsLoadPromise = this.loadTags().then(() => {
            this.tagsLoadPromise = null;
        }, () => {
            this.tagsLoadPromise = null;
        });
        return this.tagsLoadPromise;
    }

    private isDeletedTimeEntry(entry: TimeEntry): boolean {
        return Boolean(entry.server_deleted_at || entry.deleted_at || entry.deleted);
    }

    private buildRepairRangeParams(): {start_date?: string; end_date?: string;} {
        const days = this.normalizeInitialDays(this.config.initialDays);
        const end = new Date();
        const start = new Date();
        start.setTime(end.getTime() - days * 24 * 60 * 60 * 1000);
        return {
            start_date: start.toISOString(),
            end_date: end.toISOString(),
        };
    }

    private async pushLocalChanges(
        database: TargetDatabase,
        localRows: LocalDatabaseRow[],
    ): Promise<LocalUploadResult> {
        const result: LocalUploadResult = {created: 0, updated: 0, deleted: 0, failed: 0};
        const workspaceId = await this.ensureWorkspaceId();
        if (!workspaceId) return result;

        for (const row of localRows) {
            if (row.syncStatus === "本地可删除" || row.syncStatus === "失败") continue;
            if (!row.togglId && !this.isMeaningfulLocalRow(row)) continue;

            if (!row.togglId) {
                if (row.syncStatus !== "本地待上传") continue;
                const input = this.buildCreateInputFromLocalRow(row, workspaceId);
                if (!input) {
                    await this.writeSyncStatus(database, row.rowId, "失败");
                    result.failed++;
                    continue;
                }
                const response = await togglApi.createTimeEntry(workspaceId, input);
                if (!response.ok) {
                    await this.writeSyncStatus(database, row.rowId, "失败");
                    showMessage(this.formatApiError("上传本地条目失败", response), 5000, "error");
                    result.failed++;
                    continue;
                }
                await this.writeTogglId(database, row.rowId, response.data.id);
                await this.writeSyncStatus(database, row.rowId, "正常");
                result.created++;
                continue;
            }

            if (row.syncStatus === "Toggl 待更新" || row.syncStatus === "未同步") {
                const input = this.buildUpdateInputFromLocalRow(row, workspaceId);
                if (!input) {
                    await this.writeSyncStatus(database, row.rowId, "失败");
                    result.failed++;
                    continue;
                }
                const response = await togglApi.updateTimeEntry(workspaceId, row.togglId, input);
                if (!response.ok) {
                    await this.writeSyncStatus(database, row.rowId, "失败");
                    showMessage(this.formatApiError("更新 Toggl 条目失败", response), 5000, "error");
                    result.failed++;
                    continue;
                }
                await this.writeTogglRow(database, row.rowId, this.toDatabaseRow(response.data, "正常"));
                result.updated++;
            } else if (row.syncStatus === "Toggl 待删除") {
                const response = await togglApi.deleteTimeEntry(workspaceId, row.togglId);
                if (!response.ok && response.status !== 404) {
                    await this.writeSyncStatus(database, row.rowId, "失败");
                    showMessage(this.formatApiError("删除 Toggl 条目失败", response), 5000, "error");
                    result.failed++;
                    continue;
                }
                await this.writeSyncStatus(database, row.rowId, "本地可删除");
                result.deleted++;
            }
        }

        return result;
    }

    private async applyRemoteEntries(
        database: TargetDatabase,
        entries: TimeEntry[],
        localRows: LocalDatabaseRow[],
    ): Promise<RemoteApplyResult> {
        const result: RemoteApplyResult = {added: 0, updated: 0, markedDeleted: 0, skippedPending: 0};
        const rowsByTogglId = new Map<number, LocalDatabaseRow>();
        for (const row of localRows) {
            if (row.togglId && row.syncStatus !== "本地可删除") rowsByTogglId.set(row.togglId, row);
        }

        for (const entry of entries) {
            const local = rowsByTogglId.get(entry.id);
            if (this.isDeletedTimeEntry(entry)) {
                if (local && local.syncStatus !== "本地可删除") {
                    await this.writeSyncStatus(database, local.rowId, "本地可删除");
                    result.markedDeleted++;
                }
                continue;
            }

            if (local) {
                if (local.syncStatus === "Toggl 待更新" || local.syncStatus === "Toggl 待删除" || local.syncStatus === "失败") {
                    result.skippedPending++;
                    continue;
                }
                await this.writeTogglRow(database, local.rowId, this.toDatabaseRow(entry, "正常"));
                result.updated++;
            } else {
                await this.addEntries([entry], database);
                result.added++;
            }
        }

        return result;
    }

    private async markMissingRowsInRepairRange(
        database: TargetDatabase,
        localRows: LocalDatabaseRow[],
        remoteEntries: TimeEntry[],
    ): Promise<number> {
        const remoteIds = new Set(
            remoteEntries.filter((entry) => !this.isDeletedTimeEntry(entry)).map((entry) => entry.id),
        );
        const rangeStart = new Date(
            Date.now() - this.normalizeInitialDays(this.config.initialDays) * 24 * 60 * 60 * 1000,
        );

        let count = 0;
        for (const row of localRows) {
            if (!row.togglId || row.syncStatus === "本地可删除") continue;
            if (row.syncStatus === "Toggl 待更新" || row.syncStatus === "Toggl 待删除") continue;
            if (row.start && row.start < rangeStart) continue;
            if (!remoteIds.has(row.togglId)) {
                await this.writeSyncStatus(database, row.rowId, "本地可删除");
                count++;
            }
        }
        return count;
    }

    private buildCreateInputFromLocalRow(row: LocalDatabaseRow, workspaceId: number): CreateTimeEntryInput | null {
        if (!row.start) return null;
        const stop = row.stop ?? null;
        // Toggl 要求 stop - start (秒) === duration，用 stop 反算保证一致
        const duration = stop
            ? Math.round((stop.getTime() - row.start.getTime()) / 1000)
            : (row.durationSeconds > 0 ? row.durationSeconds : -1);
        const input: CreateTimeEntryInput = {
            workspace_id: workspaceId,
            description: row.description || "无描述",
            start: row.start.toISOString(),
            stop: stop ? stop.toISOString() : undefined,
            duration: duration > 0 ? duration : -1,
            created_with: "siyuan-toggl-sync",
        };
        const projectId = this.findProjectIdByName(row.projectName);
        if (projectId !== undefined) {
            input.project_id = projectId;
        }
        if (row.tagNames.length > 0) {
            input.tags = row.tagNames;
            input.tag_action = "add";
        }
        return input;
    }

    private buildUpdateInputFromLocalRow(row: LocalDatabaseRow, workspaceId: number): UpdateTimeEntryInput | null {
        if (!row.start) return null;
        const stop = row.stop ?? null;
        const duration = stop
            ? Math.round((stop.getTime() - row.start.getTime()) / 1000)
            : (row.durationSeconds > 0 ? row.durationSeconds : -1);
        const input: UpdateTimeEntryInput = {
            workspace_id: workspaceId,
            description: row.description || "无描述",
            start: row.start.toISOString(),
            stop: stop ? stop.toISOString() : null,
            duration: duration > 0 ? duration : -1,
        };
        const projectId = this.findProjectIdByName(row.projectName);
        if (projectId !== undefined) {
            input.project_id = projectId;
        }
        if (row.tagNames.length > 0) {
            input.tags = row.tagNames;
            input.tag_action = "add";
        }
        return input;
    }

    private resolveDurationSeconds(row: LocalDatabaseRow): number {
        if (row.durationSeconds > 0) return row.durationSeconds;
        if (row.start && row.stop) return Math.max(0, Math.round((row.stop.getTime() - row.start.getTime()) / 1000));
        return 0;
    }

    private findProjectIdByName(name: string): number | undefined {
        const normalized = name.trim();
        if (!normalized) return undefined;
        for (const [id, projectName] of this.projects.entries()) {
            if (projectName === normalized) return id;
        }
        const numeric = Number(normalized);
        return Number.isFinite(numeric) ? numeric : undefined;
    }

    private toDatabaseRow(entry: TimeEntry, syncStatus: SyncStatus = "正常"): TogglDatabaseRow {
        const projectName = (entry.project_id != null && entry.project_id !== undefined) ?
            this.projects.get(entry.project_id) || `${entry.project_id}` :
            "";
        return {
            id: entry.id,
            description: entry.description || "无描述",
            projectName,
            tagNames: entry.tags || [],
            start: new Date(entry.start),
            stop: entry.stop ? new Date(entry.stop) : null,
            durationSeconds: Math.max(0, entry.duration),
            billable: entry.billable,
            syncStatus,
        };
    }

    private async ensureWorkspaceId(): Promise<number | null> {
        if (this.config.workspaceId) return this.config.workspaceId;
        if (this.workspaceIdPromise) return this.workspaceIdPromise;
        this.workspaceIdPromise = this._doEnsureWorkspaceId();
        const result = await this.workspaceIdPromise;
        this.workspaceIdPromise = null;
        return result;
    }

    private async _doEnsureWorkspaceId(): Promise<number | null> {
        const response = await togglApi.getMe();
        if (!response.ok || !response.data?.default_workspace_id) {
            showMessage(
                `获取 Toggl 工作区失败: HTTP ${response.status}${response.error ? ` (${response.error})` : ""}`,
                5000,
                "error",
            );
            return null;
        }

        this.config.workspaceId = response.data.default_workspace_id;
        await this.saveConfig();
        return this.config.workspaceId;
    }

    private renderProjectOptions(selectedAttr?: string): string {
        let html = `<option value="">无项目</option>`;
        this.projects.forEach((name, id) => {
            const sel = selectedAttr && `value="${id}"` === selectedAttr ? "selected" : "";
            html += `<option value="${id}" ${sel}>${this.escapeHtml(name)}</option>`;
        });
        return html;
    }

    private renderTagOptions(): string {
        return this.tags.map((tag) => `<option value="${this.escapeHtml(tag)}"></option>`).join("");
    }

    private async refreshProjectSelect(button: HTMLButtonElement, select: HTMLSelectElement): Promise<void> {
        const previousValue = select.value;
        const previousText = button.textContent || "刷新";
        button.disabled = true;
        button.textContent = "...";
        try {
            await this.refreshProjects(true);
            select.innerHTML = this.renderProjectOptions();
            if (previousValue) {
                select.value = previousValue;
            }
        } finally {
            button.disabled = false;
            button.textContent = previousText;
        }
    }

    private async refreshTagDatalist(button: HTMLButtonElement, datalist: HTMLDataListElement): Promise<void> {
        const previousText = button.textContent || "刷新";
        button.disabled = true;
        button.textContent = "...";
        try {
            await this.refreshTags(true);
            datalist.innerHTML = this.renderTagOptions();
        } finally {
            button.disabled = false;
            button.textContent = previousText;
        }
    }

    private parseTags(value: string): string[] {
        const tags = value.split(/[,，]/)
            .map((tag) => tag.trim())
            .filter((tag) => tag.length > 0);
        const unique = new Set<string>();
        for (const tag of tags) {
            unique.add(tag);
        }
        const result: string[] = [];
        unique.forEach((tag) => result.push(tag));
        return result;
    }

    private toDateTimeInputValue(date: Date): string {
        return [
            date.getFullYear(),
            "-",
            this.leftPad(date.getMonth() + 1, 2),
            "-",
            this.leftPad(date.getDate(), 2),
            "T",
            this.leftPad(date.getHours(), 2),
            ":",
            this.leftPad(date.getMinutes(), 2),
        ].join("");
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    private normalizeStatusBarText(value: string | undefined): string {
        return (value || "").trim() || "Toggl";
    }

    private normalizeInitialDays(value: number): number {
        if (value === 7 || value === 30 || value === 90) return value;
        if (value > 0 && value <= 7) return 7;
        if (value > 7 && value <= 30) return 30;
        return 90;
    }

    // 添加时间条目
    private async addEntries(entries: TimeEntry[], database?: TargetDatabase) {
        const targetDatabase = database ?? await this.getTargetDatabase();
        if (!targetDatabase) {
            return;
        }

        for (const entry of entries) {
            const rowId = await this.insertDatabaseRow(targetDatabase.avId);
            if (!rowId) {
                console.error("[TogglSync] Failed to insert database row for entry:", entry.id);
                continue;
            }

            await this.writeTogglRow(targetDatabase, rowId, this.toDatabaseRow(entry, "正常"));
        }
    }

    private async cleanupLocalDeletableRows() {
        if (!this.config.targetDocId) {
            showMessage("请先配置目标文档 ID", 4000, "error");
            return;
        }

        const database = await this.getTargetDatabase();
        if (!database) {
            return;
        }

        const rows = await this.readLocalDatabaseRows(database);
        const deletableRows = rows.filter((row) => row.syncStatus === "本地可删除");
        if (deletableRows.length === 0) {
            showMessage("没有本地可删除项", 2500, "info");
            return;
        }

        const confirmOk = await new Promise<boolean>((resolve) => {
            confirm(
                `确定清理 ${deletableRows.length} 条本地可删除项？此操作不可撤销。`,
                "清理本地可删除项",
                () => resolve(true),
                () => resolve(false),
            );
        });
        if (!confirmOk) return;

        const txResult = await this.requestTransaction([{
            action: "removeAttrViewBlock",
            avID: database.avId,
            srcIDs: deletableRows.map((row) => row.rowId),
            removeDest: true,
        }]);
        if (!txResult || txResult.code !== 0) {
            console.error("[TogglSync] removeAttrViewBlock failed:", JSON.stringify(txResult));
            showMessage("清理本地可删除项失败，请查看控制台日志", 5000, "error");
            return;
        }
        showMessage(`已清理 ${deletableRows.length} 条本地可删除项`, 3000, "info");
    }

    private async getRenderedRowIds(avId: string): Promise<string[]> {
        const result = await this.renderDatabase(avId);
        if (result.code !== 0) return [];
        return this.extractRenderedRowIds(result.data);
    }

    private async renderDatabase(avId: string): Promise<any> {
        return fetchSyncPost("/api/av/renderAttributeView", {
            id: avId,
            viewID: "",
            query: "",
            page: 1,
            pageSize: -1,
        });
    }

    private extractRows(data: any): any[] {
        if (Array.isArray(data?.rows)) return data.rows;
        if (Array.isArray(data?.view?.rows)) return data.view.rows;
        if (Array.isArray(data?.attributeView?.rows)) return data.attributeView.rows;
        return [];
    }

    private extractRenderedRowIds(data: any): string[] {
        return this.extractRows(data).map((row) => row?.key?.id ?? row?.id ?? row?.blockID).filter(Boolean);
    }

    private normalizeAttributeViewKeys(data: any): AttributeViewKey[] {
        const candidates = [
            data,
            data?.keys,
            data?.keyValues,
            data?.av?.keyValues,
            data?.attributeView?.keyValues,
            data?.view?.columns,
            data?.columns,
        ];
        const keys = candidates.find((item) => Array.isArray(item)) ?? [];
        return keys
            .map((key: any) => ({
                id: key.id ?? key.keyID,
                name: key.name ?? key.keyName ?? key.title,
                type: key.type ?? key.valueType ?? "text",
                options: key.options,
            }))
            .filter((key: AttributeViewKey) => key.id && key.name);
    }

    private extractAvId(block: any): string | null {
        const avId = block?.AttributeViewID ?? block?.attributeViewID ?? block?.avID ?? block?.avId;
        if (avId) return String(avId);
        const markdown = block?.markdown ?? block?.content ?? block?.data ?? "";
        return this.extractAvIdsFromText(markdown)[0] ?? null;
    }

    private extractAvIdsFromText(text: string): string[] {
        return [...String(text || "").matchAll(/data-av-id=["']([^"']+)["']/g)]
            .map((match) => match[1])
            .filter(Boolean);
    }

    private extractAvIdFromBlockApiResponse(result: any): string | null {
        const operations = Array.isArray(result?.data) ?
            result.data.flatMap((item: any) => item?.doOperations ?? []) :
            [];
        for (const operation of operations) {
            const avId = this.extractAvId(operation) ?? this.extractAvId({markdown: operation?.data});
            if (avId) return avId;
        }
        return null;
    }

    private findKey(keys: AttributeViewKey[], aliases: string[]): AttributeViewKey | null {
        const normalizedAliases = aliases.map((alias) => this.normalizeKeyName(alias));
        return keys.find((key) => normalizedAliases.indexOf(this.normalizeKeyName(key.name)) !== -1) ?? null;
    }

    private findPrimaryTextKey(keys: AttributeViewKey[]): AttributeViewKey | null {
        return keys.find((key) => key.type === "block") ?? keys.find((key) => key.type === "text") ?? null;
    }

    private buildCellValue(key: AttributeViewKey, rowId: string, input: DatabaseCellInput | string[]): any | null {
        const value: any = {
            id: this.createSiyuanId(),
            keyID: key.id,
            blockID: rowId,
            type: key.type,
        };

        if (key.type === "number") {
            const number = Number(input);
            if (!Number.isFinite(number)) return null;
            value.number = {content: number, isNotEmpty: true};
        } else if (key.type === "date" || key.type === "created" || key.type === "updated") {
            const date = input instanceof Date ? input : new Date(String(input));
            if (!Number.isFinite(date.getTime())) return null;
            value[key.type] = {content: date.getTime(), isNotEmpty: true, isNotTime: false};
        } else if (key.type === "checkbox") {
            value.checkbox = {checked: Boolean(input)};
        } else if (key.type === "mSelect" || key.type === "select") {
            const values = Array.isArray(input) ? input : [String(input)];
            if (key.type === "select") {
                value.mSelect = values.filter(Boolean).slice(0, 1).map((content) => ({content, color: ""}));
            } else {
                value.mSelect = values.filter(Boolean).map((content) => ({content, color: ""}));
            }
        } else if (key.type === "block") {
            value.block = {content: String(input)};
        } else if (["url", "email", "phone", "template"].indexOf(key.type) !== -1) {
            value[key.type] = {content: String(input)};
        } else {
            value.type = "text";
            value.text = {content: Array.isArray(input) ? input.join(", ") : String(input)};
        }

        return value;
    }

    private async readLocalDatabaseRows(database: TargetDatabase): Promise<LocalDatabaseRow[]> {
        const result = await this.renderDatabase(database.avId);
        if (result.code !== 0) return [];

        const rowIds = this.getDatabaseRowIds(result.data);
        const rowsById = new Map<string, LocalDatabaseRow>();
        for (const rowId of rowIds) {
            rowsById.set(rowId, {
                rowId,
                togglId: null,
                syncStatus: "",
                description: "",
                projectName: "",
                tagNames: [],
                start: null,
                stop: null,
                durationSeconds: 0,
                billable: false,
            });
        }

        const applyCell = (rowId: string, keyId: string, raw: any) => {
            let row = rowsById.get(rowId);
            if (!row) {
                row = {
                    rowId,
                    togglId: null,
                    syncStatus: "",
                    description: "",
                    projectName: "",
                    tagNames: [],
                    start: null,
                    stop: null,
                    durationSeconds: 0,
                    billable: false,
                };
                rowsById.set(rowId, row);
            }

            const key = database.keys.find((item) => item.id === keyId);
            if (!key) return;
            if (this.findKey([{...key, name: key.name}], ["TogglID", "Toggl ID", "Toggl Id", "toggl-id"])) {
                const id = this.cellToNumber(raw);
                row.togglId = Number.isFinite(id) && id > 0 ? id : null;
            } else if (
                this.findKey([{...key, name: key.name}], [
                    "描述",
                    "Description",
                    "标题",
                    "Title",
                    "名称",
                    "Name",
                    "任务",
                    "事项",
                ])
            ) {
                row.description = this.cellToText(raw);
            } else if (this.findKey([{...key, name: key.name}], ["项目", "Project"])) {
                row.projectName = this.cellToText(raw);
            } else if (this.findKey([{...key, name: key.name}], ["标签", "Tags", "Tag"])) {
                row.tagNames = this.cellToStringArray(raw);
            } else if (this.findKey([{...key, name: key.name}], ["开始", "开始时间", "Start", "Start Time"])) {
                row.start = this.cellToDate(raw);
            } else if (
                this.findKey([{...key, name: key.name}], ["结束", "结束时间", "End", "End Time", "Stop", "Stop Time"])
            ) {
                row.stop = this.cellToDate(raw);
            } else if (this.findKey([{...key, name: key.name}], ["时长", "Duration"])) {
                const duration = this.cellToNumber(raw);
                row.durationSeconds = Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0;
            } else if (this.findKey([{...key, name: key.name}], ["计费", "可计费", "Billable"])) {
                row.billable = this.cellToBoolean(raw);
            } else if (this.findKey([{...key, name: key.name}], ["同步状态", "Sync Status"])) {
                row.syncStatus = this.normalizeSyncStatus(this.cellToText(raw));
            }
        };

        for (const keyValue of this.extractKeyValues(result.data)) {
            const keyId = keyValue?.key?.id ?? keyValue?.id ?? keyValue?.keyID;
            const values = keyValue?.values;
            if (!keyId || !Array.isArray(values)) continue;
            for (const value of values) {
                const rowId = value?.blockID ?? value?.value?.blockID;
                if (rowId) applyCell(rowId, keyId, value?.value ?? value);
            }
        }

        for (const row of this.extractRows(result.data)) {
            const rowId = row?.key?.id ?? row?.id ?? row?.blockID;
            if (!rowId) continue;
            const cells = row?.cells ?? row?.values ?? [];
            for (const cell of cells) {
                const raw = cell?.value ?? cell;
                const keyId = cell?.keyID ?? raw?.keyID;
                if (keyId) applyCell(rowId, keyId, raw);
            }
        }

        const rows = Array.from(rowsById.values());
        for (const row of rows) {
            if (!row.syncStatus) {
                row.syncStatus = row.togglId ? "正常" : "未同步";
            }
        }
        return rows;
    }

    private async backfillSyncStatus(database: TargetDatabase, rows: LocalDatabaseRow[]): Promise<void> {
        for (const row of rows) {
            if (!row.syncStatus && !row.togglId && (row.description || row.start)) {
                await this.writeSyncStatus(database, row.rowId, "未同步");
            }
        }
    }

    // 检测重复的 TogglID：保留最佳行，其余标记为「本地可删除」避免成为永久孤儿
    private async detectDuplicateTogglIds(database: TargetDatabase, rows: LocalDatabaseRow[]): Promise<number> {
        const byId = new Map<number, LocalDatabaseRow[]>();
        for (const row of rows) {
            if (!row.togglId) continue;
            const arr = byId.get(row.togglId) ?? [];
            arr.push(row);
            byId.set(row.togglId, arr);
        }

        let marked = 0;
        for (const group of byId.values()) {
            if (group.length < 2) continue;
            // 保留最佳行：优先「正常」，其次有完整数据，再次第一条
            let keepIdx = group.findIndex((r) => r.syncStatus === "正常");
            if (keepIdx === -1) keepIdx = group.findIndex((r) => this.isMeaningfulLocalRow(r));
            if (keepIdx === -1) keepIdx = 0;
            for (let i = 0; i < group.length; i++) {
                if (i === keepIdx) continue;
                const dup = group[i];
                if (dup.syncStatus === "本地可删除") continue;
                await this.writeSyncStatus(database, dup.rowId, "本地可删除");
                dup.syncStatus = "本地可删除";
                marked++;
            }
        }
        return marked;
    }

    private isMeaningfulLocalRow(row: LocalDatabaseRow): boolean {
        return Boolean(
            row.description || row.projectName || row.tagNames.length > 0 || row.start || row.stop ||
                row.durationSeconds > 0,
        );
    }

    private getDatabaseRowIds(data: any): string[] {
        const ids = new Set<string>();
        for (const id of data?.view?.itemIds ?? data?.itemIds ?? data?.attributeView?.itemIds ?? []) {
            if (id) ids.add(id);
        }
        for (const view of data?.views ?? data?.attributeView?.views ?? []) {
            for (const id of view?.itemIds ?? []) {
                if (id) ids.add(id);
            }
        }
        for (const row of this.extractRows(data)) {
            const id = row?.key?.id ?? row?.id ?? row?.blockID;
            if (id) ids.add(id);
        }
        for (const keyValue of this.extractKeyValues(data)) {
            for (const value of keyValue?.values ?? []) {
                const id = value?.blockID ?? value?.value?.blockID;
                if (id) ids.add(id);
            }
        }
        return Array.from(ids);
    }

    private extractKeyValues(data: any): any[] {
        const candidates = [
            data?.keyValues,
            data?.av?.keyValues,
            data?.attributeView?.keyValues,
            data?.view?.keyValues,
        ];
        return candidates.find((item) => Array.isArray(item)) ?? [];
    }

    private normalizeSyncStatus(value: string): SyncStatus | "" {
        const normalized = value.trim();
        return (SYNC_STATUS_OPTIONS as string[]).indexOf(normalized) !== -1 ? normalized as SyncStatus : "";
    }

    private cellToText(raw: any): string {
        const value = raw?.value ?? raw;
        return String(
            value?.text?.content ??
                value?.block?.content ??
                value?.url?.content ??
                value?.phone?.content ??
                value?.email?.content ??
                value?.template?.content ??
                value?.mSelect?.[0]?.content ??
                value?.number?.content ??
                "",
        ).trim();
    }

    private cellToStringArray(raw: any): string[] {
        const value = raw?.value ?? raw;
        if (Array.isArray(value?.mSelect)) {
            return value.mSelect.map((item: any) => String(item?.content ?? "").trim()).filter(Boolean);
        }
        return this.parseTags(this.cellToText(value));
    }

    private cellToNumber(raw: any): number {
        const value = raw?.value ?? raw;
        const number = Number(value?.number?.content ?? this.cellToText(value));
        return Number.isFinite(number) ? number : NaN;
    }

    private cellToBoolean(raw: any): boolean {
        const value = raw?.value ?? raw;
        return Boolean(value?.checkbox?.checked);
    }

    private cellToDate(raw: any): Date | null {
        const value = raw?.value ?? raw;
        const content = value?.date?.content ?? value?.created?.content ?? value?.updated?.content;
        if (Number.isFinite(content)) {
            const date = new Date(content);
            return Number.isFinite(date.getTime()) ? date : null;
        }
        const text = this.cellToText(value);
        if (!text) return null;
        const date = new Date(text);
        return Number.isFinite(date.getTime()) ? date : null;
    }

    private isEmptyCellInput(input: DatabaseCellInput | string[]): boolean {
        return input === null || input === undefined || (typeof input === "string" && input.length === 0) ||
            (Array.isArray(input) && input.length === 0);
    }

    private async requestTransaction(doOperations: any[]): Promise<any> {
        let session = "";
        let app = "";
        try {
            const wsUrl = window.siyuan?.ws?.ws?.url;
            if (wsUrl) {
                const parsed = new URL(wsUrl);
                const params = new URLSearchParams(parsed.search);
                session = params.get("id") || "";
                app = params.get("app") || "";
            }
        } catch {
            // ws 未就绪时降级
        }
        return fetchSyncPost("/api/transactions", {
            session,
            app,
            transactions: [{doOperations, undoOperations: []}],
            reqId: Date.now(),
        });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    private createSiyuanId(): string {
        const now = new Date();
        const timestamp = [
            now.getFullYear(),
            this.leftPad(now.getMonth() + 1, 2),
            this.leftPad(now.getDate(), 2),
            this.leftPad(now.getHours(), 2),
            this.leftPad(now.getMinutes(), 2),
            this.leftPad(now.getSeconds(), 2),
        ].join("");
        const random = String(Math.floor(Math.random() * 10000000)).padStart(7, "0");
        return `${timestamp}-${random}`;
    }

    private normalizeKeyName(name: string): string {
        return name.replace(/[\s_-]+/g, "").toLowerCase();
    }

    private escapeSql(value: string): string {
        return value.replace(/'/g, "''");
    }

    private formatUnknownError(error: unknown): string {
        if (error instanceof Error && error.message) return error.message;
        if (typeof error === "string") return error;
        try {
            return JSON.stringify(error);
        } catch {
            return "未知错误";
        }
    }

    private leftPad(value: number, length: number): string {
        let result = String(value);
        while (result.length < length) result = `0${result}`;
        return result;
    }

    private formatDuration(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${h}:${this.leftPad(m, 2)}:${this.leftPad(s, 2)}`;
    }

    private async sql(stmt: string): Promise<any[]> {
        const result = await fetchSyncPost("/api/query/sql", {stmt});
        return result.code === 0 ? result.data : [];
    }

    // ==================== 状态栏计时器 ====================

    private lastEntryStart = "";
    private lastEntryDescription = "";

    private async startStatusBarTimer(refreshRemote = false) {
        this.stopStatusBarTimer();
        if (!this.statusBarEl) {
            this.statusBarEl = document.createElement("div");
            this.statusBarEl.className = "toggl-sync__status-bar";
            this.statusBarEl.title = "Toggl Sync";
            this.statusBarEl.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.showSyncMenu({x: event.clientX, y: event.clientY});
            });
            this.addStatusBar({element: this.statusBarEl});
        }
        this.renderIdleState();
        if (this.config.currentTimer) {
            this.applyCurrentTimerState(this.config.currentTimer);
        } else {
            await this.clearCurrentTimer(false);
        }
        this.timerInterval = setInterval(() => {
            if (this.lastEntryStart) {
                const elapsed = Math.floor((Date.now() - new Date(this.lastEntryStart).getTime()) / 1000);
                this.renderTimer(elapsed);
            }
        }, 1000);
        if (refreshRemote) {
            await this.refreshCurrentTimer(true);
        }
    }

    private stopStatusBarTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    private renderTimer(elapsed: number) {
        if (!this.statusBarEl) return;
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = elapsed % 60;
        const time = `${h}:${this.leftPad(m, 2)}:${this.leftPad(s, 2)}`;
        const desc = this.escapeHtml(this.lastEntryDescription || "...");
        const badge = this.renderPendingBadge();
        this.statusBarEl.innerHTML =
            `<span class="toggl-sync__status-bar-dot toggl-sync__status-bar-dot--running"></span>` +
            `<span class="toggl-sync__status-bar-desc" title="${desc}">${desc}</span>` +
            `<span class="toggl-sync__status-bar-time">${time}</span>` +
            badge;
    }

    private renderIdleState() {
        if (!this.statusBarEl) return;
        const text = this.escapeHtml(this.normalizeStatusBarText(this.config.statusBarText));
        const badge = this.renderPendingBadge();
        this.statusBarEl.innerHTML = `<span class="toggl-sync__status-bar-dot"></span>` +
            `<span class="toggl-sync__status-bar-time">${text}</span>` +
            badge;
    }

    private renderPendingBadge(): string {
        const count = this.config.pendingOps.length;
        if (count === 0) return "";
        return `<span class="toggl-sync__status-bar-badge" title="${count} 条待处理操作">${count}</span>`;
    }

    private async updateCurrentTimerFromEntry(entry: TimeEntry, userProjectId?: number, userTags?: string[]) {
        const prevTimer = this.config.currentTimer;
        this.lastEntryId = entry.id;
        this.lastEntryDescription = entry.description || "";
        this.lastEntryStart = entry.start;
        this.config.currentTimer = {
            id: entry.id,
            workspaceId: entry.workspace_id,
            description: entry.description || "",
            start: entry.start,
            projectId: userProjectId,
            tags: userTags,
            localRowId: prevTimer?.localRowId,
            databaseAvId: prevTimer?.databaseAvId,
        };
        if (!this.config.workspaceId && entry.workspace_id) {
            this.config.workspaceId = entry.workspace_id;
        }
        await this.saveConfig();
        if (this.statusBarEl) {
            const elapsed = Math.floor((Date.now() - new Date(entry.start).getTime()) / 1000);
            this.renderTimer(Math.max(0, elapsed));
        }
    }

    private async clearCurrentTimer(save = true) {
        this.lastEntryId = null;
        this.lastEntryStart = "";
        this.lastEntryDescription = "";
        this.config.currentTimer = null;
        this.renderIdleState();
        if (save) {
            await this.saveConfig();
        }
    }

    private loadCurrentTimerState() {
        if (!this.config.currentTimer) return;
        this.applyCurrentTimerState(this.config.currentTimer);
    }

    private applyCurrentTimerState(timer: CurrentTimerState) {
        this.lastEntryId = timer.id;
        this.lastEntryDescription = timer.description || "";
        this.lastEntryStart = timer.start;
        if (this.statusBarEl) {
            const elapsed = Math.floor((Date.now() - new Date(timer.start).getTime()) / 1000);
            this.renderTimer(Math.max(0, elapsed));
        }
    }

    private async refreshCurrentTimer(silent = false) {
        if (this.config.apiEnabled === false) return;
        if (!this.config.token) {
            if (!silent) showMessage("请先配置 Toggl API Token", 4000, "error");
            return;
        }
        const res = await togglApi.getCurrentTimeEntry();
        // forwardProxy 可能将 null body 转为 {}，所以额外检查 id 字段
        const hasData = res.ok && res.data && (res.data as any).id;
        if (hasData) {
            await this.updateCurrentTimerFromEntry(res.data as TimeEntry);
            if (!silent) showMessage(`已刷新当前 Toggl 计时${this.formatQuotaText(res)}`, 3000, "info");
        } else if (res.ok) {
            // 云端无运行计时器，但本地还在跑：自动纠正状态栏
            // 数据库行由 syncEntries 负责用 Toggl 实际数据更新（停止时间以云端为准）
            if (this.config.currentTimer) {
                await this.clearCurrentTimer();
                if (!silent) showMessage("云端计时已停止，本地已同步", 3000, "info");
            } else {
                if (!silent) showMessage(`当前没有正在运行的 Toggl 计时${this.formatQuotaText(res)}`, 3000, "info");
            }
        } else {
            if (!silent) showMessage(this.formatApiError("刷新当前 Toggl 计时失败", res), 5000, "error");
        }
    }

    private setupAutoSync() {
        this.stopAutoSync();
        if (!this.config.token || !this.config.targetDocId || this.config.autoSyncMinutes <= 0) return;
        this.autoSyncInterval = setInterval(() => {
            void this.syncEntries("auto");
            if (this.config.statusBarTimer) {
                void this.refreshCurrentTimer(true);
            }
        }, this.config.autoSyncMinutes * 60 * 1000);
    }

    private stopAutoSync() {
        if (this.autoSyncInterval) {
            clearInterval(this.autoSyncInterval);
            this.autoSyncInterval = null;
        }
    }

    private formatQuotaText(response: {quotaRemaining?: number; quotaResetsIn?: number;}): string {
        if (response.quotaRemaining === undefined) return "";
        const resetText = response.quotaResetsIn !== undefined ? `，${response.quotaResetsIn} 秒后重置` : "";
        return `（剩余 ${response.quotaRemaining}${resetText}）`;
    }

    private formatApiError(
        prefix: string,
        response: {status: number; quotaRemaining?: number; quotaResetsIn?: number; error?: string;},
    ): string {
        if (response.status === 402) {
            return `${prefix}: Toggl API 额度已用完${this.formatQuotaText(response)}`;
        }
        if (response.status === 429) {
            return `${prefix}: 请求过快，请稍后再试${this.formatQuotaText(response)}`;
        }
        if (response.error) {
            return `${prefix}: HTTP ${response.status} ${response.error}`;
        }
        return `${prefix}: HTTP ${response.status}`;
    }
}

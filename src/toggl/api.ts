import type {
    User,
    Project,
    Tag,
    TimeEntry,
    CreateTimeEntryInput,
    UpdateTimeEntryInput,
} from "./types";
import {fetchSyncPost} from "siyuan";

const BASE_URL = "https://api.track.toggl.com/api/v9";

interface ApiResponse<T> {
    ok: boolean;
    status: number;
    data: T;
    quotaRemaining?: number;
    quotaResetsIn?: number;
    error?: string;
}

let authToken = "";

export function setToken(token: string) {
    authToken = token;
}

// btoa polyfill for SiYuan kernel goja engine (no Web API)
function base64Encode(str: string): string {
    if (typeof btoa !== "undefined") return btoa(str);
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const bytes: number[] = [];
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code < 0x80) {
            bytes.push(code);
        } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else {
            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
    }
    let result = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b1 = bytes[i];
        const b2 = i + 1 < bytes.length ? bytes[i + 1] : NaN;
        const b3 = i + 2 < bytes.length ? bytes[i + 2] : NaN;
        result += chars[b1 >> 2];
        result += chars[((b1 & 0x03) << 4) | (isNaN(b2) ? 0 : (b2 >> 4))];
        result += isNaN(b2) ? "=" : chars[((b2 & 0x0f) << 2) | (isNaN(b3) ? 0 : (b3 >> 6))];
        result += isNaN(b3) ? "=" : chars[b3 & 0x3f];
    }
    return result;
}

function authHeader(): string {
    return `Basic ${base64Encode(authToken + ":api_token")}`;
}

// URLSearchParams polyfill for goja
function buildQueryString(obj: Record<string, any>): string {
    return Object.entries(obj)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
}

async function requestViaForwardProxy<T>(url: string, method: string, body?: any): Promise<ApiResponse<T>> {
    const authorization = authHeader();
    const proxyHeaders = [{Authorization: authorization}];
    if (method !== "GET" || !body) {
        proxyHeaders.push({"Content-Type": "application/json"});
    }

    const proxyBody: any = {
        url,
        method,
        timeout: 20000,
        headers: proxyHeaders,
    };

    if (method !== "GET" || body) {
        proxyBody.contentType = "application/json";
    }

    if (method === "GET" && body) {
        const params = buildQueryString(body);
        proxyBody.url = `${url}?${params}`;
    } else if (body) {
        proxyBody.payload = body;
        proxyBody.payloadEncoding = "json";
    }

    try {
        const result = await fetchSyncPost("/api/network/forwardProxy", proxyBody);
        if (!result || result.code !== 0) {
            const errMsg = result?.msg || "unknown error";
            console.warn("[TogglSync] forwardProxy failed:", errMsg, JSON.stringify(result));
            return {ok: false, status: 502, data: {} as T, error: `forwardProxy: ${errMsg}`};
        }

        const proxyData = result.data;
        const status = proxyData?.StatusCode ?? proxyData?.statusCode ?? proxyData?.status ?? 502;
        const ok = status >= 200 && status < 300;
        const rawBody = proxyData?.Body ?? proxyData?.body;

        let data: T;
        if (ok && rawBody) {
            data = typeof rawBody === "object" ? rawBody as T : (typeof rawBody === "string" ? JSON.parse(rawBody) : {} as T);
        } else {
            data = {} as T;
        }

        return {ok, status, data, error: ok ? undefined : (typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody || ""))};
    } catch (error) {
        console.warn("[TogglSync] forwardProxy error:", error);
        return {ok: false, status: 502, data: {} as T};
    }
}

async function request<T>(url: string, method: string = "GET", body?: any): Promise<ApiResponse<T>> {
    // Try browser-native fetch first (desktop mode)
    if (typeof fetch !== "undefined") {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Authorization: authHeader(),
        };

        let finalUrl = url;
        let reqBody: string | null = null;
        if (method === "GET" && body) {
            finalUrl += `?${buildQueryString(body)}`;
        } else if (body) {
            reqBody = JSON.stringify(body);
        }

        try {
            const response = await fetch(finalUrl, {method, headers, body: reqBody});
            const status = response.status || 0;
            const ok = status >= 200 && status < 300;
            const text = typeof response.text === "function" ? await response.text() : "";
            const data = ok && text ? JSON.parse(text) : ({} as T);
            return {ok, status, data, error: ok ? undefined : text};
        } catch (error) {
            console.warn("[TogglSync] fetch failed, falling back to forwardProxy:", error);
        }
    }

    // Fallback: use SiYuan kernel forwardProxy (serve mode / goja engine)
    console.log("[TogglSync] using forwardProxy for:", method, url.substring(0, 80));
    return requestViaForwardProxy<T>(url, method, body);
}

function parseOptionalNumber(value: string | null): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export async function getMe(): Promise<ApiResponse<User>> {
    return request<User>(`${BASE_URL}/me`);
}

export async function getProjects(): Promise<ApiResponse<Project[]>> {
    return request<Project[]>(`${BASE_URL}/me/projects`);
}

export async function getWorkspaceProjects(workspaceId: number): Promise<ApiResponse<Project[]>> {
    return request<Project[]>(`${BASE_URL}/workspaces/${workspaceId}/projects`);
}

export async function getTags(): Promise<ApiResponse<Tag[]>> {
    return request<Tag[]>(`${BASE_URL}/me/tags`);
}

export async function getTimeEntries(args?: {
    since?: number;
    start_date?: string;
    end_date?: string;
}): Promise<ApiResponse<TimeEntry[]>> {
    return request<TimeEntry[]>(`${BASE_URL}/me/time_entries`, "GET", args);
}

export async function getCurrentTimeEntry(): Promise<ApiResponse<TimeEntry | null>> {
    return request<TimeEntry | null>(`${BASE_URL}/me/time_entries/current`);
}

export async function createTimeEntry(
    workspaceId: number,
    entry: CreateTimeEntryInput,
): Promise<ApiResponse<TimeEntry>> {
    return request<TimeEntry>(`${BASE_URL}/workspaces/${workspaceId}/time_entries`, "POST", entry);
}

export async function stopTimeEntry(workspaceId: number, entryId: number): Promise<ApiResponse<TimeEntry>> {
    return request<TimeEntry>(`${BASE_URL}/workspaces/${workspaceId}/time_entries/${entryId}/stop`, "PATCH");
}

export async function updateTimeEntry(
    workspaceId: number,
    entryId: number,
    entry: UpdateTimeEntryInput,
): Promise<ApiResponse<TimeEntry>> {
    return request<TimeEntry>(`${BASE_URL}/workspaces/${workspaceId}/time_entries/${entryId}`, "PUT", entry);
}

export async function deleteTimeEntry(workspaceId: number, entryId: number): Promise<ApiResponse<{}>> {
    return request<{}>(`${BASE_URL}/workspaces/${workspaceId}/time_entries/${entryId}`, "DELETE");
}

// ==================== 诊断函数 ====================

interface DiagResult {
    label: string;
    ok: boolean;
    detail: string;
}

export async function runDiagnostics(): Promise<DiagResult[]> {
    const results: DiagResult[] = [];

    // 1. 引擎能力
    const envFetch = typeof fetch !== "undefined";
    const envBtoa = typeof btoa !== "undefined";
    results.push({
        label: "引擎能力",
        ok: true,
        detail: `fetch:${envFetch ? "有" : "无"} btoa:${envBtoa ? "有" : "无(polyfill)"}`,
    });

    // 2. 实际调用 fetch
    if (envFetch) {
        try {
            const r = await fetch("https://httpbin.org/get");
            results.push({
                label: "fetch→httpbin",
                ok: r.status === 200,
                detail: `HTTP ${r.status}${typeof r.text === "function" ? " (有text方法)" : " (无text方法)"}`,
            });
        } catch (e: any) {
            results.push({
                label: "fetch→httpbin",
                ok: false,
                detail: `❌ ${e?.message || e}`,
            });
        }
    }

    // 3. forwardProxy 原始数据结构
    try {
        const fp = await fetchSyncPost("/api/network/forwardProxy", {
            url: "https://httpbin.org/get",
            method: "GET",
            timeout: 10000,
            headers: [],
        });
        const raw = JSON.stringify(fp).substring(0, 200);
        const st = fp?.data?.StatusCode ?? fp?.data?.statusCode ?? fp?.data?.status;
        results.push({
            label: "forwardProxy 数据结构",
            ok: fp?.code === 0,
            detail: `code=${fp?.code} statusCode=${st ?? "?"} raw=${raw}`,
        });
    } catch (e: any) {
        results.push({label: "forwardProxy 数据结构", ok: false, detail: `❌ ${e?.message || e}`});
    }

    // 4. fetch 直连 Toggl
    if (envFetch && authToken) {
        try {
            const r = await fetch(`${BASE_URL}/me`, {headers: {Authorization: authHeader()}});
            results.push({
                label: "fetch→Toggl /me",
                ok: r.status === 200,
                detail: `HTTP ${r.status}`,
            });
        } catch (e: any) {
            results.push({label: "fetch→Toggl /me", ok: false, detail: `❌ ${e?.message || e}`});
        }
    }

    return results;
}

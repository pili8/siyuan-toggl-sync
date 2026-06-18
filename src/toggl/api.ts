import type {
    User,
    Project,
    Tag,
    TimeEntry,
    CreateTimeEntryInput,
    UpdateTimeEntryInput,
} from "./types";

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

function authHeader(): string {
    return `Basic ${btoa(authToken + ":api_token")}`;
}

async function request<T>(url: string, method: string = "GET", body?: any): Promise<ApiResponse<T>> {
    const opts: RequestInit = {
        method,
        headers: {
            "Content-Type": "application/json",
            Authorization: authHeader(),
        },
    };

    let finalUrl = url;
    if (method === "GET" && body) {
        const params = new URLSearchParams(body).toString();
        finalUrl += `?${params}`;
    } else if (body) {
        opts.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(finalUrl, opts);
        const ok = response.ok;
        const status = response.status;
        const quotaRemaining = parseOptionalNumber(response.headers.get("X-Toggl-Quota-Remaining"));
        const quotaResetsIn = parseOptionalNumber(response.headers.get("X-Toggl-Quota-Resets-In"));
        const text = await response.text();
        const data = ok && text ? JSON.parse(text) : ({} as T);
        return {
            ok,
            status,
            data,
            quotaRemaining,
            quotaResetsIn,
            error: ok ? undefined : text,
        };
    } catch (error) {
        console.warn("[TogglSync] Request error:", error);
        return {ok: false, status: 500, data: {} as T};
    }
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

export interface User {
    id: number;
    api_token: string;
    email: string;
    fullname: string;
    default_workspace_id: number;
    timezone: string;
}

export interface Project {
    id: number;
    name: string;
    active: boolean;
    workspace_id: number;
    color: string;
}

export interface Tag {
    id: number;
    name: string;
    workspace_id: number;
}

export interface TimeEntry {
    id: number;
    description?: string;
    duration: number;
    start: string;
    stop: string | null;
    project_id?: number;
    tag_ids?: number[];
    tags?: string[];
    user_id: number;
    workspace_id: number;
    billable: boolean;
    at: string;
    server_deleted_at?: string | null;
    deleted_at?: string | null;
    deleted?: boolean;
}

export interface CreateTimeEntryInput {
    workspace_id: number;
    description: string;
    start: string;
    duration: number;
    created_with: string;
    project_id?: number;
    tags?: string[];
    tag_action?: "add" | "delete";
    billable?: boolean;
    stop?: string;
}

export interface UpdateTimeEntryInput {
    workspace_id?: number;
    description?: string;
    start?: string;
    stop?: string | null;
    duration?: number;
    project_id?: number | null;
    tags?: string[];
    tag_action?: "add" | "delete";
    billable?: boolean;
}

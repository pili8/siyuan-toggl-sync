#!/usr/bin/env python3
"""
一次性应急脚本：停止 Toggl 上所有正在运行的计时器
用法：python3 stop_all_timers.py <你的Toggl_API_Token>
获取 Token: https://track.toggl.com/profile -> API Token
"""
import sys
import json
import base64
import urllib.request
import urllib.error

TOGGL_API = "https://api.track.toggl.com/api/v9"

def b64(s):
    return base64.b64encode(s.encode()).decode()

def fetch(url, method="GET", body=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Basic {b64(sys.argv[1] + ':api_token')}")
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body else None
    try:
        with urllib.request.urlopen(req, data=data) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()}")
        return None

def main():
    if len(sys.argv) < 2:
        print("用法: python3 stop_all_timers.py <Toggl_API_Token>")
        sys.exit(1)

    print("查询当前运行中的计时器...")
    current = fetch(f"{TOGGL_API}/me/time_entries/current")
    if not current:
        print("当前没有正在运行的计时器。")
        return

    # 获取 workspace_id
    me = fetch(f"{TOGGL_API}/me")
    ws_id = me.get("default_workspace_id") if me else None
    if not ws_id:
        print("无法获取 workspace_id")
        sys.exit(1)

    stopped = 0
    for i in range(20):
        current = fetch(f"{TOGGL_API}/me/time_entries/current")
        if not current:
            break
        eid = current["id"]
        desc = current.get("description", "无描述")
        dur = int(current.get("duration", 0))
        print(f"  停止 #{eid}: {desc} (已运行 {dur}秒)")
        result = fetch(f"{TOGGL_API}/workspaces/{ws_id}/time_entries/{eid}/stop", "PATCH")
        if result:
            stopped += 1

    print(f"\n完成：已停止 {stopped} 个计时器。")

if __name__ == "__main__":
    main()

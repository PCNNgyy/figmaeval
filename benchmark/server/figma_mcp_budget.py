import asyncio
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import time
import sys
import uuid

QUOTA = re.compile(r"you.ve reached the Figma MCP tool call limit|rate limit exceeded|too many requests", re.I)


def is_quota(result):
    return any(QUOTA.search(getattr(c, "text", "")) for c in result.content if getattr(c, "type", "") == "text")


def update_state(file, operation):
    path = Path(file)
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + 30
    def local_io(action):
        while True:
            try:
                return action()
            except OSError as error:
                if error.errno not in (errno.EAGAIN, errno.EINTR) or time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
    with local_io(lambda: path.with_suffix(".lock").open("a")) as lock:
        local_io(lambda: fcntl.flock(lock, fcntl.LOCK_EX))
        try:
            state = local_io(lambda: json.loads(path.read_text()))
        except FileNotFoundError:
            state = {}
        result = operation(state)
        temp = path.with_suffix(f".{os.getpid()}.tmp")
        def persist():
            temp.write_text(json.dumps(state) + "\n")
            temp.chmod(0o600)
            temp.replace(path)
        local_io(persist)
        return result


def reserve(file, now, interval, *, defer_cooldown=False):
    def operation(state):
        if state.get("resource_blocked"):
            return -1
        slot_now = time.time() if now is None else now
        if defer_cooldown and state.get("cooldown_until", 0) > slot_now:
            return -2
        delay = max(0, state.get("next_call_at", 0) - slot_now, state.get("cooldown_until", 0) - slot_now)
        if delay == 0:
            state["next_call_at"] = slot_now + max(interval, float(state.get("min_interval_seconds", interval)))
            state["calls_reserved"] = state.get("calls_reserved", 0) + 1
            state["last_reserved_at"] = slot_now
            state["last_reserved_counter"] = state["calls_reserved"]
        return delay
    return update_state(file, operation)


def enforce_interval(file, interval, legacy_interval=4, now=None):
    checked_at = time.time() if now is None else now
    def operation(state):
        state["min_interval_seconds"] = max(interval, float(state.get("min_interval_seconds", interval)))
        counter = int(state.get("calls_reserved", 0))
        if counter and state.get("rate_adjusted_reservation") != counter:
            if state.get("last_reserved_counter") == counter:
                reserved_at = state["last_reserved_at"]
            else:
                reserved_at = min(checked_at, state.get("next_call_at", checked_at) - legacy_interval)
            state["next_call_at"] = max(state.get("next_call_at", 0), reserved_at + state["min_interval_seconds"])
        state["rate_adjusted_reservation"] = counter
        state["rate_policy_checked_at"] = checked_at
    update_state(file, operation)


async def wait_for_slot(name):
    file = os.environ.get("FIGMA_MCP_BUDGET_FILE")
    if not file or name == "whoami":
        return
    interval = max(3.1, float(os.environ.get("FIGMA_MCP_MIN_INTERVAL", "4")))
    while True:
        preflight = os.environ.get("FIGMA_MCP_USAGE_PHASE") in ("launch_preflight", "copy_preflight")
        delay = reserve(file, None, interval, defer_cooldown=preflight)
        if delay == -2:
            raise RuntimeError("Figma MCP rate limit exceeded; benchmark preflight deferred during account cooldown; no remote request was made")
        if delay < 0:
            write_resource_marker(name)
            raise RuntimeError("You've reached the Figma MCP tool call limit; account circuit is open pending an explicit resource recovery check")
        if delay <= 0:
            return
        await asyncio.sleep(min(delay, 30))


def write_resource_marker(name):
    marker = os.environ.get("FIGMA_MCP_RESOURCE_STATUS")
    if marker:
        path = Path(marker)
        path.write_text(json.dumps({"code": "FIGMA_QUOTA", "exhausted": True, "limit_kind": "unknown",
            "message": "Figma MCP 连续限额，已暂停该账号；保留已有设计，确认资源恢复后再重跑",
            "checked_at": time.time(), "tool": name}) + "\n")
        path.chmod(0o600)


def usage_event(request, event, **fields):
    file = os.environ.get("FIGMA_MCP_BUDGET_FILE")
    if not file or not request:
        return
    path = Path(file).with_suffix(".usage.jsonl")
    payload = {k: v for k, v in request.items() if not k.startswith("_")}
    payload.update(event=event, at=time.time(), account=Path(file).stem, **fields)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, (json.dumps(payload, ensure_ascii=False) + "\n").encode())
        finally:
            os.close(fd)
    except OSError:
        print("[figma-usage] local audit append failed; remote result was preserved", file=sys.stderr)


def begin_request(name, file_key=None, phase=None):
    request = {"request_id": uuid.uuid4().hex, "tool": name,
        "phase": phase or os.environ.get("FIGMA_MCP_USAGE_PHASE", "unspecified"),
        "run_id": os.environ.get("FIGMA_MCP_RUN_ID", ""), "file_key": file_key,
        "quota_exempt": name == "whoami", "_started": time.monotonic()}
    usage_event(request, "remote_start")
    return request


def record_transport_error(request, error):
    usage_event(request, "remote_end", outcome="transport_error", error_type=type(error).__name__,
        duration_ms=round((time.monotonic() - request["_started"]) * 1000))


def record_result(name, result, request=None):
    limited = is_quota(result)
    if request:
        usage_event(request, "remote_end", outcome="quota_rejected" if limited else "tool_error" if getattr(result, "isError", False) else "success",
            duration_ms=round((time.monotonic() - request["_started"]) * 1000))
    file = os.environ.get("FIGMA_MCP_BUDGET_FILE")
    if not file or name == "whoami":
        return
    def operation(state):
        consecutive = state.setdefault("consecutive_quota", {})
        consecutive[name] = consecutive.get(name, 0) + 1 if limited else 0
        state["consecutive_quota_total"] = state.get("consecutive_quota_total", 0) + 1 if limited else 0
        if limited:
            state["quota_errors"] = state.get("quota_errors", 0) + 1
            state["last_quota_at"] = time.time()
            state["cooldown_until"] = time.time() + min(300, 60 * consecutive[name])
            if state["consecutive_quota_total"] >= 3 or consecutive[name] >= 3:
                state["resource_blocked"] = True
                state["blocked_at"] = time.time()
                state["limit_kind"] = "unknown"
        return state.get("resource_blocked", False)
    failures = update_state(file, operation)
    if failures:
        write_resource_marker(name)

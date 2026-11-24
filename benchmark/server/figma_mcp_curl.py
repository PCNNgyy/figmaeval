import asyncio
import json
import os
import re
from pathlib import Path
import tempfile

from mcp.types import CallToolResult, ListToolsResult


def parse_rpc_response(raw, request_id):
    body = bytes(raw)
    while body.startswith(b'HTTP/'):
        boundary = re.search(rb'\r?\n\r?\n', body)
        if not boundary:
            return None
        body = body[boundary.end():]
    candidates = [body.decode(errors='replace')]
    for event in re.split(r'\r?\n\r?\n', candidates[0]):
        data = [line[5:].lstrip() for line in event.splitlines() if line.startswith('data:')]
        if data:
            candidates.append('\n'.join(data))
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(value, dict) and (value.get('id') == request_id or ('error' in value and value.get('id') is None)):
            return value
    return None


def safe_response_retry(method, params, code, status):
    if code == 35:
        return True
    readonly = method in {'initialize', 'notifications/initialized', 'tools/list'} or (
        method == 'tools/call' and (params or {}).get('name') in
        {'whoami', 'get_metadata', 'get_screenshot'})
    return readonly and (code in {0, 18, 28, 52, 56}) and (status < 400 or status in {408, 500, 502, 503, 504})


def response_headers(raw):
    body = bytes(raw)
    status, headers, complete = 0, {}, False
    while body.startswith(b'HTTP/'):
        boundary = re.search(rb'\r?\n\r?\n', body)
        if not boundary:
            break
        lines = body[:boundary.start()].decode(errors='replace').splitlines()
        try:
            code = int(lines[0].split()[1])
        except (ValueError, IndexError):
            break
        if code >= 200 and 'connection established' not in lines[0].lower():
            status = code
            headers = {line.split(':', 1)[0].lower(): line.split(':', 1)[1].strip()
                       for line in lines[1:] if ':' in line}
            complete = True
        body = body[boundary.end():]
    return status, headers, complete


class CurlSession:
    def __init__(self, url, headers, timeout=120):
        self.url, self.headers, self.timeout = url, dict(headers), timeout
        self.sequence = 0

    async def close(self):
        pass

    async def exchange(self, method, params=None, notification=False, _attempt=0):
        self.sequence += 1
        request = {"jsonrpc": "2.0", "method": method}
        if not notification:
            request["id"] = self.sequence
        if params is not None:
            request["params"] = params
        with tempfile.TemporaryDirectory(prefix="figma-mcp-http-") as directory:
            headers = Path(directory) / "request-headers"
            headers.write_text("\n".join(f"{k}: {v}" for k, v in self.headers.items())
                               + "\nAccept: application/json, text/event-stream\nContent-Type: application/json\n")
            headers.chmod(0o600)
            process = await asyncio.create_subprocess_exec(
                "curl", "--silent", "--show-error", "--no-buffer", "--compressed", "--http1.1", "--connect-timeout", "20",
                "--max-time", str(self.timeout), "--header", "@" + str(headers),
                "--dump-header", "-", "--data-binary", "@-", self.url,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE, limit=8 * 1024 * 1024)
            process.stdin.write(json.dumps(request).encode())
            await process.stdin.drain()
            process.stdin.close()
            result, raw, status, headers_complete = None, bytearray(), 0, False
            try:
                while True:
                    chunk = await process.stdout.read(65536)
                    if not chunk:
                        break
                    raw.extend(chunk)
                    if len(raw) > 8 * 1024 * 1024:
                        raise RuntimeError("Figma MCP response exceeded transport limit")
                    status, received, headers_complete = response_headers(raw)
                    if 'mcp-session-id' in received:
                        self.headers['Mcp-Session-Id'] = received['mcp-session-id']
                    if notification and headers_complete and 200 <= status < 300:
                        break
                    if not notification:
                        result = parse_rpc_response(raw, request.get('id'))
                        if result is not None:
                            break
                if result is None and not notification:
                    result = parse_rpc_response(raw, request.get('id'))
                if result is None and not notification:
                    await process.wait()
                    error = (await process.stderr.read()).decode(errors="replace")[:350]
                    if safe_response_retry(method, params, process.returncode, status) and _attempt < 4:
                        await asyncio.sleep(min(4, 0.5 * 2**_attempt))
                        return await self.exchange(method, params, notification, _attempt + 1)
                    raise RuntimeError(f"Figma MCP curl transport failed ({process.returncode}, {method}): {error or f'HTTP {status}; no matching JSON-RPC response ({len(raw)} bytes)'}")
                if notification:
                    if not (headers_complete and 200 <= status < 300):
                        await process.wait()
                        if safe_response_retry(method, params, process.returncode, status) and _attempt < 4:
                            await asyncio.sleep(min(4, 0.5 * 2**_attempt))
                            return await self.exchange(method, params, notification, _attempt + 1)
                        raise RuntimeError(f'Figma MCP initialization notification failed: HTTP {status}, curl {process.returncode}')
            finally:
                if process.returncode is None:
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
                await process.wait()
            if notification:
                return None
            if "error" in result:
                error = result["error"]
                raise RuntimeError(f"Figma MCP RPC error {error.get('code')}: {error.get('message')}")
            return result["result"]

    async def initialize(self):
        value = await self.exchange("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "benchmark-authenticated-proxy", "version": "1"}})
        self.headers["MCP-Protocol-Version"] = value.get("protocolVersion", "2025-03-26")
        await self.exchange("notifications/initialized", notification=True)

    async def list_tools(self):
        return ListToolsResult.model_validate(await self.exchange("tools/list", {}))

    async def call_tool(self, name, arguments):
        return CallToolResult.model_validate(await self.exchange("tools/call", {"name": name, "arguments": arguments}))

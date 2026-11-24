import asyncio
from io import BytesIO
import json
import random
from concurrent.futures import ThreadPoolExecutor

import httpx
from mcp.types import CallToolResult, ListToolsResult
from PIL import Image


class FigmaNetworkError(RuntimeError):
    def __init__(self, message, *, safe_to_retry=False, status=None):
        super().__init__(message)
        self.safe_to_retry, self.status = safe_to_retry, status


class FigmaHttpClient:
    def __init__(self, timeout=120, attempts=3, *, transport=None):
        self.timeout, self.attempts = timeout, attempts
        self.client = httpx.AsyncClient(http2=True, timeout=httpx.Timeout(timeout, connect=20),
            limits=httpx.Limits(max_connections=4, max_keepalive_connections=4, keepalive_expiry=300),
            transport=transport)
        self.requests = 0
        self.connection_retries = 0
        self.http_versions = set()

    async def close(self):
        await self.client.aclose()

    async def request(self, method, url, *, headers=None, body=None, readonly=False,
                      rpc_id=None, notification=False, max_bytes=8*1024*1024):
        for attempt in range(self.attempts):
            try:
                self.requests += 1
                async with asyncio.timeout(self.timeout):
                    async with self.client.stream(method, url, headers=headers, json=body,
                            follow_redirects=method == 'GET') as response:
                        self.http_versions.add(response.http_version)
                        if response.status_code >= 400:
                            raise FigmaNetworkError(f'Figma HTTP {response.status_code}',
                                safe_to_retry=readonly and response.status_code in {408, 429, 500, 502, 503, 504},
                                status=response.status_code)
                        response_headers = dict(response.headers)
                        if notification:
                            await response.aread()
                            return None, response_headers
                        if method == 'GET' or 'text/event-stream' not in response.headers.get('content-type', ''):
                            data = bytearray()
                            async for chunk in response.aiter_bytes():
                                data.extend(chunk)
                                if len(data) > max_bytes:
                                    raise FigmaNetworkError('Figma response exceeds the configured size limit')
                            return (bytes(data) if method == 'GET' else json.loads(data)), response_headers
                        event, size = [], 0
                        async for line in response.aiter_lines():
                            size += len(line.encode())
                            if size > max_bytes:
                                raise FigmaNetworkError('Figma RPC response exceeds the configured size limit')
                            if line.startswith('data:'):
                                event.append(line[5:].lstrip())
                            elif not line and event:
                                value = json.loads('\n'.join(event))
                                event = []
                                if value.get('id') == rpc_id:
                                    return value, response_headers
                        if event:
                            value = json.loads('\n'.join(event))
                            if value.get('id') == rpc_id:
                                return value, response_headers
                        raise FigmaNetworkError('Figma RPC stream ended before the matching response', safe_to_retry=readonly)
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as error:
                failure = FigmaNetworkError('Figma TCP/TLS connection could not be established; request was not sent', safe_to_retry=True)
                cause = error
            except (httpx.ReadError, httpx.ReadTimeout, httpx.WriteError, httpx.WriteTimeout,
                    httpx.RemoteProtocolError, TimeoutError) as error:
                failure = FigmaNetworkError(
                    'Figma connection lost while reading the response' if readonly else
                    'Figma response lost; the operation may already have applied. Read the current state before retrying.',
                    safe_to_retry=readonly)
                cause = error
            except FigmaNetworkError as error:
                failure, cause = error, error
            if not failure.safe_to_retry or attempt + 1 == self.attempts:
                raise failure from (None if cause is failure else cause)
            self.connection_retries += 1
            await asyncio.sleep(0.4 * 2**attempt + random.uniform(0, 0.2))
        raise AssertionError('unreachable')


class FigmaRpcSession:
    def __init__(self, url, authorization, timeout=120, *, network=None):
        self.url, self.authorization = url, authorization
        self.network = network or FigmaHttpClient(timeout)
        self.session_id = None
        self.protocol = '2025-03-26'
        self.sequence = 0
        self.initialized = False
        self.lock = asyncio.Lock()

    async def close(self):
        await self.network.close()

    async def rpc(self, method, params=None, *, readonly=False, notification=False):
        self.sequence += 1
        payload = {'jsonrpc': '2.0', 'method': method}
        if not notification:
            payload['id'] = self.sequence
        if params is not None:
            payload['params'] = params
        headers = {'Authorization': self.authorization, 'Accept': 'application/json, text/event-stream',
                   'MCP-Protocol-Version': self.protocol}
        if self.session_id:
            headers['Mcp-Session-Id'] = self.session_id
        value, response_headers = await self.network.request('POST', self.url, headers=headers,
            body=payload, readonly=readonly, rpc_id=payload.get('id'), notification=notification)
        self.session_id = response_headers.get('mcp-session-id') or self.session_id
        if notification:
            return None
        if value.get('id') != payload['id']:
            raise FigmaNetworkError('Figma returned a mismatched RPC response id')
        if 'error' in value:
            raise FigmaNetworkError(f"Figma RPC error {value['error'].get('code')}: {value['error'].get('message')}")
        return value['result']

    async def initialize(self):
        if self.initialized:
            return
        value = await self.rpc('initialize', {'protocolVersion': self.protocol, 'capabilities': {},
            'clientInfo': {'name': 'benchmark-pooled-transport', 'version': '1'}}, readonly=True)
        self.protocol = value.get('protocolVersion', self.protocol)
        await self.rpc('notifications/initialized', readonly=True, notification=True)
        self.initialized = True

    async def list_tools(self):
        return ListToolsResult.model_validate(await self.rpc('tools/list', {}, readonly=True))

    async def call_tool(self, name, arguments):
        return CallToolResult.model_validate(await self.rpc('tools/call', {'name': name, 'arguments': arguments},
            readonly=name in {'whoami', 'get_metadata', 'get_screenshot'}))


async def download_image(url, *, network=None, attempts=3):
    own = network is None
    client = network or FigmaHttpClient(timeout=45, attempts=attempts)
    try:
        data, headers = await client.request('GET', url, readonly=True, max_bytes=64*1024*1024)
        try:
            with Image.open(BytesIO(data)) as image:
                image.verify()
                fmt = (image.format or '').upper()
        except Exception as error:
            raise FigmaNetworkError('Downloaded Figma asset is not a valid decodable image') from error
        mime = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp', 'GIF': 'image/gif'}.get(fmt)
        if not mime:
            raise FigmaNetworkError('Figma asset has an unsupported image format')
        return data, mime
    finally:
        if own:
            await client.close()


def download_image_sync(url):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(download_image(url))
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(download_image(url))).result()

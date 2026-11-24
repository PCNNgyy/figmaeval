#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
from benchmark_frames import benchmark_product_frame
from benchmark_images import open_page_screenshot
import re
import sys
import urllib.request
from pathlib import Path

MCP_URL = "https://mcp.figma.com/mcp"
MAX_FRAMES = 24
TOP_FRAME_RE = re.compile(
    r'^  <(?:frame|component)\s+id="([^"]+)"\s+name="([^"]*)"\s+'
    r'x="(-?[\d.]+)"\s+y="(-?[\d.]+)"\s+width="([\d.]+)"\s+height="([\d.]+)"'
)
PAGE_RE = re.compile(r'<canvas\s+id="([^"]+)"\s+name="([^"]*)"')


def read_token(auth_file: str, auth_lib: str) -> str:
    try:
        sys.path.insert(0, auth_lib)
        from figma_auth import access_token

        return access_token(auth_file)
    except Exception:
        return json.loads(Path(auth_file).read_text(encoding="utf-8"))["access_token"]


def text_of(result) -> str:
    return "\n".join(getattr(c, "text", "") for c in (result.content or []) if getattr(c, "text", None))


async def call_tool(token: str, name: str, arguments: dict):
    from figma_network import FigmaRpcSession, FigmaNetworkError
    from figma_mcp_budget import wait_for_slot, record_result, begin_request, record_transport_error

    check_capture_policy()
    await wait_for_slot(name)
    check_capture_policy()
    if os.environ.get('FIGMA_MCP_HTTP_TRANSPORT') == 'curl':
        from figma_mcp_curl import CurlSession
        session = CurlSession(MCP_URL, {'Authorization': f'Bearer {token}'}, timeout=180)
    else:
        session = FigmaRpcSession(MCP_URL, f'Bearer {token}', timeout=180)
    request = begin_request(name, arguments.get("fileKey"), "capture")
    try:
        try:
            await session.initialize()
            result = await session.call_tool(name, arguments)
        except FigmaNetworkError as error:
            if not error.safe_to_retry:
                raise
            await session.close()
            from figma_mcp_curl import CurlSession
            session = CurlSession(MCP_URL, {'Authorization': f'Bearer {token}'}, timeout=180)
            await session.initialize()
            result = await session.call_tool(name, arguments)
        record_result(name, result, request)
        return result
    except BaseException as error:
        record_transport_error(request, error)
        raise
    finally:
        await session.close()


def check_capture_policy():
    file = os.environ.get("FIGMA_CAPTURE_POLICY_FILE")
    if file and Path(file).exists() and json.loads(Path(file).read_text()).get("capture_screenshots") is False:
        raise RuntimeError("用户已关闭后续截图；已有图片保留")


def parse_pages(xml: str) -> list[dict]:
    pages = [{"id": m.group(1), "name": m.group(2)} for m in PAGE_RE.finditer(xml)]
    pages.extend({"id": m.group(1), "name": m.group(2).strip()}
                 for m in re.finditer(r"^\s*[-*]\s+(\d+:\d+):\s*(.+)$", xml, re.M))
    return list({page["id"]: page for page in pages}.values())


def parse_top_frames(xml: str) -> list[dict]:
    frames = []
    for line in xml.split("\n"):
        m = TOP_FRAME_RE.match(line)
        if m:
            frames.append({
                "node_id": m.group(1), "name": m.group(2),
                "x": float(m.group(3)), "y": float(m.group(4)),
                "w": float(m.group(5)), "h": float(m.group(6)),
            })
    return frames


def download(url: str, target: Path) -> int:
    from figma_network import download_image_sync
    data, _mime = download_image_sync(url)
    target.write_bytes(data)
    return len(data)


def save_screenshot(result, target):
    text = text_of(result)
    if result.isError:
        raise RuntimeError(text[:500])
    match = re.search(r'https://(?:www\.)?figma\.com/api/mcp/asset/[^\s"\')]+', text)
    if not match:
        raise RuntimeError("截图返回里没有资产链接")
    download(match.group(0), target)


def crop_frames(shot: Path, frames: list[dict], out_dir: Path, bounds=None) -> list[dict]:
    with open_page_screenshot(shot) as image:
        return crop_page_image(image, frames, out_dir, bounds)


def crop_page_image(image, frames, out_dir, bounds):
    width, height = image.size
    bounds = bounds or frames
    x0 = min(f["x"] for f in bounds)
    y0 = min(f["y"] for f in bounds)
    x1 = max(f["x"] + f["w"] for f in bounds)
    y1 = max(f["y"] + f["h"] for f in bounds)
    if x1 <= x0 or y1 <= y0:
        raise RuntimeError("frame 包围盒无效")
    scale_x = width / (x1 - x0)
    scale_y = height / (y1 - y0)
    if abs(scale_x - scale_y) / max(scale_x, scale_y) > 0.01:
        raise RuntimeError(f"截图与包围盒比例不一致（{scale_x:.4f} vs {scale_y:.4f}），放弃裁帧")
    written = []
    for frame in frames:
        box = (
            max(0, round((frame["x"] - x0) * scale_x)),
            max(0, round((frame["y"] - y0) * scale_y)),
            min(width, round((frame["x"] - x0 + frame["w"]) * scale_x)),
            min(height, round((frame["y"] - y0 + frame["h"]) * scale_y)),
        )
        if box[2] - box[0] < 2 or box[3] - box[1] < 2:
            continue
        name = f"{frame['node_id'].replace(':', '-')}.png"
        image.crop(box).save(out_dir / name)
        written.append({"node_id": frame["node_id"], "name": frame["name"], "file": name})
    return written


def native_capture_ids(frames, bounds, manifest, out_dir, minimum_side=0):
    required, digests = set(), {}
    by_id = {item["node_id"]: item for item in manifest}
    for frame in frames:
        node_id = frame["node_id"]
        for other in bounds:
            if other.get("node_id") == node_id:
                continue
            if (min(frame["x"] + frame["w"], other["x"] + other["w"]) - max(frame["x"], other["x"]) > 1
                    and min(frame["y"] + frame["h"], other["y"] + other["h"]) - max(frame["y"], other["y"]) > 1):
                required.add(node_id)
        item = by_id.get(node_id)
        if not item:
            required.add(node_id)
            continue
        file = out_dir / item["file"]
        with open_page_screenshot(file) as image:
            if min(image.size) < minimum_side:
                required.add(node_id)
            if abs((image.width / image.height) / (frame["w"] / frame["h"]) - 1) > 0.03:
                required.add(node_id)
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        if digest in digests:
            required.update([node_id, digests[digest]])
        digests[digest] = node_id
    return required


def native_dimension(frame, options):
    dimension=getattr(options,'native_max_dimension',options.max_dimension)
    minimum=getattr(options,'minimum_frame_side',0)
    width,height=frame.get('w',0),frame.get('h',0)
    if minimum and min(width,height)>0:
        dimension=max(dimension,math.ceil((minimum+4)*max(width,height)/min(width,height)))
    return min(dimension,8000)


async def capture_native_frame(token, frame, options, out_dir, debug):
    arguments = {"fileKey": options.file_key, "nodeId": frame["node_id"],
                 "maxDimension": native_dimension(frame,options)}
    result = await call_tool(token, "get_screenshot", arguments)
    name = f"{frame['node_id'].replace(':', '-')}.png"
    response = debug / f"v2-native-{name}.txt"
    response.write_text(text_of(result), encoding="utf-8")
    save_screenshot(result, out_dir / name)
    with open_page_screenshot(out_dir / name) as image:
        image.verify()
    return {"node_id": frame["node_id"], "name": frame["name"], "file": name,
            "native_capture": {"kind": "figma-native-frame-capture/v1", "tool": "get_screenshot",
                "arguments": arguments, "screenshot_sha256": hashlib.sha256((out_dir / name).read_bytes()).hexdigest(),
                "response_file": str(response.relative_to(out_dir)),
                "response_sha256": hashlib.sha256(response.read_bytes()).hexdigest()}}


def native_checkpoint(frame, options, out_dir, entry=None):
    folder = out_dir / "native-checkpoints"
    file = folder / f"{frame['node_id'].replace(':', '-')}.json"
    inventory = hashlib.sha256(Path(options.inventory_file).read_bytes()).hexdigest() if options.inventory_file else None
    identity = {"file_key": options.file_key, "inventory_sha256": inventory, "frame": frame}
    if entry is not None:
        folder.mkdir(exist_ok=True)
        temporary = file.with_suffix(".tmp")
        temporary.write_text(json.dumps({**identity, "entry": entry}, ensure_ascii=False), encoding="utf-8")
        temporary.replace(file)
        return entry
    if not getattr(options, "resume", False) or not file.exists():
        return None
    try:
        saved = json.loads(file.read_text())
        if any(saved.get(key) != value for key, value in identity.items()):
            return None
        item = saved["entry"]
        proof = item["native_capture"]
        if (item["node_id"] != frame["node_id"] or item["name"] != frame["name"]
                or item["file"] != f"{frame['node_id'].replace(':', '-')}.png"
                or proof["arguments"] != {"fileKey": options.file_key, "nodeId": frame["node_id"],
                                           "maxDimension": native_dimension(frame,options)}):
            return None
        image_file = out_dir / item["file"]
        response_file = (out_dir / proof["response_file"]).resolve()
        if (out_dir.resolve() not in response_file.parents
                or hashlib.sha256(image_file.read_bytes()).hexdigest() != proof["screenshot_sha256"]
                or hashlib.sha256(response_file.read_bytes()).hexdigest() != proof["response_sha256"]):
            return None
        with open_page_screenshot(image_file) as image:
            image.verify()
        return item
    except (OSError, ValueError, KeyError):
        return None


async def main_async(options) -> dict:
    out_dir = Path(options.out_dir).resolve()
    if "FIGMA_CAPTURE_POLICY_FILE" not in os.environ:
        policy = next((p / "capture-policy.json" for p in out_dir.parents if (p / "capture-policy.json").exists()), None)
        if policy:
            os.environ["FIGMA_CAPTURE_POLICY_FILE"] = str(policy)
    check_capture_policy()
    token = read_token(options.auth_file, options.auth_lib)
    out_dir.mkdir(parents=True, exist_ok=True)
    debug = out_dir / "_debug"
    debug.mkdir(exist_ok=True)
    calls = 0

    inventory = json.loads(Path(options.inventory_file).read_text()) if options.inventory_file else None
    if inventory:
        if inventory.get("file_key") != options.file_key or not inventory.get("workspace"):
            raise RuntimeError("Workspace inventory does not match the assigned file")
        pages = [inventory["workspace"]]
    else:
        result = await call_tool(token, "get_metadata", {"fileKey": options.file_key})
        pages_xml = text_of(result)
        calls += 1
        (debug / "v2-01-pages.xml").write_text(pages_xml, encoding="utf-8")
        if result.isError:
            raise RuntimeError(pages_xml[:500])
        pages = parse_pages(pages_xml)
        if options.workspace_only:
            pages = [p for p in pages if re.match(r"^03\s*[·.\-—]", p["name"])]
    if not pages:
        raise RuntimeError("没解析出页面列表")

    manifest: list[dict] = []
    for page in pages:
        if len(manifest) >= options.max_frames:
            break
        bounds = None
        if inventory:
            bounds = [{"node_id": n["id"], "x": n["x"], "y": n["y"], "w": n["width"], "h": n["height"]}
                      for n in page["children"] if n.get("width", 0) > 0 and n.get("height", 0) > 0]
            frames = [{"node_id": n["id"], "name": n["name"], "x": n["x"], "y": n["y"],
                       "w": n["width"], "h": n["height"]} for n in page["children"]
                      if benchmark_product_frame(n)]
        else:
            result = await call_tool(token, "get_metadata", {"fileKey": options.file_key, "nodeId": page["id"]})
            page_xml = text_of(result)
            calls += 1
            (debug / f"v2-02-page-{page['id'].replace(':', '-')}.xml").write_text(page_xml, encoding="utf-8")
            if result.isError:
                raise RuntimeError(page_xml[:500])
            frames = parse_top_frames(page_xml)
            bounds = frames
            if options.workspace_only:
                frames = [f for f in frames if benchmark_product_frame(f)]
        if getattr(options, 'frame_ids', None) is not None:
            frames = [f for f in frames if f['node_id'] in options.frame_ids]
        frames = frames[:options.max_frames - len(manifest)]
        if not frames:
            continue
        if getattr(options, "native_only", False):
            page_manifest = []
            individual = {frame["node_id"] for frame in frames}
        else:
            result = await call_tool(token, "get_screenshot", {
                "fileKey": options.file_key, "nodeId": page["id"], "maxDimension": options.max_dimension,
            })
            shot_text = text_of(result)
            calls += 1
            (debug / f"v2-03-shot-{page['id'].replace(':', '-')}.txt").write_text(shot_text, encoding="utf-8")
            if result.isError:
                raise RuntimeError(shot_text[:500])
            match = re.search(r'https://(?:www\.)?figma\.com/api/mcp/asset/[^\s"\')]+', shot_text)
            if not match:
                raise RuntimeError(f"页面 {page['name']} 的截图返回里没有资产链接")
            shot = debug / f"v2-page-{page['id'].replace(':', '-')}.png"
            download(match.group(0), shot)
            try:
                page_manifest = crop_frames(shot, frames, out_dir, bounds)
                individual = native_capture_ids(frames, bounds, page_manifest, out_dir, getattr(options, 'minimum_frame_side', 0))
            except (RuntimeError, ValueError) as error:
                if "截图与包围盒比例不一致" not in str(error) and "bounded canvas size" not in str(error):
                    raise
                page_manifest = []
                individual = {frame["node_id"] for frame in frames}
        by_id = {item["node_id"]: item for item in page_manifest}
        for frame in frames:
            if frame["node_id"] in individual:
                item = native_checkpoint(frame, options, out_dir)
                if item is None:
                    for attempt in range(3):
                        try:
                            item = await asyncio.wait_for(capture_native_frame(token, frame, options, out_dir, debug),
                                                          timeout=getattr(options, "tool_timeout", 180))
                            break
                        except asyncio.TimeoutError:
                            if attempt == 2:
                                raise RuntimeError(f"Native screenshot timed out for node {frame['node_id']} after 3 attempts")
                            await asyncio.sleep(5)
                    native_checkpoint(frame, options, out_dir, item)
                    calls += 1
                by_id[frame["node_id"]] = item
                (out_dir / "frames.partial.json").write_text(json.dumps(
                    [*manifest, *[by_id[f["node_id"]] for f in frames if f["node_id"] in by_id]],
                    ensure_ascii=False, indent=2), encoding="utf-8")
        manifest.extend(by_id[frame["node_id"]] for frame in frames)

    if not manifest:
        raise RuntimeError("没有可裁的顶层画板")
    (out_dir / "frames.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "frames": len(manifest), "figma_calls": calls, "pages": len(pages)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file-key", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--auth-file", required=True)
    parser.add_argument("--auth-lib", required=True)
    parser.add_argument("--max-dimension", type=int, default=8000)
    parser.add_argument("--workspace-only", action="store_true")
    parser.add_argument("--inventory-file", default="")
    parser.add_argument("--native-only", action="store_true", help="Capture each final board independently when a very large canvas cannot render")
    parser.add_argument("--resume", action="store_true", help="Reuse verified per-node captures bound to this exact inventory")
    parser.add_argument("--tool-timeout", type=int, default=180, help="Per-node native screenshot deadline in seconds")
    parser.add_argument("--max-frames", type=int, default=MAX_FRAMES)
    options = parser.parse_args()
    try:
        print(json.dumps(asyncio.run(main_async(options)), ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:500] or type(error).__name__}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

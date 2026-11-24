#!/usr/bin/env python3
import argparse
import asyncio
import json
import os
from pathlib import Path
import time

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
import re
from benchmark_frames import FIGMA_PRODUCT_FRAME_PREDICATE
from figma_mcp_budget import is_quota


class InspectionError(RuntimeError):
    def __init__(self, code, message, retryable=True):
        super().__init__(message)
        self.code, self.retryable = code, retryable


def inspection_error(text):
    if re.search(r"you.ve reached the Figma MCP tool call limit|rate limit exceeded|too many requests", text, re.I):
        return InspectionError("FIGMA_QUOTA", "Figma MCP 调用额度受限；模型尚未启动，等待资源恢复")
    if re.search(r"read.only mode|permission|access denied|unauthorized|forbidden|you.ll need a Full seat", text, re.I):
        return InspectionError("FIGMA_PERMISSION", "Figma 副本没有所需的读写权限；模型尚未启动", False)
    return InspectionError("FIGMA_INSPECTION", text[:500] or "Figma 页面检查没有返回有效结果")


def page_snapshot(result, file_key):
    if result.isError or is_quota(result):
        raise inspection_error("\n".join(c.text for c in result.content if c.type == "text"))
    for block in result.content:
        if block.type != "text":
            continue
        try:
            value = json.loads(block.text)
            if isinstance(value, str):
                value = json.loads(value)
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict) and value.get("file_key") == file_key and isinstance(value.get("pages"), list):
            return value
    raise inspection_error("\n".join(c.text for c in result.content if c.type == "text"))


def foundation_reference(pages):
    matches = [p for p in pages if re.match(r"^01\s*[·.\-—]", p.get("name", ""))]
    if len(matches) != 1 or not re.fullmatch(r"\d+[:-]\d+", str(matches[0].get("id", ""))):
        raise InspectionError("FIGMA_REFERENCE", "副本缺少唯一、可定位的 01 规范页；模型尚未启动", False)
    return matches[0]


async def inspect(config_file, file_key, artifacts=False, verify_writable=False, usage_phase=None,
                  verify_reference_read=False, screen_count=False, workspace_artifacts=False):
    if workspace_artifacts and (not artifacts or verify_writable or verify_reference_read or screen_count):
        raise ValueError("Workspace artifact collection must be a separate read-only operation")
    if screen_count and (artifacts or verify_writable or verify_reference_read):
        raise ValueError("Screen inventory must be a separate read-only operation")
    if verify_reference_read and (artifacts or not verify_writable or usage_phase != "launch_preflight"):
        raise ValueError("Reference-read verification is restricted to assigned-copy launch preflight")
    config = json.loads(Path(config_file).read_text())["mcpServers"]["figma"]
    parameters = StdioServerParameters(command=config["command"], args=config.get("args", []),
        env={**os.environ, **config.get("env", {}), "FIGMA_MCP_ALLOWED_TOOLS": "use_figma,get_metadata" if verify_reference_read else "use_figma", "FIGMA_MCP_PIN_PAGE": "", "FIGMA_MCP_PIN_PAGE_ID":"",
             "FIGMA_MCP_USAGE_PHASE": usage_phase or ("artifact_inspection" if artifacts else "assigned_copy_check" if verify_writable else "source_check")})
    if screen_count or workspace_artifacts:
        parameters.env.pop("FIGMA_MCP_RESOURCE_STATUS", None)
        parameters.env["FIGMA_MCP_USAGE_PHASE"] = "artifact_inspection" if workspace_artifacts else "screen_count_inspection"
        parameters.env["FIGMA_MCP_ASSIGNED_FILE_KEY"] = file_key
    if parameters.env["FIGMA_MCP_USAGE_PHASE"] in ("launch_preflight", "copy_preflight"):
        budget_file = parameters.env.get("FIGMA_MCP_BUDGET_FILE")
        budget = json.loads(Path(budget_file).read_text()) if budget_file and Path(budget_file).exists() else {}
        if budget.get("resource_blocked") or float(budget.get("cooldown_until") or 0) > time.time():
            raise InspectionError("FIGMA_QUOTA", "Figma MCP 账号正在冷却或等待额度恢复；模型尚未启动，已返回资源等待队列")
    code = (
        "const pages=[];for(const p of figma.root.children){await p.loadAsync();"
        "pages.push({id:p.id,name:p.name,child_count:p.children.length});}"
        "return JSON.stringify({file_key:" + json.dumps(file_key) + ",pages});"
    )
    if verify_writable:
        code = code.replace("return JSON.stringify", (
            "let workspace=figma.root.children.find(p=>/^03\\s*[·.\\-—]/.test(p.name));"
            "let write_verified=false,write_probe=null;"
            "if(!workspace||workspace.children.length===0){"
            "if(!workspace){workspace=figma.createPage();workspace.name='03 · Workspace';"
            "pages.push({id:workspace.id,name:workspace.name,child_count:0});}"
            "await figma.setCurrentPageAsync(workspace);"
            "const probe=figma.createRectangle();const probeId=probe.id;"
            "try{probe.name='__benchmark_write_probe__';probe.resize(1,1);}"
            "finally{probe.remove();}"
            "write_verified=true;write_probe={id:probeId,page_id:workspace.id,removed:true};"
            "}return JSON.stringify"
        )).replace(",pages});", ",pages,write_verified,write_probe});")
    if artifacts:
        code = FIGMA_PRODUCT_FRAME_PREDICATE + (
            "const pages=[];let workspace=null;let brief='';let boards=[];for(const p of figma.root.children){await p.loadAsync();"
            "pages.push({id:p.id,name:p.name,child_count:p.children.length});"
            "if(/^00\\s*[·.\\-—]/.test(p.name))brief=p.findAll(n=>n.type==='TEXT').map(n=>n.characters).join('\\n').slice(0,6500);"
            "if(/^03\\s*[·.\\-—]/.test(p.name)){workspace={id:p.id,name:p.name,children:p.children.map(n=>({"
            "id:n.id,name:n.name,type:n.type,x:n.x,y:n.y,width:n.width,height:n.height,"
            "...('absoluteRenderBounds'in n&&n.absoluteRenderBounds&&Math.abs((n.absoluteRenderBounds.width/n.absoluteRenderBounds.height)/(n.width/n.height)-1)>0.02?"
            "{render_bounds:{width:n.absoluteRenderBounds.width,height:n.absoluteRenderBounds.height}}:{}),"
            "text_count:'findAll'in n?n.findAll(c=>c.type==='TEXT').length:0,"
            "reaction_count:('findAll'in n?[n,...n.findAll()]:[n]).reduce((a,c)=>a+(c.reactions?.length||0),0)"
            "}))};"
            "boards=p.children.filter(productFrame).map(n=>{"
            "const types={},names=[];let nodes=0,max_depth=0,instances=0,texts=0,images=0;"
            "for(const x of n.findAll()){nodes++;let depth=1,parent=x.parent;while(parent&&parent.id!==n.id){depth++;parent=parent.parent;}"
            "max_depth=Math.max(max_depth,depth);let type=x.type.toLowerCase().replaceAll('_','-');"
            "if(type==='rectangle'&&Array.isArray(x.fills)&&x.fills.some(f=>f.type==='IMAGE'))type='rectangle-image';"
            "types[type]=(types[type]||0)+1;if(type==='instance'||type==='component')instances++;"
            "if(type==='text')texts++;if(type==='rectangle-image'||type==='image')images++;"
            "if(x.name&&names.length<6&&!names.includes(x.name.slice(0,24)))names.push(x.name.slice(0,24));}"
            "return {name:n.name,size:n.width+'×'+n.height,nodes,max_depth,instances,texts,images,"
            "types:Object.entries(types).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>k+'×'+v),names};});"
            "}}return JSON.stringify({file_key:" + json.dumps(file_key) + ",pages,workspace,brief,layer_summary:{board_count:boards.length,boards}});"
        )
    if screen_count:
        code = (
            "const matches=figma.root.children.filter(p=>/^03\\s*[·.\\-—]/.test(p.name));"
            "if(matches.length>1)throw new Error('Multiple 03 Workspace pages');"
            "const w=matches[0]||null;if(w)await w.loadAsync();"
            "const children=w?w.children.map(n=>({id:n.id,name:n.name,type:n.type,x:n.x,y:n.y,width:n.width,height:n.height})):[];"
            "return JSON.stringify({kind:'benchmark-screen-inventory/v1',read_only:true,pages_complete:true,file_key:"
            + json.dumps(file_key) + ",pages:figma.root.children.map(p=>({id:p.id,name:p.name,...(w&&p.id===w.id?{child_count:children.length}:{})})),"
            "workspace:w?{id:w.id,name:w.name,children}:null});"
        )
    if workspace_artifacts:
        code = code.replace("await p.loadAsync();", "if(/^03\\s*[·.\\-—]/.test(p.name))await p.loadAsync();")
        code = code.replace("pages.push({id:p.id,name:p.name,child_count:p.children.length});",
            "pages.push({id:p.id,name:p.name,...(/^03\\s*[·.\\-—]/.test(p.name)?{child_count:p.children.length}:{})});")
        code = code.replace("if(/^00\\s*[·.\\-—]/.test(p.name))brief=p.findAll(n=>n.type==='TEXT').map(n=>n.characters).join('\\n').slice(0,6500);", "")
    failure, value = None, None
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool("use_figma", {"fileKey": file_key, "code": code,
                "skillNames": "resource:figma-use",
                "description": "Read-only final Page 03 artifacts and layers; no edits or reference-page loading" if workspace_artifacts else "Read-only final Page 03 top-level screen inventory; no edits, screenshots, or component traversal" if screen_count else "Verify assigned-copy write access by creating and removing one probe in empty Workspace" if verify_writable else "Read-only benchmark preflight: verify reference pages and an empty or missing Workspace"})
            try:
                value = page_snapshot(result, file_key)
                if verify_reference_read and value.get("write_verified") is True:
                    page = foundation_reference(value["pages"])
                    metadata = await session.call_tool("get_metadata", {"fileKey": file_key, "nodeId": page["id"]})
                    if metadata.isError or is_quota(metadata):
                        raise inspection_error("\n".join(c.text for c in metadata.content if c.type == "text"))
                    if not any(c.type == "text" and c.text.strip() for c in metadata.content):
                        raise InspectionError("FIGMA_REFERENCE", "01 规范页读取未返回内容；模型尚未启动")
                    value["reference_read_verified"] = True
                    value["reference_read"] = {"tool": "get_metadata", "node_id": page["id"], "page_name": page["name"]}
            except InspectionError as error:
                failure = error
    if failure:
        raise failure
    return value


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcp-config", required=True)
    parser.add_argument("--file-key", required=True)
    parser.add_argument("--artifacts", action="store_true")
    parser.add_argument("--screen-count", action="store_true")
    parser.add_argument("--workspace-artifacts", action="store_true")
    parser.add_argument("--verify-writable", action="store_true", help="Assigned copies only: create and remove a probe in empty 03 Workspace")
    parser.add_argument("--verify-reference-read", action="store_true", help="Launch only: verify the actual 01 reference page is readable before inference")
    parser.add_argument("--usage-phase", choices=["source_check", "copy_preflight", "launch_preflight", "artifact_inspection"])
    args = parser.parse_args()
    try:
        if args.artifacts and args.verify_writable:
            raise ValueError("Artifact recovery must remain read-only")
        print(json.dumps(asyncio.run(inspect(args.mcp_config, args.file_key, args.artifacts, args.verify_writable,
            args.usage_phase, args.verify_reference_read, args.screen_count, args.workspace_artifacts)), ensure_ascii=False))
    except Exception as error:
        payload = {"ok": False, "code": getattr(error, "code", "FIGMA_TRANSPORT"),
                   "message": str(error) if isinstance(error, InspectionError) else "Figma MCP 传输失败（" + type(error).__name__ + "）；模型尚未启动",
                   "retryable": getattr(error, "retryable", True), "retry_after_seconds": 60}
        print(json.dumps(payload, ensure_ascii=False))
        raise SystemExit(1)

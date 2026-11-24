import argparse
import asyncio
import json
import os
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from benchmark_fixture import page_snapshot
from benchmark_frames import FIGMA_PRODUCT_FRAME_PREDICATE, benchmark_product_frame


def artifact_code(file_key):
    return FIGMA_PRODUCT_FRAME_PREDICATE + r"""
const matches=figma.root.children.filter(p=>/^03\s*[·.\-—]\s*Workspace\s*$/i.test(p.name));
if(matches.length!==1)throw new Error('Expected one final Workspace');
const w=matches[0];await w.loadAsync();const boards=[];
figma.skipInvisibleInstanceChildren=false;
const children=w.children.map(n=>{
 const descendants='findAll'in n?n.findAll():[];
 const text_count=descendants.filter(x=>x.type==='TEXT').length;
 const reaction_count=[n,...descendants].reduce((sum,x)=>sum+(x.reactions?.length||0),0);
 const r=n.absoluteRenderBounds;
 const render_bounds=r&&Math.abs((r.width/r.height)/(n.width/n.height)-1)>0.02?{width:r.width,height:r.height}:null;
 if(productFrame(n)){
  const types={},names=[];let nodes=0,max_depth=0,instances=0,texts=0,images=0;
  for(const x of descendants){nodes++;let depth=1,parent=x.parent;while(parent&&parent.id!==n.id){depth++;parent=parent.parent;}
   max_depth=Math.max(max_depth,depth);let type=x.type.toLowerCase().replaceAll('_','-');
   if(type==='rectangle'&&Array.isArray(x.fills)&&x.fills.some(f=>f.type==='IMAGE'))type='rectangle-image';
   types[type]=(types[type]||0)+1;if(type==='instance'||type==='component')instances++;
   if(type==='text')texts++;if(type==='rectangle-image'||type==='image')images++;
   if(x.name&&names.length<6&&!names.includes(x.name.slice(0,24)))names.push(x.name.slice(0,24));
  }
  boards.push({id:n.id,name:n.name,size:n.width+'×'+n.height,nodes,max_depth,instances,texts,images,
   types:Object.entries(types).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>k+'×'+v),names});
 }
 return [n.id,n.name,n.type,n.x,n.y,n.width,n.height,text_count,reaction_count,render_bounds];
});
return JSON.stringify({file_key:FILE_KEY,pages:figma.root.children.map(p=>({id:p.id,name:p.name,...(p.id===w.id?{child_count:children.length}:{})})),
workspace:{id:w.id,name:w.name,children},brief:'',layer_summary:{board_count:boards.length,boards}});
""".replace("FILE_KEY", json.dumps(file_key))


def expand_snapshot(value):
    fields = ["id", "name", "type", "x", "y", "width", "height", "text_count", "reaction_count", "render_bounds"]
    rows = value["workspace"]["children"]
    if any(not isinstance(row, list) or len(row) != len(fields) for row in rows):
        raise ValueError("Compact artifact contains an incomplete node")
    nodes = [dict(zip(fields, row)) for row in rows]
    if len({n["id"] for n in nodes}) != len(nodes):
        raise ValueError("Compact artifact contains duplicate node IDs")
    for node in nodes:
        if node["render_bounds"] is None:
            del node["render_bounds"]
    page = next(p for p in value["pages"] if p["id"] == value["workspace"]["id"])
    if (page["child_count"] != len(nodes) or value["layer_summary"]["board_count"] != sum(map(benchmark_product_frame, nodes))
            or len(value["layer_summary"]["boards"]) != value["layer_summary"]["board_count"]):
        raise ValueError("Compact artifact is truncated")
    value["workspace"]["children"] = nodes
    return value


async def inspect_compact(config_file, file_key):
    config = json.loads(Path(config_file).read_text())["mcpServers"]["figma"]
    env = {**os.environ, **config.get("env", {}), "FIGMA_MCP_ALLOWED_TOOLS": "use_figma", "FIGMA_MCP_PIN_PAGE": "",
           "FIGMA_MCP_USAGE_PHASE": "artifact_inspection", "FIGMA_MCP_ASSIGNED_FILE_KEY": file_key}
    env.pop("FIGMA_MCP_RESOURCE_STATUS", None)
    parameters = StdioServerParameters(command=config["command"], args=config.get("args", []), env=env)
    failure = value = None
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool("use_figma", {"fileKey": file_key, "code": artifact_code(file_key),
                "skillNames": "resource:figma-use", "description": "Read-only complete final Workspace; compact transport with no omitted nodes or layer fields"})
            try:
                value = expand_snapshot(page_snapshot(result, file_key))
            except Exception as error:
                failure = error
    if failure:
        raise failure
    return value


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcp-config", required=True)
    parser.add_argument("--file-key", required=True)
    options = parser.parse_args()
    try:
        print(json.dumps(asyncio.run(inspect_compact(options.mcp_config, options.file_key)), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "code": getattr(error, "code", "FIGMA_INSPECTION"), "message": str(error) or type(error).__name__}, ensure_ascii=False))
        raise SystemExit(1)

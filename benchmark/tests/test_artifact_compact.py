import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from benchmark_artifact_compact import artifact_code, expand_snapshot


class CompactArtifactTests(unittest.TestCase):
    def snapshot(self, media_page='04 · Media'):
        script = r"""
const fs=require('node:fs'),code=JSON.parse(fs.readFileSync(0,'utf8')).code;let loads=0;
const children=Array.from({length:304},(_,i)=>({id:'20:'+i,name:'顶层节点名称'+String(i).padStart(3,'0'),
 type:i<19?'FRAME':'TEXT',x:i*400,y:0,width:375,height:812,reactions:[],absoluteRenderBounds:null}));
for(const n of children.slice(0,19)){n.findAll=()=>[{id:n.id+'t',name:'Title',type:'TEXT',parent:n,reactions:[]}];}
const w={id:'3:1',name:'03 · Workspace',children,loadAsync:async()=>{loads++;}};
const refs=['00 · Start Here','01 · Foundations','02 · Components','04 · Media'].map((name,i)=>({id:i+':0',name,
 get children(){throw Error('Reference traversal');},loadAsync:async()=>{throw Error('Reference load');}}));
const figma={root:{children:[...refs,w]}};
(async()=>{const F=Object.getPrototypeOf(async()=>{}).constructor;
 const value=JSON.parse(await new F('figma',code)(figma));process.stdout.write(JSON.stringify({value,loads}));})();
"""
        script = script.replace('04 · Media', media_page)
        result = subprocess.run(["node", "-e", script], input=json.dumps({"code": artifact_code("OutputCopy")}),
                                capture_output=True, text=True, check=True, timeout=10)
        return json.loads(result.stdout)

    def test_paper_media_page_is_not_mistaken_for_workspace(self):
        result = self.snapshot('03 · Media')
        self.assertEqual(result['loads'], 1)
        self.assertEqual(result['value']['workspace']['name'], '03 · Workspace')

    def test_real_read_only_script_preserves_all_304_nodes_and_all_19_layer_summaries(self):
        result = self.snapshot()
        self.assertEqual(result["loads"], 1)
        compact = result["value"]
        wire_size = len(json.dumps(json.dumps(compact, ensure_ascii=False), ensure_ascii=False).encode())
        value = expand_snapshot(copy.deepcopy(compact))
        self.assertLess(wire_size, 48000)
        self.assertEqual(len(value["workspace"]["children"]), 304)
        self.assertEqual(value["workspace"]["children"][-1]["name"], "顶层节点名称303")
        self.assertEqual(value["workspace"]["children"][0]["text_count"], 1)
        self.assertEqual(value["layer_summary"]["board_count"], 19)
        self.assertEqual(len(value["layer_summary"]["boards"]), 19)
        self.assertEqual(value["layer_summary"]["boards"][0]["texts"], 1)

    def test_decoder_rejects_missing_fields_duplicate_nodes_and_truncated_summaries(self):
        original = self.snapshot()["value"]
        for change in [lambda v: v["workspace"]["children"][0].pop(),
                       lambda v: v["workspace"]["children"].append(v["workspace"]["children"][0]),
                       lambda v: v["layer_summary"].update(board_count=18)]:
            value = copy.deepcopy(original)
            change(value)
            with self.assertRaises(ValueError):
                expand_snapshot(value)


if __name__ == "__main__":
    unittest.main()

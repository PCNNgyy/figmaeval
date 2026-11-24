import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image, ImageDraw

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('acceptance_harness',ROOT/'scripts/claude_code_harness.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
from benchmark_blank_screens import image_metrics,structural_empty_frames
from benchmark_screen_count import evaluate_named_screens

class AcceptanceTests(unittest.TestCase):
 def test_parent_model_credentials_and_agent_config_are_not_inherited(self):
  with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'fixture-secret','CLAUDECODE':'parent','CLAUDE_CONFIG_DIR':'parent-config'}):
   env=h.clean_environment()
   for key in ['ANTHROPIC_API_KEY','CLAUDECODE','CLAUDE_CONFIG_DIR']:
    self.assertNotIn(key,env)

 def test_blank_shell_and_zero_descendants_fail(self):
  with tempfile.TemporaryDirectory() as folder:
   file=Path(folder)/'synthetic.png';image=Image.new('RGB',(360,640),'white');draw=ImageDraw.Draw(image)
   draw.rectangle((0,0,360,30),fill='black');draw.rectangle((0,610,360,640),fill='black');image.save(file)
   self.assertEqual(image_metrics(file)['blank_reason'],'empty_body_with_chrome')
   draw.rectangle((40,120,320,480),fill=(80,130,180));image.save(file)
   self.assertFalse(image_metrics(file)['blank'])
  self.assertEqual(structural_empty_frames({'layer_summary':{'boards':[{'id':'a','nodes':0}]}},[{'id':'a'}]),[{'id':'a'}])

 def test_missing_or_duplicate_screen_names_fail(self):
  inventory={'workspace':{'children':[{'id':'a','type':'FRAME','name':'01_Catalog'},{'id':'b','type':'FRAME','name':'01_Catalog'}]}}
  value=evaluate_named_screens(inventory,['01_Catalog','02_Detail'])
  self.assertFalse(value['passed']);self.assertEqual(value['missing_screen_names'],['02_Detail'])
  self.assertEqual(value['duplicate_screen_names'],{'01_Catalog':2})

 def test_account_lease_coordinates_independent_processes(self):
  with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'FIGMA_HARNESS_LOCK_DIR':folder}):
   marker=Path(folder)/'entered'
   code="import importlib.util; from pathlib import Path; s=importlib.util.spec_from_file_location('h',"+repr(str(ROOT/'scripts/claude_code_harness.py'))+"); h=importlib.util.module_from_spec(s); s.loader.exec_module(h)\nwith h.lease('account'): Path("+repr(str(marker))+").touch()"
   with h.lease('account'):
    proc=subprocess.Popen([sys.executable,'-c',code])
    try:
     with self.assertRaises(subprocess.TimeoutExpired):proc.wait(timeout=.3)
     self.assertFalse(marker.exists())
    except BaseException:proc.kill();proc.wait();raise
   proc.wait(timeout=5);self.assertTrue(marker.exists())

if __name__=='__main__':unittest.main()

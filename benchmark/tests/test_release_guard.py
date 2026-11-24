import importlib.util
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('release_guard',ROOT/'scripts/check-release.py')
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)

class ReleaseGuardTests(unittest.TestCase):
 def test_framework_allowlist_blocks_arena_data_and_every_binary_media_location(self):
  for name in ['arena/arena.js','server/benchmark_arena.mjs','scripts/arena-demo.mjs','tests/test_harness.py','benchmarks/rubrics/fixed-v4.json','examples/inference.example.json']:
   self.assertTrue(guard.allowed_path(name),name)
  for name in ['arena/snapshot.json','arena/media/design.png','storage/arena.sqlite3','private/credentials.json','outputs/results.json','tests/example.png','docs/data.zip','arena/real-query.txt','examples/scores.json','server/private/config.py','../escape.py']:
   self.assertFalse(guard.allowed_path(name),name)

 def test_credentials_personal_accounts_and_real_file_urls_fail_without_echoing_the_value(self):
  secret='gh'+'p_'+'A'*32
  file_url='https://'+'www.figma.com/design/'+'A'*22
  email='person'+'@'+'company'+'.com'
  for text in [secret,file_url,email]:
   issues=guard.scan_content(text.encode())
   self.assertTrue(issues)
   self.assertNotIn(text,str(issues))

 def test_internal_paths_private_networks_and_keys_fail(self):
  samples=['/'+'mnt/afs-project/user/runtime','/'+'home/private-user/data','10'+'.1.2.3','-----BEGIN '+'OPENSSH PRIVATE KEY-----']
  for text in samples:
   self.assertTrue(guard.scan_content(text.encode()),text)

 def test_documented_placeholders_and_loopback_services_remain_usable(self):
  text='account@example.invalid https://www.figma.com/design/replaceWithAssignedCopy/ http://127.0.0.1:18186 http://0.0.0.0:18186'
  self.assertEqual(guard.scan_content(text.encode()),[])

 def test_binary_and_oversized_disguised_source_are_rejected(self):
  self.assertTrue(guard.scan_content(b'abc\x00def'))
  self.assertTrue(guard.scan_content(b'x'*(guard.MAX_FILE_BYTES+1)))

 def test_pre_push_blocks_a_runtime_snapshot_before_it_reaches_a_local_remote(self):
  with tempfile.TemporaryDirectory() as tmp:
   folder=Path(tmp);repo=folder/'source';remote=folder/'remote.git';repo.mkdir()
   def git(*args,check=True,cwd=repo):
    return subprocess.run(['git',*args],cwd=cwd,check=check,text=True,capture_output=True)
   git('init');git('symbolic-ref','HEAD','refs/heads/main')
   git('config','user.name','Synthetic maintainer');git('config','user.email','maintainer@example.invalid')
   git('init','--bare',str(remote));git('remote','add','origin',str(remote))
   (repo/'scripts').mkdir();(repo/'.githooks').mkdir()
   shutil.copy2(ROOT/'scripts/check-release.py',repo/'scripts/check-release.py')
   shutil.copy2(ROOT/'.githooks/pre-push',repo/'.githooks/pre-push')
   git('config','core.hooksPath','.githooks')
   (repo/'README.md').write_text('Synthetic framework fixture\n')
   git('add','README.md','scripts/check-release.py','.githooks/pre-push');git('commit','-m','Synthetic framework')
   good=git('rev-parse','HEAD').stdout.strip();git('push','origin','main')
   (repo/'arena').mkdir();(repo/'arena/snapshot.json').write_text('{"synthetic_runtime":true}\n')
   git('add','arena/snapshot.json');git('commit','-m','Synthetic runtime data must be blocked')
   bad=git('rev-parse','HEAD').stdout.strip()
   pushed=git('push','origin','main',check=False)
   self.assertNotEqual(pushed.returncode,0)
   self.assertIn('not-framework-source',pushed.stdout)
   self.assertEqual(git('--git-dir='+str(remote),'rev-parse','refs/heads/main').stdout.strip(),good)
   self.assertNotEqual(git('--git-dir='+str(remote),'cat-file','-e',bad,check=False).returncode,0)

if __name__=='__main__':unittest.main()

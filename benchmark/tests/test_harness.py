import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('paper_harness', ROOT/'scripts/claude_code_harness.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class PaperProtocolTests(unittest.TestCase):
    def config(self, mode='judge'):
        return h.read(ROOT/'examples'/('judges.example.json' if mode == 'judge' else 'inference.example.json'))

    def fixture(self, folder):
        config = self.config()
        artifact = config['artifacts'][0]
        (folder/'screens').mkdir()
        for name in ['01.png', '02.png']:
            Image.new('RGB', (360, 640), (30, 80, 160)).save(folder/'screens'/name)
        (folder/'task-query.txt').write_text('Synthetic task, no model identity')
        boards = [{'id': im['node_id'], 'name': str(i), 'nodes': 2, 'max_depth': 2, 'size': '360×640',
                   'instances': 0, 'texts': 1, 'images': 0, 'types': ['text×1'], 'names': ['Title']}
                  for i, im in enumerate(artifact['images'])]
        layers = {'board_count': 2, 'boards': boards}
        h.save(folder/'layer-summary.json', layers)
        h.save(folder/'screen-inventory.json', {'file_key': 'Copy', 'workspace': {'id': '3:1', 'name': '03 · Workspace',
               'children': [{'id': b['id'], 'name': '0'+str(i)+'_Screen', 'type': 'FRAME', 'width': 360, 'height': 640}
                            for i, b in enumerate(boards)]}, 'layer_summary': layers})
        return config

    def test_exact_judges_seeds_gate_and_scope_are_enforced(self):
        config = self.config()
        h.validate(config, 'judge')
        changes = [lambda c: c.update(seeds=[1, 2, 3]), lambda c: c.update(repetitions=2),
                   lambda c: c.update(gate_policy='disabled'), lambda c: c.update(scope='full'),
                   lambda c: c['judges'][2].update(paper_model='DeepSeek V4 Flash'),
                   lambda c: c['judges'][0].pop('seed_transport'),
                   lambda c: c['judges'][0].update(returned_model_prefixes=[''])]
        for change in changes:
            bad = copy.deepcopy(config)
            change(bad)
            with self.assertRaises(ValueError):
                h.validate(bad, 'judge')

    def test_full_grid_requires_all_84_by_11_pairs_and_783_screens(self):
        config = self.config('inference')
        template = config['jobs'][0]
        config.update(scope='full', jobs=[])
        for i in range(84):
            for model in config['models']:
                config['jobs'].append({**template, 'id': f'task-{i}-{model["id"]}', 'task_id': f'task-{i}',
                    'source_figma_url': f'https://www.figma.com/design/Source{i}/',
                    'figma_url': f'https://www.figma.com/design/Copy{i}{model["id"]}/',
                    'model_id': model['id'], 'expected_screens': 10 if i < 27 else 9, 'required_screen_names': []})
        h.validate(config, 'inference')
        config['jobs'].pop()
        with self.assertRaises(ValueError):
            h.validate(config, 'inference')

    def test_copy_and_original_cannot_be_reused_even_under_different_urls(self):
        config = self.config('inference')
        config['jobs'][0]['figma_url'] = 'https://www.figma.com/file/SourceStarter001/AnotherName'
        with self.assertRaisesRegex(ValueError, 'Original starter'):
            h.validate(config, 'inference')
        config = self.config('inference')
        config['jobs'].append(dict(config['jobs'][0], id='second'))
        with self.assertRaisesRegex(ValueError, 'distinct writable'):
            h.validate(config, 'inference')

    def test_paper_media_and_separate_empty_workspace_are_distinguished(self):
        pages = [{'name': name, 'child_count': 2} for name in
                 ['00 · Start Here', '01 · Foundations', '02 · Components', '03 · Media']]
        h.validate_starter({'pages': pages})
        pages.append({'name': '03 · Workspace', 'child_count': 0})
        h.validate_starter({'pages': pages})
        pages[-1]['child_count'] = 1
        with self.assertRaises(ValueError):
            h.validate_starter({'pages': pages})
        pages.pop()
        pages[-1]['name'] = '04 · Media'
        with self.assertRaises(ValueError):
            h.validate_starter({'pages': pages})

    def test_snapshot_is_shared_and_tampering_or_missing_screens_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            config = self.fixture(folder)
            frozen = h.freeze_config(config, folder, folder/'batch', 'judge')
            artifact = frozen['artifacts'][0]
            before = h.artifact_fingerprint(artifact, folder/'batch')
            (folder/'task-query.txt').write_text('Changed original')
            self.assertEqual(h.artifact_fingerprint(artifact, folder/'batch'), before)
            Path(artifact['images'][0]['path']).chmod(0o600)
            Path(artifact['images'][0]['path']).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'screenshot changed'):
                h.artifact_fingerprint(artifact, folder/'batch')
            config['artifacts'][0]['images'].pop()
            with self.assertRaisesRegex(ValueError, 'every final product frame'):
                h.artifact_fingerprint(config['artifacts'][0], folder)

    def test_inference_freezes_original_and_only_replaces_the_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            config = self.config('inference')
            original = '前文\n'+config['jobs'][0]['source_figma_url']+'\n后文'
            (folder/'task-query.txt').write_text(original)
            frozen = h.freeze_config(config, folder, folder/'batch', 'inference')
            query = Path(frozen['jobs'][0]['query_file'])
            self.assertEqual(query.read_text(), original.replace('SourceStarter001', 'AssignedCopy001'))
            self.assertEqual(query.with_name('source-query.txt').read_text(), original)

    def test_nine_samples_and_duplicate_or_wrong_seed_cannot_complete_a_block(self):
        config = self.config()
        config['artifacts'][0]['input_sha256'] = 'frozen'
        rubric = h.read(ROOT/'benchmarks/rubrics/fixed-v4.json')
        results = [{'id': config['artifacts'][0]['id'], 'judge_id': j['id'], 'repeat': r, 'seed': h.SEEDS[r-1],
                    'seed_forwarded': True, 'g0_pass': True, 'input_sha256': 'frozen', 'gate_policy': 'required', 'status': 'completed',
                    'score_total': 53, 'values': {q['key']: q.get('max', 2) for q in rubric['questions']}}
                   for j in config['judges'] for r in range(1, 4)]
        row = h.summarize_scores(config, results)[0]
        self.assertTrue(row['complete'])
        self.assertEqual(row['percent'], 100)
        self.assertEqual(sum(d['max_score'] for d in row['dimensions'].values()), 53)
        self.assertTrue(all(d['percent'] == 100 for d in row['dimensions'].values()))
        for broken in [results[:-1], results[:-1]+[results[-2]], [dict(r, seed=1) for r in results]]:
            row = h.summarize_scores(config, broken)[0]
            self.assertFalse(row['complete'])
            self.assertIsNone(row['mean_score'])
            self.assertIsNone(h.summarize_models(config, [row])[0]['percent'])

    def test_read_coverage_requires_successful_image_tool_result(self):
        events = [{'message': {'content': [{'type': 'tool_use', 'name': 'Read', 'id': 'r', 'input': {'file_path': '/tmp/a.png'}}]}},
                  {'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'r', 'content': [{'type': 'text', 'text': 'read'}]}]}}]
        self.assertEqual(h.opened_images(events), set())
        events[-1]['message']['content'][0]['content'] = [{'type': 'image'}]
        self.assertEqual(h.opened_images(events), {'/tmp/a.png'})
        events[-1]['message']['content'][0]['is_error'] = True
        self.assertEqual(h.opened_images(events), set())

    def test_g0_failure_remains_a_valid_zero_and_zeroes_dimension_display(self):
        config = self.config()
        config['artifacts'][0]['input_sha256'] = 'frozen'
        rubric = h.read(ROOT/'benchmarks/rubrics/fixed-v4.json')
        results = [{'id': config['artifacts'][0]['id'], 'judge_id': j['id'], 'repeat': r, 'seed': h.SEEDS[r-1],
                    'seed_forwarded': True, 'g0_pass': False, 'input_sha256': 'frozen', 'gate_policy': 'required',
                    'status': 'completed', 'score_total': 0, 'values': {q['key']: q.get('max', 2) for q in rubric['questions']}}
                   for j in config['judges'] for r in range(1, 4)]
        row = h.summarize_scores(config, results)[0]
        self.assertTrue(row['complete'])
        self.assertEqual(row['mean_score'], 0)
        self.assertTrue(all(d['percent'] == 0 for d in row['dimensions'].values()))

    def test_inference_preflight_and_artifact_export_use_the_paper_pipeline(self):
        async def preflight(*args, **kwargs):
            return {'pages': [{'name': name, 'child_count': 2} for name in
                              ['00 · Start Here', '01 · Foundations', '02 · Components', '03 · Media']]}
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            judge_config = self.fixture(folder)
            inventory = h.read(folder/'screen-inventory.json')
            inventory['file_key'] = 'AssignedCopy001'
            config = self.config('inference')
            config['jobs'][0]['required_screen_names'] = []
            (folder/'task-query.txt').write_text('Design '+config['jobs'][0]['source_figma_url'])
            (folder/'figma-oauth.json').write_text('{}')
            frozen = h.freeze_config(config, folder, folder/'batch', 'inference')
            job, model, account = frozen['jobs'][0], frozen['models'][1], frozen['accounts'][0]
            case = folder/'batch'/job['id']
            case.mkdir()
            async def inspect(*args, **kwargs):
                return inventory
            async def blank(*args, **kwargs):
                return {'status': 'passed', 'screens': [
                    {'node_id': im['node_id'], 'image': str((folder/im['path']).relative_to(folder)),
                     'sha256': h.digest((folder/im['path']).read_bytes())} for im in judge_config['artifacts'][0]['images']]}
            async def capture(*args, **kwargs):
                report = await blank()
                for screen in report['screens']:
                    screen['image'] = os.path.relpath(folder/screen['image'], case)
                return report
            with patch('benchmark_fixture.inspect', preflight), patch('benchmark_artifact_compact.inspect_compact', inspect), \
                 patch('benchmark_blank_screens.check_blank_screens', capture), \
                 patch.object(h, 'run_cli', return_value=({'status': 'generated'}, [])) as cli, \
                 patch.dict(os.environ, {'FIGMA_HARNESS_LOCK_DIR': str(folder/'locks')}):
                result = h.infer_one(frozen, job, model, account, case, folder/'batch')
            self.assertEqual(result['status'], 'success')
            artifact = h.read(case/'artifact.json')
            self.assertEqual(artifact['task_id'], job['task_id'])
            self.assertEqual(Path(artifact['query_file']).read_text(), 'Design '+job['source_figma_url'])
            self.assertEqual(len(artifact['images']), 2)
            prompt = cli.call_args.kwargs['system_prompt']
            self.assertIn('03 · Media', prompt)
            self.assertIn('take multiple screenshots', prompt)
            batch = folder/'batch'
            h.save(batch/'manifest.json', {'protocol': h.PROTOCOL, 'framework': 'claude-code', 'mode': 'inference',
                   'configuration_sha256': h.digest((batch/'config.json').read_bytes())})
            h.save(batch/'results.json', [{'id': job['id'], 'status': 'success'}])
            scope, artifacts, _ = h.artifacts_from_inference(batch)
            self.assertEqual(scope, 'subset')
            self.assertEqual(artifacts[0]['id'], job['id'])
            h.save(batch/'results.json', [{'id': job['id'], 'status': 'acceptance_failed'}])
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                h.artifacts_from_inference(batch)

    def test_seed_forwarding_and_nine_independent_cli_runs_end_to_end(self):
        seen = []
        class Provider(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                seen.append(body['seed'])
                payload = json.dumps({'seed_seen': body['seed']}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *args):
                pass
        provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        thread = threading.Thread(target=provider.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(provider.server_close)
        self.addCleanup(provider.shutdown)
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            config = self.fixture(folder)
            cli = folder/'fixture-cli'
            cli.write_text('#!'+sys.executable+'\n'+r'''
import json,sys,os,urllib.request
from pathlib import Path
if '--version' in sys.argv: print('fixture-cli');sys.exit(0)
sys.stdin.read()
url=os.environ['ANTHROPIC_BASE_URL']+'/v1/messages'
request=urllib.request.Request(url,data=json.dumps({'model':'fixture-model','messages':[]}).encode(),headers={'content-type':'application/json'})
with urllib.request.urlopen(request) as response: response.read()
for i,p in enumerate(Path.cwd().glob('*.png')):
 print(json.dumps({'type':'assistant','message':{'model':'fixture-model','content':[{'type':'tool_use','name':'Read','id':str(i),'input':{'file_path':str(p)}}]}}))
 print(json.dumps({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':str(i),'content':[{'type':'image'}]}]}}))
rubric=json.loads(Path(__file__).with_name('rubric.json').read_text())
print(json.dumps({'type':'result','result':json.dumps({'g0':{'pass':True,'reason':'Synthetic valid artifact'},'scores':[{'key':q['key'],'score':0,'evidence':'第 1 屏顶部标题与主要内容明确对应，主操作可以直接定位，用户能够判断当前任务和后续操作。'} for q in rubric['questions']]}),'is_error':False,'usage':{'input_tokens':10,'output_tokens':20},'num_turns':2}))
''')
            cli.chmod(0o700)
            (folder/'rubric.json').write_bytes((ROOT/'benchmarks/rubrics/fixed-v4.json').read_bytes())
            config.update(claude_bin=str(cli), concurrency=3)
            for judge in config['judges']:
                judge.update(base_url=f'http://127.0.0.1:{provider.server_port}', returned_model_prefixes=['fixture-'])
            h.save(folder/'config.json', config)
            proc = subprocess.run([sys.executable, str(ROOT/'scripts/claude_code_harness.py'), 'judge', '--config',
                  str(folder/'config.json'), '--output', str(folder/'outputs')], env={**os.environ, 'MODEL_API_KEY':'fixture-secret'},
                  capture_output=True, text=True, timeout=60)
            batch = json.loads(proc.stdout.splitlines()[-1])
            diagnostics = {str(p.relative_to(Path(batch['directory']))): p.read_text()
                           for pattern in ['*/result.json', '*/failure.json', '*/stderr.log', '*/transport/proxy.log']
                           for p in Path(batch['directory']).glob(pattern)}
            self.assertEqual(proc.returncode, 0, proc.stderr + json.dumps(diagnostics, ensure_ascii=False))
            self.assertEqual(batch['passed'], 9, proc.stderr + json.dumps(diagnostics, ensure_ascii=False))
            self.assertEqual(sorted(seen), sorted(h.SEEDS*3))
            scores = h.read(Path(batch['directory'])/'scores.json')
            self.assertEqual(scores[0]['mean_score'], 0)
            self.assertTrue(scores[0]['complete'])
            invocations = list(Path(batch['directory']).glob('*/invocation.json'))
            self.assertEqual(len(invocations), 9)
            for file in invocations:
                invocation = file.read_text()
                self.assertNotIn('fixture-secret', invocation)
                self.assertIn('--strict-mcp-config', invocation)
                self.assertIn('--no-session-persistence', invocation)
            generation = h.read(invocations[0].parent/'result.json')
            self.assertEqual(generation['seed_provider_enforcement'], 'unverified')
            self.assertEqual(generation['images_read'], 2)
            self.assertEqual(generation['usage']['output_tokens'], 20)


if __name__ == '__main__':
    unittest.main()

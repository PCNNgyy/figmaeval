#!/usr/bin/env python3
import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import statistics
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / 'server'
sys.path.insert(0, str(SERVER))
PROTOCOL = 'figmaeval-cvpr2027/v1'
SEEDS = [42, 102, 423]
PAPER_MODELS = [
    'Claude Sonnet 5.5', 'Claude Opus 5.5', 'DeepSeek V4 Flash',
    'GPT-6.1 Sol', 'GPT-6 Astra', 'Qwen 3.8 Max', 'Fable 5.1',
    'GLM-5.3 Flash', 'SenseNova 6.8 Flash', 'Gemini 3.5 Flash', 'Kimi K3',
]
PAPER_JUDGES = ['Claude Opus 5.5', 'GPT-6.1 Sol', 'DeepSeek V4.1 Flash']


def read(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def implementation_hashes():
    files = ['scripts/claude_code_harness.py', 'scripts/harness-context.mjs', 'scripts/parse-harness-score.mjs',
             'scripts/arena-judge-result.mjs', 'server/benchmark_design.mjs', 'server/run_compatibility_proxy.mjs',
             'server/benchmark_artifact_compact.py', 'server/benchmark_blank_screens.py', 'server/benchmark_frames.py',
             'server/figma_mcp_stdio_proxy.py', 'server/fixed20_scale.mjs', 'server/fixed_scales/fixed_v4.mjs']
    return {name: digest((ROOT/name).read_bytes()) for name in files}


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}', value):
        raise ValueError('IDs must contain only letters, digits, dots, underscores and hyphens')
    return value


def resolve(base, value):
    return (Path(base) / value).resolve()


def validate_starter(snapshot):
    required = {'00 Start Here', '01 Foundations', '02 Components', '03 Media'}
    seen = set()
    for page in snapshot['pages']:
        name = re.sub(r'\s*[·.\-—]\s*', ' ', page['name']).strip()
        if name in seen or name not in required | {'03 Workspace'}:
            raise ValueError('Unexpected or duplicate starter page: ' + page['name'])
        seen.add(name)
        count = page.get('child_count')
        if type(count) is not int or count < 0 or (name == '03 Workspace' and count != 0) or (name in required and count == 0):
            raise ValueError('References must be nonempty and Workspace must start empty')
    if not required.issubset(seen):
        raise ValueError('Paper starter requires 00 Start Here, 01 Foundations, 02 Components and 03 Media')


def artifact_fingerprint(artifact, base):
    from benchmark_frames import benchmark_product_frame
    inventory = read(resolve(base, artifact['inventory_file']))
    layers = read(resolve(base, artifact['layer_summary_file']))
    nodes = [n['id'] for n in inventory['workspace']['children'] if benchmark_product_frame(n)]
    images = artifact['images']
    if (len(nodes) != artifact['expected_screens'] or len(images) != len(nodes)
            or len(set(nodes)) != len(nodes) or {im['node_id'] for im in images} != set(nodes)):
        raise ValueError('PNG inputs must cover every final product frame exactly once')
    if layers != inventory['layer_summary'] or {b['id'] for b in layers['boards']} != set(nodes):
        raise ValueError('Layer evidence must come from the same complete final inventory')
    if len(layers['boards']) != len(nodes) or layers.get('board_count') != len(nodes) or any(
            not isinstance(b.get('types'), list) or not isinstance(b.get('names'), list)
            or any(type(b.get(k)) is not int or b[k] < 0 for k in ['nodes', 'max_depth', 'instances', 'texts', 'images'])
            for b in layers['boards']):
        raise ValueError('Incomplete per-board structural evidence')
    proof = {'query': digest(resolve(base, artifact['query_file']).read_bytes()),
             'inventory': digest(resolve(base, artifact['inventory_file']).read_bytes()),
             'layers': digest(resolve(base, artifact['layer_summary_file']).read_bytes()), 'images': []}
    for im in images:
        sha = digest(resolve(base, im['path']).read_bytes())
        if im.get('sha256') and im['sha256'] != sha:
            raise ValueError('Frozen screenshot changed')
        proof['images'].append({'node_id': im['node_id'], 'sha256': sha})
    return digest(json.dumps(proof, sort_keys=True).encode())


def freeze_config(config, base, run, mode):
    frozen = json.loads(json.dumps(config))
    tasks = {}
    def copy_input(source, destination):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(resolve(base, source).read_bytes())
        destination.chmod(0o400)
        return str(destination)
    for index, row in enumerate(frozen['jobs' if mode == 'inference' else 'artifacts']):
        folder = run/'inputs'/f'{index:05d}'
        row['query_file'] = copy_input(row['query_file'], folder/'query.txt')
        source_hash = digest(Path(row['query_file']).read_bytes())
        if row['task_id'] in tasks and tasks[row['task_id']] != source_hash:
            raise ValueError('Models of the same task must receive the identical original query')
        tasks[row['task_id']] = source_hash
        if mode == 'inference':
            query_path = Path(row['query_file'])
            source = query_path.read_bytes().decode('utf-8')
            if source.count(row['source_figma_url']) != 1:
                raise ValueError('Source query must contain the exact original starter URL once')
            query_path.chmod(0o600)
            (folder/'source-query.txt').write_text(source)
            query_path.write_text(source.replace(row['source_figma_url'], row['figma_url']))
            query_path.chmod(0o400)
            row['source_query_sha256'] = source_hash
        else:
            row['layer_summary_file'] = copy_input(row['layer_summary_file'], folder/'layers.json')
            row['inventory_file'] = copy_input(row['inventory_file'], folder/'inventory.json')
            for i, im in enumerate(row['images']):
                im['path'] = copy_input(im['path'], folder/f'screen-{i:03d}.png')
                im['sha256'] = digest(Path(im['path']).read_bytes()) if not im.get('sha256') else im['sha256']
            actual = artifact_fingerprint(row, run)
            if row.get('input_sha256') and row['input_sha256'] != actual:
                raise ValueError('Artifact inputs changed since they were frozen')
            row['input_sha256'] = actual
    for account in frozen.get('accounts', []):
        account['auth_file'] = str(resolve(base, account['auth_file']))
    frozen['rubric_sha256'] = digest((ROOT/'benchmarks/rubrics/fixed-v4.json').read_bytes())
    frozen['implementation_sha256'] = implementation_hashes()
    save(run/'config.json', frozen)
    return frozen


@contextmanager
def lease(name):
    root = Path(os.environ.get('FIGMA_HARNESS_LOCK_DIR', str(Path.home() / '.cache/figma-harness/locks')))
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / (digest(name.encode()) + '.lock')).open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def terminate(proc):
    if proc.poll() is not None:
        return
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()


def execute(argv, *, directory, env, prompt, timeout, out, err):
    with Path(out).open('w') as stdout, Path(err).open('w') as stderr:
        proc = subprocess.Popen(argv, cwd=directory, env=env, stdin=subprocess.PIPE,
                                stdout=stdout, stderr=stderr, text=True, start_new_session=True)
        try:
            proc.communicate(prompt, timeout=timeout)
        except BaseException:
            terminate(proc)
            raise
        return proc.returncode


def parse_events(path):
    events = []
    for line in Path(path).read_text().splitlines():
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                events.append(obj)
        except json.JSONDecodeError:
            pass
    final = next((e for e in reversed(events) if e.get('type') == 'result'), {})
    models = sorted({e['message']['model'] for e in events
                     if e.get('type') == 'assistant' and isinstance(e.get('message'), dict)
                     and e['message'].get('model')})
    return events, final, models


def opened_images(events):
    reads, image_results = {}, set()
    for event in events:
        content = (event.get('message') or {}).get('content', [])
        if not isinstance(content, list):
            continue
        for block in content:
            if block.get('type') == 'tool_use' and block.get('name') == 'Read':
                reads[block['id']] = block.get('input', {}).get('file_path')
            if block.get('type') == 'tool_result' and not block.get('is_error'):
                result = block.get('content', [])
                if isinstance(result, list) and any(isinstance(b, dict) and b.get('type') == 'image' for b in result):
                    image_results.add(block.get('tool_use_id'))
    return {str(Path(v).resolve()) for k, v in reads.items() if k in image_results and v}


def clean_environment():
    return {k: v for k, v in os.environ.items()
            if not k.startswith(('ANTHROPIC_', 'CLAUDE_', 'CTTAP_')) and k != 'CLAUDECODE'}


def node_json(config, script, *args):
    return json.loads(subprocess.check_output([config.get('node_bin', 'node'), str(ROOT/'scripts'/script),
                                               *map(str, args)], cwd=ROOT, text=True))


def run_cli(config, model, case, prompt, *, mcp, judge=False, system_prompt=None, seed=None):
    work = case / 'work'
    work.mkdir(exist_ok=True)
    settings = case / 'settings.json'
    tools = ['Read'] if judge else ['mcp__figma__whoami', 'mcp__figma__get_metadata',
                                    'mcp__figma__use_figma', 'mcp__figma__get_screenshot']
    save(settings, {'permissions': {'allow': tools,
                                   'deny': ['Bash', 'Write', 'Edit', 'Agent', 'WebFetch', 'WebSearch']}})
    binary = config.get('claude_bin', 'claude')
    version = subprocess.check_output([binary, '--version'], text=True).strip()
    argv = [binary, '--bare', '--restricted', '--settings', str(settings), '--setting-sources', '',
            '--model', model['cli_model'], '--tools', ','.join(['Read'] if judge else []),
            '--allowedTools', ','.join(tools), '--permission-mode', 'dontAsk', '--disable-slash-commands',
            '--strict-mcp-config', '--mcp-config', str(mcp), '--no-session-persistence',
            '--output-format', 'stream-json', '--verbose']
    if model.get('effort'):
        argv += ['--effort', model['effort']]
    if system_prompt:
        system_file = case / 'system-prompt.txt'
        system_file.write_text(system_prompt)
        argv += ['--append-system-prompt', system_prompt]
    argv += ['-p']
    env = clean_environment()
    secret = os.environ.get(model['api_key_env'], '')
    if not secret:
        raise ValueError('Missing credential environment variable: ' + model['api_key_env'])
    env.update(ANTHROPIC_API_KEY=secret, ANTHROPIC_BASE_URL=model['base_url'],
               CLAUDE_CONFIG_DIR=str(case/'cli-config'), CLAUDE_CODE_NO_MODEL_FALLBACK='1',
               CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS='1',
               CLAUDE_CODE_DISABLE_AUTO_MEMORY='1', DISABLE_AUTOUPDATER='1',
               CLAUDE_CODE_MAX_OUTPUT_TOKENS=str(model.get('max_output_tokens', 16384)),
               API_TIMEOUT_MS=str(int(config.get('api_timeout_seconds', 900)*1000)))
    proxy = None
    proxy_log = None
    started = time.monotonic()
    try:
        if model.get('route_model') or seed is not None:
            transport = case / 'transport'
            transport.mkdir()
            save(transport/'config.json', {'upstream_base_url': model['base_url'],
                 'model_override': model.get('route_model'), 'normalize_text_blocks': True,
                 **({'request_seed': seed} if seed is not None else {})})
            proxy_log = (transport/'proxy.log').open('w')
            proxy = subprocess.Popen([config.get('node_bin', 'node'), str(SERVER/'run_compatibility_proxy.mjs'),
                                      '--config', str(transport/'config.json'), '--state', str(transport/'state.json')],
                                     stdout=proxy_log, stderr=proxy_log, start_new_session=True, env=clean_environment())
            for _ in range(100):
                if (transport/'state.json').exists() and read(transport/'state.json').get('status') == 'ready':
                    break
                if proxy.poll() is not None:
                    raise RuntimeError('Compatibility transport exited before ready')
                time.sleep(.1)
            else:
                raise TimeoutError('Compatibility transport startup timeout')
            env['ANTHROPIC_BASE_URL'] = read(transport/'state.json')['url']
            bypass = ','.join(filter(None, [env.get('NO_PROXY', ''), env.get('no_proxy', ''), '127.0.0.1,localhost,::1']))
            env['NO_PROXY'] = env['no_proxy'] = bypass
        (case/'prompt.txt').write_text(prompt)
        save(case/'invocation.json', {'framework': 'claude-code', 'cli_version': version, 'argv': argv,
             'cwd': str(work), 'prompt_via_stdin': True, 'prompt_sha256': digest(prompt.encode()),
             'configured_cli_model': model['cli_model'], 'configured_route_model': model.get('route_model'),
             'protocol': PROTOCOL, 'seed_requested': seed,
             'effort_requested': model.get('effort'), 'timeout_seconds': config.get('timeout_seconds', 5400)})
        timed_out = False
        try:
            code = execute(argv, directory=work, env=env, prompt=prompt,
                           timeout=config.get('timeout_seconds', 5400), out=case/'events.jsonl', err=case/'stderr.log')
        except subprocess.TimeoutExpired:
            code, timed_out = None, True
        events, final, models = parse_events(case/'events.jsonl')
        metrics = {'framework': 'claude-code', 'cli_version': version, 'returned_models': models,
                   'protocol': PROTOCOL, 'seed_requested': seed,
                   'duration_ms': round((time.monotonic()-started)*1000), 'usage': final.get('usage'),
                   'model_usage': final.get('modelUsage'), 'num_turns': final.get('num_turns'),
                   'cli_duration_ms': final.get('duration_ms'), 'cli_duration_api_ms': final.get('duration_api_ms'),
                   'total_cost_usd': final.get('total_cost_usd'), 'returncode': code}
        save(case/'generation.json', metrics)
        if timed_out:
            return {**metrics, 'status': 'timeout'}, events
        if code or final.get('is_error') or not final.get('result'):
            return {**metrics, 'status': 'inference_failed' if not judge else 'judge_failed'}, events
        if seed is not None:
            receipt_file = case/'transport/seed-transport.jsonl'
            receipts = [json.loads(line) for line in receipt_file.read_text().splitlines()] if receipt_file.exists() else []
            if not receipts or any(r['seed_requested'] != seed for r in receipts) or not any(
                    200 <= r['response_status'] < 300 for r in receipts):
                return {**metrics, 'status': 'seed_transport_unverified'}, events
            metrics.update(seed_forwarded=True, seed_provider_enforcement='unverified')
        prefixes = model['returned_model_prefixes']
        if not models or any(not any(m.casefold().startswith(p.casefold()) for p in prefixes) for m in models):
            return {**metrics, 'status': 'unexpected_returned_model'}, events
        save(case/'generation.json', metrics)
        (case/'output.txt').write_text(final['result'])
        return {**metrics, 'status': 'generated'}, events
    finally:
        if proxy:
            terminate(proxy)
        if proxy_log:
            proxy_log.close()


def prepare_mcp(config, account, job, case, base):
    auth = resolve(base, account['auth_file'])
    if not auth.is_file():
        raise ValueError('Figma OAuth file missing')
    file_key = node_json(config, 'harness-context.mjs', 'inference', case/'context.json')['file_key']
    mcp = case/'mcp.json'
    save(mcp, {'mcpServers': {'figma': {'command': sys.executable,
         'args': [str(SERVER/'figma_mcp_stdio_proxy.py')], 'env': {
         'FIGMA_MCP_AUTH_FILE': str(auth), 'FIGMA_MCP_ASSIGNED_FILE_KEY': file_key,
         'FIGMA_MCP_ALLOWED_TOOLS': 'whoami,get_metadata,use_figma,get_screenshot',
         'FIGMA_MCP_AWAIT_ASYNC_IIFE': '1', 'FIGMA_MCP_BUDGET_FILE': str(case/'mcp-budget.json')}}}})
    return mcp, file_key


def infer_one(config, job, model, account, case, base):
    from benchmark_artifact_compact import inspect_compact
    from benchmark_blank_screens import check_blank_screens
    from benchmark_frames import benchmark_product_frame, SCREEN_COUNT_RULE_VERSION
    from benchmark_screen_count import evaluate_named_screens
    from benchmark_fixture import inspect
    query = resolve(base, job['query_file']).read_bytes().decode('utf-8')
    save(case/'context.json', {'query': query, 'figma_url': job['figma_url'], 'identity': account.get('identity')})
    context = node_json(config, 'harness-context.mjs', 'inference', case/'context.json')
    mcp, file_key = prepare_mcp(config, account, job, case, base)
    with lease('account:' + account.get('identity', str(resolve(base, account['auth_file']))).casefold()), lease('file:' + file_key):
        starter = asyncio.run(asyncio.wait_for(inspect(str(mcp), file_key), config.get('check_timeout_seconds', 600)))
        save(case/'starter-inventory.json', starter)
        validate_starter(starter)
        metrics, _ = run_cli(config, model, case, query, mcp=mcp, system_prompt=context['system_prompt'])
        if metrics['status'] != 'generated':
            return metrics
        save(case/'generation.json', metrics)
        async def inspect():
            return await asyncio.wait_for(inspect_compact(str(mcp), file_key), config.get('check_timeout_seconds', 600))
        inventory = asyncio.run(inspect())
        save(case/'screen-inventory.json', inventory)
        if job.get('required_screen_names'):
            count = evaluate_named_screens(inventory, job['required_screen_names'])
        else:
            actual = sum(benchmark_product_frame(n) for n in inventory['workspace']['children'])
            count = {'rule_version': SCREEN_COUNT_RULE_VERSION, 'expected': job['expected_screens'],
                     'actual': actual, 'passed': actual == job['expected_screens']}
        save(case/'screen-count.json', count)
        blank = asyncio.run(check_blank_screens(mcp, file_key, inventory, count, case,
                                                timeout=config.get('check_timeout_seconds', 600)))
        passed = count['passed'] and blank['status']=='passed'
        if passed:
            save(case/'layer-summary.json', inventory['layer_summary'])
            artifact = {'id': job['id'], 'task_id': job['task_id'], 'design_model_name': model['paper_model'],
                 'query_file': str(resolve(base, job['query_file']).with_name('source-query.txt')), 'inventory_file': str(case/'screen-inventory.json'),
                 'layer_summary_file': str(case/'layer-summary.json'), 'expected_screens': job['expected_screens'],
                 'images': [{'path': str(case/s['image']), 'node_id': s['node_id'], 'sha256': s['sha256']}
                            for s in blank['screens']]}
            artifact['input_sha256'] = artifact_fingerprint(artifact, case)
            save(case/'artifact.json', artifact)
        return {**metrics, 'status': 'success' if passed else 'acceptance_failed',
                'file_key': file_key, 'screen_count': count, 'blank_screen_check': blank}


def judge_one(config, artifact, judge, repetition, case, base):
    from PIL import Image
    if artifact_fingerprint(artifact, base) != artifact['input_sha256']:
        raise ValueError('Frozen scoring input changed')
    work = case/'work'
    work.mkdir()
    paths, proof = [], []
    for i, entry in enumerate(artifact['images'], 1):
        entry = {'path': entry} if isinstance(entry, str) else entry
        source = resolve(base, entry['path'])
        data = source.read_bytes()
        sha = digest(data)
        if entry.get('sha256') and entry['sha256'] != sha:
            raise ValueError('Frozen screenshot changed')
        with Image.open(source) as image:
            if image.format != 'PNG':
                raise ValueError('Judge inputs must be PNG screenshots')
            image.verify()
        dest = work/f'screen-{i:03d}.png'
        dest.write_bytes(data)
        paths.append(str(dest))
        proof.append({'file': dest.name, 'sha256': sha})
    context = {'query': resolve(base, artifact['query_file']).read_bytes().decode('utf-8'), 'images': paths,
               'layer_summary': read(resolve(base, artifact['layer_summary_file'])),
               'gate_policy': config['gate_policy']}
    save(case/'context.json', context)
    save(case/'input-proof.json', {'images': proof, 'query_sha256': digest(context['query'].encode()),
                                 'layer_summary_sha256': digest(json.dumps(context['layer_summary'],sort_keys=True).encode())})
    prompt = node_json(config, 'harness-context.mjs', 'judge', case/'context.json')['prompt']
    save(case/'empty-mcp.json', {'mcpServers': {}})
    seed = config['seeds'][repetition-1]
    metrics, events = run_cli(config, judge, case, prompt, mcp=case/'empty-mcp.json', judge=True, seed=seed)
    if metrics['status'] != 'generated':
        return metrics
    missing = sorted(set(paths)-opened_images(events))
    if missing:
        return {**metrics, 'status': 'incomplete_image_coverage', 'missing_images': missing}
    score = node_json(config, 'parse-harness-score.mjs', case/'output.txt', config['gate_policy'])
    if any(not 30 <= len(text.strip()) <= 120 for text in score['evidence'].values()):
        raise ValueError('Every rubric item requires 30-120 characters of specific evidence')
    return {**metrics, **score, 'status': 'completed', 'images_read': len(paths),
            'input_sha256': artifact['input_sha256'], 'seed': seed,
            'image_sha256': [p['sha256'] for p in proof], 'gate_policy': config['gate_policy'],
            'judge_id': judge['id'], 'repeat': repetition}


def validate(config, mode):
    if config.get('protocol') != PROTOCOL or config.get('scope') not in ('subset', 'full'):
        raise ValueError('Set protocol figmaeval-cvpr2027/v1 and explicit scope: subset or full')
    if mode == 'judge' and config.get('gate_policy') != 'required':
        raise ValueError('The local rubric supplement defines G0; paper gate_policy must be required')
    models = config.get('judges' if mode == 'judge' else 'models', [])
    ids = [identifier(m['id']) for m in models]
    if not ids or len(set(ids)) != len(ids):
        raise ValueError('Unique model IDs required')
    for m in models:
        if not m.get('cli_model') or not m.get('base_url') or not m.get('api_key_env'):
            raise ValueError('Models require cli_model, base_url and api_key_env')
        if not isinstance(m.get('returned_model_prefixes'), list) or not m['returned_model_prefixes'] or any(
                not isinstance(p, str) or not p.strip() for p in m['returned_model_prefixes']):
            raise ValueError('Nonempty returned_model_prefixes required')
        if m.get('paper_model') not in (PAPER_JUDGES if mode == 'judge' else PAPER_MODELS):
            raise ValueError('Unknown paper_model identity; generation DeepSeek V4 and judge V4.1 are distinct')
    if len({m['paper_model'] for m in models}) != len(models):
        raise ValueError('Duplicate paper model identity')
    if mode == 'judge':
        if len(models) != 3 or len({m.get('route_model',m['cli_model']) for m in models}) != 3:
            raise ValueError('Three distinct judge model routes required')
        if config.get('repetitions') != 3 or config.get('seeds') != SEEDS:
            raise ValueError('Paper requires three scoring passes with seeds [42, 102, 423]')
        if any(m.get('seed_transport') != 'request-body' for m in models):
            raise ValueError('Judges must explicitly configure seed_transport: request-body on a compatible gateway')
        rows = config['artifacts']
        for r in rows:
            if not r.get('images') or not r.get('layer_summary_file') or not r.get('inventory_file'):
                raise ValueError('All screenshots, final inventory and a layer summary are required')
            if r.get('design_model_name') not in PAPER_MODELS:
                raise ValueError('Artifact design_model_name must identify a paper generation model')
    else:
        accounts = config['accounts']
        account_ids = [identifier(a['id']) for a in accounts]
        identities = [str(a.get('identity', '')).strip().casefold() for a in accounts]
        if not account_ids or len(set(account_ids)) != len(account_ids) or not all(identities) or len(set(identities)) != len(identities):
            raise ValueError('Unique account IDs and canonical nonempty account identities required')
        rows = config['jobs']
        urls = []
        task_sources = {}
        for r in rows:
            if r['account_id'] not in account_ids or r['model_id'] not in ids:
                raise ValueError('Unknown account/model')
            if type(r['expected_screens']) is not int or r['expected_screens'] < 1:
                raise ValueError('Positive expected_screens required')
            if r.get('required_screen_names') and len(r['required_screen_names']) != r['expected_screens']:
                raise ValueError('Required names must match expected screen count')
            match = re.search(r'^https://(?:www\.)?figma\.com/(?:design|file)/([A-Za-z0-9]+)(?:/|$)', r['figma_url'])
            if not match:
                raise ValueError('Expected assigned Figma copy URL')
            urls.append(match[1])
            if r.get('source_figma_url') == r['figma_url'] or not r.get('source_figma_url'):
                raise ValueError('Distinct read-only source_figma_url and assigned copy required')
            source = re.fullmatch(r'https://(?:www\.)?figma\.com/(?:design|file)/([A-Za-z0-9]+)(?:/[^\s]*)?', r['source_figma_url'])
            if not source or source[1] == match[1]:
                raise ValueError('Original starter file cannot be used as the writable copy')
            if r['task_id'] in task_sources and task_sources[r['task_id']] != source[1]:
                raise ValueError('Models of a task must share one original starter')
            task_sources[r['task_id']] = source[1]
        if len(set(task_sources.values())) != len(task_sources):
            raise ValueError('Distinct tasks need distinct original starters')
        source_keys = {re.search(r'/(?:design|file)/([A-Za-z0-9]+)', r['source_figma_url'])[1] for r in rows}
        if source_keys.intersection(urls):
            raise ValueError('No assigned copy may be any task original starter')
        if len(set(urls)) != len(urls):
            raise ValueError('Every job needs a distinct writable Figma copy')
    row_ids = [identifier(r['id']) for r in rows]
    if not rows or len(set(row_ids)) != len(row_ids):
        raise ValueError('Unique nonempty job/artifact IDs required')
    if not isinstance(config.get('concurrency', 1), int) or config.get('concurrency',1) < 1:
        raise ValueError('Positive concurrency required')
    pairs = [(identifier(r['task_id']), r['design_model_name'] if mode == 'judge' else r['model_id']) for r in rows]
    if len(set(pairs)) != len(pairs):
        raise ValueError('Duplicate task/model pair')
    counts = {}
    for r in rows:
        if type(r.get('expected_screens')) is not int or r['expected_screens'] < 1:
            raise ValueError('Positive expected_screens required')
        if r['task_id'] in counts and counts[r['task_id']] != r['expected_screens']:
            raise ValueError('Screen count differs across models of a task')
        counts[r['task_id']] = r['expected_screens']
    if config['scope'] == 'full':
        if len(counts) != 84 or sum(counts.values()) != 783 or len(rows) != 84*11:
            raise ValueError('Full benchmark requires 84 tasks, 783 required screens and 924 task/model artifacts')
        if mode == 'inference' and set(m['paper_model'] for m in models) != set(PAPER_MODELS):
            raise ValueError('Full inference requires all eleven paper models')
        expected = set(PAPER_MODELS) if mode == 'judge' else set(ids)
        if any({pair[1] for pair in pairs if pair[0] == task} != expected for task in counts):
            raise ValueError('Every task must contain all eleven generation models')


def worker(config_file, mode, row_id, case, judge_id=None, repetition=1):
    os.umask(0o077)
    config = read(config_file)
    base = Path(config_file).parent
    started = time.monotonic()
    case = Path(case).resolve()
    case.mkdir(parents=True, exist_ok=False)
    try:
        if config['implementation_sha256'] != implementation_hashes():
            raise ValueError('Protocol implementation changed during the batch')
        if digest((ROOT/'benchmarks/rubrics/fixed-v4.json').read_bytes()) != config['rubric_sha256']:
            raise ValueError('Rubric changed during the batch')
        if mode == 'inference':
            job = next(r for r in config['jobs'] if r['id']==row_id)
            model = next(m for m in config['models'] if m['id']==job['model_id'])
            account = next(a for a in config['accounts'] if a['id']==job['account_id'])
            result = infer_one(config, job, model, account, case, base)
        else:
            artifact = next(r for r in config['artifacts'] if r['id']==row_id)
            judge = next(m for m in config['judges'] if m['id']==judge_id)
            result = judge_one(config, artifact, judge, repetition, case, base)
    except Exception as error:
        metrics = read(case/'generation.json') if (case/'generation.json').exists() else {}
        result = {**metrics, 'status': 'error', 'error_type': type(error).__name__}
        message = str(error)
        for m in config.get('models', []) + config.get('judges', []):
            secret = os.environ.get(m.get('api_key_env', ''), '')
            if secret:
                message = message.replace(secret, '[redacted]')
        save(case/'failure.json', {'error_type': type(error).__name__, 'message': message[:2000]})
    result.update(id=row_id, mode=mode, judge_id=judge_id, repeat=repetition if judge_id else None,
                  total_duration_ms=round((time.monotonic()-started)*1000))
    save(case/'result.json', result)
    return result


def summarize_scores(config, results):
    rubric = read(ROOT/'benchmarks/rubrics/fixed-v4.json')
    groups = {}
    for q in rubric['questions']:
        groups.setdefault(q['dimension'], []).append(q)
    rows = []
    for artifact in config['artifacts']:
        per_judge = []
        all_samples = []
        for judge in config['judges']:
            selected = [r for r in results if r['id']==artifact['id'] and r['judge_id']==judge['id']]
            scores = [r['score_total'] for r in selected if r['status']=='completed']
            complete = (len(selected) == len(scores) == 3 and {r.get('repeat') for r in selected} == {1, 2, 3}
                        and all(r.get('seed') == SEEDS[r['repeat']-1] and r.get('seed_forwarded') is True
                                and r.get('input_sha256') == artifact['input_sha256']
                                and type(r.get('g0_pass')) is bool
                                and r.get('gate_policy') == 'required' for r in selected))
            if complete:
                all_samples.extend(selected)
            per_judge.append({'judge_id': judge['id'], 'completed': len(scores), 'expected': config['repetitions'],
                              'mean': statistics.mean(scores) if complete else None,
                              'stddev': statistics.stdev(scores) if complete and len(scores)>1 else None})
        complete = all(r['mean'] is not None for r in per_judge)
        dimensions = {}
        if complete:
            for dimension, questions in groups.items():
                maximum = sum(q.get('max', 2) for q in questions)
                raw = statistics.mean(int(r['g0_pass'])*sum(r['values'][q['key']] for q in questions) for r in all_samples)
                dimensions[dimension] = {'mean_score': raw, 'max_score': maximum, 'percent': raw/maximum*100}
        mean = statistics.mean(r['mean'] for r in per_judge) if complete else None
        rows.append({'artifact_id':artifact['id'], 'task_id': artifact['task_id'],
                     'design_model_name': artifact['design_model_name'], 'judges':per_judge, 'complete':complete,
                     'mean_score':mean, 'max_score':53, 'percent':mean/53*100 if mean is not None else None,
                     'dimensions':dimensions})
    return rows


def summarize_models(config, scores):
    output = []
    for model in sorted({a['design_model_name'] for a in config['artifacts']}):
        rows = [r for r in scores if r['design_model_name'] == model]
        complete = all(r['complete'] for r in rows)
        output.append({'model': model, 'scope': config['scope'], 'expected_tasks': len(rows),
                       'completed_tasks': sum(r['complete'] for r in rows),
                       'percent': statistics.mean(r['percent'] for r in rows) if complete else None,
                       'dimensions': {key: statistics.mean(r['dimensions'][key]['percent'] for r in rows)
                                      for key in rows[0]['dimensions']} if complete else {}})
    return output


def artifacts_from_inference(batch):
    batch = Path(batch).resolve()
    manifest = read(batch/'manifest.json')
    config = read(batch/'config.json')
    if (manifest.get('protocol') != PROTOCOL or manifest.get('framework') != 'claude-code'
            or manifest.get('mode') != 'inference'
            or manifest['configuration_sha256'] != digest((batch/'config.json').read_bytes())):
        raise ValueError('Expected an intact paper inference batch')
    results = read(batch/'results.json')
    if len(results) != len(config['jobs']) or any(r['status'] != 'success' for r in results):
        raise ValueError('Inference batch is incomplete; failures must not silently disappear from the judge cohort')
    artifacts = []
    for job in config['jobs']:
        if len([r for r in results if r['id'] == job['id'] and r['status'] == 'success']) != 1:
            raise ValueError('Missing or duplicated accepted inference result')
        item = read(batch/job['id']/'artifact.json')
        model = next(m for m in config['models'] if m['id'] == job['model_id'])
        if (item['id'] != job['id'] or item['task_id'] != job['task_id']
                or item['design_model_name'] != model['paper_model'] or item['expected_screens'] != job['expected_screens']):
            raise ValueError('Artifact identity differs from the inference assignment')
        if digest(Path(item['query_file']).read_bytes()) != job['source_query_sha256']:
            raise ValueError('Original task query changed after inference')
        assigned_key = re.search(r'/(?:design|file)/([A-Za-z0-9]+)', job['figma_url'])[1]
        if read(item['inventory_file'])['file_key'] != assigned_key:
            raise ValueError('Artifact inventory belongs to a different assigned file')
        if artifact_fingerprint(item, batch) != item['input_sha256']:
            raise ValueError('Accepted artifact evidence changed after inference')
        artifacts.append(item)
    return config['scope'], artifacts, digest((batch/'manifest.json').read_bytes())


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['inference', 'judge'])
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--validate-only', action='store_true')
    parser.add_argument('--from-inference', type=Path, help='Judge all accepted artifacts from a complete paper inference batch')
    parser.add_argument('--worker-id', help=argparse.SUPPRESS)
    parser.add_argument('--judge-id', help=argparse.SUPPRESS)
    parser.add_argument('--repeat', type=int, default=1, help=argparse.SUPPRESS)
    args = parser.parse_args()
    config_file = args.config.resolve()
    config = read(config_file)
    if args.from_inference:
        if args.mode != 'judge' or args.worker_id:
            parser.error('--from-inference is only for the parent judge scheduler')
        config['scope'], config['artifacts'], config['inference_manifest_sha256'] = artifacts_from_inference(args.from_inference)
    validate(config, args.mode)
    if args.validate_only:
        print(json.dumps({'valid':True, 'mode':args.mode, 'protocol':PROTOCOL, 'scope':config['scope'],
                          'files_and_credentials_checked':False, 'network_calls':0}))
        return
    if args.worker_id:
        worker(config_file,args.mode,args.worker_id,args.output,args.judge_id,args.repeat)
        return
    run = args.output.resolve()/('batch-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8])
    run.mkdir(parents=True)
    source_config_hash = digest(config_file.read_bytes())
    config = freeze_config(config, config_file.parent, run, args.mode)
    config_file = run/'config.json'
    save(run/'manifest.json',{'framework':'claude-code','mode':args.mode,'configuration_sha256':digest(config_file.read_bytes()),
                             'source_configuration_sha256':source_config_hash, 'protocol':PROTOCOL, 'scope':config['scope'],
                             'seeds':config.get('seeds'), 'rubric_sha256':config['rubric_sha256'],
                             'historical_results_reused':False})
    results=[]
    def launch(item):
        row, judge_id, repeat = item
        name=row['id']+(f'--{judge_id}--r{repeat}' if judge_id else '')
        case=run/name
        argv=[sys.executable,str(Path(__file__).resolve()),args.mode,'--config',str(config_file),
              '--output',str(case),'--worker-id',row['id']]
        if judge_id:
            argv+=['--judge-id',judge_id,'--repeat',str(repeat)]
        code=subprocess.call(argv)
        if code or not (case/'result.json').exists():
            return {'id':row['id'],'judge_id':judge_id,'repeat':repeat,'status':'worker_failed'}
        return read(case/'result.json')
    if args.mode=='inference':
        groups=[[r for r in config['jobs'] if r['account_id']==a['id']] for a in config['accounts']]
        def account_queue(rows):
            return [launch((r,None,1)) for r in rows]
        with ThreadPoolExecutor(max_workers=min(config.get('concurrency',len(groups)),len(groups))) as pool:
            for values in pool.map(account_queue,groups):
                results.extend(values)
                save(run/'results.json',results)
    else:
        items=[(a,j['id'],r) for a in config['artifacts'] for j in config['judges'] for r in range(1,config['repetitions']+1)]
        with ThreadPoolExecutor(max_workers=config.get('concurrency',8)) as pool:
            for value in pool.map(launch,items):
                results.append(value)
                save(run/'results.json',results)
        scores = summarize_scores(config,results)
        save(run/'scores.json',scores)
        save(run/'model-scores.json',summarize_models(config,scores))
    passed = sum(r['status'] in ('completed','success') for r in results)
    print(json.dumps({'directory':str(run),'total':len(results), 'passed':passed}))
    if passed != len(results):
        raise SystemExit(1)


if __name__=='__main__':
    main()

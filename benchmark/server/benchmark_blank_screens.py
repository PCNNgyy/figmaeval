import asyncio
from contextlib import contextmanager
import datetime
import fcntl
import hashlib
import json
import os
import re
import time
from pathlib import Path
from types import SimpleNamespace

from PIL import Image, ImageChops, ImageStat
from benchmark_artifact_compact import inspect_compact
from benchmark_frames import benchmark_product_frame
from benchmark_images import open_page_screenshot
from figma_page_frames import main_async as capture_frames, capture_native_frame, read_token

RULE = 'blank-screen-pixels/v2'
THRESHOLDS = {'white_channel_min': 250, 'blank_white_fraction': 0.9999,
              'blank_stddev_max': 1.0, 'mostly_white_warning_fraction': 0.995,
              'minimum_capture_side': 64,
              'body_horizontal_inset_fraction': 0.03,
              'body_top_inset_fraction': 0.08, 'body_bottom_inset_fraction': 0.08}


@contextmanager
def readonly_check_lease(base, file_key):
    if not re.fullmatch(r'[A-Za-z0-9]+', file_key):
        raise ValueError('Invalid Figma file key')
    directory = Path(base) / 'locks'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / f'readonly-screen-{file_key}.lock').open('a') as lease:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def workspace_identity(snapshot):
    workspace = snapshot.get('workspace')
    return {'file_key': snapshot['file_key'], 'workspace': None if workspace is None else {
        'id': workspace['id'], 'name': workspace['name'],
        'children': [{key: node[key] for key in ['id', 'name', 'type', 'x', 'y', 'width', 'height']}
                     for node in workspace['children']]}}


def apply_recheck_fields(task, fields, count_passed, receipt, checked_at):
    original_status = task.get('pre_white_screen_check_status', task['status'])
    original_error = task.get('pre_white_screen_check_error', task.get('error', ''))
    accepted = original_status == 'success' and count_passed and fields['white_screen_check_passed']
    return {**task, **fields, 'pre_white_screen_check_status': original_status,
            'pre_white_screen_check_error': original_error,
            'white_screen_check_receipt': receipt, 'white_screen_rechecked_at': checked_at,
            'content_check_required': True, 'content_check_passed': fields['white_screen_check_passed'],
            'content_check_rule': RULE, 'empty_screen_count': fields['white_screen_count'],
            'empty_screen_names': fields['white_screen_names'],
            'status': 'success' if accepted else 'failed',
            'error': '; '.join(error for error in [original_error, acceptance_error(fields)] if error)}


def image_metrics(path):
    with open_page_screenshot(path) as source:
        rgba = source.convert('RGBA')
        rgb = Image.alpha_composite(Image.new('RGBA', rgba.size, (255, 255, 255, 255)), rgba).convert('RGB')
        channels = rgb.split()
        minimum = ImageChops.darker(ImageChops.darker(channels[0], channels[1]), channels[2])
        fraction = sum(minimum.histogram()[THRESHOLDS['white_channel_min']:]) / (rgb.width * rgb.height)
        deviation = max(ImageStat.Stat(rgb).stddev)
        full_blank = fraction >= THRESHOLDS['blank_white_fraction'] and deviation <= THRESHOLDS['blank_stddev_max']
        x = int(rgb.width * THRESHOLDS['body_horizontal_inset_fraction'])
        top = int(rgb.height * THRESHOLDS['body_top_inset_fraction'])
        bottom = rgb.height - int(rgb.height * THRESHOLDS['body_bottom_inset_fraction'])
        body = rgb.crop((x, top, rgb.width-x, bottom))
        body_channels = body.split()
        body_minimum = ImageChops.darker(ImageChops.darker(body_channels[0], body_channels[1]), body_channels[2])
        body_fraction = sum(body_minimum.histogram()[THRESHOLDS['white_channel_min']:]) / (body.width * body.height)
        body_deviation = max(ImageStat.Stat(body).stddev)
        body_blank = body_fraction >= THRESHOLDS['blank_white_fraction'] and body_deviation <= THRESHOLDS['blank_stddev_max']
        blank = full_blank or body_blank
        return {'width': rgb.width, 'height': rgb.height, 'white_fraction': fraction,
                'max_channel_stddev': deviation, 'blank': blank,
                'blank_reason': 'full_white' if full_blank else 'empty_body_with_chrome' if body_blank else None,
                'body_white_fraction': body_fraction, 'body_max_channel_stddev': body_deviation,
                'mostly_white': not blank and fraction >= THRESHOLDS['mostly_white_warning_fraction']}


def submitted_frames(inventory, screen_result):
    children = inventory['workspace']['children']
    if screen_result.get('rule_version') == 'required-named-screens/v1':
        supplemental = {n['id'] for n in screen_result['supplemental_frames']}
        return [n for n in children if n.get('type') == 'FRAME' and n['id'] not in supplemental]
    return [n for n in children if benchmark_product_frame(n)]


def audit_captured_content(directory, frames):
    root = Path(directory).resolve()
    screens = []
    groups = {}
    for frame in frames:
        image = (root / frame['file']).resolve()
        if not image.is_relative_to(root) or image == root:
            raise ValueError('Captured product PNG is outside its evidence directory')
        sha = hashlib.sha256(image.read_bytes()).hexdigest()
        result = {'node_id': frame['node_id'], 'name': frame['name'],
                  'sha256': sha, **image_metrics(image)}
        if min(result['width'], result['height']) < THRESHOLDS['minimum_capture_side']:
            raise ValueError('Captured product PNG is too small to verify its content')
        screens.append(result)
        groups.setdefault(sha, []).append(result)
    blank = [s for s in screens if s['blank']]
    return {'kind': 'captured-product-content/v1', 'rule': RULE,
            'status': 'failed' if blank or not screens else 'passed',
            'screens': screens, 'blank_screens': blank,
            'duplicate_groups': [{'sha256': sha, 'node_ids': [s['node_id'] for s in group],
                                  'blank': group[0]['blank']}
                                 for sha, group in groups.items() if len(group) > 1]}


def structural_empty_frames(inventory, frames):
    summaries = {b['id']: b for b in inventory.get('layer_summary', {}).get('boards', []) if b.get('id')}
    return [n for n in frames if n['id'] in summaries and summaries[n['id']]['nodes'] == 0]


def acceptance_fields(check):
    blank = check.get('blank_screens', [])
    return {'white_screen_check_required': True, 'white_screen_check_version': RULE,
            'white_screen_check_status': check['status'],
            'white_screen_check_passed': check['status'] == 'passed',
            'white_screen_count': len(blank) if check['status'] != 'error' else None,
            'white_screen_names': [n['name'] for n in blank],
            'white_screen_check_error': check.get('error', ''),
            'white_screen_check_seconds': check.get('duration_seconds'),
            'mostly_white_screen_names': [n['name'] for n in check.get('mostly_white_screens', [])]}


def acceptance_error(fields):
    if fields['white_screen_check_status'] == 'error':
        return 'White screen check unavailable: ' + fields['white_screen_check_error']
    if not fields['white_screen_check_passed']:
        return f"Blank product screens: {fields['white_screen_count']}; " + ', '.join(fields['white_screen_names'])
    return ''


def _save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.pending-' + str(os.getpid()))
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)


async def check_blank_screens(config_file, file_key, inventory, screen_result, run_dir, *, timeout=300):
    started = time.monotonic()
    folder = Path(run_dir) / 'blank-screen-check'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    report = {'kind': RULE, 'file_key': file_key, 'thresholds': THRESHOLDS,
              'status': 'error', 'blank_screens': [], 'mostly_white_screens': [],
              'screens': [], 'model_calls': 0, 'screenshot_calls': 0,
              'semantic_requirements_checked': False,
              'inventory_sha256': hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()}
    frames = submitted_frames(inventory, screen_result)
    report['expected_screens_to_check'] = len(frames)
    if not frames:
        report['error'] = 'No submitted product frames available for blank-screen verification'
    else:
        empty = structural_empty_frames(inventory, frames)
        if empty:
            report.update(status='failed', method='empty-frame-structure',
                          blank_screens=[{'node_id': n['id'], 'name': n['name'], 'reason': 'zero_descendant_nodes'} for n in empty],
                          pixel_check_skipped='Confirmed empty product frames already fail acceptance')
        else:
            config = json.loads(Path(config_file).read_text())
            env = config['mcpServers']['figma']['env']
            policy = folder / 'capture-policy.json'
            _save(policy, {'capture_screenshots': True, 'purpose': RULE})
            settings = {**env, 'FIGMA_CAPTURE_POLICY_FILE': str(policy),
                        'FIGMA_MCP_ASSIGNED_FILE_KEY': file_key,
                        'FIGMA_MCP_USAGE_PHASE': 'blank_screen_check',
                        'FIGMA_MCP_ALLOWED_TOOLS': 'use_figma,get_screenshot'}
            prior = {key: os.environ.get(key) for key in settings}
            os.environ.update(settings)
            try:
                async with asyncio.timeout(timeout):
                    source = folder / 'inventory.json'
                    _save(source, inventory)
                    options = SimpleNamespace(out_dir=str(folder / 'frames'), file_key=file_key,
                        auth_file=env['FIGMA_MCP_AUTH_FILE'], auth_lib='', inventory_file=str(source),
                        workspace_only=True, max_frames=len(frames), max_dimension=8192,
                        frame_ids=[n['id'] for n in frames], minimum_frame_side=64,
                        native_max_dimension=512, native_only=False, resume=False, tool_timeout=45)
                    captured = await capture_frames(options)
                    report['screenshot_calls'] = captured['figma_calls']
                    entries = json.loads((folder / 'frames/frames.json').read_text())
                    if {e['node_id'] for e in entries} != {n['id'] for n in frames} or len(entries) != len(frames):
                        raise ValueError('Blank-screen images do not cover exactly the submitted product frames')
                    lookup = {n['id']: n for n in frames}
                    for entry in entries:
                        node = lookup[entry['node_id']]
                        path = folder / 'frames' / entry['file']
                        metrics = image_metrics(path)
                        if metrics['blank'] and not entry.get('native_capture'):
                            confirm = folder / 'native-confirmation'
                            (confirm / '_debug').mkdir(parents=True, exist_ok=True, mode=0o700)
                            native = await capture_native_frame(read_token(options.auth_file, ''),
                                {'node_id': node['id'], 'name': node['name'], 'w':node['width'],'h':node['height']},
                                SimpleNamespace(file_key=file_key, max_dimension=512, minimum_frame_side=64), confirm, confirm / '_debug')
                            path = confirm / native['file']
                            metrics = image_metrics(path)
                            report['screenshot_calls'] += 1
                        if min(metrics['width'], metrics['height']) < THRESHOLDS['minimum_capture_side']:
                            raise ValueError('Screenshot is too small to verify blank-screen content: ' + node['id'])
                        result = {'node_id': node['id'], 'name': node['name'], **metrics,
                                  'image': str(path.relative_to(Path(run_dir))),
                                  'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                        report['screens'].append(result)
                        if metrics['blank']:
                            report['blank_screens'].append(result)
                        elif metrics['mostly_white']:
                            report['mostly_white_screens'].append(result)
                    after = await inspect_compact(config_file, file_key)
                    _save(folder / 'inventory-after.json', after)
                    if after['workspace'] != inventory['workspace'] or after['layer_summary'] != inventory['layer_summary']:
                        raise ValueError('Workspace changed during read-only blank-screen verification')
                    report.update(status='failed' if report['blank_screens'] else 'passed', method='rendered-pixels')
            except Exception as error:
                report.update(status='error', error=(str(error) or type(error).__name__)[:800])
            finally:
                for key, value in prior.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
    report['duration_seconds'] = round(time.monotonic() - started, 3)
    report['checked_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    _save(Path(run_dir) / 'blank-screen-check.json', report)
    return report

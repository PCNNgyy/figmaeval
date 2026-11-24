import collections
import hashlib
import json
from pathlib import Path
import re
from benchmark_frame_requirements import expected_frame_count
from benchmark_frames import benchmark_product_frame, SCREEN_COUNT_RULE_VERSION

NAMED_RULE = 'required-named-screens/v1'


def required_screen_names(brief):
    total = expected_frame_count(brief)
    scope = re.split(r'Fixed data\s*&\s*copy|Deliver in your own Figma file', brief, flags=re.I)[0]
    names = [name.strip() for name in re.findall(r'^\s*(\d{2,3}[A-Z]?_[^\n]+)$', scope, re.M)]
    if len(names) != total or len(set(names)) != total:
        raise ValueError('The required screen names are incomplete or ambiguous')
    return names


def evaluate_named_screens(inventory, names):
    if len(set(names)) != len(names) or not names:
        raise ValueError('Unique required names are necessary')
    children = (inventory.get('workspace') or {}).get('children', [])
    frames = [n for n in children if n.get('type') == 'FRAME']
    required = set(names)
    matches = [n for n in frames if n.get('name') in required]
    counts = collections.Counter(n['name'] for n in matches)
    missing = [name for name in names if not counts[name]]
    duplicates = {name: count for name, count in counts.items() if count > 1}
    return {'rule_version': NAMED_RULE, 'expected': len(names), 'actual': len(matches),
            'passed': not missing and not duplicates,
            'matched_unique': len(counts), 'missing_screen_names': missing,
            'duplicate_screen_names': duplicates,
            'supplemental_frames': [{k:n.get(k) for k in ['id', 'name', 'type']} for n in frames if n.get('name') not in required],
            'legacy_product_frame_count': sum(benchmark_product_frame(n) for n in children)}


def task_screen_count(base, task, inventory, expected, plan_hash, brief_sha256):
    policy_file = Path(base) / 'screen-count-policy.json'
    policy = json.loads(policy_file.read_text()) if policy_file.exists() else {}
    entry = policy.get('tasks', {}).get(task['id'])
    if entry is None:
        actual = sum(benchmark_product_frame(n) for n in (inventory.get('workspace') or {}).get('children', []))
        return {'rule_version': SCREEN_COUNT_RULE_VERSION, 'expected': expected, 'actual': actual, 'passed': actual == expected}
    file_matches = entry['file_key'] == task['file_key']
    if not file_matches:
        binding = json.loads((Path(base)/'private/runtime.json').read_text()).get('task_bindings', {}).get(task['id'], {})
        file_matches = (binding.get('source_file_key') == entry['file_key'] and binding.get('file_key') == task['file_key']
                        and binding.get('plan_hash') == plan_hash and binding.get('model_id') == task['model_id']
                        and binding.get('brief_sha256') == entry['brief_sha256'] and bool(binding.get('verified_at')))
    if (policy.get('kind') != 'benchmark-named-screen-count-policy/v1' or policy.get('plan_hash') != plan_hash
        or entry['model_id'] != task['model_id'] or not file_matches
        or entry['brief_sha256'] != brief_sha256 or len(entry['required_names']) != expected
        or inventory.get('file_key') != task['file_key']):
        raise ValueError('Named screen policy differs from the task, brief, or assigned file')
    return {**evaluate_named_screens(inventory, entry['required_names']),
            'screen_count_policy_sha256': hashlib.sha256(policy_file.read_bytes()).hexdigest()}

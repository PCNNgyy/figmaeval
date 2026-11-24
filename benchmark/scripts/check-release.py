#!/usr/bin/env python3
import argparse
import ipaddress
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {'.gitignore', 'README.md', 'package.json', 'package-lock.json', 'requirements.txt', '.githooks/pre-push'}
CODE_EXTENSIONS = {'server': {'.mjs', '.py'}, 'scripts': {'.mjs', '.py'},
                   'arena': {'.html', '.js', '.css'}, 'tests': {'.mjs', '.py'}}
EXAMPLES = {'inference.example.json', 'judges.example.json', 'layer-summary.example.json',
            'task-query.txt', 'ci-workflow.example.yml'}
MAX_FILE_BYTES = 1024 * 1024
PATTERNS = {
    'credential': re.compile(r'(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})'),
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'internal-filesystem-path': re.compile(r'/(?:mnt/afs[^/\s]*|home|Users)/[A-Za-z0-9_.-]+'),
    'internal-service': re.compile(r'\btoken' r'hub\.[A-Za-z0-9.-]+|https?://[^/\s]+\.internal\b'),
}
EMAIL = re.compile(r'[A-Za-z0-9_.+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})')
FIGMA = re.compile(r'https://(?:www\.)?figma\.com/(?:design|file)/([A-Za-z0-9]{20,})')
IPV4 = re.compile(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])')


def allowed_path(name):
    path = PurePosixPath(name)
    parts = path.parts
    if path.is_absolute() or '..' in parts:
        return False
    if name in ROOT_FILES or name == 'benchmarks/rubrics/fixed-v4.json':
        return True
    if len(parts) == 2 and parts[0] == 'examples' and parts[1] in EXAMPLES:
        return True
    if len(parts) == 2 and parts[0] == 'docs' and path.suffix == '.md':
        return True
    if len(parts) == 3 and parts[:2] == ('.github', 'workflows') and path.suffix in {'.yml', '.yaml'}:
        return True
    if parts and parts[0] in CODE_EXTENSIONS and path.suffix in CODE_EXTENSIONS[parts[0]]:
        return len(parts) == 2 or (len(parts) == 3 and parts[:2] == ('server', 'fixed_scales'))
    return False


def scan_content(data):
    if len(data) > MAX_FILE_BYTES:
        return [{'kind': 'oversized-file', 'line': None}]
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return [{'kind': 'binary-file', 'line': None}]
    if '\x00' in text:
        return [{'kind': 'binary-file', 'line': None}]
    found = []
    def record(kind, start):
        item = {'kind': kind, 'line': text.count('\n', 0, start) + 1}
        if item not in found:
            found.append(item)
    for kind, pattern in PATTERNS.items():
        for match in pattern.finditer(text):
            record(kind, match.start())
    for match in EMAIL.finditer(text):
        domain = match[1].lower()
        if not (domain.endswith(('.invalid', '.test', '.example')) or domain in {'example.com', 'example.org', 'example.net'}):
            record('non-placeholder-email', match.start())
    for match in FIGMA.finditer(text):
        if not match[1].lower().startswith(('demo', 'synthetic', 'replace', 'sourcestarter', 'assignedcopy')):
            record('non-placeholder-figma-file', match.start())
    for match in IPV4.finditer(text):
        try:
            address = ipaddress.ip_address(match[0])
        except ValueError:
            continue
        if address.is_private and not address.is_loopback and str(address) != '0.0.0.0':
            record('private-network-address', match.start())
    return found


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def entries(tree=None, working_tree=False):
    if working_tree:
        for raw in git('ls-files', '-c', '-o', '--exclude-standard', '-z').split(b'\0'):
            if raw:
                name = raw.decode('utf-8')
                file = ROOT/name
                yield name, '120000' if file.is_symlink() else '100644', file.read_bytes() if file.is_file() else b'\0'
        return
    args = ('ls-tree', '-r', '-z', tree, '--', '.') if tree else ('ls-files', '--stage', '-z')
    for row in git(*args).split(b'\0'):
        if not row:
            continue
        metadata, name = row.split(b'\t', 1)
        mode, middle, last = metadata.decode().split()
        oid = last if tree else middle
        if not tree and last != '0':
            raise ValueError('Unresolved Git index entries')
        yield name.decode('utf-8'), mode, git('cat-file', 'blob', oid) if mode != '160000' else b'\0'


def audit(tree=None, working_tree=False):
    problems = []
    count = 0
    for name, mode, data in entries(tree, working_tree):
        count += 1
        if not allowed_path(name):
            problems.append({'file': name, 'kind': 'not-framework-source', 'line': None})
        if mode not in {'100644', '100755'}:
            problems.append({'file': name, 'kind': 'symlink-or-submodule', 'line': None})
        problems.extend({'file': name, **problem} for problem in scan_content(data))
    return {'target': tree or ('working-tree' if working_tree else 'index'), 'files': count, 'problems': problems}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument('--tree', help='Audit a committed tree such as HEAD')
    source.add_argument('--working-tree', action='store_true', help='Also inspect new nonignored source before staging')
    parser.add_argument('--history', action='store_true', help='Audit all locally reachable commits as well')
    args = parser.parse_args()
    reports = [audit(args.tree, args.working_tree)]
    if args.history:
        for commit in git('rev-list', '--all').decode().splitlines():
            reports.append(audit(commit))
    print(json.dumps({'framework_only': not any(r['problems'] for r in reports), 'reports': reports}, indent=2))
    if any(r['problems'] for r in reports):
        raise SystemExit(1)


if __name__ == '__main__':
    main()

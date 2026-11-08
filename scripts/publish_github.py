#!/usr/bin/env python3
"""Publish this clean standalone project via PR, never private parent history.
Requires narrowly scoped GH_TOKEN for the pre-created hayate-agent/webui repo.
The publisher never creates repositories, changes protections or auto-merges.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import urllib.error

REPO = 'hayate-agent/webui'
REMOTE = 'https://github.com/' + REPO + '.git'
TOKEN = os.environ.get('GH_TOKEN', '')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


HTTP = urllib.request.build_opener(NoRedirect())


def api(route, body=None, method=None):
    request = urllib.request.Request('https://api.github.com/repos/' + REPO + route,
        data=None if body is None else json.dumps(body).encode(), method=method,
        headers={'Authorization': 'Bearer ' + TOKEN, 'User-Agent': 'Hayate-WebUI-Publisher/1.0', 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json'})
    try:
        with HTTP.open(request, timeout=30) as response:
            raw = response.read(); return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raise RuntimeError('GitHub publication HTTP ' + str(error.code)) from None


def git(directory, *args):
    with tempfile.TemporaryDirectory(prefix='webui-publish-auth-') as home:
        helper = Path(home) / 'credential'
        helper.write_text('''#!/usr/bin/env python3
import os,sys
if len(sys.argv)!=2 or sys.argv[1]!='get':sys.exit(0)
f=dict(line.rstrip('\\n').split('=',1)for line in sys.stdin if '=' in line)
if f.get('protocol')=='https' and f.get('host')=='github.com' and f.get('path')=='hayate-agent/webui.git':
 print('username=x-access-token');print('password='+os.environ['GH_TOKEN']);print()
'''); helper.chmod(0o700)
        result = subprocess.run(['git', '-c', 'credential.helper=', '-c', 'credential.useHttpPath=true', '-c', 'credential.helper=' + str(helper), '-C', str(directory), *args], text=True, capture_output=True, env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'}, timeout=90)
        if result.returncode: raise RuntimeError('Git transport failed; no credentials emitted')
        return result.stdout.strip()


def main():
    if not TOKEN: raise RuntimeError('GH_TOKEN scoped to hayate-agent/webui required')
    root = Path(__file__).resolve().parents[1]
    if git(root, 'status', '--porcelain'): raise RuntimeError('Refuse dirty publication source')
    repo = api('')
    if repo.get('full_name') != REPO or repo.get('private') or repo.get('default_branch') != 'main': raise RuntimeError('Unexpected public repository')
    with tempfile.TemporaryDirectory(prefix='webui-public-export-') as temporary:
        output = Path(temporary); git(output, 'init', '-q', '-b', 'main')
        git(output, 'config', 'user.name', 'Hayate Publisher'); git(output, 'config', 'user.email', 'publisher@users.noreply.github.com')
        # The GitHub history has only public-main ancestry, never Forgejo's parent
        # history. Initial bootstrap contains one public README only.
        branches = api('/branches?per_page=100')
        if not branches:
            (output / 'README.md').write_text('# Hayate WebUI\n\nIndependent dashboard for Hayate agents.\n')
            git(output, 'add', 'README.md'); git(output, 'commit', '-qm', 'Initialize independent Hayate WebUI')
            git(output, 'push', '--force-with-lease=refs/heads/main:', REMOTE, 'HEAD:refs/heads/main')
        git(output, 'fetch', '-q', REMOTE, 'main'); git(output, 'reset', '--hard', 'FETCH_HEAD')
        git(output, 'rm', '-r', '--ignore-unmatch', '.')
        # Only tracked standalone project files, never ignored build/credential data.
        names = git(root, 'ls-files').splitlines()
        if not names or any(name.startswith(('.env', 'node_modules/', 'dist/', '.git/')) or name.startswith('/') or '..' in Path(name).parts for name in names): raise RuntimeError('Unsafe export path')
        for name in names:
            source = root / name
            if source.is_symlink() or not source.is_file(): raise RuntimeError('Unsafe export source')
            target = output / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(source.read_bytes())
        source = git(root, 'rev-parse', 'HEAD')
        (output / 'PUBLIC-SOURCE.json').write_text(json.dumps({'repository': 'https://git.vanillacore.net/harness/webui', 'revision': source}, indent=2) + '\n')
        git(output, 'add', '.')
        if not git(output, 'diff', '--cached', '--name-only'):
            print(json.dumps({'unchanged': True, 'source': source})); return
        git(output, 'commit', '-qm', 'Publish independent WebUI ' + source[:12])
        previous = git(output, 'ls-remote', REMOTE, 'refs/heads/publish/webui').split()
        old = previous[0] if previous else ''
        git(output, 'push', '--force-with-lease=refs/heads/publish/webui:' + old, REMOTE, 'HEAD:refs/heads/publish/webui')
        prs = api('/pulls?state=open&head=hayate-agent:publish/webui&base=main')
        if len(prs) > 1: raise RuntimeError('Ambiguous publication PR')
        payload = {'title': 'Publish independent WebUI ' + source[:12], 'body': 'Separate dashboard source: `' + source + '`. AgentLink/AgentHub remain external Plugins API dependencies. GitHub CI must pass before merge.'}
        pr = api('/pulls/' + str(prs[0]['number']), payload, 'PATCH') if prs else api('/pulls', {**payload, 'head': 'publish/webui', 'base': 'main'})
        print(json.dumps({'pr': pr['html_url'], 'source': source}))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Publication failed: ' + type(error).__name__)
        raise SystemExit(1)

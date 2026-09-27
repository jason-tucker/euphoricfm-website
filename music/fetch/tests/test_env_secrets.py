"""Proof that music-fetch never reads environment secrets.

Three layers:
  1. static: no module other than envguard touches os.environ / getenv /
     putenv, envguard only reads variable NAMES, and every subprocess call
     passes an explicit env= (never inherits);
  2. startup: the real entry point refuses to run (exit 78) when any
     unexpected variable is present, and prints the NAME, never the value;
  3. runtime: through the real entry point, the yt-dlp child's execve
     environment is exactly {PATH, HOME=/tmp}.
"""

import ast
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid

from tests.helpers import STUB

import fetchsvc

PKG = os.path.dirname(os.path.abspath(fetchsvc.__file__))   # works from the repo and from site-packages
ROOT = os.path.dirname(PKG)
ENV_ATTRS = {'environ', 'environb', 'getenv', 'getenvb', 'putenv', 'unsetenv'}
BOOT = ('import sys; sys.path.insert(0, %r); from fetchsvc.__main__ import main; sys.exit(main())' % ROOT)


def _modules():
    for name in sorted(os.listdir(PKG)):
        if name.endswith('.py'):
            with open(os.path.join(PKG, name)) as f:
                yield name, ast.parse(f.read(), name)


class StaticTests(unittest.TestCase):
    def test_only_envguard_touches_the_environment(self):
        for name, tree in _modules():
            for node in ast.walk(tree):
                hit = (isinstance(node, ast.Attribute) and node.attr in ENV_ATTRS) or \
                      (isinstance(node, ast.Name) and node.id in ENV_ATTRS) or \
                      (isinstance(node, ast.alias) and node.name in ENV_ATTRS)
                if hit and name != 'envguard.py':
                    self.fail(f'{name}:{node.lineno} touches the process environment')

    def test_envguard_reads_names_only(self):
        tree = dict(_modules())['envguard.py']
        uses = [n for n in ast.walk(tree) if isinstance(n, ast.Attribute) and n.attr in ENV_ATTRS]
        self.assertEqual(len(uses), 1)
        parents = {id(c): p for p in ast.walk(tree) for c in ast.iter_child_nodes(p)}
        parent = parents[id(uses[0])]
        # os.environ is only ever used as `os.environ.keys()`
        self.assertIsInstance(parent, ast.Attribute)
        self.assertEqual(parent.attr, 'keys')

    def test_every_subprocess_call_passes_explicit_env(self):
        calls = 0
        for name, tree in _modules():
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                        and isinstance(node.func.value, ast.Name) and node.func.value.id == 'subprocess':
                    calls += 1
                    kws = {k.arg for k in node.keywords}
                    self.assertIn('env', kws, f'{name}:{node.lineno} subprocess call without env=')
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    mods = [a.name for a in node.names] + [getattr(node, 'module', None) or '']
                    self.assertFalse({'os.system', 'pty'} & set(mods), name)
        self.assertEqual(calls, 1)  # the single yt-dlp Popen


class StartupRefusalTests(unittest.TestCase):
    def test_refuses_with_secret_in_env_and_never_prints_value(self):
        with tempfile.TemporaryDirectory() as d:
            env = {'PATH': '/usr/bin:/bin', 'HOME': d, 'TICKETS_API_KEY': 'etk.SUPERSECRETVALUE123'}
            p = subprocess.run([sys.executable, '-I', '-B', '-c', BOOT, '--spool-dir', d, '--staging-dir', d],
                               env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(p.returncode, 78, p.stderr)
            self.assertIn('TICKETS_API_KEY', p.stderr)
            self.assertNotIn('SUPERSECRETVALUE', p.stderr + p.stdout)
            self.assertEqual(os.listdir(d), [])  # refused before creating anything

    def test_refuses_proxy_variables(self):
        with tempfile.TemporaryDirectory() as d:
            env = {'PATH': '/usr/bin:/bin', 'HOME': d, 'HTTPS_PROXY': 'http://10.0.0.1:3128'}
            p = subprocess.run([sys.executable, '-I', '-B', '-c', BOOT], env=env,
                               capture_output=True, text=True, timeout=30)
            self.assertEqual(p.returncode, 78)


class RuntimeChildEnvTests(unittest.TestCase):
    def test_entrypoint_child_env_is_exactly_path_and_home(self):
        with tempfile.TemporaryDirectory() as root:
            spool, staging = os.path.join(root, 'spool'), os.path.join(root, 'staging')
            os.makedirs(os.path.join(spool, 'in'))
            os.makedirs(staging)
            uid = str(uuid.uuid4())
            with open(os.path.join(spool, 'in', f'{uid}.json'), 'w') as f:
                json.dump({'uuid': uid, 'url': 'https://soundcloud.com/stub/noart', 'requestedBy': '1'}, f)
            env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'HOSTNAME': 'music-fetch',
                   'LANG': 'C.UTF-8'}
            p = subprocess.run([sys.executable, '-I', '-B', '-c', BOOT, '--once', '--spool-dir', spool,
                                '--staging-dir', staging, '--ytdlp', STUB],
                               env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(p.returncode, 0, p.stderr)
            with open(os.path.join(spool, 'out', f'{uid}.json')) as f:
                self.assertEqual(json.load(f)['status'], 'ok')
            with open(os.path.join(root, f'stub-env-{uid}.json')) as f:
                seen = json.load(f)
            seen.pop('__url__')
            self.assertEqual(seen.pop('__cwd__'), '/tmp')
            self.assertEqual(seen, {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp'})


if __name__ == '__main__':
    unittest.main()

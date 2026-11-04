"""Offline deployment regressions: no network or real Stellar CLI."""
import base64
import binascii
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def strkey(version):
    raw = bytes([version]) + bytes(32)
    return base64.b32encode(raw + binascii.crc_hqx(raw, 0).to_bytes(2, "little")).decode()


class DeployTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cwd = Path(self.temp.name)
        for name in ("deploy-testnet.sh", "deploy_testnet.py"):
            shutil.copy(ROOT / "contracts/soroban" / name, self.cwd / name)
        fake = self.cwd / "stellar"
        fake.write_text('''#!/usr/bin/env python3
import os, sys, json
from pathlib import Path
args = sys.argv[1:]
with open('calls.jsonl', 'a') as f: f.write(json.dumps(args) + '\\n')
if args[:2] == ['keys', 'address']: print(os.environ['PUBLIC_G']); sys.exit(0)
if args[:2] == ['contract', 'build']:
    out = Path('target/wasm32v1-none/release'); out.mkdir(parents=True)
    for name in ['account','ed25519_verifier','webauthn_verifier','account_factory','vault']:
        (out / ('tilcai_' + name + '.wasm')).write_bytes(b'fake wasm')
    sys.exit(0)
count = sum(1 for l in Path('calls.jsonl').read_text().splitlines() if json.loads(l)[1] in ['deploy','upload'])
if count == int(os.environ.get('FAIL_STEP', '0')): sys.exit(1)
if os.environ.get('INVALID_RESULT'): print('unverified'); sys.exit(0)
print('a'*64 if args[1] == 'upload' else os.environ['PUBLIC_C'])
''')
        fake.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(self.cwd) + os.pathsep + os.environ['PATH'], 'PUBLIC_G': strkey(48), 'PUBLIC_C': strkey(16)}
        self.base = ['--source', 'local-identity', '--operator', strkey(48)]

    def run_cli(self, args):
        return subprocess.run(['bash', str(self.cwd / 'deploy-testnet.sh'), *args], cwd=self.cwd, env=self.env, text=True, capture_output=True)

    def calls(self):
        log = self.cwd / 'calls.jsonl'
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def test_invalid_inputs_have_zero_build_upload_deploy(self):
        for tail in [['--unknown'], ['--only', 'typo'], ['--max'], ['--max', "1');print('injection')#"],
                     ['--max', '1.00000001'], ['--max', '0'], ['--max', '-1'], ['--max', '1e2'],
                     ['--max', '1001'], ['--max', str(2**127)], ['--operator', 'G' * 56]]:
            with self.subTest(tail=tail):
                result = self.run_cli(self.base + tail)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(c[:1] == ['contract'] for c in self.calls()))
        self.assertNotEqual(self.run_cli(['--source', 'local-identity']).returncode, 0)
        self.assertFalse(self.calls())

    def test_exact_atomic_amount_and_completed_manifest(self):
        result = self.run_cli(self.base + ['--only', 'vault', '--max', '0.0000001', '--daily', '123.4567890'])
        self.assertEqual(result.returncode, 0, result.stderr)
        deploy = next(c for c in self.calls() if c[:2] == ['contract', 'deploy'])
        self.assertEqual(deploy[deploy.index('--max_per_disbursement')+1], '1')
        self.assertEqual(deploy[deploy.index('--daily_limit')+1], '1234567890')
        journal = json.loads((self.cwd / 'deploy-testnet-manifest.json').read_text())
        self.assertEqual(journal['steps']['vault']['state'], 'COMPLETED')
        self.assertTrue(journal['artifacts']['tilcai_vault'])
        self.assertNotEqual(self.run_cli(self.base).returncode, 0)
        self.assertEqual(sum(c[:2] == ['contract', 'deploy'] for c in self.calls()), 1)

    def test_partial_deployment_cannot_repeat_unknown_operation(self):
        self.env['FAIL_STEP'] = '3'
        result = self.run_cli(self.base)
        self.assertNotEqual(result.returncode, 0)
        journal = json.loads((self.cwd / 'deploy-testnet-manifest.json').read_text())
        self.assertEqual(journal['steps']['ed25519']['state'], 'COMPLETED')
        self.assertEqual(journal['steps']['webauthn']['state'], 'UNKNOWN')
        before = sum(c[:1] == ['contract'] for c in self.calls())
        self.assertNotEqual(self.run_cli(self.base).returncode, 0)
        self.assertEqual(sum(c[:1] == ['contract'] for c in self.calls()), before)

    def test_accounts_only_needs_no_operator(self):
        self.assertEqual(self.run_cli(['--source', 'local-identity', '--only', 'accounts']).returncode, 0)
        self.assertNotIn('vault', json.loads((self.cwd / 'deploy-testnet-manifest.json').read_text())['steps'])

    def test_unverified_cli_result_stays_unknown(self):
        self.env['INVALID_RESULT'] = '1'
        self.assertNotEqual(self.run_cli(self.base + ['--only', 'vault']).returncode, 0)
        self.assertEqual(json.loads((self.cwd / 'deploy-testnet-manifest.json').read_text())['steps']['vault']['state'], 'UNKNOWN')


if __name__ == '__main__':
    unittest.main()

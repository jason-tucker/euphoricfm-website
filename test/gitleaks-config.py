#!/usr/bin/env python3
"""Check the two narrow historical false-positive exceptions.

Usage: python3 test/gitleaks-config.py /path/to/gitleaks
Run with the action's Gitleaks version (8.24.3). All values are synthetic.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


scanner = shutil.which(sys.argv[1] if len(sys.argv) > 1 else "gitleaks")
if not scanner:
    raise SystemExit("gitleaks executable is required")
config = Path(__file__).resolve().parents[1] / ".gitleaks.toml"
placeholder = "replace-with-the-music-client-id"
fixture = "123456789" + "012345678"
canary = "AbCdEfGhIjKlMnOp" + "QrStUvWxYz012345"
alternate_id = "987654321" + "098765432"
env_path = "music/env/events-web.env.example"
test_path = "music/test/events-db.test.ts"
cases = [
    ("exact example placeholder", env_path, f"AUTH_DISCORD_ID={placeholder}\n", []),
    ("other secret in same file", env_path, f"AUTH_DISCORD_SECRET={canary}\n", ["discord-client-secret"]),
    ("placeholder in other file", "music/env/unrelated.env.example", f"AUTH_DISCORD_ID={placeholder}\n", ["discord-client-secret"]),
    ("exact test fixture", test_path, f"const viewer = {{ discordId: '{fixture}' }}\n", []),
    ("other ID in same file", test_path, f"const viewer = {{ discordId: '{alternate_id}' }}\n", ["discord-client-id"]),
    ("fixture in other file", "music/test/unrelated.test.ts", f"const viewer = {{ discordId: '{fixture}' }}\n", ["discord-client-id"]),
]

with tempfile.TemporaryDirectory(prefix="gitleaks-config-") as temporary:
    root = Path(temporary)
    for index, (name, path, body, expected) in enumerate(cases):
        source = root / str(index)
        target = source / path
        target.parent.mkdir(parents=True)
        target.write_text(body)
        # Git mode uses repository-relative paths, as the Actions scan does.
        for command in [
            ["git", "init", "-q"],
            ["git", "add", "."],
            ["git", "-c", "user.name=Scanner Regression", "-c",
             "user.email=scanner@example.invalid", "commit", "-qm",
             "add synthetic scanner fixture"],
        ]:
            subprocess.run(command, cwd=source, check=True, capture_output=True)
        report = root / f"{index}.json"
        result = subprocess.run([
            scanner, "detect", "--redact", "--source", str(source),
            "--config", str(config), "--report-format=json",
            "--report-path", str(report),
        ], capture_output=True, text=True)
        if result.returncode not in (0, 1) or not report.exists():
            raise SystemExit(f"FAIL {name}: scanner did not complete")
        actual = sorted({finding["RuleID"] for finding in json.loads(report.read_text())})
        if actual != expected or result.returncode != bool(expected):
            raise SystemExit(f"FAIL {name}: expected {expected}, found {actual}")
        print(f"PASS {name}")

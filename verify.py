#!/usr/bin/env python3
"""Resolve only the MCP credential, then run the metadata-only live smoke test."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from manage import public_origin, resolve

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--bridge", action="store_true")
args = parser.parse_args()
try:
    env = os.environ.copy()
    env["MCP_REMOTE_URL"] = public_origin() + "/mcp"
    env["MCP_BRIDGE_PYTHON"] = sys.executable
    if not args.bridge:
        env["SOLO_MCP_BRIDGE_TOKEN"] = (
            resolve("SOLO_MCP_REMOTE_TOKEN", "/mcp", True) or ""
        )
    node = shutil.which("node") or str(Path.home() / ".local/bin/node")
    command = [node, str(Path(__file__).with_name("smoke.mjs"))]
    if args.bridge:
        command.append("--bridge")
    raise SystemExit(subprocess.run(command, env=env, timeout=180).returncode)
except Exception:
    print(
        '{"status":"failed","error":"verification_provider_unavailable"}',
        file=sys.stderr,
    )
    raise SystemExit(1)

#!/usr/bin/env python3
"""Start the remote MCP bridge with auth resolved at runtime, never in config."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor"))


def main() -> int:
    os.environ.setdefault("SECRETS_PROVIDER", "infisical-cli")
    os.environ.setdefault("INFISICAL_CLI_ENABLED", "true")
    os.environ["INFISICAL_SECRET_PATH"] = "/mcp"
    binary = shutil.which("infisical") or str(Path.home() / ".local/bin/infisical")
    os.environ.setdefault("INFISICAL_CLI", binary)
    from secret_resolver import get_secret, SecretResolutionError

    try:
        token = get_secret("SOLO_MCP_REMOTE_TOKEN", required=True)
    except SecretResolutionError:
        print(
            "Remote MCP: Infisical authentication is unavailable; reauthenticate the secret manager.",
            file=sys.stderr,
        )
        return 1
    node = shutil.which("node") or str(Path.home() / ".local/bin/node")
    os.environ["SOLO_MCP_BRIDGE_TOKEN"] = token or ""
    os.execv(node, [node, str(Path(__file__).parent / "bridge.mjs")])
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

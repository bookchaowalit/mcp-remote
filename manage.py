#!/usr/bin/env python3
"""Secret-safe remote MCP preflight, bootstrap, deployment and client setup.

Only fixed provider commands run; credentials pass through memory/stdin.
No database, private transcript or repo runtime state is uploaded.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import tomllib
import urllib.error
import urllib.request
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "infra/scripts/utils"))
os.environ.setdefault("SECRETS_PROVIDER", "infisical-cli")
os.environ.setdefault("INFISICAL_CLI_ENABLED", "true")
from secret_resolver import DEFAULT_INFISICAL_PROJECT_ID, get_secret, SecretResolutionError

NAME = "solo-empire-mcp-remote"


@contextlib.contextmanager
def secret_path(path: str):
    previous = os.environ.get("INFISICAL_SECRET_PATH")
    os.environ["INFISICAL_SECRET_PATH"] = path
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("INFISICAL_SECRET_PATH", None)
        else:
            os.environ["INFISICAL_SECRET_PATH"] = previous


def resolve(name: str, path: str, required: bool = False) -> str | None:
    with secret_path(path):
        try:
            return get_secret(name, required=required)
        except SecretResolutionError:
            if required:
                raise
            # Optional upstreams stay explicitly unconfigured when absent or
            # their secret cannot be read; never treat this as connected.
            return None


def cf_request(path: str):
    account = resolve("CLOUDFLARE_ACCOUNT_ID", "/cloudflare", True)
    key = resolve("CLOUDFLARE_API_TOKEN", "/cloudflare", True)
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/accounts/{account}{path}",
        headers={"Authorization": "Bearer " + (key or "")},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"cloudflare_request_failed_http_{exc.code}") from None
    if not payload.get("success"):
        raise RuntimeError("cloudflare_request_failed")
    return payload.get("result")


def public_origin() -> str:
    result = cf_request("/workers/subdomain")
    subdomain = result.get("subdomain") if isinstance(result, dict) else None
    if not subdomain or not re.fullmatch(r"[a-zA-Z0-9-]+", subdomain):
        raise RuntimeError("workers_dev_subdomain_not_configured")
    return f"https://{NAME}.{subdomain}.workers.dev"


def fixed_command(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    result = subprocess.run(args, capture_output=True, text=True, timeout=180, **kwargs)
    if result.returncode:
        # Provider output can include values; expose neither stdout nor stderr.
        raise RuntimeError("provider_command_failed")
    return result


def bootstrap() -> None:
    project = os.environ.get("INFISICAL_PROJECT_ID", DEFAULT_INFISICAL_PROJECT_ID)
    environment = os.environ.get("INFISICAL_ENVIRONMENT", "dev")
    cli = os.environ.get("INFISICAL_CLI", "infisical")
    lookup = subprocess.run([cli, "secrets", "get", "SOLO_MCP_REMOTE_TOKEN", "--plain", "--silent",
                             "--path", "/mcp", "--env", environment, "--projectId", project],
                            capture_output=True, text=True, timeout=30)
    existing = lookup.stdout.strip() if lookup.returncode == 0 else None
    if existing:
        print(json.dumps({"secret": "SOLO_MCP_REMOTE_TOKEN", "status": "exists"}))
        return
    error = (lookup.stderr + lookup.stdout).lower()
    if lookup.returncode != 0 and not ("404" in error and "not found" in error):
        raise RuntimeError("cannot_confirm_mcp_secret_absence")
    # Creating an existing folder may return nonzero; secret save/readback is
    # the actual gate and never overwrites an existing key deliberately.
    subprocess.run([cli, "secrets", "folders", "create", "--name", "mcp", "--path", "/",
                    "--env", environment, "--projectId", project], capture_output=True, timeout=30)
    token = secrets.token_urlsafe(48)
    fd, filename = tempfile.mkstemp(suffix=".env", prefix="solo-mcp-bootstrap-")
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write("SOLO_MCP_REMOTE_TOKEN=" + token + "\n")
        fixed_command([cli, "secrets", "set", "--file", filename, "--path", "/mcp",
                       "--env", environment, "--projectId", project, "--silent"])
    finally:
        Path(filename).unlink(missing_ok=True)
    if resolve("SOLO_MCP_REMOTE_TOKEN", "/mcp", True) != token:
        raise RuntimeError("infisical_readback_failed")
    print(json.dumps({"secret": "SOLO_MCP_REMOTE_TOKEN", "status": "saved_and_verified", "path": "/mcp"}))


def worker_secrets() -> dict[str, str]:
    token = resolve("SOLO_MCP_REMOTE_TOKEN", "/mcp", True)
    values = {"MCP_TOKEN_SHA256": hashlib.sha256((token or "").encode()).hexdigest()}
    for binding, key, path in (
        ("AI_API_READ_TOKEN", "AI_GATEWAY_API_READ_TOKEN", "/ai-gateway"),
        ("AGENCY_CRM_TOKEN", "CRM_API_TOKEN", "/crm"),
        ("INCOME_CRM_TOKEN", "CRM_API_TOKEN", "/income"),
    ):
        value = resolve(key, path)
        if value:
            values[binding] = value
    return values


def deploy() -> None:
    endpoint = public_origin()
    values = worker_secrets()
    wrangler = HERE / "node_modules/wrangler/bin/wrangler.js"
    if not wrangler.exists():
        raise RuntimeError("run_npm_ci_first")
    env = os.environ.copy()
    env["CLOUDFLARE_API_TOKEN"] = resolve("CLOUDFLARE_API_TOKEN", "/cloudflare", True) or ""
    env["CLOUDFLARE_ACCOUNT_ID"] = resolve("CLOUDFLARE_ACCOUNT_ID", "/cloudflare", True) or ""
    env["WRANGLER_SEND_METRICS"] = "false"
    base = [shutil.which("node") or "node", str(wrangler)]
    # The initial version fails closed (503) until its authentication binding
    # is provisioned. Never deploy the legacy MCP or local database.
    fixed_command(base + ["deploy", "--var", "PUBLIC_ORIGIN:" + endpoint], cwd=HERE, env=env)
    fixed_command(base + ["secret", "bulk"], cwd=HERE, env=env, input=json.dumps(values))
    print(json.dumps({"status": "deployed", "origin": endpoint, "secret_names": sorted(values)}))


def configure(endpoint: str, config_path: Path | None = None) -> None:
    url = urlparse(endpoint)
    if url.scheme != "https" or url.username or url.password or url.path != "/mcp" or url.query or url.fragment:
        raise RuntimeError("invalid_mcp_endpoint")
    config = config_path or Path.home() / ".codex/config.toml"
    original = config.read_text() if config.exists() else ""
    parsed = tomllib.loads(original)
    servers = parsed.get("mcp_servers", {})
    if "solo-empire-remote" in servers:
        existing = servers["solo-empire-remote"]
        if existing.get("args") == [str(HERE / "launch.py")] and existing.get("env", {}).get("MCP_REMOTE_URL") == endpoint:
            print(json.dumps({"client": "codex", "status": "already_configured"}))
            return
        raise RuntimeError("existing_remote_config_requires_review")
    def literal(value: str) -> str:
        return json.dumps(value, ensure_ascii=False)
    block = "\n[mcp_servers.solo-empire-remote]\n" + "command = " + literal(sys.executable) + "\n"
    block += "args = [" + literal(str(HERE / "launch.py")) + "]\nstartup_timeout_sec = 60\ntool_timeout_sec = 30\nenabled = true\n"
    block += "\n[mcp_servers.solo-empire-remote.env]\nMCP_REMOTE_URL = " + literal(endpoint) + "\n"
    block += 'SECRETS_PROVIDER = "infisical-cli"\nINFISICAL_CLI_ENABLED = "true"\n'
    block += "INFISICAL_CLI = " + literal(shutil.which("infisical") or "infisical") + "\n"
    updated = original.rstrip() + "\n" + block
    tomllib.loads(updated)
    config.parent.mkdir(parents=True, exist_ok=True)
    fd, filename = tempfile.mkstemp(dir=config.parent, prefix=".mcp-config-")
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(updated)
        os.replace(filename, config)
    finally:
        Path(filename).unlink(missing_ok=True)
    print(json.dumps({"client": "codex", "status": "configured", "endpoint": endpoint, "stored_secret_values": False}))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "bootstrap", "deploy", "configure"))
    parser.add_argument("--endpoint")
    args = parser.parse_args()
    try:
        if args.action == "status":
            result = {"origin": public_origin(), "cloudflare": "reachable"}
            try:
                plans = cf_request("/subscriptions")
                result["rate_plans"] = [p.get("rate_plan", {}).get("id") for p in plans]
            except RuntimeError:
                result["rate_plans"] = "unverified"
            result["mcp_token_configured"] = bool(resolve("SOLO_MCP_REMOTE_TOKEN", "/mcp"))
            print(json.dumps(result))
        elif args.action == "bootstrap":
            bootstrap()
        elif args.action == "deploy":
            deploy()
        else:
            if not args.endpoint:
                parser.error("configure needs --endpoint")
            configure(args.endpoint)
    except (SecretResolutionError, RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        code = str(exc) if type(exc) is RuntimeError and re.fullmatch(r"[a-z0-9_]+", str(exc)) else "secret_manager_or_provider_unavailable"
        print(json.dumps({"status": "failed", "action": args.action, "error": code}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

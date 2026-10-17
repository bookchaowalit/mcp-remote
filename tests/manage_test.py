"""Regression checks for preservation of local client config and secret boundaries."""

import importlib.util
import io
import json
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "manage.py"
spec = importlib.util.spec_from_file_location("remote_mcp_manage", MODULE)
manage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manage)


class ConfigurationTests(unittest.TestCase):
    def test_preserves_unrelated_client_config_and_contains_no_token_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            original = '# user settings\nmodel = "existing-model"\n[mcp_servers.local]\ncommand = "node"\n'
            path.write_text(original)
            with patch("sys.stdout", io.StringIO()):
                manage.configure("https://mcp.example.com/mcp", path)
            configured = path.read_text()
            self.assertTrue(configured.startswith(original.rstrip()))
            data = tomllib.loads(configured)
            self.assertEqual(data["model"], "existing-model")
            self.assertEqual(data["mcp_servers"]["local"]["command"], "node")
            remote = data["mcp_servers"]["solo-empire-remote"]
            self.assertEqual(
                remote["env"]["MCP_REMOTE_URL"], "https://mcp.example.com/mcp"
            )
            self.assertNotIn("SOLO_MCP_REMOTE_TOKEN", configured)
            with patch("sys.stdout", io.StringIO()):
                manage.configure("https://mcp.example.com/mcp", path)
            self.assertEqual(path.read_text(), configured)

    def test_rejects_endpoint_credentials_and_does_not_overwrite_other_remote_config(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            original = '[mcp_servers.solo-empire-remote]\ncommand = "other"\n'
            path.write_text(original)
            for url in [
                "http://mcp.example.com/mcp",
                "https://user:pass@mcp.example.com/mcp",
                "https://mcp.example.com/mcp?token=private",
                "https://mcp.example.com/wrong",
            ]:
                with self.assertRaises(RuntimeError):
                    manage.configure(url, path)
            with self.assertRaisesRegex(
                RuntimeError, "existing_remote_config_requires_review"
            ):
                manage.configure("https://mcp.example.com/mcp", path)
            self.assertEqual(path.read_text(), original)

    def test_worker_receives_hash_not_raw_mcp_token(self):
        def secret(name, path, required=False):
            return (
                "unit-test-private-credential"
                if name == "SOLO_MCP_REMOTE_TOKEN"
                else None
            )

        with patch.object(manage, "resolve", side_effect=secret):
            payload = manage.worker_secrets()
        self.assertEqual(len(payload["MCP_TOKEN_SHA256"]), 64)
        self.assertNotIn("unit-test-private-credential", json.dumps(payload))
        self.assertEqual(set(payload), {"MCP_TOKEN_SHA256"})

    def test_provider_command_output_is_never_exposed_on_failure(self):
        failure = manage.subprocess.CompletedProcess(
            ["test"], 1, "private-value", "private-error"
        )
        with patch.object(manage.subprocess, "run", return_value=failure):
            with self.assertRaisesRegex(RuntimeError, "^provider_command_failed$"):
                manage.fixed_command(["test"])


if __name__ == "__main__":
    unittest.main()

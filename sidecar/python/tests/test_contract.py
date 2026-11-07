"""The client's half of the wire contract (REQ-GAP-02): the same file the relay's Rust test runs.

Each case: a stub sidecar on loopback answers `response`; the client must have sent exactly
`request` and must turn the answer into `outcome`.
"""

import http.server
import json
import pathlib
import re
import socketserver
import sys
import threading
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

import gis_workbench_client as gw  # noqa: E402

CONTRACT = json.loads((HERE.parent / "contract" / "relay-contract.json").read_text(encoding="utf-8"))
TOKEN = CONTRACT["token"]
PAIRING = "ab" * 24


def sample(v):
    """A concrete answer from a contract pattern."""
    if isinstance(v, str):
        if v == "@any":
            return 1
        m = re.fullmatch(r"@hex:(\d+)", v)
        if m:
            return "a" * int(m[1])
        m = re.fullmatch(r"@digits:(\d+)", v)
        if m:
            return "1" * int(m[1])
    if isinstance(v, dict):
        return {k: sample(x) for k, x in v.items()}
    if isinstance(v, list):
        return [sample(x) for x in v]
    return v


def matches(want, got):
    if want == "@any":
        return got is not None
    if isinstance(want, dict):
        return isinstance(got, dict) and set(want) == set(got) and all(matches(v, got[k]) for k, v in want.items())
    if isinstance(want, list):
        return isinstance(got, list) and len(want) == len(got) and all(matches(a, b) for a, b in zip(want, got))
    return want == got


class Stub:
    """One request, one scripted answer; records what arrived."""

    def __enter__(self):
        stub = self
        stub.seen = []
        stub.status = 200
        stub.body = None

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def answer(self):
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b""
                stub.seen.append({"method": self.command, "path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "json": json.loads(raw) if raw else None})
                out = b"" if stub.body is None else json.dumps(stub.body).encode()
                self.send_response(stub.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            do_GET = do_POST = do_DELETE = answer

        class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        self.srv = S(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *a):
        self.srv.shutdown()
        self.srv.server_close()


def subset(want, got):
    if isinstance(want, dict):
        return isinstance(got, dict) and all(k in got and subset(v, got[k]) for k, v in want.items())
    return want == got


class Contract(unittest.TestCase):
    def test_every_case(self):
        cases = [c for c in CONTRACT["cases"] if "client" in c]
        self.assertGreaterEqual(len(cases), 18)
        for case in cases:
            with self.subTest(case["name"]), Stub() as stub:
                spec = case["client"]
                c = gw.Client(stub.port, TOKEN if spec.get("paired", True) else None)
                stub.status = case["response"]["status"]
                stub.body = sample(case["response"].get("json"))
                args = {k: (PAIRING if v == "@pairing" else v) for k, v in spec.get("args", {}).items()}
                out = case["outcome"]
                fn = getattr(c, spec["call"])
                try:
                    r = fn(**args)
                except gw.WorkbenchError as e:
                    self.assertIn("raises", out, repr(e))
                    self.assertEqual(type(e).__name__, out["raises"])
                else:
                    self.assertNotIn("raises", out, repr(r))
                    if "proposal" in out:
                        self.assertIsInstance(r, gw.Proposal)
                        self.assertEqual(r.id, out["proposal"]["id"])
                        self.assertEqual(r.status, out["proposal"]["status"])
                    elif isinstance(out["returns"], dict):
                        self.assertTrue(subset(out["returns"], r), r)
                    else:
                        self.assertEqual(r, out["returns"])
                self.assertEqual(len(stub.seen), 1)
                got = stub.seen[0]
                rq = case["request"]
                self.assertEqual(got["method"], rq["method"])
                self.assertEqual(got["path"], rq["path"].replace("@pairing", PAIRING))
                self.assertEqual(got["headers"].get("authorization"), "Bearer " + TOKEN if rq["auth"] else None)
                self.assertTrue(matches(rq.get("json"), got["json"]), got["json"])
                # What the relay's browser refusal looks for is never sent, and the host is loopback.
                for h in ("origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"):
                    self.assertNotIn(h, got["headers"])
                self.assertEqual(got["headers"]["host"], "127.0.0.1:{}".format(stub.port))


if __name__ == "__main__":
    unittest.main()

"""The client: one connection to the sidecar on this computer, MCP over its relay.

Standard library only. There is no way to name a host: every request goes to 127.0.0.1, through
http.client, which ignores proxy settings and follows no redirect.
"""

import http.client
import json
import os
import re
import socket
import stat
import sys
import tempfile
import time
from pathlib import Path

from . import errors
from .errors import (
    BadMessage,
    NoSidecar,
    NotPaired,
    PairingFailed,
    ProposalNotDecided,
    RelayError,
    RelayTimeout,
    RpcError,
    ToolError,
    TruncatedResult,
)

__version__ = "0.1.0"

LOOPBACK = "127.0.0.1"
PORTS = (47821, 47822, 47823)
PROTOCOL_VERSION = "2025-06-18"
#: The most the sidecar waits for the page.
MAX_TIMEOUT = 300.0
#: How a decided proposal ends: the analyst decided, or it can no longer apply.
FINAL = ("accepted", "rejected", "stale", "failed")

_TRUNCATED = re.compile(r"… \[truncated \d+ characters\]$")
_TOKEN = re.compile(r"^[0-9a-f]{64}$")


def token_path():
    """Where the token is kept: the user's own folder, readable by this user only."""
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "GIS Workbench Client" / "relay-token.json"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / "gis-workbench" / "relay-token.json"


def load_token(path=None):
    """The saved token, or None."""
    p = Path(path) if path else token_path()
    try:
        t = json.loads(p.read_text(encoding="utf-8")).get("token")
    except (OSError, ValueError, AttributeError):
        return None
    return t if isinstance(t, str) and _TOKEN.match(t) else None


def save_token(token, path=None):
    """Write the token readable by this user only, in one step."""
    p = Path(path) if path else token_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".relay-token-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"token": token}, f)
        if sys.platform != "win32":
            os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return p


def forget_token(path=None):
    p = Path(path) if path else token_path()
    try:
        p.unlink()
    except FileNotFoundError:
        pass


def _hello(port, timeout):
    """The sidecar's hello on `port`, or None if something else (or nothing) answers."""
    try:
        status, body = _exchange(port, "GET", "/relay/v1/hello", None, None, timeout)
    except OSError:
        return None
    if status == 200 and isinstance(body, dict) and body.get("service") == "gwb-sidecar":
        return body
    return None


def _exchange(port, method, path, token, payload, timeout):
    """One HTTP request to the sidecar: (status, parsed JSON or None)."""
    headers = {"Accept": "application/json"}
    body = None
    if token:
        headers["Authorization"] = "Bearer " + token
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    conn = http.client.HTTPConnection(LOOPBACK, port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers)
        r = conn.getresponse()
        raw = r.read()
        status = r.status
    finally:
        conn.close()
    if not raw:
        return status, None
    try:
        return status, json.loads(raw.decode("utf-8"))
    except ValueError:
        return status, None


def find_port(timeout=1.5):
    """The port the sidecar answers on."""
    for p in PORTS:
        if _hello(p, timeout):
            return p
    raise NoSidecar("no sidecar answered on 127.0.0.1:47821-47823: start GIS Workbench Sidecar")


class Proposal:
    """A write the app holds until the analyst decides. Nothing has changed yet."""

    def __init__(self, client, id, status="pending", message=""):
        self._client = client
        self.id = id
        self.status = status
        self.message = message
        self.outcome = None

    def __repr__(self):
        return "Proposal({!r}, status={!r})".format(self.id, self.status)

    @property
    def decided(self):
        return self.status in FINAL

    def refresh(self):
        """Ask the app where the proposal stands."""
        r = self._client.call("gw_proposal_status", id=self.id)
        self.status = r["status"]
        self.outcome = r.get("outcome")
        return self.status

    def wait(self, timeout=600.0, interval=1.0):
        """Wait for the analyst's decision; returns the final status."""
        end = time.monotonic() + timeout
        while True:
            if self.refresh() in FINAL:
                return self.status
            left = end - time.monotonic()
            if left <= 0:
                raise ProposalNotDecided("proposal {} is still {}".format(self.id, self.status))
            time.sleep(min(interval, left))


class _Namespace:
    """`client.v2.layers.list()` is `client.v2_call("layers.list")`."""

    def __init__(self, client, prefix=""):
        self._client = client
        self._prefix = prefix

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return _Namespace(self._client, self._prefix + "." + name if self._prefix else name)

    def __call__(self, **arguments):
        return self._client.v2_call(self._prefix, **arguments)


def _tool_name(method):
    return "gw2_" + method.replace(".", "_")


class Client:
    """Drives the page that has the relay on. Use `Client.pair` once, then `Client.connect`."""

    def __init__(self, port, token=None, *, timeout=120.0, next_id=1):
        if not isinstance(port, int) or not 0 < port < 65536:
            raise ValueError("port must be a port number; the host is always 127.0.0.1")
        if token is not None and not _TOKEN.match(token):
            raise ValueError("a relay token is 64 lower-case hexadecimal digits")
        self.port = port
        self.token = token
        self.timeout = min(float(timeout), MAX_TIMEOUT + 10)
        self.server = None
        self._next_id = next_id
        self.v2 = _Namespace(self)

    # ---------------------------------------------------------------- pairing

    @classmethod
    def connect(cls, *, token=None, token_file=None, port=None, timeout=120.0):
        """A client with the token saved by an earlier `pair`, initialised."""
        tok = token or load_token(token_file)
        if not tok:
            raise NotPaired("this computer has no relay token: run `python -m gis_workbench_client pair`", status=401, code="unauthorized")
        c = cls(port or find_port(), tok, timeout=timeout)
        c.initialize()
        return c

    @classmethod
    def pair(cls, name, *, on_code=None, token_file=None, port=None, timeout=120.0, interval=1.0):
        """Ask to pair: `on_code(code)` shows the six digits the sidecar window also shows.

        Returns when the user has checked them and clicked Allow there, with the token saved.
        """
        c = cls(port or find_port(), timeout=timeout)
        start = c.pair_start(name)
        (on_code or (lambda code: print("Check this code in the sidecar window, then click Allow:", code)))(start["code"])
        end = time.monotonic() + start["expires_in"]
        while time.monotonic() < end:
            st = c.pair_status(start["pairing_id"])
            if st["state"] == "approved" and st.get("token"):
                c.token = st["token"]
                save_token(c.token, token_file)
                return c
            if st["state"] in ("denied", "expired"):
                raise PairingFailed("the pairing was {} in the sidecar window".format(st["state"]), state=st["state"])
            time.sleep(interval)
        raise PairingFailed("the pairing request expired", state="expired")

    def pair_start(self, name):
        return self._request("POST", "/relay/v1/pair", {"client": name})

    def pair_status(self, pairing_id):
        return self._request("GET", "/relay/v1/pair/" + pairing_id)

    def forget(self, token_file=None):
        """Revoke this client's token in the sidecar, and drop it here."""
        try:
            self._request("DELETE", "/relay/v1/pair")
        finally:
            self.token = None
            forget_token(token_file)

    # ---------------------------------------------------------------- HTTP

    def hello(self):
        return self._request("GET", "/relay/v1/hello")

    def _request(self, method, path, payload=None, timeout=None):
        try:
            status, body = _exchange(self.port, method, path, self.token, payload, timeout or self.timeout)
        except socket.timeout as e:
            raise RelayTimeout("the sidecar did not answer in time", status=504, code="client_timeout") from e
        except OSError as e:
            raise NoSidecar("no sidecar on 127.0.0.1:{} ({})".format(self.port, e)) from e
        if status >= 400:
            b = body if isinstance(body, dict) else {}
            code = b.get("code", "")
            cls = errors.CODES.get(code, RelayError)
            msg = b.get("error") or "the sidecar answered {}".format(status)
            if cls is NoSidecar:
                raise NoSidecar(msg)
            raise cls(msg, status=status, code=code)
        return body

    # ---------------------------------------------------------------- MCP

    def _take_id(self):
        n = self._next_id
        self._next_id += 1
        return n

    def rpc(self, method, params=None, *, timeout=None):
        """One JSON-RPC request; returns its `result`."""
        m = {"jsonrpc": "2.0", "id": self._take_id(), "method": method}
        if params is not None:
            m["params"] = params
        r = self._request("POST", "/relay/v1/mcp", m, timeout)
        if not isinstance(r, dict) or r.get("id") != m["id"]:
            raise BadMessage("the answer does not match the request", status=502, code="bad_reply")
        if "error" in r:
            e = r["error"]
            raise RpcError(e.get("message", "error"), code=e.get("code", 0))
        return r.get("result")

    def initialize_raw(self):
        return self.rpc("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "gis-workbench-client", "version": __version__}})

    def notify_initialized(self):
        return self._request("POST", "/relay/v1/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"})

    def initialize(self):
        """The MCP handshake; returns the server's description."""
        self.server = self.initialize_raw()
        self.notify_initialized()
        return self.server

    def ping(self):
        return self.rpc("ping")

    def tools(self):
        """The tools this page offers: name, description, input schema, whether read-only."""
        return self.rpc("tools/list")["tools"]

    def resources(self):
        return self.rpc("resources/list")["resources"]

    def read_resource(self, uri):
        """A resource's value, parsed."""
        c = self.rpc("resources/read", {"uri": uri})["contents"][0]
        return json.loads(c["text"])

    def prompts(self):
        return self.rpc("prompts/list")["prompts"]

    def call(self, tool, arguments=None, *, timeout=None, **named):
        """Call a tool.

        A read tool returns its value (parsed JSON, or text). A write tool returns a `Proposal`:
        nothing has changed until the analyst accepts it in the app.
        """
        args = dict(arguments or {}, **named)
        r = self.rpc("tools/call", {"name": tool, "arguments": args}, timeout=timeout)
        text = "".join(c.get("text", "") for c in r.get("content", []) if c.get("type") == "text")
        if r.get("isError"):
            raise ToolError(text or "the tool failed")
        p = (r.get("structuredContent") or {}).get("proposal")
        if p:
            return Proposal(self, p, r["structuredContent"].get("status", "pending"), text)
        if _TRUNCATED.search(text):
            raise TruncatedResult("the result of {} was cut at the page's limit".format(tool), text=text)
        try:
            return json.loads(text)
        except ValueError:
            return text

    def v2_call(self, method, **arguments):
        """Call automation API v2 by method name, such as `layers.list`."""
        return self.call(_tool_name(method), arguments)

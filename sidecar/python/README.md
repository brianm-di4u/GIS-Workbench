# GIS Workbench Python client

Drives GIS Workbench from your own Python, through the optional sidecar on this computer. This is the only route for user Python: the app has no Python inside it.

It uses the standard library only, and needs Python 3.9 or later. The package is the wheel `gis_workbench_client-0.1.0-py3-none-any.whl` in the sidecar's install folder:

```
python -m pip install "<sidecar folder>/python/gis_workbench_client-0.1.0-py3-none-any.whl"
```

## Using it
1. Start the sidecar and open GIS Workbench (Full), paired with it.
2. Pair your scripts, once:
   ```
   python -m gis_workbench_client pair --name "survey script"
   ```
   It prints six digits. The sidecar window shows the same six: check them and click Allow.
3. In the app, open **Sidecar ▸ Python Relay…** and turn it on. It stays on until you turn it off, or the page closes or reloads.
4. Run your script:

```python
from gis_workbench_client import Client

wb = Client.connect()

for layer in wb.v2.layers.list():       # read tools run at once
    print(layer["name"])

proposal = wb.v2.graphics.delete(ids=["g1"])   # a write is a Proposal
print(proposal.status)                  # "pending": nothing has changed
print(proposal.wait())                  # the analyst's decision, made in the app
```

`wb.v2.<group>.<method>(...)` calls automation API v2. `wb.tools()` lists every tool, and `wb.call(name, ...)` calls one.

## What it can and cannot do
- **Reads** run directly, and may move the view or the selection, as those tools do for any MCP client.
- **Writes are proposals.** A tool that would change the project, add a layer or save a file comes back as a `Proposal`. Only the analyst can accept it, in the app; this client has no call that does. A file saved by an accepted proposal goes through the browser's own save or download.
- **Files stay in the app.** A result that is a binary file comes back as a note with its size, not its bytes. Text results stop at 4,000,000 characters and raise `TruncatedResult` rather than arrive short.
- **Everything stays on this computer.** The client has no way to name a host; it talks to 127.0.0.1 only. The sidecar's relay refuses browsers and anything not from loopback, and the tools of remote MCP servers joined to the app are not offered through it.

## Errors
Each exception says what happened and derives from `WorkbenchError`:

| Exception | Meaning |
|---|---|
| `NoSidecar` | No sidecar on 127.0.0.1:47821–47823 |
| `NotPaired` | No valid token: pair again, it may have been revoked |
| `PairingFailed` | Denied in the sidecar window, or expired |
| `NoApp` | No page has the relay on, or the page stopped answering |
| `RelayBusy` | 32 calls are already waiting for the page |
| `RelayTimeout` | The page did not answer in time; a write may still have become a proposal there |
| `BadMessage` | The sidecar refused the message before it reached the page |
| `RpcError` | The page's MCP server answered with an error |
| `ToolError` | A tool failed, or refused its arguments |
| `TruncatedResult` | The result was too long; `.text` holds what arrived |
| `ProposalNotDecided` | `wait` ran out of time; the proposal is still waiting |

## The token
The token is kept in `%LOCALAPPDATA%\GIS Workbench Client\relay-token.json` on Windows and `~/.config/gis-workbench/relay-token.json` on Linux (mode 600). Anything running as you can read it. Revoke it with `python -m gis_workbench_client forget`, or in the sidecar window under Paired pages.

## Tests
`python -m unittest discover -s tests` runs the client's tests. `contract/relay-contract.json` is the wire contract: `tests/test_contract.py` runs it here, and `gwb-sidecar/tests/relay.rs` runs the same file against the relay.

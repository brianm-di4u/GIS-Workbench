"""Drive GIS Workbench from Python, through the sidecar's loopback relay.

    from gis_workbench_client import Client

    Client.pair("my script")          # once: check the code in the sidecar window, click Allow
    wb = Client.connect()             # later runs
    print(wb.v2.layers.list())        # read tools run
    p = wb.v2.graphics.delete(ids=["g1"])   # a write is a Proposal: nothing has changed yet
    print(p.wait())                   # "accepted" or "rejected", by the analyst, in the app

The app must have the relay on (Sidecar > Python Relay...). See README.md.
"""

from .client import FINAL, PORTS, PROTOCOL_VERSION, Client, Proposal, __version__, find_port, forget_token, load_token, save_token, token_path
from .errors import (
    BadMessage,
    NoApp,
    NoSidecar,
    NotPaired,
    PairingFailed,
    ProposalNotDecided,
    RelayBusy,
    RelayError,
    RelayTimeout,
    RpcError,
    ToolError,
    TruncatedResult,
    WorkbenchError,
)

__all__ = [
    "BadMessage",
    "Client",
    "FINAL",
    "NoApp",
    "NoSidecar",
    "NotPaired",
    "PORTS",
    "PROTOCOL_VERSION",
    "PairingFailed",
    "Proposal",
    "ProposalNotDecided",
    "RelayBusy",
    "RelayError",
    "RelayTimeout",
    "RpcError",
    "ToolError",
    "TruncatedResult",
    "WorkbenchError",
    "__version__",
    "find_port",
    "forget_token",
    "load_token",
    "save_token",
    "token_path",
]

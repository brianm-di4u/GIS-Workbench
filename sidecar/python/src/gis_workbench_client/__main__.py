"""`python -m gis_workbench_client pair | status | tools | forget`"""

import argparse
import json
import sys

from .client import Client, find_port, load_token
from .errors import WorkbenchError


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m gis_workbench_client", description="Pair with the GIS Workbench sidecar and look at its relay.")
    ap.add_argument("--token-file", help="keep the token here instead of the default place")
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("pair", help="pair this computer's scripts with the sidecar")
    p.add_argument("--name", default="Python client", help="the name the sidecar window and the Proposals list show")
    sub.add_parser("status", help="is a sidecar running, is this client paired, is a page answering")
    sub.add_parser("tools", help="list the tools the page offers")
    sub.add_parser("forget", help="revoke this client's token")
    a = ap.parse_args(argv)
    try:
        if a.command == "pair":
            Client.pair(a.name, token_file=a.token_file)
            print("Paired.")
        elif a.command == "status":
            print(json.dumps(Client(find_port(), load_token(a.token_file)).hello(), indent=1))
        elif a.command == "tools":
            for t in Client.connect(token_file=a.token_file).tools():
                kind = "read " if t.get("annotations", {}).get("readOnlyHint") else "write"
                print(kind, t["name"])
        elif a.command == "forget":
            Client(find_port(), load_token(a.token_file)).forget(a.token_file)
            print("Forgotten.")
    except WorkbenchError as e:
        print("error:", e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

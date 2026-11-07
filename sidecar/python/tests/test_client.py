"""The client beyond the wire contract: pairing loop, token file, proposals, v2 names, loopback."""

import inspect
import json
import os
import pathlib
import stat
import sys
import tempfile
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))

import gis_workbench_client as gw  # noqa: E402
from gis_workbench_client import client as mod  # noqa: E402
from gis_workbench_client.__main__ import main  # noqa: E402

TOKEN = "ab" * 32


def scripted(*answers):
    """Stand in for one HTTP exchange: each call pops (status, body); records the requests."""
    log = []
    left = list(answers)

    def exchange(port, method, path, token, payload, timeout):
        log.append({"port": port, "method": method, "path": path, "token": token, "payload": payload, "timeout": timeout})
        a = left.pop(0)
        if isinstance(a, Exception):
            raise a
        return a

    exchange.log = log
    return exchange


def tool_reply(i, *, text="", **more):
    return (200, {"jsonrpc": "2.0", "id": i, "result": dict({"content": [{"type": "text", "text": text}], "isError": False}, **more)})


class Pairing(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.file = os.path.join(self.dir.name, "sub", "token.json")

    def start(self):
        return (200, {"pairing_id": "c" * 48, "code": "123456", "expires_in": 180})

    def test_the_code_is_shown_and_the_token_saved(self):
        ex = scripted(self.start(), (200, {"state": "pending"}), (200, {"state": "approved", "token": TOKEN}))
        codes = []
        with mock.patch.object(mod, "_exchange", ex):
            c = gw.Client.pair("my script", port=47821, token_file=self.file, on_code=codes.append, interval=0)
        self.assertEqual(codes, ["123456"])
        self.assertEqual(c.token, TOKEN)
        self.assertEqual(gw.load_token(self.file), TOKEN)
        self.assertEqual(ex.log[0]["payload"], {"client": "my script"})
        if sys.platform != "win32":
            self.assertEqual(stat.S_IMODE(os.stat(self.file).st_mode), 0o600)

    def test_denied_and_expired(self):
        for state in ("denied", "expired"):
            ex = scripted(self.start(), (200, {"state": state}))
            with mock.patch.object(mod, "_exchange", ex), self.assertRaises(gw.PairingFailed) as e:
                gw.Client.pair("x", port=47821, token_file=self.file, on_code=lambda c: None, interval=0)
            self.assertEqual(e.exception.state, state)
        self.assertIsNone(gw.load_token(self.file))

    def test_no_token_says_how_to_pair(self):
        with self.assertRaises(gw.NotPaired) as e:
            gw.Client.connect(token_file=self.file)
        self.assertIn("pair", str(e.exception))

    def test_a_damaged_token_file_is_no_token(self):
        os.makedirs(os.path.dirname(self.file))
        for bad in ("", "{", "[]", '{"token": 5}', '{"token": "short"}', '{"token": "' + "Z" * 64 + '"}'):
            pathlib.Path(self.file).write_text(bad, encoding="utf-8")
            self.assertIsNone(gw.load_token(self.file), bad)

    def test_forget_drops_the_token_even_if_the_sidecar_has_gone(self):
        gw.save_token(TOKEN, self.file)
        c = gw.Client(47821, TOKEN)
        with mock.patch.object(mod, "_exchange", scripted(ConnectionRefusedError("gone"))), self.assertRaises(gw.NoSidecar):
            c.forget(self.file)
        self.assertIsNone(c.token)
        self.assertIsNone(gw.load_token(self.file))

    def test_the_default_place_is_per_user(self):
        with mock.patch.dict(os.environ, {"LOCALAPPDATA": "L", "XDG_CONFIG_HOME": "X"}):
            self.assertIn("relay-token.json", str(gw.token_path()))
            self.assertTrue(str(gw.token_path()).startswith("L" if sys.platform == "win32" else "X"))


class Discovery(unittest.TestCase):
    def test_tries_the_three_ports_and_trusts_only_a_sidecar(self):
        ex = scripted(ConnectionRefusedError("no"), (200, {"service": "something else"}), (200, {"service": "gwb-sidecar"}))
        with mock.patch.object(mod, "_exchange", ex):
            self.assertEqual(gw.find_port(), 47823)
        self.assertEqual([x["port"] for x in ex.log], [47821, 47822, 47823])
        self.assertTrue(all(x["token"] is None for x in ex.log), "no token goes to a port before it says who it is")

    def test_none_answers(self):
        with mock.patch.object(mod, "_exchange", scripted(*[OSError("no")] * 3)), self.assertRaises(gw.NoSidecar):
            gw.find_port()


class Loopback(unittest.TestCase):
    def test_there_is_no_way_to_name_a_host(self):
        for fn in (gw.Client.__init__, gw.Client.connect, gw.Client.pair, mod._exchange):
            names = set(inspect.signature(fn).parameters)
            self.assertFalse(names & {"host", "url", "address", "base", "proxy"}, fn)
        self.assertEqual(mod.LOOPBACK, "127.0.0.1")
        with self.assertRaises(ValueError):
            gw.Client("gwb.example")

    def test_the_connection_is_to_loopback_only(self):
        made = []

        class Conn:
            def __init__(self, host, port, timeout=None):
                made.append((host, port))

            def request(self, *a, **k):
                pass

            def getresponse(self):
                class R:
                    status = 204

                    def read(self):
                        return b""

                return R()

            def close(self):
                pass

        with mock.patch("http.client.HTTPConnection", Conn), mock.patch.dict(os.environ, {"HTTP_PROXY": "http://proxy.example:8080", "http_proxy": "http://proxy.example:8080"}):
            gw.Client(47821, TOKEN).hello()
        self.assertEqual(made, [("127.0.0.1", 47821)])

    def test_a_bad_token_never_leaves_the_constructor(self):
        with self.assertRaises(ValueError):
            gw.Client(47821, "abc\r\nX-Injected: 1")


class Calls(unittest.TestCase):
    def client(self, *answers):
        self.ex = scripted(*answers)
        p = mock.patch.object(mod, "_exchange", self.ex)
        p.start()
        self.addCleanup(p.stop)
        return gw.Client(47821, TOKEN)

    def test_text_that_is_not_json_stays_text(self):
        self.assertEqual(self.client(tool_reply(1, text="ran x")).call("gw_run_command", command="x"), "ran x")

    def test_arguments_by_dict_and_by_name(self):
        c = self.client(tool_reply(1, text="1"), tool_reply(2, text="2"))
        c.call("t", {"a": 1})
        c.call("t", b=2)
        self.assertEqual([x["payload"]["params"]["arguments"] for x in self.ex.log], [{"a": 1}, {"b": 2}])
        self.assertEqual([x["payload"]["id"] for x in self.ex.log], [1, 2])

    def test_v2_names(self):
        c = self.client(tool_reply(1, text="[]"), tool_reply(2, text="[]"), tool_reply(3, text="[]"))
        c.v2.layers.list()
        c.v2.ai.models.list()
        c.v2_call("view.get")
        self.assertEqual([x["payload"]["params"]["name"] for x in self.ex.log], ["gw2_layers_list", "gw2_ai_models_list", "gw2_view_get"])

    def test_a_cut_result_is_an_error_not_silently_short(self):
        with self.assertRaises(gw.TruncatedResult) as e:
            self.client(tool_reply(1, text='[{"a":1… [truncated 9000 characters]')).call("t")
        self.assertTrue(e.exception.text.startswith('[{"a"'))

    def test_a_reply_to_another_request_is_refused(self):
        with self.assertRaises(gw.BadMessage):
            self.client((200, {"jsonrpc": "2.0", "id": 99, "result": {}})).ping()

    def test_error_codes_map_to_named_exceptions(self):
        for code, status, cls in (("no_app", 503, gw.NoApp), ("app_gone", 503, gw.NoApp), ("busy", 429, gw.RelayBusy), ("relay_timeout", 504, gw.RelayTimeout), ("bad_message", 400, gw.BadMessage), ("unauthorized", 401, gw.NotPaired), ("stopping", 503, gw.NoSidecar), ("new_code", 500, gw.RelayError)):
            with self.assertRaises(cls) as e:
                self.client((status, {"code": code, "error": "why"})).ping()
            self.assertIn("why", str(e.exception))

    def test_a_timeout_on_this_side(self):
        import socket

        with self.assertRaises(gw.RelayTimeout):
            self.client(socket.timeout("slow")).ping()

    def test_the_sidecar_stops_mid_call(self):
        with self.assertRaises(gw.NoSidecar):
            self.client(ConnectionResetError("reset")).ping()


class Proposals(unittest.TestCase):
    def rig(self, *statuses, sleep=None):
        answers = [tool_reply(1, text="Proposal p1 created.", structuredContent={"proposal": "p1", "status": "pending"})]
        for i, s in enumerate(statuses):
            answers.append(tool_reply(i + 2, text=json.dumps({"id": "p1", "status": s, "title": "t", "outcome": "done" if s == "accepted" else None})))
        self.ex = scripted(*answers)
        p = mock.patch.object(mod, "_exchange", self.ex)
        p.start()
        self.addCleanup(p.stop)
        return gw.Client(47821, TOKEN).call("gw2_graphics_delete", ids=["g"])

    def test_a_write_is_only_a_proposal(self):
        p = self.rig()
        self.assertEqual((p.id, p.status, p.decided), ("p1", "pending", False))
        self.assertIn("p1", repr(p))

    def test_wait_follows_it_to_the_decision(self):
        p = self.rig("pending", "running", "accepted")
        self.assertEqual(p.wait(interval=0), "accepted")
        self.assertEqual(p.outcome, "done")
        self.assertTrue(p.decided)
        self.assertEqual(self.ex.log[1]["payload"]["params"], {"name": "gw_proposal_status", "arguments": {"id": "p1"}})

    def test_every_final_state_ends_the_wait(self):
        for s in gw.FINAL:
            self.assertEqual(self.rig(s).wait(interval=0), s)

    def test_wait_gives_up_without_deciding(self):
        p = self.rig("pending")
        with self.assertRaises(gw.ProposalNotDecided):
            p.wait(timeout=0, interval=0)
        self.assertEqual(p.status, "pending")

    def test_the_client_can_only_ask(self):
        self.assertFalse({n for n in dir(gw.Proposal) if not n.startswith("_")} & {"accept", "reject", "approve", "apply"})
        self.assertFalse({n for n in dir(gw.Client) if not n.startswith("_")} & {"accept", "reject", "approve", "apply"})


class Cli(unittest.TestCase):
    def test_no_sidecar_is_a_message_not_a_trace(self):
        with mock.patch.object(mod, "_exchange", scripted(*[OSError("no")] * 3)), mock.patch("sys.stderr") as err:
            self.assertEqual(main(["status"]), 1)
        self.assertTrue(err.write.called)


if __name__ == "__main__":
    unittest.main()

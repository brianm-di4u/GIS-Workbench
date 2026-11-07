"""Exceptions of the GIS Workbench client. Each says what happened in plain words."""


class WorkbenchError(Exception):
    """Base class of everything this package raises."""


class NoSidecar(WorkbenchError):
    """No sidecar answered on 127.0.0.1:47821-47823."""


class RelayError(WorkbenchError):
    """The sidecar refused or could not carry a request."""

    def __init__(self, message, *, status=0, code=""):
        super().__init__(message)
        self.status = status
        self.code = code


class NotPaired(RelayError):
    """This client has no valid token: pair it, or it was revoked in the sidecar window."""


class NoApp(RelayError):
    """No page has the relay on, or the page stopped answering."""


class RelayBusy(RelayError):
    """Too many calls are waiting for the page."""


class RelayTimeout(RelayError):
    """The page did not answer in time. A write may still have become a proposal there."""


class BadMessage(RelayError):
    """The sidecar refused the message before it reached the page."""


class PairingFailed(WorkbenchError):
    """The pairing was denied in the sidecar window, or it expired."""

    def __init__(self, message, *, state=""):
        super().__init__(message)
        self.state = state


class RpcError(WorkbenchError):
    """The page's MCP server answered with a JSON-RPC error."""

    def __init__(self, message, *, code=0):
        super().__init__(message)
        self.code = code


class ToolError(WorkbenchError):
    """A tool ran and failed, or its arguments were refused."""


class TruncatedResult(WorkbenchError):
    """The result was longer than the page returns. `text` holds what arrived."""

    def __init__(self, message, *, text=""):
        super().__init__(message)
        self.text = text


class ProposalNotDecided(WorkbenchError):
    """`Proposal.wait` ran out of time; the proposal is still waiting for the analyst."""


CODES = {
    "unauthorized": NotPaired,
    "no_app": NoApp,
    "app_gone": NoApp,
    "busy": RelayBusy,
    "relay_timeout": RelayTimeout,
    "bad_message": BadMessage,
    "stopping": NoSidecar,
}

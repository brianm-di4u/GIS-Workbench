# DN-70 CSM plug-in host (2.6, REQ-GAP-25)

**Status: off.** OD-2.18 keeps third-party plug-ins off until the sidecar is signed and has passed its external security review. Nothing described here is reachable in a shipped build. This note is the published interface a plug-in would be built to.

The project distributes no plug-ins. There is no general plug-in framework: this host takes CSM 3.0.x sensor models and nothing else.

## What keeps it off

Three locks, each enough alone:

| Lock | Where | Proved by |
|---|---|---|
| The `csm-host` Cargo feature. Without it the host's code is not compiled, every `/v1/csm` path answers 403 `csm_off`, and `--test-allow-csm` is an unknown flag | `gwb-sidecar/src/csmhost.rs`, `config.rs` | `tests/csmgate.rs` (a test run, with the test field set); `csm_host_stays_off` in `tests/security.rs` |
| With the feature, the `csm-plugin` gate needs `--test-allow-csm` and `GWB_SIDECAR_TEST=1` | `Config::gate_open` | `csm_host_stays_off`; `no_other_gate_name_opens` |
| No package holds the host, the CSM API library or a mock, and the service binary must refuse the flag | `sidecar/installer/gates.mjs`, called by `package.mjs` and `package-linux.mjs` | `tests/unit/csm-gate.test.js` |

To turn it on after the review: set the feature in the package builds, add the host to a module, replace `test_csm_host` with that module's path, and change `gates.mjs` and the tests above in the same change. That is a deliberate edit in five places, not a setting.

## A plug-in's path

No code of a plug-in runs before the third step.

1. **Recorded.** `POST /v1/csm/plugins` names a file. The sidecar refuses anything but a native library of this system, copies it to its own folder, and records the SHA-256 and what the system says of the signer as `pending`.
   - Windows: `WinVerifyTrust` from cached revocation data only (REQ-SDC-14), then the certificate's name and thumbprint. `valid`, `untrusted`, `unsigned` or `invalid`.
   - Linux: `unchecked`. A shared object carries no signature a host can check.
2. **Approved.** The user approves or refuses it in the sidecar window (`POST /ui/api/csm/decide`, which needs the window's secret). A page's token cannot. An unsigned plug-in can be approved: the signer is shown, not judged.
3. **Started.** `POST /v1/csm/sessions` copies the stored file and the ISD into a new run folder, hashes that copy against the approved hash, and starts one host on it.

## The sandbox

| | Windows | Linux |
|---|---|---|
| Network | AppContainer with no capabilities: none, loopback included | seccomp: no `socket`, `socketpair`, `connect`, `bind`, `listen`, `accept`, `io_uring_setup`; Landlock TCP rules as well |
| Files read | Only the run folder (granted to the container) and what every AppContainer may read, such as System32 | Landlock: the run folder, `/usr`, `/lib`, `/lib64`, `ld.so.cache`, `/dev/null` |
| Files written | The run folder's `tmp` | The same |
| New processes | Job process cap of 1, and child processes refused at creation | seccomp: no `fork`, `vfork`, `execve`, `clone` without `CLONE_THREAD` |
| Limits | Job Object: 2 GiB, 600 s CPU; kill on close; UI restrictions | rlimits: 2 GiB address space, 600 s CPU, 64 files, 1 GiB file size; parent-death signal; process group |
| Integrity | Low, as every AppContainer | Not a Linux idea: Landlock takes its place |

The tool sandbox of `winjob.rs` is not enough: Low integrity alone stops neither reads nor sockets, and the proxy settings that hold a tool back do not bind native code.

The host checks its own confinement before it loads anything: on Windows the token must be an AppContainer's at Low integrity, and on Linux it installs its filter and proves it with a `socket` call that must fail. If not, HELLO says so, the sidecar stops, and the plug-in is never loaded. Without Landlock ABI 4 there is no session. `GWB_SIDECAR_TOOL_IL=medium`, the diagnostic switch for tools, does not apply: the host refuses to start under it.

Limits of the sandbox that remain:
- A plug-in holds the protocol's pipe handles in its own process and can forge replies. The sidecar therefore treats each reply as untrusted (below), and a forged geometry is still possible: an approved plug-in is trusted for its numbers.
- The host's memory limit surfaces as an allocation failure inside the plug-in, so a plug-in that catches it keeps running. The wall and CPU limits still end it.
- One library file per plug-in. A plug-in with dependent libraries or data files does not run yet.

## The protocol

Length-framed binary on the host's stdin and stdout, little-endian. Before it loads anything the host moves these off fds 0 and 1, so what a plug-in prints does not reach the wire.

```
frame   = magic u32, op or status u32, id u32, length u32, payload
magic   = "GCSQ" request, "GCSR" reply; a reply's id is its request's
length  ≤ 16 MiB
strings = count u32 (≤ 16), then length u32 (≤ 4096) and bytes for each
numbers = f64, every one finite
```

| Op | Request | Reply |
|---|---|---|
| 1 HELLO | nothing | strings: `gwb-csm-host`, protocol, CSM version built against, confinement |
| 2 LOAD | nothing | strings: plug-in, manufacturer, release date, CSM version, model count |
| 3 OPEN | strings: ISD path, model name or empty | strings: model, version, sensor, platform, collection, trajectory, sensor type, sensor mode |
| 4 G2I | numbers: x, y, z, precision for each point (≤ 65536) | numbers: line, sample, achieved precision |
| 5 I2G | numbers: line, sample, height, precision for each point | numbers: x, y, z, achieved precision |
| 6 PARTIALS | numbers: x, y, z | numbers: 6 ground partials, then line and sample by each parameter |
| 7 COVARIANCE | numbers: line, sample | numbers: unmodelled line², line·sample, sample²; parameter count n; n² covariances |
| 8 QUIT | nothing | none |

Status: 0 ok, 1 bad request, 2 not ready, 3 CSM version, 4 no model, 5 CSM error, 6 plug-in exception, 7 load failed, 8 sandbox. Any status but 0 carries one string, the reason. A bad magic or an oversized length ends the host with no reply.

**What the sidecar does with a reply.** Magic, id, size and count are checked, numbers must be finite, and strings lose control characters. A reply that fails ends the session (`csm_bad_reply`). So do a host that dies (`csm_host_ended`) and one that passes the wall limit of 60 s (`csm_host_timeout`). A `csm::Error` or C++ exception is an answer (`csm_error`), and the session stays open. Nothing in this list touches the sidecar or another session.

HTTP: `/v1/csm/sessions/{id}/g2i`, `/i2g`, `/partials` and `/covariance` map one to one to ops 4 to 7, and the schema is in `sidecar/schema/api.schema.json`. Sessions belong to the pairing that opened them, at most four are open, and an idle one closes after 5 minutes.

Coordinates are CSM's own: ECEF metres, image line and sample with CSM's origin, and height above the model's ellipsoid. The sidecar does not convert them.

## For a plug-in author

A CSM 3.0.x model can connect in either of two ways. Both are interfaces only: the project ships no plug-ins and makes no compliance claim.

**1. As a CSM plug-in through this host.** Once the gate is lifted, supply one shared library that:
- registers one `csm::Plugin` when it loads, as CSM 3.0 requires (a static instance);
- states `getCsmVersion()` 3.0.x, or the host refuses it with `csm_version`;
- builds a `csm::RasterGM`, or `csm_no_model`, from a filename ISD (`csm::Isd(filename)`), the only ISD form the protocol carries;
- links the CSM API as a shared library (`csmapi.dll`, `libcsmapi.so`) and, on Windows, the same dynamic C++ runtime as the host, because `std::string` crosses the interface;
- works with no network, no new process, and no file outside its run folder. A licence server or a data store outside that folder will not work here; a plug-in that needs one needs a change to this design, and a new review.

**2. Through the sensor-model C ABI in the browser** (REQ-GAP-24, `build/csm/src/gw_csm.cpp`): usgscsm's interface in WebAssembly, for models that can be compiled to it.

The contract is `sidecar/csmhost/contract/csm-host-contract.json`, made by `make-contract.mjs` from the mock's written formulas with no code of the host or the sidecar. `tests/csmhost.rs` and `tests/e2e/sidecar/26-csmhost.spec.js` both hold the path through the sidecar, the host and a mock plug-in to its numbers. Passing it says the protocol is carried faithfully. It says nothing about any real plug-in.

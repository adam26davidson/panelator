# 111. Backend: the Rust workspace with its checks, and a WebSocket relay stub for the spike

Status: written 2026-11-23 for issue #432, the planned child
`backend-workspace-and-relay-stub` of the v0 build design; a spec derived
from its parent design needs no maintainer approval (delivery-system design
section 11).
Class: product. Domain: backend (sensitive paths: `.github/workflows/ci.yml`,
under `.github/`, and everything under `backend/crates/relay/`, matched by
`backend/**/relay/**`; process-spec section 5).
Parent: docs/designs/product-v0-build.md
Derives from: [v0 build design](../../docs/designs/product-v0-build.md)
sections 3 and 4 ("Rust types are the source of the wire format": milestone
1's relay traffic is a stub and fixes no message shape; "Checks arrive with
the layer"; "Geometry is configuration") and its planned child
`backend-workspace-and-relay-stub`; [product spec](../../docs/product-spec.md)
sections 4 (an outbound WebSocket over TLS, CBOR messages), 5 (Rust: axum,
tokio, tower; one workspace, crates split by domain), 5.4 (`tracing`
structured logs; a Graviton instance), 12 (milestone 1: relay traffic running
concurrently) and 13 (rustfmt, clippy pedantic as errors, cargo-deny,
cargo-nextest); [design-tree](../../docs/design-tree.md) R2.Q8 (runtime spike
first), R4.Q8 (relay traffic concurrent with rendering), R4.Q9 (the backend
is Rust), R4.Q10 (WebSocket over TLS, CBOR), R5.Q2 (axum, tokio, tower,
crates by domain);
[spec 106](../106-firmware-project-and-hil/spec.md) (the HIL workflow and
the rig this stub is run on) and
[spec 107](../107-widget-abi-and-rust-sdk/spec.md) section 4 (the root
workspace excludes `backend/`, which keeps its own workspace; the pinned
toolchain and `deny.toml` this spec reuses);
[ADR 0016](../../docs/decisions/0016-product-breakdown-is-one-ordered-design.md).

## 1. Goal

`backend/` holds only `.gitkeep`. The runtime spike (product spec 12.1) has
to render at 60 Hz *while relay traffic flows*, and there is nothing for the
board to hold a connection to. After this spec:

- `backend/` is a Cargo workspace of its own, with crates split by domain
  under `backend/crates/`, shared lint settings, and one script,
  `backend/check.sh`, that runs the Rust checks of product spec 13; CI's
  required `test` job runs it.
- `backend/crates/relay/` is the first domain crate. It builds one service,
  the binary `panelator-relay-stub`: a WebSocket endpoint served over TLS
  that accepts a board's connection, sends it CBOR messages at a configured
  rate and size, and accepts and counts the CBOR messages the board sends.
- The same binary creates the certificates a rig needs, reports what it sees
  as JSON lines a test harness can read, and is published by CI as an
  artifact that runs on the HIL laptop with nothing else installed.

The stub is test equipment for milestone 1. It is the place the real relay
is later built (`backend-screen-store-and-relay` replaces the stub in this
crate), but nothing it sends or accepts is the relay protocol.

## 2. Out of scope

- **Message types and shapes.** The relay message families of product spec 4,
  their Rust types, `schemars`, JSON Schema in `schemas/`, the CBOR fixtures
  and the round-trip tests are `screen-config-and-type-sharing`. Nothing
  later may depend on what the stub's messages contain (AC-9, AC-10).
- **Postgres, sqlx, sqlx offline in CI, the Docker Compose file, the HTTP API
  and the relay proper** (hello, config push): `backend-screen-store-and-relay`.
  This spec adds no database, no migration, no container image and no
  Compose file, and the stub stores nothing: no file, no database, no state
  that outlives the process (the files `gen-cert` writes are its output, not
  the service's state).
- **Accounts, sessions, board identity, authentication of a board and
  claiming**: `backend-accounts-and-login`, `board-identity-and-claiming`.
  The stub authenticates nobody (section 5, "No authentication").
- **The firmware's side**: joining WiFi, the WebSocket client, trusting the
  rig's certificate, reconnect and backoff, and the HIL tests for connect,
  traffic and reconnect are `firmware-relay-client`. **Changing
  `.github/workflows/hil.yml` or `tools/hil/`** to fetch and start the stub
  on the runner is that child's too: only it has a firmware that connects,
  and a HIL step with nothing to test would be a step that cannot fail. This
  spec delivers what that child starts (section 6).
- **The measurement** (traffic levels, the numbers, the execution mode):
  `runtime-spike-measurement`.
- **Deploying anything.** The stub is never part of the hosted instance or
  of what self-hosters are given. Metrics, an uptime check and alerts
  (product spec 5.4) come with the services that are deployed.
- The workers crate, the `image` crate and `wamrc` (product spec 5): the
  children that need them add their crates to this workspace.
- Any change to `AGENTS.md`, the root `package.json`, `pnpm-workspace.yaml`,
  the sensitive-path list, the security review criteria or how either is
  enforced.

## 3. Acceptance criteria

Terms. *The stub* is the running `panelator-relay-stub serve` process. A
*frame* is one WebSocket message. *Well-formed CBOR* is exactly one data item
that is well-formed by RFC 8949 section 3 and Appendix C, with no bytes after
it.

**The workspace and its checks**

- AC-1. **One workspace for the backend.** Given the repository, then
  `backend/Cargo.toml` is a Cargo workspace (resolver 3) whose members are
  the directories of `backend/crates/`, with `[workspace.package]` giving
  edition 2024, licence `Apache-2.0`, `publish = false` and the
  `rust-version` of the root workspace, `[workspace.dependencies]` holding
  every third-party dependency's version once, and `[workspace.lints]`
  setting `clippy::pedantic` and `missing_docs` to warn and `unsafe_code` to
  forbid; every member inherits the package fields, the lints and its
  dependency versions from the workspace. `backend/Cargo.lock` is committed.
  The toolchain is the one the root `rust-toolchain.toml` pins; `backend/`
  has no toolchain file of its own. The root `Cargo.toml` keeps `backend` in
  `exclude`, and the root `Cargo.lock` does not change.
- AC-2. **Crates by domain; the first is the relay.** Given the workspace,
  then its one member is `backend/crates/relay/`, the package
  `panelator-relay`: a library holding everything of AC-5 to AC-17, and the
  binary `panelator-relay-stub`, whose `main` only parses arguments and calls
  the library. `backend/README.md` says that a crate is a domain of product
  spec 5 (relay, accounts, screens, feeds and so on), that a new domain is a
  new directory under `backend/crates/`, and that code on a sensitive path
  (`agents/sensitive-paths.txt`) sits in a directory of that name so the
  security review sees it.
- AC-3. **The Rust checks of product spec 13.** `backend/check.sh` runs
  from any working directory and fails when any step fails. Its steps, each
  over the whole backend workspace and with `--locked` where the command
  takes it: `cargo fmt --all --check`; `cargo clippy --workspace
  --all-targets` with `-D warnings -D clippy::pedantic`; `cargo deny check`
  against the repository's one `deny.toml` (the root file, passed
  explicitly); `cargo nextest run --workspace`; and AC-18's release build.
  Any `allow` of a lint is on the smallest item it applies to, with its
  reason. Given a formatting difference, a clippy pedantic warning, a
  dependency with a licence outside the allow-list or a failing test in
  `backend/`, when the script runs, then it exits non-zero.
- AC-4. **One dependency policy.** The root `deny.toml` stays the policy for
  both workspaces. It gains `aarch64-unknown-linux-gnu` among its targets
  (the hosted instance is a Graviton machine, product spec 5.4), and
  `sdk/rust/check.sh` still passes. Given a dependency of the backend needs a
  licence the allow-list lacks, then the licence is added only if it is
  permissive (no copyleft, weak copyleft included), on its own line with a
  comment naming the crate that needs it; otherwise another crate is used.
  No advisory is ignored without a comment giving the advisory's id, why it
  does not apply and what removes the entry. `sources` and `bans` are not
  loosened.

**The stub: connection**

- AC-5. **TLS only.** `panelator-relay-stub serve` needs `--tls-cert <file>`
  and `--tls-key <file>` (PEM: the server certificate, followed by its chain
  if it has one, and its private key) and serves TLS 1.2 and 1.3 with them
  on `--listen <addr:port>` (default `127.0.0.1:8443`; port 0 takes a free
  port). It offers only `http/1.1` by ALPN. There is no plaintext mode: given
  either file is missing, unreadable or not a certificate and its key, when
  `serve` starts, then it prints the reason on stderr and exits with status
  2 without listening. Given a client that does not complete the TLS
  handshake (it does not trust the certificate, or speaks plain HTTP), then
  the stub emits a `handshake_failed` event (AC-14), serves that client
  nothing, and keeps serving others.
- AC-6. **The endpoint.** Given a TLS connection, when the client sends an
  HTTP/1.1 WebSocket upgrade for `GET /relay-stub`, then the stub accepts
  it, with no subprotocol and no extension (no compression), and emits
  `connected`. A request for the path without an upgrade gets 426 (or the
  framework's equivalent 4xx), and any other path gets 404. The path is the
  stub's; the real relay chooses its own.
- AC-7. **A bounded number of connections.** Given `--max-connections <n>`
  (default 4, 1 to 64) connections are open, when another upgrade arrives,
  then it is answered 503 and no WebSocket is opened. Each connection is
  independent: its own traffic, its own counters, its own number `conn`,
  counted from 1 in the order of acceptance and never reused in a run.
- AC-8. **Liveness.** The stub sends a WebSocket ping on each connection
  every 10 seconds and answers a ping with a pong. Given no frame of any
  kind (data, ping or pong) has arrived on a connection for 30 seconds, then
  the stub closes it and emits `disconnected` with reason `timeout`. Given
  the client closes, or the TCP connection ends without a close frame, then
  the stub emits `disconnected` with reason `peer_closed` or `peer_lost` and
  frees the connection's slot. Both intervals are constants of the library
  that a test may shorten; they are not command-line options.

**The stub: traffic**

- AC-9. **Downlink at a configured rate and size.** Given `--down-rate <r>`
  (messages per second, an integer 0 to 1000, default 10) and `--down-size
  <s>` (bytes, an integer 0 to 1048576, default 256), then from the moment a
  connection is accepted the stub sends it one binary frame every `1/r`
  seconds, the first after one interval, and each frame is well-formed CBOR:
  one definite-length byte string of `s` content bytes in its shortest
  encoding, so the frame is `s` bytes plus a 1, 2, 3 or 5 byte head. With
  `r` 0 the stub sends no data frame. The content bytes are filler chosen by
  the stub; they mean nothing, may change in any release, and the only
  things a receiver may check are that the frame is well-formed CBOR and how
  long it is. Measured on the stub's clock over any window of at least 5
  seconds on a connection whose peer keeps reading, the number of frames
  sent is `r` times the window's length, within one frame and 2 percent.
- AC-10. **Uplink is accepted and counted, never interpreted.** Given the
  client sends a binary frame of at most `--max-up-size <n>` bytes (default
  65536, 1 to 1048576), then the stub counts it and its bytes, counts it as
  `malformed` as well when it is not well-formed CBOR, replies nothing and
  keeps the connection. Any well-formed item of any type and nesting counts
  as well-formed; the stub looks at no value in it. Given a larger binary
  frame, then the stub closes the connection with status 1009 and emits
  `disconnected` with reason `too_big`; given a text frame, status 1003 and
  reason `text_frame`. Checking well-formedness allocates no more than a
  small multiple of the frame's size and cannot overflow the stack on a
  deeply nested item (a depth limit of at least 64 levels is allowed, beyond
  which the frame counts as `malformed`).
- AC-11. **A slow peer costs the stub nothing.** Given a peer that stops
  reading, then the stub holds at most one unsent data frame for that
  connection: a tick whose predecessor has not been written is skipped and
  counted in `skipped`, memory for the connection does not grow with time,
  the other connections keep their rate, and AC-8's timeout still ends the
  connection when the peer also stops answering.
- AC-12. **Invalid configuration never starts.** Given a value outside its
  range in AC-5, AC-7, AC-9, AC-10 or AC-14, an unknown option or a missing
  required one, when `serve` starts, then it names the option on stderr and
  exits with status 2 without listening. Every option of `serve` can also be
  given as an environment variable `PANELATOR_STUB_<OPTION>` (upper case,
  `-` as `_`), the command line winning; `--help` lists options, ranges,
  defaults and variables.

**The stub: what a harness sees**

- AC-13. **Start and stop.** Given `serve` has bound its socket, then the
  first line on stdout is the `listening` event with the address actually
  bound, and the stub accepts connections from then on. Given SIGTERM or
  SIGINT, then the stub stops accepting, closes every connection with status
  1001, emits `disconnected` with reason `shutdown` for each, and exits with
  status 0 within 5 seconds whether or not the peers answer. A stub that is
  killed outright simply drops its connections; that is the rig's way to
  test an unannounced loss.
- AC-14. **Events on stdout, logs on stderr.** stdout carries only events:
  one JSON object per line, flushed when written, each with `event` and `ts`
  (milliseconds since the Unix epoch):
  - `listening`: `addr` (`ip:port`), `path` (`/relay-stub`), `down_rate`,
    `down_size`, `max_up_size`, `max_connections`.
  - `connected`: `conn`, `peer` (`ip:port`).
  - `handshake_failed`: `peer`, `error` (a short text).
  - `stats`: `conn`, and the connection's cumulative counters `sent`,
    `sent_bytes`, `skipped`, `received`, `received_bytes`, `malformed`
    (frames and payload bytes of data frames only). One per open connection
    every `--stats-interval <seconds>` (default 1, 1 to 3600).
  - `disconnected`: `conn`, `reason` (one of `peer_closed`, `peer_lost`,
    `timeout`, `too_big`, `text_frame`, `shutdown`, `error`), and the same
    counters with their final values.

  Human-readable diagnostics go to stderr through `tracing`, at the level
  `--log-level` gives (default `info`). No event or log line contains a
  frame's content or the private key.
- AC-15. **Certificates for a rig.** `panelator-relay-stub gen-cert --out
  <dir> --san <name-or-ip>` (`--san` one or more times; `--days <n>`,
  default 30, 1 to 825) writes into `<dir>`, creating it if needed, `ca.pem`
  (a new self-signed CA certificate), `server.pem` (a server certificate
  signed by that CA whose subject alternative names are exactly the given
  DNS names and IP addresses) and `server.key` (its private key, written
  with mode 0600). Both keys are ECDSA P-256. The CA's private key is used
  once and never written anywhere. Given `<dir>` already holds any of the
  three files, then nothing is written and the command exits with status 2
  unless `--force` is given. Given `serve` is started with `server.pem` and
  `server.key`, when a client that trusts only `ca.pem` connects by a name or
  address among the SANs, then the handshake succeeds; by any other name, or
  trusting a different CA, it fails.
- AC-16. **No authentication, said where it is seen.** The stub checks no
  identity and needs none: it holds nothing to read and nothing to change.
  Given `--listen` names an address that is not a loopback address, then the
  stub logs one warning at start that it is reachable from the network and
  authenticates nobody. `backend/crates/relay/README.md` says the stub is
  for a development machine and the HIL rig, is never exposed to the
  internet and is in no deployment.
- AC-17. **Tested where it is built.** The crate's tests, run by `cargo
  nextest run`, cover with real sockets on loopback, certificates from the
  `gen-cert` code and a WebSocket client that trusts only that CA: AC-5 (a
  trusting client connects, a client trusting another CA is refused and
  produces `handshake_failed`, a missing key file exits 2), AC-6, AC-7,
  AC-8 with shortened intervals, AC-9 (every frame's length and
  well-formedness at sizes 0, 23, 24, 255, 256, 65535, 65536 and 1048576;
  rate 0 sends nothing), AC-10 (well-formed items of each major type,
  truncated items, trailing bytes, nesting past the limit, an oversized
  frame, a text frame), AC-11, AC-13 and AC-15. The rate of AC-9 and the
  skipping of AC-11 are tested on the traffic generator with tokio's paused
  clock, so no test's result depends on how fast the machine is; a test that
  uses real time asserts only bounds a stalled machine cannot break (at
  least one frame, never more than the rate allows). AC-12 and AC-14's line
  format are tested on the argument parser and the event serializer
  directly.

**Built and published by CI**

- AC-18. **The release binary.** `backend/build-relay-stub.sh` builds the
  stub in release mode with `--locked` for the build machine's target and
  prints the binary's path, `backend/target/release/panelator-relay-stub`.
  The binary needs no file beside it and no library other than the system's
  C library and what it links by default; TLS is rustls with one of the
  crypto providers rustls ships, so no OpenSSL is linked.
- AC-19. **CI.** The `test` job of `.github/workflows/ci.yml` runs
  `backend/check.sh` after `sdk/rust/check.sh`, with `backend/target` added
  to the Cargo cache and `backend/Cargo.lock` added to its key, and uploads
  the binary of AC-18 as the artifact `relay-stub`, failing when the file is
  missing. Its existing steps stay as they are, `pnpm test` runs what it ran
  before, and the required check stays `test`, so a failing backend check
  blocks a merge. It adds no secret, no permission and no trigger, and any
  third-party action it adds is pinned by commit SHA.
- AC-20. **Documents.** `backend/README.md` says how to run the checks and
  what a developer needs installed (the pinned toolchain, `cargo-nextest`
  and `cargo-deny` at the versions CI pins). `backend/crates/relay/README.md`
  gives the commands of section 6, every option with its range and default,
  the event lines of AC-14, the statement of AC-9 that the frames' content is
  not a protocol, and AC-16's warning. The root `README.md` gains one line
  pointing to `backend/README.md`. `backend/.gitkeep` is removed.

## 4. Interfaces and files

New:

- `backend/Cargo.toml`, `backend/Cargo.lock` (AC-1); `backend/check.sh`
  (AC-3), `backend/build-relay-stub.sh` (AC-18), both executable;
  `backend/README.md` (AC-2, AC-20).
- `backend/crates/relay/` (sensitive path): `Cargo.toml`, `README.md`,
  `src/lib.rs`, `src/main.rs`, the library's modules and `tests/`. The
  module layout is the plan's; the library's public surface is what the
  binary and the tests need and no more.

Changed:

- `.github/workflows/ci.yml` (sensitive path): AC-19.
- `deny.toml`: AC-4.
- `README.md`: one line (AC-20).
- `backend/.gitkeep`: removed.

Not changed: the root `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` and
`.cargo/config.toml`; `.github/workflows/hil.yml`; `tools/`; `firmware/`;
`schemas/`; `AGENTS.md`, `package.json`, `pnpm-workspace.yaml`.

The command line:

```
panelator-relay-stub serve --tls-cert <file> --tls-key <file>
    [--listen <addr:port>] [--down-rate <0..1000>] [--down-size <0..1048576>]
    [--max-up-size <1..1048576>] [--max-connections <1..64>]
    [--stats-interval <1..3600>] [--log-level <trace|debug|info|warn|error>]
panelator-relay-stub gen-cert --out <dir> --san <name-or-ip>... [--days <1..825>] [--force]
```

Exit status: 0 after a signalled stop or a finished `gen-cert`; 2 for a
configuration or file error before listening; 1 for a failure while running
(the listener is lost).

Dependencies *(agent's call)*: axum (its WebSocket support), tokio and tower
are the product spec's. The rest are the plan's choice of maintained crates
that pass `cargo deny check`, each at its newest release when the
implementation is written and exact in `backend/Cargo.lock`: rustls for TLS,
a CBOR crate for AC-9 and AC-10, a certificate-generation crate for AC-15,
an argument parser, `tracing` with a subscriber, `serde_json` for AC-14, and
a WebSocket client as a dev-dependency. The CBOR crate chosen here binds
nobody: `screen-config-and-type-sharing` chooses the one its types use, and
may replace this one.

## 5. Design notes (agent's calls)

- **`backend/` is its own workspace.** Spec 107 put the SDK, the test host
  and the widgets in a workspace at the repository root and excluded
  `backend/`, because the widgets build for `wasm32-unknown-unknown` with a
  size-optimised, `panic = "abort"` release profile and link arguments that
  a server must not inherit, and because product spec 5 and 14 call
  `backend/` a workspace. Two lockfiles follow; one toolchain file and one
  `deny.toml` keep the two from drifting where it matters.
- **The crate is `relay`, not `relay-stub`.** The relay is a sensitive path
  (process-spec section 5), and the list matches `backend/**/relay/**`. The
  stub is the first code a board connects to and the code the real relay
  grows from, so it sits where the security review reads it. A directory
  named `relay-stub` would have built the relay's first TLS listener outside
  that review.
- **TLS in the process, by rustls.** The board connects over TLS (product
  spec 4), so the rig needs a TLS server whatever the hosted instance later
  puts in front of the backend. rustls keeps the binary free of OpenSSL, so
  the artifact built on a GitHub-hosted `ubuntu-24.04` machine runs on the
  HIL laptop (x86-64 Linux, a newer C library) with nothing installed there,
  which is how spec 106 keeps the runner free of toolchains. Whether the
  deployed relay terminates TLS itself is `backend-screen-store-and-relay`'s
  or the hosting child's to say.
- **No plaintext mode.** A second mode would be a second thing to test and
  a way to run the rig without the handshake whose cost on the board the
  spike is there to include. The tests make certificates in-process.
- **A CA made per rig, not a committed certificate.** `gen-cert` writes a
  fresh CA and throws its key away, so there is no long-lived signing key on
  the laptop or in the repository, and a certificate can be made per run.
  How the board comes to trust `ca.pem` (at build or at flash time, as with
  the WiFi credentials), which name or address the board dials, and whether
  the firmware checks validity dates before it has a clock, are
  `firmware-relay-client`'s; `--san` and `--days` leave it every choice.
  ECDSA P-256 is what ESP-IDF's mbedTLS accepts in its default
  configuration and the cheapest handshake for the board.
- **The stub's frames are byte strings of filler.** The design says
  milestone 1's traffic fixes no message shape. A byte string is the
  smallest item that is CBOR, has a size that can be set exactly, and has no
  fields anyone could come to rely on. "Size" is the content's length, not
  the frame's, because a frame of exactly 25 or 258 bytes has no shortest
  encoding as a byte string; the head adds at most 5 bytes and the events
  count content bytes.
- **Two independent directions, no echo.** The spike needs load in both
  directions while rendering, not a conversation. The firmware decides what
  it sends and how often; the stub only counts it, and counts malformed
  frames apart so a HIL test can require zero.
- **Rate and size are set at start, and changed by restarting.** The
  measurement can stop the stub and start it with other values; the board
  reconnects, which is behaviour `firmware-relay-client` has to have anyway.
  A control endpoint would be an unauthenticated way to change a running
  service, for nothing a restart does not give.
- **Limits.** 1000 messages a second and 1 MiB are far above anything the
  relay will carry to a board (the spike's image is 24 KB) and low enough
  that a mistyped option cannot fill the laptop's memory or its network.
  Four connections by default is the board and a developer's test client
  with room to spare.
- **JSON lines on stdout.** The HIL harness already reads a serial port line
  by line (spec 106); a child process's stdout is the same kind of input,
  needs no second port and no HTTP client, and the `listening` line is the
  readiness signal. The lines are the stub's interface to tests, not a
  product API.
- **The backend check runs on every pull request.** It sits in the required
  `test` job for the reason spec 106 section 5 gives for the firmware's
  checks; with the cache it costs well under the job's existing Rust step,
  and a path filter would let a change to `deny.toml` or the toolchain break
  the backend unseen.

## 6. What `firmware-relay-client` and the rig get

On the laptop, with the `relay-stub` artifact downloaded (or
`backend/build-relay-stub.sh` run where a toolchain exists):

```
panelator-relay-stub gen-cert --out "$dir" --san <the laptop's address or name on the rig's network>
panelator-relay-stub serve --listen <that address>:8443 \
    --tls-cert "$dir/server.pem" --tls-key "$dir/server.key" \
    --down-rate 20 --down-size 1024
```

The board is given `wss://<that address>:8443/relay-stub` and `ca.pem`. A
harness waits for the `listening` line, reads `connected`, `stats` and
`disconnected` lines to assert on traffic, sends SIGTERM for an announced
close and SIGKILL for an unannounced one, and restarts the stub to change
the traffic or to test reconnect. The workflow step that builds or downloads
the binary in `hil.yml` and the harness code that starts it are added by
`firmware-relay-client` with the tests that use them.

Nothing here needs a credential, a purchase or an outside party. The rig's
WiFi and the laptop's reachability from the board are that child's to ask
about, as its brief says.

## 7. Verification

- `backend/check.sh` passes locally and in CI (AC-1 to AC-4, AC-17, AC-18);
  its output is in the implementation PR, with `pnpm test`'s.
- `sdk/rust/check.sh` passes with the changed `deny.toml` (AC-4).
- The tests of AC-17 exist and pass; the implementation PR lists which test
  covers which criterion.
- By hand once, recorded in the PR: `gen-cert` then `serve` on loopback, a
  WebSocket client trusting `ca.pem` connected for 10 seconds at the default
  rate and size, the stdout lines pasted (AC-5, AC-9, AC-13, AC-14), and
  `ldd` on the release binary showing no OpenSSL (AC-18).
- The CI run of the PR shows the `test` job running `backend/check.sh` and
  the `relay-stub` artifact uploaded (AC-19).
- The diff touches no file section 4 lists as not changed, and the security
  review covers `.github/workflows/ci.yml` and `backend/crates/relay/`.

## 8. Open decisions

None.

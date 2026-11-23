# backend

The Rust workspace of the backend (product spec 5). It is its own Cargo workspace with its own
`Cargo.lock`; the workspace at the repository root (SDK, test host, widgets) excludes it. The two share
the toolchain pinned by the root `rust-toolchain.toml` and the dependency policy in the root
`deny.toml`.

## Crates

A crate under `crates/` is a domain of product spec 5 (relay, accounts, screens, feeds and so on). A new
domain is a new directory under `backend/crates/`. Code on a sensitive path
(`agents/sensitive-paths.txt`) sits in a directory of that name, so the security review sees it: the
relay is `crates/relay/`.

| Crate | What it is |
|---|---|
| `crates/relay/` | The WebSocket relay stub of spec 111, test equipment for the runtime spike. See its [README](crates/relay/README.md). |

## Checks

```
backend/check.sh               # fmt, clippy pedantic as errors, cargo-deny, cargo-nextest, release build
backend/build-relay-stub.sh    # builds the stub in release mode, prints the binary's path
```

Both run from any directory. You need the toolchain `rust-toolchain.toml` pins (rustup installs it on
first use), `cargo-nextest` 0.9.152 and `cargo-deny` 0.22.0 (the versions `.github/workflows/ci.yml`
installs):

```
cargo install --locked --version 0.9.152 cargo-nextest
cargo install --locked --version 0.22.0 cargo-deny
```

CI's `test` job runs `backend/check.sh` and uploads the stub as the artifact `relay-stub`.

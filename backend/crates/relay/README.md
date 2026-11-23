# panelator-relay: the relay stub

`panelator-relay-stub` is **test equipment for milestone 1** (spec 111). It is a WebSocket endpoint over
TLS that sends CBOR messages to a board at a configured rate and size, and counts what the board sends,
so the runtime spike can run relay traffic while rendering.

> **No authentication.** The stub checks no identity. It is for a development machine and the HIL rig,
> is never exposed to the internet and is in no deployment. When `--listen` is not a loopback address it
> logs a warning at start that it is reachable from the network and authenticates nobody.

The frames are **not a protocol**. Each one the stub sends is one CBOR byte string of filler: its content
means nothing and may change in any release. A receiver may check only that a frame is well-formed CBOR
and how long it is. The real relay is built later in this crate.

## Run it

```
panelator-relay-stub gen-cert --out "$dir" --san <the laptop's address or name on the rig's network>
panelator-relay-stub serve --listen <that address>:8443 \
    --tls-cert "$dir/server.pem" --tls-key "$dir/server.key" \
    --down-rate 20 --down-size 1024
```

The board is given `wss://<that address>:8443/relay-stub` and `ca.pem`. Build with
`backend/build-relay-stub.sh`, or download the `relay-stub` artifact of a CI run (an artifact does not
keep the executable bit: `chmod +x panelator-relay-stub`). The binary needs no file beside it.

## `serve`

Every option can also be given as the environment variable `PANELATOR_STUB_<OPTION>` (upper case, `-` as
`_`); the command line wins. A value outside its range, an unknown option or a missing required one
prints the option on stderr and exits with status 2 without listening.

| Option | Range | Default | Variable |
|---|---|---|---|
| `--tls-cert <file>` | PEM: certificate, then its chain | required | `PANELATOR_STUB_TLS_CERT` |
| `--tls-key <file>` | PEM: private key | required | `PANELATOR_STUB_TLS_KEY` |
| `--listen <addr:port>` | port 0 takes a free port | `127.0.0.1:8443` | `PANELATOR_STUB_LISTEN` |
| `--down-rate <n>` | messages per second, 0 to 1000 | 10 | `PANELATOR_STUB_DOWN_RATE` |
| `--down-size <n>` | content bytes, 0 to 1048576 | 256 | `PANELATOR_STUB_DOWN_SIZE` |
| `--max-up-size <n>` | bytes, 1 to 1048576 | 65536 | `PANELATOR_STUB_MAX_UP_SIZE` |
| `--max-connections <n>` | 1 to 64 | 4 | `PANELATOR_STUB_MAX_CONNECTIONS` |
| `--stats-interval <s>` | seconds, 1 to 3600 | 1 | `PANELATOR_STUB_STATS_INTERVAL` |
| `--log-level <l>` | trace, debug, info, warn, error | info | `PANELATOR_STUB_LOG_LEVEL` |

TLS 1.2 and 1.3 only, ALPN `http/1.1`; there is no plaintext mode. The endpoint is `GET /relay-stub`;
another path is 404, a request without an upgrade is 4xx, and a connection beyond `--max-connections` is
answered 503. The stub pings every 10 seconds and closes a connection that has sent nothing for 30.
An uplink binary frame larger than `--max-up-size` closes the connection with 1009, a text frame with
1003. SIGTERM or SIGINT closes every connection with 1001 and exits 0 within 5 seconds.

## `gen-cert`

```
panelator-relay-stub gen-cert --out <dir> --san <name-or-ip>... [--days <1..825>] [--force]
```

Writes `ca.pem`, `server.pem` and `server.key` (mode 0600) into `<dir>`: ECDSA P-256, a new CA whose key
is never written, and a server certificate whose subject alternative names are exactly the `--san`
values. `--days` defaults to 30. If any of the three files exists nothing is written and the exit status
is 2, unless `--force`.

| Option | Range / accepted values | Default |
|---|---|---|
| `--out <dir>` | output directory, created if absent | required |
| `--san <name-or-ip>` | DNS name or IP address; repeat for multiple SANs | at least one required |
| `--days <n>` | 1 to 825 days | 30 |
| `--force` | flag: replace all three existing files | false |

`gen-cert` has no environment-variable options. The CA private key is discarded after signing.

## Exit status

0 after a signalled stop or a finished `gen-cert`; 2 for a configuration or file error before
listening; 1 for a failure while running.

## Events on stdout

stdout carries only events, one JSON object per line, flushed when written, each with `event` and `ts`
(milliseconds since the Unix epoch). The first line is `listening`. Logs go to stderr.

- `listening`: `addr`, `path`, `down_rate`, `down_size`, `max_up_size`, `max_connections`.
- `connected`: `conn` (from 1, never reused), `peer`.
- `handshake_failed`: `peer`, `error`.
- `stats` (one per open connection every `--stats-interval`): `conn`, `sent`, `sent_bytes`, `skipped`,
  `received`, `received_bytes`, `malformed` (data frames only; `sent_bytes` counts filler content
  bytes, `received_bytes` counts complete binary payload bytes, including their CBOR heads).
- `disconnected`: `conn`, `reason`, and the same counters. `reason` is one of `peer_closed`, `peer_lost`,
  `timeout`, `too_big`, `text_frame`, `shutdown`, `error`.

No event or log line contains a frame's content or the private key.

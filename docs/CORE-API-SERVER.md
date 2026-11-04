# Core API Server v1 — acceptance and release review

RemoteHand exposes an opt-in read-only HTTP API **only while the RemoteHand process is running**.

## Generic Plugin API Gateway — RemoteHand v1.4.0

The v1.4.0 Core API Server dynamically discovers enabled plugins' optional `api.json` descriptors and publishes authenticated GET-only routes from their `api.read` handlers. Neither plugin names nor their endpoint implementations are hardcoded in Core. The explorer at `/api/docs` renders OpenAPI parameters as editable inputs, validates each named path variable (including multiple variables), and substitutes the values before issuing a request. The gateway enforces GET-only, descriptor/route/response bounds and existing bearer-token authorization. Plugins must sanitize their own response objects.

System Monitor v0.5.2 and Target Monitor v0.7.12 have been live-tested with the gateway on Windows, including authorized requests, HTTP 401 for missing credentials, Target Monitor's `{id}` paths, live TCP/HTTP checks, and enabled/disabled plugin route isolation. A gateway-enabled Core release is required for these plugin endpoints; older Core builds continue running the existing plugin UIs. See [Generic Plugin API Gateway v1](SYSTEM-MONITOR-API-V1.md).

## Per-plugin API publication controls

Open **Settings → API Server → Plugin API Routes** to view each installed, enabled plugin with a valid API descriptor and expand its list of GET routes. The **API enabled** switch independently controls whether that plugin's routes are published by the Core HTTP server. Switching it off removes the plugin's routes from `/api/v1/routes`, OpenAPI, and the explorer, and requests to those routes return HTTP 404. It does **not** stop the plugin, Ping/TCP/HTTP monitoring, its UI, or other plugins' routes. Settings persist between restarts in `data/config/plugin-api-routes.json`; existing registrations default to enabled until explicitly switched off. This is separate from the global API Server enable switch and Plugin Manager's plugin enable/disable.

## Settings and network bindings

Open **Settings → API Server**. The API is **disabled by default**. With the default localhost binding it listens on `127.0.0.1:8765` using HTTP; a configurable port in the range 1024–65535 is supported. Its status remains available even when minimized or in the system tray, but the server stops on full process exit or when disabled.

Use **Listening network** to select:

- **Localhost** (`127.0.0.1`) — default, no remote access.
- **All IPv4 interfaces** (`0.0.0.0`) — reachable on all IPv4 interfaces when allowed by firewall. The status panel reports `Listening on: 0.0.0.0:<port>` separately from local access (`127.0.0.1`) and detected network URLs; the latter are connection examples, not additional sockets. Windows Firewall may restrict individual interfaces or profiles.
- **Specific IPv4 address** — bind only an address assigned to this host, such as a LAN or Tailnet IP.
  Selecting this mode automatically fills the first detected active, non-loopback IPv4 address (preferring normal LAN adapters over recognizable virtual adapters). The field stays fully editable; you can replace the suggested address. If no suitable address is found, the field remains blank and an explanation appears. Switching modes never applies a new binding until you click **Apply listening configuration**.

The **Server status** panel shows the actual listening address and the available local/network URLs. Each displayed URL is a clickable **Copy** target, which uses the native clipboard and shows a **Copied!** confirmation; it does not open a browser or expose credentials. Only URLs for the running listener may be copied through this command.

The separate **Transport security** selector supports:

- **HTTP (unencrypted)** — no certificate required. Localhost is the default. Remote HTTP requires a clear security confirmation; passwords and API Bearer tokens are transmitted in cleartext and may be captured by anyone who can observe the path. Use this option **only on an isolated, fully trusted network**. Do not expose this endpoint on public networks, through internet port forwarding, or to untrusted users.
- **HTTPS (TLS)** — requires readable PEM certificate and matching PEM private key. Recommended for LAN/Tailnet and required wherever traffic crosses an untrusted network. The certificate must cover the DNS name or IP used by clients and be trusted by those clients.

**Apply listening configuration** changes the binding explicitly rather than on every keystroke. Non-loopback selections require confirmation; Windows Firewall is never changed automatically. The private key's file **path** is stored in settings, not its contents; protect the actual private key on disk. TLS is implemented directly in the Rust API listener.

### Create a free HTTPS certificate

For development or a private home lab, the free open-source [mkcert utility](https://github.com/FiloSottile/mkcert) can issue local certificates without buying one. On Windows, install mkcert on the RemoteHand machine with PowerShell:

```powershell
winget install --id FiloSottile.mkcert --exact --source winget
```

Close and reopen PowerShell, then verify the installation with `mkcert -version`. If winget isn't available, use the installation guidance in the official mkcert repository. Next, generate a certificate (replace the sample IP with the actual RemoteHand machine's address):

```powershell
New-Item -ItemType Directory -Force C:\certs | Out-Null
mkcert -install
mkcert -cert-file C:\certs\remotehand.crt -key-file C:\certs\remotehand.key 192.168.1.100 localhost 127.0.0.1
```

Then choose **HTTPS** in Settings. Use each field's **Browse…** button to select the certificate and private key with a native file picker, or type/paste their absolute paths manually (for example `C:\certs\remotehand.crt` and `C:\certs\remotehand.key`). Cancelling a file picker leaves the existing value unchanged. Connect using the IP or hostname covered by the certificate. Each separate client machine (including a Raspberry Pi running DisplayHand) needs to trust the **mkcert local CA certificate**. Use `mkcert -CAROOT` to locate the CA directory on the issuing machine, then distribute **only `rootCA.pem`**, never the CA private key (`rootCA-key.pem`). A certificate made with mkcert is not automatically trusted on other devices and is intended for development, not public production.

Alternatively, use a certificate issued by an already-trusted internal or public CA. Public TLS certificates can often be obtained free of charge through an ACME provider for a suitable domain.

The first enable creates a cryptographically random 256-bit access token under the portable `data/config/api-server-token` file. It is **not included** in normal settings JSON, public endpoint responses, or logs. Use **Reveal Token** to enter it into authorized API clients; **Rotate Token** immediately invalidates previous credentials. Protect the token, key file, and portable data backups. On Unix the token file is created with mode 0600; on Windows it uses the enclosing folder ACL.

The API runs inside the RemoteHand process with no Windows service, daemon, or administrator requirement. Configured listening address, port, and certificate *paths* persist under `data/config/settings.json`; private key contents are never copied into settings.

## Access history

Settings → API Server includes a request history viewer with **Refresh**, **Export CSV**, **Clear history** (confirmation required), and automatic refresh every five seconds while the tab is open. Recent requests display local date/time, source IP, method, path, HTTP status, and duration in milliseconds. A summary shows successes and failures based on the retained records.

The audit log is private to RemoteHand's Settings UI and is **not published as an HTTP endpoint**. A bounded background writer retains the configured maximum (**100–10,000 requests**, default **1,000**) in portable `data/activity/api-history.json` and displays the most recent **100**. It records completed HTTP responses including success, unauthorized, missing route, and wrong method; tokens, headers, query parameters, and request bodies are never stored. Timestamps are recorded as UTC Unix milliseconds (string) and rendered in the user's local time zone. The access history is best-effort, bounded, and not a tamper-proof security audit system.

## Routes

| Method | Path | Authentication | Response |
| --- | --- | --- | --- |
| GET | `/api/docs` | No (on configured listener) | Offline interactive API explorer (HTML) |
| GET | `/api/openapi.json` | No (on configured listener) | OpenAPI 3.0.3 JSON specification |
| GET | `/api/v1/health` | No (on configured listener) | `status: ok`, service identity |
| GET | `/api/v1/core/status` | Bearer token | Application name, version, platform, uptimeSeconds |
| GET | `/api/v1/plugins` | Bearer token | Empty list until plugin API providers are supported |
| GET | `/api/v1/routes` | Bearer token | Currently registered core routes and auth requirements |

API replies are JSON except the HTML documentation at `/api/docs`. The bundled explorer loads its OpenAPI schema from the running server, provides in-memory Bearer authorization, and supports GET requests through **Try it out**. This is a lightweight locally bundled **OpenAPI explorer**, not the upstream Swagger UI distribution; it requires no CDN and never stores the token in localStorage or cookies. The `Open API Documentation` button in Settings opens only the local API server. The documentation and schema are unauthenticated on any configured listener (including LAN if enabled); neither contains secrets. The two documentation routes are also listed by route discovery.

All replies include `Cache-Control: no-store`. Missing or invalid credentials on protected routes return HTTP 401. Unknown authenticated routes return HTTP 404. Non-GET requests return HTTP 405. HTTP request parsing is intentionally minimal for this bounded read-only milestone.

## Windows acceptance smoke test

Start RemoteHand, enable its API under Settings, and reveal the token. In PowerShell:

```powershell
$Base = 'http://127.0.0.1:8765'
$Token = Read-Host 'Paste the API token'
$Headers = @{ Authorization = "Bearer $Token" }
Invoke-RestMethod "$Base/api/v1/health"
Invoke-RestMethod "$Base/api/v1/core/status" -Headers $Headers
Invoke-RestMethod "$Base/api/v1/plugins" -Headers $Headers
Invoke-RestMethod "$Base/api/v1/routes" -Headers $Headers
```

Expected: health and core status report `ok`, plugins returns `data: []`, and routes lists the six paths (four core routes and two documentation routes). Open `http://127.0.0.1:8765/api/docs`, verify it loads without an internet connection, and test an authorized call using a token pasted into the browser session. Open `/api/openapi.json` and verify `openapi: 3.0.3`. Accessing `/core/status` without authorization must fail with 401. Minimize RemoteHand to tray: API should remain accessible. Disable API: HTTP connection should fail. Re-enable API: it should work again. Rotate the token: the previous token should return 401. Exit RemoteHand fully: the listener must disappear.

The listener supports explicit LAN/Tailnet IPv4 binding using either opt-in unencrypted HTTP (trusted isolated networks only) or HTTPS with a valid certificate and key. Operator acceptance of both HTTP and HTTPS network connections was completed on Windows 11 (November 4, 2026); the remote client's mkcert root CA trust setup was deferred. For DisplayHand, configure a trusted certificate matching the endpoint address and verify the connection using its generic HTTPS JSON source. Never forward this API port openly to an untrusted network.

## Later milestones

- **Generic Plugin API gateway candidate:** optional plugin-root `api.json` enables read-only GET route registration without adding per-plugin Core code, with Core-managed bearer auth, IPC timeouts and dynamic OpenAPI/route discovery. See [Generic Plugin API Gateway v1](SYSTEM-MONITOR-API-V1.md). This feature branch is not yet Windows-accepted or merged.
- System Monitor plugin integration is on its own feature branch; its candidate ZIP must contain `api.json` and support `api.read`.
- Target Monitor read-only HTTP endpoints are a future *plugin-only* addition using the same gateway.
- Safe remote-device consumption from DisplayHand.

In the new gateway candidate, `/api/v1/plugins` enumerates enabled API-publishing plugins, not all installed plugins. The existing production Core API still returns the original empty placeholder.

## Notes for developers

Core's `api_server.rs` maintains a bounded, process-owned nonblocking localhost listener, serves short JSON responses, and uses a constant-time bearer token comparison. Configuration and token management are exposed as native Tauri commands. Standard plugins remain unchanged and have no API capabilities until a specific publication contract is implemented and reviewed.

Prior Core API routes, OpenAPI docs and bearer authentication were successfully tested manually on Windows by Papa. The remote-binding, history, TLS and CSV changes have been built and tested manually by the operator on Windows 11; they have **not been compiled or tested in the ChatGPT connector environment**. The new Rust TLS dependencies will cause Cargo.lock to update when Cargo resolves them; review and commit the regenerated lockfile before merging. Windows build and manual functional tests passed as described in the acceptance record below. CI and a fresh clean checkout build remain to be verified before merge.

## Additional Windows acceptance checks

After building, with RemoteHand enabled and bound to localhost:

1. Open **Settings → API Server** and verify Access History lists previous requests or the new ones you generate. Call health and protected status; refresh history and confirm timestamp, `127.0.0.1`, route, status (200), and duration. Call a protected endpoint without a token and verify 401 is recorded.
2. Click **Clear history**, confirm, and verify the records are gone. Generate a new request and verify it appears. Exit and relaunch RemoteHand; the new record should remain.
3. Select **All interfaces** and HTTPS with blank certificate/key paths, then click **Apply**. Verify the action is rejected and the existing listener remains in its original state. Next choose HTTP, apply with explicit warning confirmation, and verify the URL shows HTTP and the remote client can reach it from an isolated test network. Restore localhost after the test.
4. If you have a trusted TLS certificate and matching private key, set a specific local LAN/Tailnet IPv4 address, choose HTTPS and provide paths. Apply and confirm; verify HTTPS from another trusted client and verify HTTP is not accepted at that address. Use the certificate's actual host/IP SAN. Confirm the new source IP appears in history.
5. Restore binding to localhost and verify prior HTTP behavior and port. Disable the API and confirm the listener closes; fully exit and verify the same.

Do not expose the server over public internet or broadly open Windows Firewall. A certificate alone does not enforce network trust; use appropriate firewall rules and network access controls for the chosen interface.

## HTTPS handshake troubleshooting (Windows)

Windows acceptance found the API listener reporting HTTPS running while `curl.exe -vk https://127.0.0.1:8765/api/v1/health` failed with `Recv failure: Connection was aborted` during TLS negotiation. The fix explicitly switches each accepted socket to blocking mode (a nonblocking listening socket may produce nonblocking accepted sockets on Windows), completes the Rustls handshake before reading the HTTP request, and logs handshake/read failures. After rebuilding, the operator confirmed local TLS returned HTTP 200 and remote API documentation loaded via HTTPS.

Smoke-test on the RemoteHand machine with `curl.exe -vk https://127.0.0.1:8765/api/v1/health`, then from the client using the real LAN IP. `-k` is for TLS diagnosis only: remove it once the client trusts the mkcert root CA, and verify without disabling TLS validation. Do not consider HTTPS accepted until both handshake and authenticated routes work.

## API Access History CSV export and retention

Settings → API Server → API Access History now offers **Export CSV** alongside Refresh and Clear history. It opens a native Save dialog, exporting the entire retained audit log, latest entries first—not only the 100 shown in the table. Columns are `Timestamp (Unix ms)`, `Client IP`, `Method`, `Route`, `Status`, and `Duration (ms)`. CSV fields are quoted and untrusted leading spreadsheet-formula characters are escaped. Authorization headers and bearer tokens are never logged or exported.

**Maximum saved requests** is configurable from **100 to 10,000**, default **1,000**. Choose a value and click **Apply**; RemoteHand saves the preference and trims the oldest entries immediately if the new limit is smaller. The UI still displays only the latest 100 for responsiveness, while the CSV contains all retained records. A canceled Save dialog does not write a file.

Operator acceptance completed: Windows release build, native CSV Save dialog and readable export of retained records (31 entries), setting maximum retention to 500 and verifying the setting survived application restart. Still unverified: export with more than 100 retained records, automatic oldest-record trimming after exceeding the limit, Save-dialog cancellation and filesystem permission/error behavior.

## Operator acceptance record — November 4, 2026

Environment: RemoteHand Windows 11 VM `TENCHI` (API listener `192.168.93.149:8765`) and a separate Windows client. The operator reported successful Windows release builds and supplied screenshots/PowerShell output throughout acceptance. Tests were manual, not automated CI.

| Area | Outcome | Evidence / limitation |
| --- | --- | --- |
| Local read-only API and OpenAPI explorer | **Passed** | Health/status routes returned HTTP 200, authenticated explorer worked, route discovery and plugins placeholder returned expected results. |
| Auth / token rotation | **Passed** | Old token returned HTTP 401 after rotation; newly issued token returned HTTP 200. |
| IPv4 bindings | **Passed** | Localhost, all interfaces (`0.0.0.0`), and specific VM IPv4; other machine could access only supported listener bindings. |
| HTTPS with mkcert | **Passed, functional TLS** | Windows TLS handshake issue fixed; local `curl.exe -vk` returned HTTP 200 and remote `https://192.168.93.149:8765/api/docs` loaded. Browser still displayed untrusted CA warning on client; certificate trust explicitly deferred. |
| Enable/disable and process lifecycle | **Passed** | Disabling API closed listener; re-enabling restored it. Full RemoteHand exit stopped service, restart restored saved settings and listener. |
| Access history and persistence | **Passed** | HTTP 200/401 records, source IPs, timestamp, route, and durations shown; records survived restart. |
| RemoteHand confirmation modals | **Passed** | Rotation confirmation updated from native browser prompt; native `confirm` calls removed from `src/App.tsx`. |
| CSV export | **Passed, initial scope** | Native Save dialog created readable CSV including successful and failed requests. Full 100+ entry export not yet verified. |
| History retention setting persistence | **Passed** | Changed from 1,000 to 500; UI retained 500 after restart with 31 existing entries. |

### Deferred / pre-merge validation

- Trust the mkcert root CA on the client and verify a certificate-validated HTTPS request without `-k` and without a browser exception, when required by target deployment.
- Generate more than 100 API requests to verify full-history export beyond the viewer cap, lower retention to 100 and confirm oldest entries are trimmed on disk and across restarts.
- Verify canceled CSV Save dialog creates no file and filesystem write failures show an actionable error.
- Review the regenerated Rust `Cargo.lock` from a clean Windows build and commit if tracked by the repository. Confirm CI checks and final merged diff before merge.

The primary user-controlled LAN development scenario was accepted manually; deferred cases are not represented as passed.

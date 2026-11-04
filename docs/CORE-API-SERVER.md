# Core API Server v1 (test branch)

RemoteHand exposes an opt-in read-only HTTP API **only while the RemoteHand process is running**.

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

Settings → API Server includes a request history viewer with **Refresh**, **Clear history** (confirmation required), and refresh every five seconds while the tab is open. Recent requests display local date/time, source IP, method, path, HTTP status, and duration in milliseconds. A summary shows successes and failures based on the retained records.

The audit log is private to RemoteHand's Settings UI and is **not published as an HTTP endpoint**. A bounded background writer retains the last **1,000 requests** in portable `data/activity/api-history.json` and displays the most recent **100**. It records completed HTTP responses including success, unauthorized, missing route, and wrong method; tokens, headers, query parameters, and request bodies are never stored. Timestamps are recorded as UTC Unix milliseconds (string) and rendered in the user's local time zone. The access history is best-effort, bounded, and not a tamper-proof security audit system.

## Routes

| Method | Path | Authentication | Response |
| --- | --- | --- | --- |
| GET | `/api/docs` | No (localhost only) | Offline interactive API explorer (HTML) |
| GET | `/api/openapi.json` | No (localhost only) | OpenAPI 3.0.3 JSON specification |
| GET | `/api/v1/health` | No (localhost only) | `status: ok`, service identity |
| GET | `/api/v1/core/status` | Bearer token | Application name, version, platform, uptimeSeconds |
| GET | `/api/v1/plugins` | Bearer token | Empty list until plugin API providers are supported |
| GET | `/api/v1/routes` | Bearer token | Currently registered core routes and auth requirements |

API replies are JSON except the HTML documentation at `/api/docs`. The bundled explorer loads its OpenAPI schema from the running server, provides in-memory Bearer authorization, and supports GET requests through **Try it out**. This is a lightweight locally bundled **OpenAPI explorer**, not the upstream Swagger UI distribution; it requires no CDN and never stores the token in localStorage or cookies. The `Open API Documentation` button in Settings opens only the local API server. The documentation and schema are public *on localhost*; neither contains secrets. The two documentation routes are also listed by route discovery.

All replies include `Cache-Control: no-store`. Missing or invalid credentials on protected routes return HTTP 401. Unknown authenticated routes return HTTP 404. Non-GET requests return HTTP 405. HTTP request parsing is intentionally minimal for this bounded localhost-only milestone.

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

The listener supports explicit LAN/Tailnet IPv4 binding using either opt-in unencrypted HTTP (trusted isolated networks only) or HTTPS with a valid certificate and key. Remote HTTP and HTTPS behavior have not yet been operator-accepted. For DisplayHand, configure a trusted certificate matching the endpoint address and verify the connection using its generic HTTPS JSON source. Never forward this API port openly to an untrusted network.

## Later milestones

- Plugin route registration and authorization policy through generic host-owned IPC.
- System Monitor read-only metric endpoints.
- Target Monitor read-only target status endpoints.
- Safe remote-device consumption from DisplayHand.

These are **not yet implemented**. Do not treat the empty plugins response as a list of all installed plugins.

## Notes for developers

Core's `api_server.rs` maintains a bounded, process-owned nonblocking localhost listener, serves short JSON responses, and uses a constant-time bearer token comparison. Configuration and token management are exposed as native Tauri commands. Standard plugins remain unchanged and have no API capabilities until a specific publication contract is implemented and reviewed.

Prior Core API routes, OpenAPI docs and bearer authentication were successfully tested manually on Windows by Papa. The new remote-binding and access-history changes have **not been compiled or tested** in the ChatGPT connector environment. The new Rust TLS dependencies will cause Cargo.lock to update when Cargo resolves them; review and commit the regenerated lockfile before merging. Windows build and manual tests are required before acceptance.

## Additional Windows acceptance checks

After building, with RemoteHand enabled and bound to localhost:

1. Open **Settings → API Server** and verify Access History lists previous requests or the new ones you generate. Call health and protected status; refresh history and confirm timestamp, `127.0.0.1`, route, status (200), and duration. Call a protected endpoint without a token and verify 401 is recorded.
2. Click **Clear history**, confirm, and verify the records are gone. Generate a new request and verify it appears. Exit and relaunch RemoteHand; the new record should remain.
3. Select **All interfaces** and HTTPS with blank certificate/key paths, then click **Apply**. Verify the action is rejected and the existing listener remains in its original state. Next choose HTTP, apply with explicit warning confirmation, and verify the URL shows HTTP and the remote client can reach it from an isolated test network. Restore localhost after the test.
4. If you have a trusted TLS certificate and matching private key, set a specific local LAN/Tailnet IPv4 address, choose HTTPS and provide paths. Apply and confirm; verify HTTPS from another trusted client and verify HTTP is not accepted at that address. Use the certificate's actual host/IP SAN. Confirm the new source IP appears in history.
5. Restore binding to localhost and verify prior HTTP behavior and port. Disable the API and confirm the listener closes; fully exit and verify the same.

Do not expose the server over public internet or broadly open Windows Firewall. A certificate alone does not enforce network trust; use appropriate firewall rules and network access controls for the chosen interface.

## HTTPS handshake troubleshooting (Windows)

Windows acceptance found the API listener reporting HTTPS running while `curl.exe -vk https://127.0.0.1:8765/api/v1/health` failed with `Recv failure: Connection was aborted` during TLS negotiation. The fix explicitly switches each accepted socket to blocking mode (a nonblocking listening socket may produce nonblocking accepted sockets on Windows), completes the Rustls handshake before reading the HTTP request, and logs handshake/read failures. This change requires a fresh Windows build and operator re-test.

Smoke-test on the RemoteHand machine with `curl.exe -vk https://127.0.0.1:8765/api/v1/health`, then from the client using the real LAN IP. `-k` is for TLS diagnosis only: remove it once the client trusts the mkcert root CA, and verify without disabling TLS validation. Do not consider HTTPS accepted until both handshake and authenticated routes work.

## API Access History CSV export and retention

Settings → API Server → API Access History now offers **Export CSV** alongside Refresh and Clear history. It opens a native Save dialog, exporting the entire retained audit log, latest entries first—not only the 100 shown in the table. Columns are `Timestamp (Unix ms)`, `Client IP`, `Method`, `Route`, `Status`, and `Duration (ms)`. CSV fields are quoted and untrusted leading spreadsheet-formula characters are escaped. Authorization headers and bearer tokens are never logged or exported.

**Maximum saved requests** is configurable from **100 to 10,000**, default **1,000**. Choose a value and click **Apply**; RemoteHand saves the preference and trims the oldest entries immediately if the new limit is smaller. The UI still displays only the latest 100 for responsiveness, while the CSV contains all retained records. A canceled Save dialog does not write a file.

Acceptance still required: Windows release build; export and inspect CSV rows (including >100 entries); change limit and verify retention after restart; verify cancel behavior and permissions/error display.

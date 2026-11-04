# Core API Server v1 (test branch)

RemoteHand exposes an opt-in read-only HTTP API **only while the RemoteHand process is running**.

## Settings

Open **Settings → API Server**. By default, hosting is **disabled**. Enable it to start a listener on `127.0.0.1:8765` (configurable ports 1024–65535). The first enable creates a cryptographically random 256-bit access token under the portable `data/config/api-server-token` file. This token is intentionally **not included** in normal settings JSON, public endpoint responses, or logs.

Use **Reveal Token** to copy the secret into a trusted client, or **Rotate Token** to revoke the old one immediately. Handle the token as a password and protect portable data backups containing it. On Unix the token file is created with mode 0600; on Windows it uses the enclosing folder's ACL. API configuration persists in `data/config/settings.json`.

The API runs in the same RemoteHand application process and stops at process exit. It remains up when RemoteHand is minimized or placed in its system tray. Disabling the API stops the listener without quitting the application. No separate daemon, service, installer, or administrator privilege is required.

## Routes

| Method | Path | Authentication | Response |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | No (localhost only) | `status: ok`, service identity |
| GET | `/api/v1/core/status` | Bearer token | Application name, version, platform, uptimeSeconds |
| GET | `/api/v1/plugins` | Bearer token | Empty list until plugin API providers are supported |
| GET | `/api/v1/routes` | Bearer token | Currently registered core routes and auth requirements |

All replies are JSON, with `Cache-Control: no-store`. Missing or invalid credentials on protected routes return HTTP 401. Unknown authenticated routes return HTTP 404. Non-GET requests return HTTP 405. HTTP request parsing is intentionally minimal for this bounded localhost-only milestone.

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

Expected: health and core status report `ok`, plugins returns `data: []`, and routes lists the four paths. Accessing `/core/status` without authorization must fail with 401. Minimize RemoteHand to tray: API should remain accessible. Disable API: HTTP connection should fail. Re-enable API: it should work again. Rotate the token: the previous token should return 401. Exit RemoteHand fully: the listener must disappear.

The listener **does not accept LAN/Tailnet requests** in this initial implementation. For use with DisplayHand on another machine, we should design and separately validate authenticated remote access (for example TLS and Tailnet binding/proxy) before enabling it. Do not forward this local HTTP port openly to an untrusted network.

## Later milestones

- Plugin route registration and authorization policy through generic host-owned IPC.
- System Monitor read-only metric endpoints.
- Target Monitor read-only target status endpoints.
- Safe remote-device consumption from DisplayHand.

These are **not yet implemented**. Do not treat the empty plugins response as a list of all installed plugins.

## Notes for developers

Core's `api_server.rs` maintains a bounded, process-owned nonblocking localhost listener, serves short JSON responses, and uses a constant-time bearer token comparison. Configuration and token management are exposed as native Tauri commands. Standard plugins remain unchanged and have no API capabilities until a specific publication contract is implemented and reviewed.

Current code is a Windows-test candidate. No local Rust/Windows build or live HTTP tests were performed in the ChatGPT connector environment; operator build and smoke-test results are required before declaring acceptance.

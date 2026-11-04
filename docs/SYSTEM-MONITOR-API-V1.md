# System Monitor HTTP API v1 — implementation candidate

**Status:** feature-branch implementation; not released or Windows-accepted. Do not merge, tag, or publish before operator build and manual acceptance.

## Dependency and architecture

- Core branch: `webbytenchi/remotehand` / `emma/monitoring-api-v1`.
- Compatible plugin candidate: `webbytenchi/remotehand-plugin-system-monitor` / `emma/system-monitor-api-v1`.
- The already released System Monitor v0.5.1 does **not** provide `system.api.read`. Both candidate builds are required for live responses.
- API server remains opt-in, process-bound, and bearer authenticated. Host checks installed/enabled status, routes the request through the existing plugin IPC session with a bounded deadline, and records HTTP access history.
- Plugin method: `system.api.read`, parameter `{"view":"summary|metrics|gpus|disks|history|alerts"}`. This is explicitly **not** `system.status`: the latter exposes configuration and extra internal state.
- All API responses are wrapped as `{"status":"ok","data":{...}}`.
- Unknown paths are 404 (after authentication); missing/invalid bearer tokens are 401; missing, disabled, old, or unresponsive plugin yields 503. An oversized response (>256 KiB serialized JSON) yields 502. No raw plugin errors in response body.

## Authenticated read-only routes

| Method | Path | Data allowlist |
| --- | --- | --- |
| GET | `/api/v1/system-monitor` | timestamp, CPU %, memory %, optional temperature, GPU and disk counts |
| GET | `/api/v1/system-monitor/metrics` | timestamp, CPU % and per-core %, memory bytes and %, optional CPU temperature |
| GET | `/api/v1/system-monitor/gpus` | timestamp, numbered GPU telemetry: utilization, dedicated/shared memory bytes, optional temperature |
| GET | `/api/v1/system-monitor/disks` | timestamp, numbered disk capacity, usage and read/write throughput |
| GET | `/api/v1/system-monitor/history` | latest **120** timestamped CPU %, memory %, optional temperature samples |
| GET | `/api/v1/system-monitor/alerts` | **active** warning/critical alert metric and state only |

No process data, GPU LUID, drive letters, disk mount points, names, filesystem identities, HTTP secrets, settings/config, full alert history, sound paths or private internal state are included. The plugin intentionally emits index-based device references rather than stable hardware identifiers; confirm suitability with Papa before final release. The history endpoint caps records rather than accepting unbounded queries. Alert events that have recovered are not returned by the active-alert endpoint.

## Operator acceptance sequence

1. **Build the plugin candidate** on Windows, with `cargo test` and its usual optimized executable/package workflow; confirm added API projection tests and existing regressions pass.
2. **Build RemoteHand** from its candidate branch using `npm.cmd ci`, `npm.cmd run tauri build` or a focused `cargo test` as appropriate. No CI/build success is claimed from GitHub editing.
3. Install the **candidate** plugin into the candidate RemoteHand; confirm it is enabled and its runtime is started.
4. Enable API in Settings, obtain bearer token locally without posting the token in chat. Confirm all six protected endpoints return schema-shaped safe data; confirm OpenAPI and route discovery reflect them.
5. Test 401 without/with bad token; 503 if plugin disabled/outdated; history `<=120` points, no private paths/config/process data, active alerts only; check Access History captures requests.
6. Verify tray/disable/exit still behave correctly and no host/UI freeze when the plugin is unresponsive. Verify bounded calls under concurrent UI requests.

### Example PowerShell smoke test (after building both candidates)

```powershell
$Base = 'http://127.0.0.1:8765'
$Token = Read-Host 'Paste API bearer token locally'
$Headers = @{ Authorization = "Bearer $Token" }
Invoke-RestMethod "$Base/api/v1/system-monitor" -Headers $Headers
Invoke-RestMethod "$Base/api/v1/system-monitor/metrics" -Headers $Headers
Invoke-RestMethod "$Base/api/v1/system-monitor/gpus" -Headers $Headers
Invoke-RestMethod "$Base/api/v1/system-monitor/disks" -Headers $Headers
Invoke-RestMethod "$Base/api/v1/system-monitor/history" -Headers $Headers
Invoke-RestMethod "$Base/api/v1/system-monitor/alerts" -Headers $Headers
```

## Deferred before acceptance

- No Target Monitor integration in this slice.
- Review safe DTO semantics, device identifiers, alert naming, and empty/unavailable data on actual Windows hardware.
- The existing plugin runtime has synchronous IPC; HTTP calls have a limited timeout for queue acquisition and response receive. Revisit write-path stall scenarios and HTTP concurrency during extended validation.
- Keep `/api/v1/plugins` as its existing empty placeholder until the general plugin publication contract is accepted.

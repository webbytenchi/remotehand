# Generic Plugin API Gateway v1 — RemoteHand v1.4.0

**Status:** integrated and Windows-tested with System Monitor v0.5.2 and Target Monitor v0.7.12; included in the RemoteHand v1.4.0 release source. Final exact-main build, packaging and tag verification are required before public release. One Core upgrade supplies a generic route gateway. Compatible future plugin API routes require **no further RemoteHand Core changes**.

## Design rationale and backward compatibility

The initial six System Monitor routes were hardcoded into Core and have been replaced with dynamic discovery.

- **Core**: `webbytenchi/remotehand`, branch `emma/monitoring-api-v1`.
- **System Monitor**: `webbytenchi/remotehand-plugin-system-monitor`, released **v0.5.2**, seven routes.
- **Plugin API v1 is unchanged**: `plugin.json` remains unchanged and retains `apiVersion: 1`. The API contract lives in an **optional, separate `api.json`** file in the plugin package root. Older RemoteHand versions ignore that extra file and preserve the existing plugin UI.
- **Core** discovers the enabled plugins' `api.json` declarations dynamically on each request, validates them and publishes their GET routes. There is no hardcoded System Monitor or Target Monitor knowledge.
- **Plugin** handles the generic `api.read` IPC method with `{"view":"...","pathParams":{...}}`, returns an explicitly sanitized object. Core forwards no raw tokens, headers, bodies, or query strings.
- A plugin that has no `api.json` continues functioning normally in its UI without HTTP publishing. An enabled API plugin whose runtime is not available returns HTTP 503. Disabled plugin routes disappear from discovery.
- `/api/openapi.json`, `/api/docs`, `/api/v1/routes`, and `/api/v1/plugins` dynamically enumerate registered APIs.
- Existing Core API auth settings, HTTP(S) listener, access history and token rotation remain in Core; API is opt-in and disabled by default. The endpoint remains read-only GET.
- Core enforces descriptor version, restricted base paths, GET-only publication, path segment and parameter bounds, route count caps, duplicate/conflict rejection, symlink/size checks, IPC response deadline, JSON object responses and 256 KiB reply ceiling. The plugin author is responsible for selecting explicitly safe response fields and implementing `api.read` without leaking private settings or user data.

## api.json declaration example

```json
{
  "version": 1,
  "basePath": "/api/v1/system-monitor",
  "routes": [
    {"path": "/", "view": "summary", "summary": "System Monitor overview"},
    {"path": "/metrics", "view": "metrics", "summary": "System metrics"},
    {"path": "/gpus", "view": "gpus", "summary": "GPU telemetry"},
    {"path": "/disks", "view": "disks", "summary": "Disk telemetry"},
    {"path": "/history", "view": "history", "summary": "System metrics history"},
    {"path": "/alerts", "view": "alerts", "summary": "Active system alerts"}
  ]
}
```

Only a plugin's own `api.json` defines routes, so adding a future plugin requires implementing `api.read`, packaging `api.json`, and installing/enabling the plugin. No Core build or route registration edits should be needed.

Target Monitor **v0.7.12** uses the same contract for seven routes including `/targets/{id}`, `/targets/{id}/checks` and `/targets/{id}/history`. The OpenAPI explorer renders a separate input for every declared path parameter, substitutes values when trying the endpoint, and validates them against the gateway's restricted ASCII path-segment rules. Multiple named parameters are supported by design; one variable per endpoint has been live-tested. Named parameters arrive in plugin IPC as `pathParams`, never a raw request path.

## Released System Monitor routes

| Method | Route | Sanitized response |
| --- | --- | --- |
| GET | `/api/v1/system-monitor` | CPU/memory/temperature and device counts |
| GET | `/api/v1/system-monitor/metrics` | CPU, cores, memory, temperature |
| GET | `/api/v1/system-monitor/gpus` | Numbered utilization/memory/temperature without LUIDs |
| GET | `/api/v1/system-monitor/disks` | Numbered capacity/usage/throughput without mount paths |
| GET | `/api/v1/system-monitor/history` | Last 120 CPU/memory/temperature points |
| GET | `/api/v1/system-monitor/alerts` | Only currently active warning/critical alert states |
| GET | `/api/v1/system-monitor/catalog` | Dashboard-ready metric labels, units and data sources |

## HTTP responses

- 200: authorized successful response, shaped as `{"status":"ok","data":{...}}`.
- 401: missing or invalid bearer token for protected endpoints.
- 404: unknown route or disabled/absent plugin API.
- 405: method other than GET.
- 502: invalid or oversized plugin response.
- 503: plugin advertised an API but its runtime is unavailable, incompatible, failed, or timed out.

The existing `/api/v1/plugins` endpoint now enumerates enabled API-publishing plugins by id, rather than the previous empty placeholder. It is **not** a full list of installed plugins.

## Windows acceptance and release validation

- RemoteHand generic API Gateway on `emma/monitoring-api-v1` compiled with a successful optimized Windows Tauri release build on TENCHI at commit `80ddaf9a0ca816eac8d1ac9e4fb17238cf90e3a1`. The updated API explorer accepted the `{id}` input and routed real target values.
- **System Monitor v0.5.2**: seven authenticated routes returned HTTP 200, invalid bearer authentication failed, and disabling the plugin removed its API routes. The plugin is independently released.
- **Target Monitor v0.7.12**: seven authenticated routes returned HTTP 200, including current Ping status/history and live TCP + HTTP checks; `/targets/{id}`, `/checks` and `/history` worked after entering the target ID in the explorer. Missing bearer tokens returned HTTP 401. Disabling Target Monitor removed its routes while System Monitor stayed available; the operator re-enabled Target Monitor. The plugin is independently released.
- The Core Rust **unit-test executable** previously failed to start on the Windows test machine with `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`; `cargo check` and the optimized release build succeeded. **Do not claim Core Rust unit tests passed** until an executable test run succeeds; report this validation limitation in the v1.4.0 release notes.
- The final v1.4.0 tagged build must be produced and smoke-tested from the exact merged `main` source, with all release assets and checksums verified before publication. The existing Windows API listener is opt-in, disabled by default.

## Constraints and caveats

- The gateway protocol is **v1** (GET + JSON object responses + sanitized DTOs); future protocol changes may require a Core upgrade. New plugins adhering to v1 need no new Core update.
- Read-only HTTP does not intrinsically make a plugin response safe; plugin authors must explicitly sanitize the returned DTO. Core guards size and shape, not the semantic safety of arbitrary plugin-chosen fields.
- Plugin IPC writes still use the existing synchronous transport; Core bounds queue wait and reply receive, and cleans pending calls after timeout. Further hostile-plugin hang testing is advisable before public exposure.
- Currently the Core API listener serves connections sequentially; a slow plugin can delay other HTTP requests for up to the bounded IPC deadline. Production concurrency can be a later gateway-protocol-compatible optimization, not a requirement for new plugin APIs.

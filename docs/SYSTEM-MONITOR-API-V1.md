# Generic Plugin API Gateway v1 — implementation candidate

**Status:** unmerged feature branches, not yet Windows-tested or released. One Core upgrade supplies a generic route gateway. Adding compatible future plugin APIs requires **no further RemoteHand Core code changes**.

## Design rationale and backward compatibility

The initial six System Monitor routes were hardcoded into Core and have been replaced with dynamic discovery.

- **Core**: `webbytenchi/remotehand`, branch `emma/monitoring-api-v1`.
- **System Monitor**: `webbytenchi/remotehand-plugin-system-monitor`, branch `emma/system-monitor-api-v1`.
- **Plugin API v1 is unchanged**: `plugin.json` remains unchanged and retains `apiVersion: 1`. The API contract lives in an **optional, separate `api.json`** file in the plugin package root. Older RemoteHand versions ignore that extra file; they must still be smoke-tested before release.
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

For Target Monitor, the same descriptor contract supports future routes such as `/targets/{id}` and `/targets/{id}/alerts`. The named parameters are delivered as `pathParams`, with strict input characters and length checks; no raw request path is forwarded to plugins.

## Expected System Monitor routes

| Method | Route | Sanitized response |
| --- | --- | --- |
| GET | `/api/v1/system-monitor` | CPU/memory/temperature and device counts |
| GET | `/api/v1/system-monitor/metrics` | CPU, cores, memory, temperature |
| GET | `/api/v1/system-monitor/gpus` | Numbered utilization/memory/temperature without LUIDs |
| GET | `/api/v1/system-monitor/disks` | Numbered capacity/usage/throughput without mount paths |
| GET | `/api/v1/system-monitor/history` | Last 120 CPU/memory/temperature points |
| GET | `/api/v1/system-monitor/alerts` | Only currently active warning/critical alert states |

## HTTP responses

- 200: authorized successful response, shaped as `{"status":"ok","data":{...}}`.
- 401: missing or invalid bearer token for protected endpoints.
- 404: unknown route or disabled/absent plugin API.
- 405: method other than GET.
- 502: invalid or oversized plugin response.
- 503: plugin advertised an API but its runtime is unavailable, incompatible, failed, or timed out.

The existing `/api/v1/plugins` endpoint now enumerates enabled API-publishing plugins by id, rather than the previous empty placeholder. It is **not** a full list of installed plugins.

## Windows verification

Before installing any new Core build:
1. Check clean branches and SHA/ref of both feature candidates.
2. Test `cargo test --locked` and `cargo check --locked` in Core; note the earlier test-executable Windows error `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` (a loader problem to troubleshoot separately). A passing compilation alone is not a passing test run.
3. On System Monitor plugin branch: `cargo test`, then run the existing Windows packaging script using process-scoped execution policy as needed. **Rebuild the ZIP after the addition of `api.json`**. The candidate retains its existing `v0.5.1` label until a deliberate release bump; distinguish it from the published v0.5.1 ZIP by hash and contents.
4. Smoke test older RemoteHand v1.3.8 `7c0c778` with rebuilt candidate plugin. Initial prior candidate UI load passed but predates adding `api.json`; check installation and UI again.
5. After approval/test build Core and plugin, verify route discovery and OpenAPI reflect six routes, correct bearer 401, active-only alerts, bounded history, empty/unavailable plugin behavior, and that disabling the plugin removes its routes.
6. Verify restart with API enabled starts the plugin gateway with correct app context, as well as normal Settings enable, HTTPS, tray and exit.
7. Test dynamic path parameter contract with a suitable future plugin; unit tests currently cover Target Monitor-like declarations.
8. Do not merge, tag, release or claim Windows runtime acceptance until Papa reviews results.

## Constraints and caveats

- The gateway protocol is **v1** (GET + JSON object responses + sanitized DTOs); future protocol changes may require a Core upgrade. New plugins adhering to v1 need no new Core update.
- Read-only HTTP does not intrinsically make a plugin response safe; plugin authors must explicitly sanitize the returned DTO. Core guards size and shape, not the semantic safety of arbitrary plugin-chosen fields.
- Plugin IPC writes still use the existing synchronous transport; Core bounds queue wait and reply receive, and cleans pending calls after timeout. Further hostile-plugin hang testing is advisable before public exposure.
- Currently the Core API listener serves connections sequentially; a slow plugin can delay other HTTP requests for up to the bounded IPC deadline. Production concurrency can be a later gateway-protocol-compatible optimization, not a requirement for new plugin APIs.

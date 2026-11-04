//! Manifest-driven read-only plugin API gateway.
//! A plugin opts in via a separate api.json file; legacy plugin.json stays unchanged
//! so older RemoteHand hosts can still install the plugin.
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

const MAX_DESCRIPTOR_BYTES: u64 = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_PLUGIN_ROUTES: usize = 32;
const MAX_PATH_BYTES: usize = 256;
const MAX_DESCRIPTION_BYTES: usize = 512;
const MAX_PATH_PARAM_BYTES: usize = 128;
const RESERVED: &[&str] = &[
    "/api/docs", "/api/openapi.json", "/api/v1/health",
    "/api/v1/core", "/api/v1/plugins", "/api/v1/routes"
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApiDescriptor {
    version: u32,
    base_path: String,
    routes: Vec<ApiRoute>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApiRoute {
    path: String,
    view: String,
    summary: String,
    #[serde(default)]
    description: String,
}

#[derive(Clone, Debug)]
pub struct PublishedRoute {
    pub path: String,
    pub plugin_id: String,
    pub view: String,
    pub summary: String,
    pub description: String,
}

fn valid_segment(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 &&
        s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_path(path: &str, template: bool) -> bool {
    path.len() <= MAX_PATH_BYTES && path.starts_with('/') &&
    !path.contains("//") && !path.ends_with('/') &&
    path.split('/').skip(1).all(|segment| {
        if template && segment.starts_with('{') && segment.ends_with('}') {
            let name = &segment[1..segment.len() - 1];
            valid_segment(name)
        } else {
            valid_segment(segment)
        }
    })
}

fn parse_descriptor(content: &str, plugin_id: &str) -> Result<Vec<PublishedRoute>, String> {
    let desc: ApiDescriptor = serde_json::from_str(content).map_err(|_| "invalid api.json JSON")?;
    if desc.version != 1 { return Err("unsupported API descriptor version".into()); }
    if !desc.base_path.starts_with("/api/v1/") || !valid_path(&desc.base_path, false) ||
        RESERVED.iter().any(|r| desc.base_path == *r || desc.base_path.starts_with(&format!("{r}/"))) {
        return Err("invalid or reserved API base path".into());
    }
    if desc.routes.is_empty() || desc.routes.len() > MAX_PLUGIN_ROUTES {
        return Err("invalid number of API routes".into());
    }
    let mut paths = BTreeSet::new();
    let mut results = Vec::new();
    for route in desc.routes {
        if route.path != "/" && (!valid_path(&route.path, true) || route.path.len() > 128) {
            return Err("invalid API route path".into());
        }
        if route.view.is_empty() || route.view.len() > 64 ||
            !route.view.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err("invalid API view".into());
        }
        if route.summary.trim().is_empty() || route.summary.len() > 120 ||
            route.description.len() > MAX_DESCRIPTION_BYTES {
            return Err("invalid API documentation".into());
        }
        let path = if route.path == "/" { desc.base_path.clone() }
                   else { format!("{}{}", desc.base_path, route.path) };
        if path.len() > MAX_PATH_BYTES || RESERVED.contains(&path.as_str()) ||
            !paths.insert(path.clone()) {
            return Err("duplicate or reserved API route".into());
        }
        // Forbid duplicate parameter labels and ambiguous templates within a descriptor.
        let mut labels = BTreeSet::new();
        for segment in path.split('/').filter(|s| s.starts_with('{')) {
            if !labels.insert(segment) { return Err("duplicate API path parameter".into()); }
        }
        results.push(PublishedRoute {
            path, plugin_id: plugin_id.to_owned(), view: route.view,
            summary: route.summary, description: route.description,
        });
    }
    for (i, left) in results.iter().enumerate() {
        for right in results.iter().skip(i + 1) {
            if routes_overlap(&left.path, &right.path) {
                return Err("ambiguous API routes".into());
            }
        }
    }
    Ok(results)
}

fn routes_overlap(a: &str, b: &str) -> bool {
    let aa: Vec<&str> = a.split('/').collect();
    let bb: Vec<&str> = b.split('/').collect();
    aa.len() == bb.len() && aa.iter().zip(bb.iter()).all(|(l, r)| {
        l == r || l.starts_with('{') || r.starts_with('{')
    })
}

fn descriptor_path(plugin: &crate::plugins::PluginInfo) -> Result<PathBuf, String> {
    let root = crate::plugins::plugins_root_for_runtime()?;
    let dir = &plugin.directory;
    // directory originates from guarded, single-component plugin discovery.
    if dir.is_empty() || dir == "." || dir == ".." ||
        dir.contains('/') || dir.contains('\\') {
        return Err("unsafe plugin directory".into());
    }
    Ok(root.join(dir).join("api.json"))
}

/// Discovers enabled plugin API routes on demand, with no host release for new plugins.
/// A malformed descriptor excludes its plugin's routes without breaking other plugins.
pub fn published_routes() -> Vec<PublishedRoute> {
    let plugins = match crate::plugins::plugin_list() {
        Ok(plugins) => plugins,
        Err(error) => { log::warn!("API plugin discovery failed: {error}"); return vec![]; }
    };
    let mut routes = Vec::new();
    for plugin in plugins.into_iter().filter(|p| p.enabled) {
        let path = match descriptor_path(&plugin) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let metadata = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => { log::warn!("API descriptor cannot be read"); continue; }
        };
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() ||
            metadata.len() > MAX_DESCRIPTOR_BYTES {
            log::warn!("Ignoring invalid API descriptor for {}", plugin.manifest.id);
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        match parse_descriptor(&content, &plugin.manifest.id) {
            Ok(mut found) => {
                // Reject conflicts with ALL currently registered routes, including templated ones.
                if found.iter().any(|candidate| routes.iter().any(|existing: &PublishedRoute|
                    routes_overlap(&candidate.path, &existing.path))) {
                    log::warn!("Conflicting API descriptor for {}", plugin.manifest.id);
                } else {
                    routes.append(&mut found);
                }
            }
            Err(error) => log::warn!("Ignoring API descriptor for {}: {error}", plugin.manifest.id),
        }
    }
    routes
}

fn decode_segment(s: &str) -> Option<String> {
    // Exact path segments only; percent-encoding is deliberately unsupported in v1.
    (s.len() <= MAX_PATH_PARAM_BYTES && !s.is_empty() &&
        s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.')))
        .then(|| s.to_string())
}

pub fn match_route(path: &str, routes: &[PublishedRoute]) -> Option<(PublishedRoute, BTreeMap<String, String>)> {
    if path.len() > MAX_PATH_BYTES || path.contains('?') || path.contains('#') {
        return None;
    }
    for route in routes {
        let pattern: Vec<_> = route.path.split('/').collect();
        let parts: Vec<_> = path.split('/').collect();
        if pattern.len() != parts.len() { continue; }
        let mut params = BTreeMap::new();
        let mut matches = true;
        for (expected, actual) in pattern.iter().zip(parts.iter()) {
            if expected.starts_with('{') && expected.ends_with('}') {
                let key = &expected[1..expected.len()-1];
                match decode_segment(actual) {
                    Some(v) => { params.insert(key.to_string(), v); },
                    None => { matches = false; break; }
                }
            } else if expected != actual {
                matches = false; break;
            }
        }
        if matches { return Some((route.clone(), params)); }
    }
    None
}

pub fn read(route: &PublishedRoute, params: BTreeMap<String, String>, app: Option<&AppHandle>) -> (u16, Value) {
    let Some(app) = app else {
        return (503, json!({"status":"error","error":"plugin_unavailable"}));
    };
    if !matches!(crate::plugins::plugin_available(&route.plugin_id), Ok(true)) {
        return (503, json!({"status":"error","error":"plugin_unavailable"}));
    }
    let runtime = app.state::<crate::plugin_runtime::PluginRuntimeState>();
    // No HTTP headers, token, body, query, or arbitrary user-selected method crosses IPC.
    match runtime.call_with_timeout(&route.plugin_id, "api.read",
        json!({"view": route.view, "pathParams": params}), Duration::from_secs(2)) {
        Ok(data) => {
            if !data.is_object() || data.to_string().len() > MAX_RESPONSE_BYTES {
                (502, json!({"status":"error","error":"invalid_plugin_response"}))
            } else {
                (200, json!({"status":"ok","data":data}))
            }
        }
        Err(error) => {
            log::warn!("Plugin API call failed for {}: {error}", route.plugin_id);
            (503, json!({"status":"error","error":"plugin_unavailable"}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const DESCRIPTOR: &str = r#"{
        "version":1,"basePath":"/api/v1/target-monitor","routes":[
        {"path":"/targets","view":"targets","summary":"Targets"},
        {"path":"/targets/{id}","view":"target","summary":"Target"},
        {"path":"/targets/{id}/alerts","view":"target-alerts","summary":"Target alerts"}
        ]}"#;
    #[test] fn accepts_generic_target_monitor_contract() {
        let routes = parse_descriptor(DESCRIPTOR, "remotehand.target-monitor").unwrap();
        assert_eq!(routes.len(), 3);
        let (route, params) = match_route("/api/v1/target-monitor/targets/server-1/alerts", &routes).unwrap();
        assert_eq!(route.view,"target-alerts");
        assert_eq!(params["id"],"server-1");
        assert!(match_route("/api/v1/target-monitor/targets/%2e%2e/alerts", &routes).is_none());
    }
    #[test] fn rejects_conflicts_and_invalid_declarations() {
        assert!(parse_descriptor(r#"{"version":1,"basePath":"/api/v1/core","routes":[{"path":"/status","view":"x","summary":"Bad"}]}"#, "p").is_err());
        assert!(parse_descriptor(r#"{"version":1,"basePath":"/api/v1/x","routes":[{"path":"/{id}","view":"a","summary":"One"},{"path":"/static","view":"b","summary":"Two"}]}"#, "p").is_err());
        assert!(parse_descriptor(r#"{"version":1,"basePath":"/api/v1/x","routes":[{"path":"/../secret","view":"x","summary":"Bad"}]}"#, "p").is_err());
    }
    #[test] fn old_plugins_without_api_descriptor_have_no_routes() {
        assert!(parse_descriptor(DESCRIPTOR, "remotehand.target-monitor").is_ok());
        assert!(match_route("/api/v1/unknown", &[]).is_none());
    }
}

use std::path::{Component, Path, PathBuf};
pub(crate) fn safe_local_child(root: &Path, remote_name: &str) -> Result<PathBuf, String> {
    let name = remote_name;
    if name.is_empty() {
        return Err("remote entry name cannot be empty".to_string());
    }

    if name.contains('/') || name.contains('\\') {
        return Err(format!("unsafe remote entry name: {remote_name:?}"));
    }

    let path = Path::new(name);
    let mut components = path.components();

    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => return Err(format!("unsafe remote entry name: {remote_name:?}")),
    }

    let child = root.join(path);
    if child.parent() != Some(root) {
        return Err(format!(
            "unsafe local download destination: {}",
            child.display()
        ));
    }

    Ok(child)
}
#[cfg(test)]
mod tests {
    use super::safe_local_child;
    use std::path::Path;
    #[test]
    fn accepts_single_filename_component() {
        let root = Path::new("/tmp/downloads");
        assert_eq!(
            safe_local_child(root, "normal.txt").unwrap(),
            root.join("normal.txt")
        );
    }

    #[test]
    fn rejects_unsafe_remote_names() {
        let root = Path::new("/tmp/downloads");

        for name in [
            "",
            ".",
            "..",
            "../escape",
            "../../foo",
            "/absolute",
            "nested/path",
            r"C:\escape",
            r"..\escape",
            r"foo\..\bar",
            r"\\server\share",
        ] {
            assert!(
                safe_local_child(root, name).is_err(),
                "{name:?} should be rejected"
            );
        }
    }
}

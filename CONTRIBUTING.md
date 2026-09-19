# Contributing to RemoteHand

RemoteHand has reached its V1 feature baseline. Contributions should preserve the portable-first architecture and avoid regressing the accepted Windows/Linux desktop workflows.

## Principles

Contributions should preserve these goals:

- Modern, approachable UI
- Strong security defaults
- Portable-only Windows and Linux operation
- Cross-platform design
- Reuse of mature protocol implementations
- Clear frontend/native separation
- Small, reviewable changes
- No unnecessary installer, service, or cloud dependencies

## Development Workflow

1. Create a focused branch.
2. Keep changes scoped and reviewable.
3. Add or update tests when behavior changes.
4. Run the relevant formatting, linting, tests, and build checks.
5. Test native/Tauri behavior on the affected platform when the change touches PTYs, SSH, SFTP, windows, paths, or portable storage.
6. Update documentation when architecture or user-visible behavior changes, including plugin API and panel-hosting behavior.
7. Open a pull request describing intent, implementation, and verification.
8. For plugin changes, test both development and release builds when the change affects sandboxing, CSP, IPC, or plugin loading.

Useful frontend commands:

```bash
npm install
npm run lint
npm run test
npm run build
npm run check
```

Run the desktop application with:

```bash
npm run tauri dev
```

Rust-side changes should also be checked with the appropriate Cargo tooling when the local platform toolchain is available.

## Portable-Data Contract

V1 stores application state relative to the executable under `data/`. Changes must not silently move normal portable state into user-profile, registry, system-wide, or installer-managed locations.

Current persistent areas include:

- `data/config/settings.json`
- `data/connections/connections.json`
- `data/activity/recent.json`
- `data/workspaces/default.json`
- `data/vault/credentials.enc`

Do not place plaintext credentials in normal settings, workspace, activity, or connection JSON files.

## Dependency Changes

New dependencies should include a short justification covering:

- Why the dependency is needed
- License
- Maintenance state
- Security considerations
- Platform support
- Packaging/portable impact
- Why existing dependencies cannot provide the capability

This is especially important for SSH, SFTP, RDP, VNC, X11, credentials, cryptography, PTY/process execution, filesystem, and update-related dependencies.

## Code Style

Prefer:

- Small focused modules
- Explicit interfaces
- Testable business logic
- Clear error handling
- Bounded command/process output
- No hidden security-sensitive fallbacks
- Compatibility with saved portable state when reasonable

Avoid broad formatting-only changes to unrelated native files. In particular, platform/build files should be changed deliberately because small formatting or quoting differences can affect Windows build behavior.

## User Interface

UI contributions should support:

- Keyboard navigation
- Dark, light, and system themes
- High-DPI displays
- Accessible labels/tooltips
- Responsive pane resizing
- Collapsed and expanded sidebar layouts
- Narrow panel widths without clipped controls
- Minimal unnecessary modal workflows

When changing Dockview component identifiers or serialized panel state, consider compatibility with existing saved workspace layouts.

## Security-Sensitive Changes

Changes involving the credential vault, SSH/SFTP authentication, known-host verification, process spawning, clipboard behavior, remote paths, or file transfer should receive extra review and explicit acceptance testing.

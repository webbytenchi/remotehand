# Contributing to RemoteHand

RemoteHand is currently in its early design/bootstrap stage.
Principles
Contributions should preserve these goals:

Modern and approachable UI

Strong security defaults

Cross-platform design

Portable Windows support

Reuse of mature protocol implementations

Clear separation between UI and protocol backends

Minimal unnecessary complexity

Development Workflow

Create a focused branch.

Keep changes scoped and reviewable.

Add or update tests when behavior changes.

Run formatting, linting, tests, and relevant integration checks.

Update documentation when architecture or user-visible behavior changes.

Open a pull request describing intent, implementation, and verification.

Dependency Changes
New dependencies should include a short justification covering:

Why the dependency is needed

License

Maintenance state

Security considerations

Why an existing dependency cannot provide the capability

This is especially important for SSH, RDP, VNC, X11, credential, cryptography, process-execution, and update-related dependencies.
Style
Detailed coding standards will be added once the initial Tauri/React project is scaffolded.
Prefer:

Small focused modules

Explicit interfaces

Testable business logic

Clear error handling

No hidden security-sensitive fallbacks

User Interface
UI contributions should support:

Keyboard navigation

Dark and light themes

High-DPI displays

Accessible labels/tooltips

Responsive pane resizing

Avoiding unnecessary modal workflows

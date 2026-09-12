# RemoteHand Roadmap

This roadmap describes intended sequencing, not fixed release dates.
Phase 0 - Foundation

Create repository

Establish product vision

Establish initial architecture

Establish security principles

Scaffold Tauri + React + TypeScript

Add coding standards and automated checks

Add CI

Validate portable-only Windows and Linux archive layout

Phase 1 - Workspace Shell
Goal: create the application experience before networking complexity.

Application shell

Light/dark/system themes

Connection sidebar

Dockview integration

Multiple tabs

Horizontal/vertical splits

Nested layouts

Drag/drop docking

Layout save/restore

Popout/detachable panels

Command palette

Keyboard navigation

Acceptance target: a polished desktop shell with mock session panes.
Phase 2 - Local Terminal

xterm.js integration

Backend PTY integration

Local PowerShell

Local Command Prompt

WSL integration where available

Resize handling

Copy/paste

Search

Terminal themes

Acceptance target: RemoteHand is useful as a local terminal even before SSH ships.
Phase 3 - SSH V1

Select and document SSH library

Host-key verification

Password authentication

Private-key authentication

SSH agent support where practical

Saved profiles

Reconnect/disconnect

Port forwarding

Connection-state UI

Known-host management

Security-focused integration tests

Acceptance target: daily-use SSH client with tabs and splits.
Phase 4 - Portable Data and Credential UX

Finalize Windows/Linux portable storage rules

Credential abstraction

Encrypted secret storage strategy

Import/export

Clear portable-only security documentation

Backup/restore configuration

Phase 5 - SFTP

Remote file browser

Upload/download

Drag/drop

Transfer queue

Conflict handling

Progress/speed/ETA

Permission editing where supported

Phase 6 - Remote Desktop
VNC

Select VNC library

Embedded viewer

Clipboard handling

Scaling/fullscreen

Authentication

RDP

Evaluate FreeRDP integration

Embedded vs orchestrated-client decision

Clipboard

Display scaling

Multi-monitor strategy

Credential integration

Phase 7 - X11

Evaluate Windows X11 strategies

Evaluate WSLg integration

X11 forwarding UX

Document limitations/security model

Phase 8 - Advanced Productivity

Host groups

Favorites

Per-host notes

Saved workspace templates

Session logging

Connection health/status

Tailscale-aware conveniences

Quick project/server shortcuts

Optional plugin architecture

Guiding Rule
A later protocol should not delay delivery of a polished SSH-first application.
RemoteHand should become useful early and grow incrementally.

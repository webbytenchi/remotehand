# Release Standard

This document defines the standard RemoteHand release process and release-note format.

## Release workflow

Use this sequence for every normal release:

1. Complete feature/fix work on a temporary branch.
2. Run the release checks on that branch:
   - `npm.cmd run lint`
   - `npm.cmd run test`
   - `npm.cmd run build`
   - `cargo check --manifest-path src-tauri\Cargo.toml`
3. Update documentation and version metadata on the branch:
   - `CHANGELOG.md`
   - `README.md` when the release changes documented behavior/status
   - `package.json`
   - `package-lock.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/Cargo.lock`
   - `src-tauri/tauri.conf.json`
4. Merge the branch into `main`, preferably by squash merge for release-prep branches.
5. Clean up the temporary branch locally and remotely.
6. Confirm `main` is at the intended release commit and that the only unrelated local state is intentionally retained.
7. Build the exact release binary from `main`:
   - `npm.cmd run tauri build`
8. Smoke-test that exact release binary before packaging.
9. Package the Windows x64 artifacts:
   - `RemoteHand-vX.Y.Z-windows-x64.exe`
   - `RemoteHand-vX.Y.Z-windows-x64.zip`
   - `SHA256SUMS.txt`
10. Create and push an annotated tag `vX.Y.Z` pointing to the exact release commit.
11. Create the GitHub Release from that tag.
12. Upload the three release artifacts and verify their sizes and SHA256 digests from GitHub after publication.

Do not modify or delete unrelated existing files under the local `release/` directory while preparing a new release.

## Release-note format

Use this structure for GitHub Releases:

~~~markdown
## RemoteHand vX.Y.Z

<One short paragraph describing the purpose of the release.>

### Added

- **Feature name**
  - User-visible behavior or capability.
  - Important implementation or compatibility detail when useful.

### Improved

- **Area**
  - What was improved and why it matters.

### Fixed

- **Issue name**
  - What was wrong.
  - What changed.
  - The user-visible result.

### Verification

<Platform/architecture> release-build testing covered:

- Important manual regression test
- Important restore/restart lifecycle test
- Important protocol/workflow test
- Frontend lint: <warning/error result>
- Tests: <result>
- Production frontend build: passed
- Cargo check: passed
- Final release EXE smoke test: passed

### SHA256

```text
<SHA256>  RemoteHand-vX.Y.Z-windows-x64.exe
<SHA256>  RemoteHand-vX.Y.Z-windows-x64.zip
```
~~~

Include only sections that apply. For example, a patch release may contain only `Fixed`, `Verification`, and `SHA256`.

## Release artifact rules

For Windows x64 releases, the standard published assets are:

- `RemoteHand-vX.Y.Z-windows-x64.exe`
- `RemoteHand-vX.Y.Z-windows-x64.zip`
- `SHA256SUMS.txt`

Generate SHA256 values from the final packaged artifacts, not from an earlier development build.

The GitHub Release must be checked after publication to confirm:

- correct release title and tag
- not draft unless intentionally requested
- not prerelease unless intentionally requested
- all expected assets report as uploaded
- uploaded asset sizes match the locally packaged files
- GitHub-reported SHA256 digests match `SHA256SUMS.txt`
- Markdown code fences in the release notes are properly closed

## Version/tag rules

- Application version: `X.Y.Z`
- Git tag: `vX.Y.Z`
- Release title: `RemoteHand vX.Y.Z`
- Use an annotated tag.
- The tag must point to the exact commit used to build and smoke-test the release binary.

## Current reference

RemoteHand v1.2.12 follows this release format and workflow. Continue using the same sequence for future releases: branch validation, docs/version prep, merge and branch cleanup, exact-main release build, smoke test, packaging/checksums, annotated tag, then GitHub Release publication.

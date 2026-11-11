# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The documentation (README and CHANGELOG) is rewritten in plain English.

## [1.2.0]

### Added

- **Editable preview.** Fix any parsed server before install: rename it, change
  `command`, `args` or `url`, and add, edit or remove `env` and `headers`
  entries. Risk is checked again as you edit, with a short debounce (about
  400 ms). A row that becomes blocked cannot be selected.
- **Credential wizard.** One click turns a value that looks like a `${VAR}`
  placeholder or a live secret (`sk-…`, `ghp_…`, `AKIA…`, JWTs, bearer tokens,
  long high-entropy strings) into a `!!js process.env.VAR` expression. The
  secret never lands in the config file.
- **Conflict strategies.** A batch no longer stops when one name already exists.
  Choose `skip` (the UI default, partial success), `overwrite` (profile-layer
  rows only) or `fail` (the whole batch aborts).
- **Connection test.** Probe a server before or after install. The Host runs a
  real MCP `initialize` handshake over stdio or Streamable HTTP, then
  `tools/list`. SSE is not supported and is reported as blocked. A failure
  reports the stage, the duration, server info, the protocol version, the tools
  and a stderr / HTTP detail tail.
- **Backups and rollback.** Each write first snapshots the patch to a sibling
  named `cordis.patch.yml.bak-<UTC timestamp>`, with a `-<n>` suffix on
  same-millisecond collisions. The newest 20 are kept and older ones pruned. A
  restore replaces the whole file and backs up the current content first, so a
  restore is itself undoable. The first write onto a missing patch makes no
  backup.
- **Write-conflict detection.** Install and restore refuse to write if the patch
  changed on disk since it was previewed (SHA-256 fingerprint). A conflict is
  reported instead of silently overwriting.
- **Redacted export.** Export installed servers as portable `mcpServers` JSON,
  with secret-looking values replaced by `${VAR}` placeholders.
- **Enable/disable toggle.** Turn a server off without deleting its row. The
  write sets `config.disabled: true`.
- **Install status polling.** After install the UI polls every 1200 ms until the
  servers are active. After 15 s it stops and explains why.
- **Route-level tests.** The HTTP layer has integration tests.

### Changed

- **The plugin shows under its package name, `dsh-mcp-installer`, in every
  language.** The Settings entry, the page title and the Plugin Manager metadata
  (`locale/en.json` and `locale/zh.json`) all use it verbatim. The translated
  aliases "MCP Installer" / "MCP 安装器" are gone, because a localized name hid
  the plugin from anyone searching for the package they just installed.
- **The Host half is fully localized.** Risk findings, parser notes and install
  results follow `Accept-Language`, so an English UI no longer shows hard-coded
  Chinese. Findings also carry stable codes, so the Client can re-localize them.
- **`/status` and `/servers` agree.** Both use the same layer-attribution logic
  and cover every layer, so the status strip no longer hides a server that
  `/servers` lists.
- **Docker and podman get a real security review.** `--privileged`, host-root
  mounts, `docker.sock` / `podman.sock` mounts, `--network host` and host
  PID/IPC namespaces are `high` risk. `--cap-add` is a warning.
- **Unpinned packages are flagged.** `npx`, `uvx` or `bunx` without an exact
  version raises a supply-chain drift warning.
- **Secret detection reads values, not only key names.** Reports carry key names
  in `params`, never values.
- **Every route shares one `route()` wrapper.** The method check, auth, body
  limits, localization and the error envelope live in one place, so a new route
  cannot forget them.
- **`shellSplit` keeps backslashes.** Windows paths such as `C:\work\bin`
  round-trip correctly.
- **URL fetching is bounded.** One 20-second deadline covers the whole redirect
  chain. DNS is checked again right before the request. Concurrency is capped at
  2 active and 8 queued. Private and loopback targets are refused.
- **Some fields cannot be translated.** VS Code `inputs`, `${workspaceFolder}`,
  `${env:VAR}` and Codex `env_file` are reported as such.
- **`lib/client.js` is minified.** The package is smaller.
- **CI runs on every push and pull request, not only on tags.** It runs
  typecheck, tests and the verify scripts.

### Fixed

- **Same-millisecond backups no longer overwrite each other.** Two writes inside
  one millisecond used to produce the same file name, so one snapshot was lost.
  Names now take a `-<n>` suffix when needed.
- **Renaming a server now clears its high-risk acknowledgement**, so the
  confirmation cannot be reused for a different command under a new name.
- **`layerOf` no longer mislabels a row from another layer as a profile-patch
  row.**
- **Test fixtures no longer embed literal provider tokens.** They are assembled
  at runtime, so GitHub push protection does not refuse the push.
  `npm run scan:secrets` enforces this locally and in CI.

## [1.1.1]

### Fixed

- Correctness fixes across the Host half of the installer.

## [1.1.0]

### Added

- Installed-server view backed by the live Loader, with layers, connection
  state and registered tools.
- Edit and delete for rows inserted by the current profile patch.

## [1.0.0]

### Added

- Initial release: paste, file or URL import; safety preview; write into the
  current profile's `cordis.patch.yml`.

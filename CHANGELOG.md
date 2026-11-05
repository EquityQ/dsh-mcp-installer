# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0]

### Added

- **Editable preview.** Every parsed server can be corrected before install:
  rename it, change `command` / `args` / `url`, and add, edit or remove
  `env` and `headers` entries. Risk is re-assessed as you edit, so a row that
  becomes blocked can no longer be selected.
- **Credential wizard.** Values that still look like `${VAR}` placeholders, and
  values that look like live secrets (`sk-…`, `ghp_…`, `AKIA…`, JWTs, bearer
  tokens), are detected and can be converted to a `!!js process.env.VAR`
  expression in one click, so the secret never lands in the config file.
- **Conflict strategies.** Installing a batch no longer aborts when one name
  already exists. Choose *skip existing* (partial success), *overwrite*
  (profile-layer rows only), or *fail* (the previous all-or-nothing behavior).
- **Connection test.** Probe a server before or after installing it: the Host
  performs the MCP `initialize` handshake over stdio or Streamable HTTP, lists
  the tools, and reports the stage it failed at (spawn, handshake, HTTP status)
  together with the server's stderr tail.
- **Backups and rollback.** Every write first snapshots the patch to a
  timestamped `.bak` sibling (20 kept, oldest pruned). The UI lists them and can
  restore any version, taking another backup first.
- **Write-conflict detection.** Writes carry the SHA-256 of the patch the UI
  previewed. If another writer (Config Editor, Plugin Manager, your editor)
  changed the file in between, the write is refused instead of silently
  overwriting it, and the UI offers a retry against the new content.
- **Redacted export.** Export every installed server as portable `mcpServers`
  JSON with secret-looking values replaced by `${VAR}` placeholders.
- **Enable/disable toggle.** Switch a server off without deleting its row
  (`disabled: true`, which the loader skips).
- **Install status polling.** After installing, the UI polls until the servers
  are active (or times out and explains why) instead of refreshing once.
- **Route-level tests.** The HTTP layer now has integration tests covering
  method gating, the authenticated-connection fence, body parsing, localized
  errors and every route's payload shape.

### Changed

- **The plugin displays under its package name, `dsh-mcp-installer`, in every
  language.** The Settings navigation entry, the page title, and the Plugin
  Manager metadata (`locale/en.json` + `locale/zh.json`) all use it verbatim
  instead of the translated "MCP Installer" / "MCP 安装器" aliases: a localized
  name hid the plugin from anyone searching for the package they just installed.
- **The Host half is fully localized.** Risk findings, parser notes and install
  results follow the request's `Accept-Language`; an English UI no longer shows
  hard-coded Chinese. Findings also carry stable codes so the Client can
  re-localize them.
- **`/status` and `/servers` now agree.** Both derive existing rows from the
  same layer-attribution logic and cover every layer, so the status strip no
  longer hides servers that `/servers` lists.
- **Docker/podman get a real security review.** `--privileged`, host-root
  mounts, `docker.sock` mounts, `--network host`, host PID/IPC namespaces and
  `--cap-add` are now flagged instead of being treated as trusted commands.
- **Unpinned packages are flagged.** `npx` / `uvx` / `bunx` invocations without
  an exact version raise a supply-chain drift warning.
- **Secret detection looks at values**, not just key names.
- Every route shares one wrapper, so a new route cannot forget the auth check,
  the method check or the body limits.
- The parser's `shellSplit` no longer eats backslashes, so Windows paths such as
  `C:\work\bin` survive round-tripping.
- URL fetching now applies one 20-second deadline to the whole redirect chain,
  re-checks DNS before the request (mitigating rebinding), and bounds
  concurrency.
- VS Code `inputs`, `${workspaceFolder}`, `${env:VAR}` and Codex `env_file` are
  reported as fields that cannot be translated directly.
- `lib/client.js` is minified; the package size dropped accordingly.
- CI runs typecheck and tests on every push and pull request, not only on tags.

### Fixed

- **Two backups written in the same millisecond no longer overwrite each other.**
  A backup name carried only a millisecond timestamp, so several writes inside
  one millisecond (routine on Linux, where a write takes well under a
  millisecond) produced the same file name and each snapshot replaced the
  previous one: the plugin reported a backup per write and silently kept one.
  Names now take a `-<n>` suffix when needed, and same-instant backups sort in
  the order they were taken.
- A high-risk acknowledgement was bound to the server *name*, so a different
  config under the same name reused the confirmation. It is now bound to the
  content fingerprint.
- `layerOf` mislabelled a row as coming from the profile patch when a
  same-named server existed in another layer.
- Test fixtures no longer embed literal provider tokens (`xoxb-…`, `ghp_…`,
  `AKIA…`, JWTs); they are assembled at runtime so GitHub's push protection
  does not refuse the push. `npm run scan:secrets` enforces this locally and in
  CI.

## [1.1.1]

### Fixed

- Correctness fixes across the Host halves of the installer.

## [1.1.0]

### Added

- Installed-server view backed by the live Loader, with layers, connection
  state and registered tools.
- Edit and delete for rows inserted by the current profile patch.

## [1.0.0]

### Added

- Initial release: paste, file or URL import; safety preview; write into the
  current profile's `cordis.patch.yml`.

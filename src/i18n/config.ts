/**
 * Persistence messages (`config.*`).
 *
 * Owned by `src/config.ts`: spec validation, install/update/delete/toggle/
 * restore outcomes, conflict handling, backup notes, status/servers warnings
 * and the redacted export. `config.test.mjs` asserts that every key resolves to
 * a non-empty message in both languages and that the historical Chinese
 * substrings the existing suite matches are still produced.
 */
import type { MessageCatalog } from './types.js';

export const configMessages: MessageCatalog = {
  // ── spec validation (the /install trust boundary) ─────────────────────────
  'config.specNotObject': {
    zh: 'spec 必须是对象',
    en: 'spec must be an object',
  },
  'config.specUnknownField': {
    zh: 'spec 含未知字段 "{key}"',
    en: 'spec contains an unknown field "{key}"',
  },
  'config.nameInvalid': {
    zh: 'serverName "{name}" 不符合 DSH 的命名规则（[A-Za-z0-9_-]{1,32}）',
    en: 'serverName "{name}" does not follow the DSH naming rule ([A-Za-z0-9_-]{1,32})',
  },
  'config.transportInvalid': {
    zh: '服务器 "{name}" 的 transport 不合法',
    en: 'transport of server "{name}" is not supported',
  },
  'config.sourceInvalid': {
    zh: '服务器 "{name}" 的 source 不合法',
    en: 'source of server "{name}" is not supported',
  },
  'config.commandRequired': {
    zh: '服务器 "{name}" 的 command 必须是非空字符串',
    en: 'command of server "{name}" must be a non-empty string',
  },
  'config.commandTooLong': {
    zh: '服务器 "{name}" 的 command 过长',
    en: 'command of server "{name}" is too long',
  },
  'config.argsArray': {
    zh: '服务器 "{name}" 的 args 必须是数组（最多 256 项）',
    en: 'args of server "{name}" must be an array (at most 256 items)',
  },
  'config.argsString': {
    zh: '服务器 "{name}" 的 args 只能包含字符串',
    en: 'args of server "{name}" may contain strings only',
  },
  'config.argsTooLong': {
    zh: '服务器 "{name}" 的 args 单项过长',
    en: 'an item of args for server "{name}" is too long',
  },
  'config.urlInvalid': {
    zh: '服务器 "{name}" 的 url 不合法',
    en: 'url of server "{name}" is invalid',
  },
  'config.disabledInvalid': {
    zh: '服务器 "{name}" 的 disabled 必须是布尔值',
    en: 'disabled of server "{name}" must be a boolean',
  },
  'config.mapObject': {
    zh: '服务器 "{name}" 的 {label} 必须是对象',
    en: '{label} of server "{name}" must be an object',
  },
  'config.mapTooMany': {
    zh: '服务器 "{name}" 的 {label} 项数过多',
    en: '{label} of server "{name}" has too many entries',
  },
  'config.mapKeyInvalid': {
    zh: '服务器 "{name}" 的 {label} 键不合法',
    en: 'a key of {label} for server "{name}" is invalid',
  },
  'config.mapValueInvalid': {
    zh: '服务器 "{name}" 的 {label}.{key} 必须是不超过 8192 字符的字符串',
    en: '{label}.{key} of server "{name}" must be a string of at most 8192 characters',
  },
  'config.stdioCommandMissing': {
    zh: '服务器 "{name}" 是 stdio 传输，必须提供 command',
    en: 'server "{name}" uses stdio transport and needs a command',
  },
  'config.httpUrlMissing': {
    zh: '服务器 "{name}" 是 streamable-http 传输，必须提供 url',
    en: 'server "{name}" uses streamable-http transport and needs a url',
  },

  // ── install ───────────────────────────────────────────────────────────────
  'config.installMissingSpecs': {
    zh: '安装请求缺少 specs 数组。',
    en: 'The install request is missing the specs array.',
  },
  'config.installEmpty': {
    zh: '没有勾选任何要安装的服务器。',
    en: 'No server was selected for installation.',
  },
  'config.installTooMany': {
    zh: '一次最多安装 {max} 个服务器。',
    en: 'At most {max} servers can be installed at once.',
  },
  'config.installInvalid': {
    zh: '安装请求不合法：{detail}',
    en: 'The install request is invalid: {detail}',
  },
  'config.batchDuplicate': {
    zh: '本批次中服务器名重复：{name}，未写入。',
    en: 'The batch repeats the server name {name}; nothing was written.',
  },
  'config.installBlockedHeader': {
    zh: '以下服务器不能安装：\n{detail}',
    en: 'These servers cannot be installed:\n{detail}',
  },
  'config.installBlockedRow': {
    zh: '- {name}：{reasons}',
    en: '- {name}: {reasons}',
  },
  'config.acknowledgeRequired': {
    zh: '以下高风险服务器尚未确认：{names}。请逐项勾选确认后再安装。',
    en: 'These high-risk servers are not acknowledged yet: {names}. Confirm each one before installing.',
  },
  'config.resolveFailed': {
    zh: '无法定位 profile 配置文件：{detail}',
    en: 'Cannot locate the profile configuration file: {detail}',
  },
  'config.readFailed': {
    zh: '无法读取 {file}：{detail}',
    en: 'Cannot read {file}: {detail}',
  },
  'config.writeFailed': {
    zh: '写入 {file} 失败：{detail}',
    en: 'Failed to write {file}: {detail}',
  },
  'config.backupFailed': {
    zh: '写入前备份失败，为避免丢数据已放弃本次修改：{detail}',
    en: 'The pre-write backup failed, so this change was abandoned to avoid data loss: {detail}',
  },
  'config.conflictExists': {
    zh: '服务器名 "{name}" 已存在（id: {id}）',
    en: 'Server name "{name}" already exists (id: {id})',
  },
  'config.conflictRowId': {
    zh: '行 id "{id}" 已被占用',
    en: 'Row id "{id}" is already taken',
  },
  'config.conflictRefuse': {
    zh: '。为避免覆盖已有配置，本次未写入；请修改来源中的服务器名后重试。',
    en: '. Nothing was written so existing configuration is not overwritten; rename the server in the source and retry.',
  },
  'config.conflictChanged': {
    zh: '配置文件已被其他程序修改（hash 不匹配），本次未写入。请刷新后重试。',
    en: 'The configuration file was changed by another program (hash mismatch) and nothing was written. Refresh and retry.',
  },
  'config.conflictChangedHash': {
    zh: '。当前 hash：{hash}',
    en: '. Current hash: {hash}',
  },
  'config.precheckYaml': {
    zh: '写入前校验失败：生成的 patch 不是合法的 YAML 序列，未写入。',
    en: 'Pre-write check failed: the generated patch is not a valid YAML sequence; nothing was written.',
  },
  'config.precheckRowMissing': {
    zh: '写入前校验失败：未能在新文档中定位行 {id}，未写入。',
    en: 'Pre-write check failed: row {id} is missing from the new document; nothing was written.',
  },
  'config.precheckNotSingle': {
    zh: '写入前校验失败：{names} 在写入后的文档中不是恰好一条，未写入。',
    en: 'Pre-write check failed: {names} is not exactly one row in the new document; nothing was written.',
  },
  'config.precheckMismatch': {
    zh: '写入前校验失败：{name} 写入后的行 id 不是 {id}，未写入。',
    en: 'Pre-write check failed: the row for {name} does not have id {id}; nothing was written.',
  },
  'config.effectNote': {
    zh: '新建会话或重启 DSH 后生效；若当前部署启用了 HMR，profile patch 的变更也会被自动重载。工具将以 mcp__<serverName>__<toolName> 的形式出现。',
    en: 'It takes effect in a new session or after restarting DSH; when HMR is enabled the profile patch is reloaded automatically. Tools appear as mcp__<serverName>__<toolName>.',
  },
  'config.installedSummary': {
    zh: '配置已写入 {file}{note}，共 {count} 个服务器：{names}。',
    en: 'Configuration written to {file}{note}, {count} server(s): {names}. ',
  },
  'config.updatedSummary': {
    zh: '配置已更新 {file}，覆盖 {count} 个服务器：{names}。',
    en: 'Configuration updated in {file}, {count} server(s) overwritten: {names}. ',
  },
  'config.mixedSummary': {
    zh: '配置已写入 {file}：新增 {count} 个（{names}），覆盖 {updatedCount} 个（{updatedNames}）。',
    en: 'Configuration written to {file}: {count} added ({names}), {updatedCount} overwritten ({updatedNames}). ',
  },
  'config.existingNote': {
    zh: '（当前 profile 已有 {count} 个 MCP 服务器，本次未改动它们）',
    en: ' (the profile already had {count} MCP server(s); they were left untouched)',
  },
  'config.partialSuffix': {
    zh: '另有 {count} 个已存在的服务器按策略跳过：{names}。',
    en: ' {count} existing server(s) were skipped by policy: {names}.',
  },
  'config.allSkipped': {
    zh: '没有写入任何服务器：{count} 个服务器已存在，已按「跳过」策略跳过（{names}）。',
    en: 'Nothing was written: {count} server(s) already exist and were skipped by policy ({names}).',
  },
  'config.skipExists': {
    zh: '已存在（{layer}），已跳过',
    en: 'already exists ({layer}), skipped',
  },
  'config.skipRowId': {
    zh: '行 id "{id}" 已被占用，已跳过',
    en: 'row id "{id}" is already taken, skipped',
  },
  'config.skipOtherLayer': {
    zh: '声明在 {layer}，不能从当前 profile patch 覆盖',
    en: 'declared in {layer} and cannot be overwritten from this profile patch',
  },
  'config.conflictOtherLayer': {
    zh: '同名服务器声明在 {layer}，不在当前 profile patch 内，无法覆盖',
    en: 'a server with the same name is declared in {layer}, outside this profile patch, so it cannot be overwritten',
  },
  'config.skipNotEditable': {
    zh: '不是当前 profile patch 插入的行，无法安全覆盖：{detail}',
    en: 'not inserted by the current profile patch, so it cannot be overwritten safely: {detail}',
  },
  'config.layerProfile': {
    zh: 'profile 层',
    en: 'the profile layer',
  },
  'config.layerHome': {
    zh: 'home 层',
    en: 'the home layer',
  },
  'config.layerBundle': {
    zh: 'bundle 层',
    en: 'a bundle layer',
  },
  'config.layerUnknown': {
    zh: '未知层',
    en: 'an unknown layer',
  },

  // ── update ────────────────────────────────────────────────────────────────
  'config.updateInvalid': {
    zh: '修改请求不合法：{detail}',
    en: 'The update request is invalid: {detail}',
  },
  'config.nameCannotChange': {
    zh: '修改时不能更改服务器名称。',
    en: 'The server name cannot be changed by an update.',
  },
  'config.transportUnknown': {
    zh: '该服务器使用未知传输方式，无法安全修改。',
    en: 'This server uses an unknown transport and cannot be edited safely.',
  },
  'config.transportCannotChange': {
    zh: '修改时不能更改服务器传输方式。',
    en: 'The transport cannot be changed by an update.',
  },
  'config.updateBlocked': {
    zh: '该服务器不能保存：{reasons}',
    en: 'This server cannot be saved: {reasons}',
  },
  'config.updateAckRequired': {
    zh: '服务器「{name}」修改后属于高风险配置，请确认后再次保存。',
    en: 'After this change server "{name}" is high risk; acknowledge it and save again.',
  },
  'config.updateVerifyFailed': {
    zh: '修改前校验失败：目标服务器未能保持唯一，未写入。',
    en: 'Pre-write check failed: the target server is not unique in the new document; nothing was written.',
  },
  'config.updated': {
    zh: '服务器「{name}」已更新。新建会话或重启 DSH 后生效；启用 HMR 时会自动重载。',
    en: 'Server "{name}" was updated. It takes effect in a new session or after restarting DSH; HMR reloads it automatically.',
  },

  // ── delete ────────────────────────────────────────────────────────────────
  'config.deleteVerifyFailed': {
    zh: '删除前校验失败：目标服务器仍存在或 patch 格式无效，未写入。',
    en: 'Pre-write check failed: the target server still exists or the patch is invalid; nothing was written.',
  },
  'config.deleted': {
    zh: '服务器「{name}」已从当前 profile 删除。',
    en: 'Server "{name}" was removed from the current profile.',
  },

  // ── shared identity and row location ──────────────────────────────────────
  'config.identityInvalid': {
    zh: '服务器标识不合法。',
    en: 'The server identifier is invalid.',
  },
  'config.patchParseInvalid': {
    zh: 'profile patch 格式无效，已停止修改：{detail}',
    en: 'The profile patch is not valid YAML, so the change was stopped: {detail}',
  },
  'config.patchNotSequence': {
    zh: 'profile patch 不是 YAML 序列，已停止修改。',
    en: 'The profile patch is not a YAML sequence, so the change was stopped.',
  },
  'config.rowMissing': {
    zh: 'profile patch 中找不到「{name}」；home 或 bundle 层的服务器不能从此处修改。',
    en: 'Cannot find "{name}" in the profile patch; servers from the home or bundle layers cannot be edited here.',
  },
  'config.rowDuplicated': {
    zh: 'profile patch 中「{name}」或行 ID「{id}」重复或已变化，无法确定要修改哪一条。',
    en: 'In the profile patch "{name}" or row id "{id}" is duplicated or changed, so the target row is ambiguous.',
  },
  'config.rowDuplicateEntries': {
    zh: 'profile patch 中「{name}」存在重复条目，无法确定要修改哪一条。',
    en: 'The profile patch contains duplicated entries for "{name}", so the target row is ambiguous.',
  },
  'config.rowRangeUnsafe': {
    zh: '无法安全定位服务器配置行，未修改文件。',
    en: 'The server row could not be located safely; the file was not modified.',
  },

  // ── toggle ────────────────────────────────────────────────────────────────
  'config.toggleInvalid': {
    zh: '服务器「{name}」的启用状态不合法：disabled 必须是布尔值。',
    en: 'The enabled state for server "{name}" is invalid: disabled must be a boolean.',
  },
  'config.toggleVerifyFailed': {
    zh: '切换启用状态后校验失败：目标服务器的 disabled 状态与请求不一致，未写入。',
    en: 'Post-write check failed: the disabled state of the target server does not match the request; nothing was written.',
  },
  'config.toggledDisabled': {
    zh: '服务器「{name}」已禁用；其上已注册的工具会在重载后消失，配置仍然保留。',
    en: 'Server "{name}" is now disabled. Its tools disappear after the reload; the configuration is kept.',
  },
  'config.toggledEnabled': {
    zh: '服务器「{name}」已启用；新建会话或重载后将重新连接。',
    en: 'Server "{name}" is enabled again. It reconnects in a new session or after a reload.',
  },

  // ── backups and restore ───────────────────────────────────────────────────
  'config.backupNameInvalid': {
    zh: '备份文件名不合法，只能使用 /backups 返回的文件名。',
    en: 'The backup file name is invalid; use a name returned by /backups.',
  },
  'config.backupMissing': {
    zh: '找不到备份文件「{name}」。',
    en: 'Backup file "{name}" was not found.',
  },
  'config.backupInvalid': {
    zh: '备份文件「{name}」不是合法的 patch 内容，未写入。',
    en: 'Backup file "{name}" is not a valid patch, so nothing was written.',
  },
  'config.restored': {
    zh: '已用备份「{name}」恢复 profile patch；恢复前的版本也已备份，可再次回滚。',
    en: 'The profile patch was restored from backup "{name}". The previous content was backed up as well, so this can be rolled back.',
  },

  // ── status and servers view ───────────────────────────────────────────────
  'config.loaderUnavailable': {
    zh: 'Loader 不可用，已回退为扫描 profile / home patch；行状态与工具数不可用。',
    en: 'The Loader is unavailable, so the profile and home patches were scanned instead; row state and tool counts are unavailable.',
  },
  'config.loaderReadFailed': {
    zh: '读取 Loader 条目失败：{detail}',
    en: 'Failed to read Loader entries: {detail}',
  },
  'config.toolsReadFailed': {
    zh: '读取工具注册表失败：{detail}',
    en: 'Failed to read the tool registry: {detail}',
  },
  'config.patchParseFallback': {
    zh: 'profile patch 解析失败，已回退为文本扫描：{detail}',
    en: 'The profile patch could not be parsed, so it was scanned as text: {detail}',
  },
  'config.patchParseFallbackFile': {
    zh: '{file} 解析失败，已回退为文本扫描：{detail}',
    en: '{file} could not be parsed, so it was scanned as text: {detail}',
  },
};

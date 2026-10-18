# DSH MCP Installer

在 DSH「设置 → MCP 安装」中导入并管理 MCP 服务器，配置写入当前 profile 的 `cordis.patch.yml`。

## 快速开始

检查 npm 上当前发布版本：

```bash
npm view dsh-mcp-installer version
```

普通 DSH CLI 用户可安装到 `web` profile：

```bash
dsh plugin --profile web add dsh-mcp-installer
```

将 `web` 替换为你实际使用的非 Desktop profile。安装后打开或重启该 profile，在 **设置 → MCP 安装** 中使用。

DSH Desktop 的 `desktop` profile 由 Desktop 自带的 DSH 命令管理。先启动 Desktop 初始化 profile，再在 Desktop 提供的命令环境中运行：

```bash
dsh plugin --profile desktop add dsh-mcp-installer
```

不要用单独安装的通用 `dsh` CLI 管理 Desktop 的保留 profile。

## 管理 MCP 服务器

- **查看**：搜索服务器，查看连接状态、工具数、配置和来源。
- **添加**：粘贴配置、选择文件或输入网页链接，检查风险后安装。
- **编辑/删除**：仅支持当前 profile patch 中可唯一定位的服务器；其他来源请在所属配置层管理。

支持 JSON、YAML、TOML、Markdown、Claude/Codex CLI 命令和网页导入。支持 `stdio` 与 `streamable-http`，不支持 SSE。

示例：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

## 安全说明

- 导入的 env/header 值会写入 profile patch；敏感值建议使用 DSH 支持的 `!!js` 环境变量表达式。页面只显示键名，编辑时保留原值。
- 高风险命令或 URL 需要确认；网页导入会拒绝本机和内网地址。

## 开发

```bash
npm install
npm run build
npm run typecheck
npm test
```

许可证：MIT

# dsh-mcp-installer

在 DSH「设置 → MCP 安装」中查看、添加、编辑和删除 MCP 服务器。配置写入当前 profile 的 `cordis.patch.yml`，并由 DSH Loader 加载。

## 功能

- 查看服务器连接状态、工具数、配置目标和来源层，支持搜索与详情展开。
- 从 JSON、YAML、TOML、Markdown、Claude/Codex CLI 命令或网页导入服务器配置。
- 写入前检查命令、URL、凭证和高风险项；高风险配置需确认，不支持的 SSE 配置会被拦截。
- 编辑或删除当前 profile patch 中的服务器；home patch 和 bundle 来源的服务器只读。
- 页面不读取或返回 env/header 密钥值；编辑时保留原有值。

## 安装

推荐通过 DSH 的 `plugin_manager` 安装本地 bundle：

```js
plugin_manager({ action: "install_bundle", target: "<插件目录绝对路径>" })
```

本地开发时，在 profile 的 `package.json` 中将本包加入 `dependencies` 和 `dsh.profile.bundles`，并把仓库链接到该 profile 的 `node_modules`。

## 使用

打开 **设置 → MCP 安装**：

1. 在「已安装」页查看服务器。展开 profile 层服务器可编辑命令、参数或 URL，也可删除；删除前会确认。
2. 在「安装新服务器」页粘贴配置、选择文件或输入网页链接，解析并检查风险后安装。
3. profile patch 会在启用 HMR 时自动重载；否则新建会话或重启 DSH。

stdio 配置示例：

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

## 限制与安全

- 仅 `stdio` 和 `streamable-http` 可用；SSE、`cwd`、来源中的权限字段不会导入。
- 编辑和删除仅作用于当前 profile patch 中可唯一定位的服务器，其他来源请到所属配置层管理。
- 导入配置中的 env/header 值会写入 profile patch。敏感值建议使用 DSH 支持的 `!!js` 环境变量表达式；列表只显示键名。
- 网页导入会拒绝本机和内网地址；写操作仅接受同源 JSON 请求。

## 开发

```powershell
npm install
npm run build
npm run typecheck
npm test
```

`npm test` 会构建 Host/Client bundle 并运行 Node.js 单元测试。

## 许可证

MIT

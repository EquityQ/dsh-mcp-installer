# dsh-mcp-installer

**DSH「MCP 安装器」插件**：在 Web GUI 的 **设置 → MCP 安装** 里管理当前 profile 的 MCP 服务器 —— **「已安装」页**用可滚动表格查看所有 MCP 服务器（传输、命令/URL、来源层、连接状态、工具数、展开详情）；**「安装新服务器」页**粘贴 / 导入来源（Claude Desktop、Claude Code、Cursor、VS Code、Codex、YAML、Markdown 文档或网页链接），先做安全审查与预览，确认后写入当前 profile 的 `cordis.patch.yml`，为每个服务器插入一条 `@deepseek-ai/dsh-mcp-client` 配置。

本插件**不代替用户安装 MCP**：它只负责查看现状、解析来源、解释风险、并把用户确认过的配置写进 DSH 自己的 profile 配置层。

- 包名：`dsh-mcp-installer`
- 版本：`0.2.0`（本地 bundle，`private: true`）
- 运行面：Host（Node / HTTP 路由 + Loader 读取 + 写 profile patch）+ Client（模块加载器工厂 + React 设置页）
- 本机已安装：当前 `desktop` profile 已加载本插件，设置页可用（见「验证记录」）

---

## 1. 功能

| 能力 | 说明 |
|---|---|
| 输入 | 粘贴文本、选择本地文件（`.json/.yaml/.yml/.toml/.md/.txt`）、输入网页 URL |
| 已安装视图 | **查看当前 profile 里所有 MCP 服务器**：名称、Loader id、传输方式、命令/URL、来源层（profile patch / home patch / bundle）、连接状态、已注册工具数；表格支持横向/纵向滚动、首列吸顶、搜索过滤、点击行展开完整详情（args / env 键 / header 键 / 工具名 / 提示） |
| 来源格式 | Claude Desktop/Claude Code/Cursor `mcpServers`、VS Code `servers`、Codex `[mcp_servers.<name>]` TOML、通用 YAML/JSON、Markdown 代码块、`claude mcp add` / `codex mcp add` 命令、HTML 文档页 |
| 归一化 | 每个服务器归一化为 `McpServerSpec`（name / transport / command / args / env / url / headers / source），缺失字段保持缺失，不编造 |
| 安全审查 | 信任的可执行文件、高危命令模式、shell 元字符、网络访问、凭证字段、远程 URL 协议与来源、变量占位符、本地二进制是否存在 |
| 风险分级 | `none` / `warning` / `high` / `blocked`；**high 必须逐项勾选确认**，blocked 禁止安装（如 SSE 传输） |
| 预览 | 可滚动表格展示名称 / 传输 / 命令或 URL / 风险，逐项勾选安装、行内展开详情、全选/清空 |
| 写入 | 插入 `- insert:` + `@deepseek-ai/dsh-mcp-client` 行，原子写入 profile patch；写入前后双重校验，检测重名与 id 冲突 |
| 生效 | profile patch 变更会被 HMR 监听并热重载（已实测）；新建会话或重启 DSH 后 MCP 工具以 `mcp__<serverName>__<toolName>` 出现 |
| 防越权 | 四个路由只接受同源请求（POST 必须带匹配 Origin，GET/HEAD 兼容无 Origin）；URL 导入拒绝本机/内网目标并逐跳校验重定向；`/install` 在 Host 侧重新校验 + 重新做风险评估，不信任浏览器；`/servers` 只返回 env/header 的**键名**，不下发值 |

**明确不支持 / 不导入**：

- `sse` 传输（DSH 的 MCP 客户端只支持 `stdio` 与 `streamable-http`）→ 标红阻止；
- `cwd` 字段（不写入，提示手动补充）；
- 来源里的 `autoApprove` / `alwaysAllow` / `permissions`（安全原因不导入，提示安装后手动配置）；
- 删除 / 停用已有 MCP 服务器（当前版本只增不改）。

---

## 2. 目录结构

```
dsh-mcp-installer/
├── package.json               # bundle 清单：main / files / dsh.bundle.patch / dsh.client
├── cordis.patch.yml           # bundle patch：向 profile 插入一条插件行
├── icon.svg                   # 插件图标（Plugin Manager / 设置页使用）
├── locale/
│   ├── en.json                # meta.title / meta.description（英文）
│   └── zh.json                # meta.title / meta.description（中文）
├── src/
│   ├── index.ts               # Host 入口：apply() + 四个 HTTP 路由 + 同源校验
│   ├── types.ts               # 共享数据契约 McpServerSpec / RiskAssessment / 响应类型
│   ├── dsh-api.ts             # 本插件用到的 DSH Host/Client API 的最小类型镜像
│   ├── parse.ts               # 来源解析：JSON/YAML/TOML/Markdown/HTML/CLI → McpServerSpec[]
│   ├── security.ts            # 风险评估
│   ├── config.ts              # profile patch 定位、扫描、渲染、原子写入
│   └── client/
│       ├── index.tsx          # Client 入口：注册 settings.section（settings.mcpInstaller）
│       ├── page.tsx           # 安装向导组件（idle→parsing→preview→installing→done/error）
│       └── locale.ts          # 页面中英文文案
├── scripts/
│   └── build.mjs              # esbuild 构建 Host ESM 与 Client 模块加载器产物
├── test/
│   ├── parse.test.mjs         # 29 个单元测试（解析 / 风险 / patch 渲染）
│   └── fixtures/
│       └── demo-mcp-server.mjs# 仅用于端到端验证的最小 MCP stdio 服务器
├── tsconfig.json
├── README.md
└── lib/                       # 构建产物（git 忽略；安装必需）
    ├── index.js               # Host 半（esbuild 打包，js-yaml 内联，零运行时依赖）
    └── client.js              # Client 半（window.__ModuleLoader__.load 工厂格式）
```

---

## 3. 安装

### 3.1 官方方式（推荐，`plugin_manager`）

```jsonc
// 由 DSH 的 plugin_manager 工具执行；target 指向本包目录
plugin_manager({ "action": "install_bundle", "target": "F:\\AI Workspace\\default_ai\\dsh-mcp-installer" })
```

`install_bundle` 会完成依赖安装、把包加入 profile 的 `dsh.profile.bundles` 与 `dependencies`，并热加载 bundle patch。

> ⚠️ **本机环境问题（已确认）**：当前 `desktop` profile 的 pnpm 状态中，
> `dsh-chrome-control` 目录被正在运行的 `chrome-daemon` 进程占用，pnpm 每次
> install 都尝试重新 import 该包并以 `EPERM ... rename ... chrome-control`
> 失败——这是**既有环境问题**，与本插件无关（安装前就存在多个
> `_tmp_<pid>_*` 残留）。绕行方式：先结束 `chrome-daemon` 进程再执行
> `install_bundle`；或按 3.2 的链接安装方式。

### 3.2 链接安装（本机实际采用，已生效）

当官方安装器被上述 pnpm 状态阻塞时，可以用与 pnpm `link:` 依赖等价的方式安装本地目录：

```powershell
$profile = "C:\Users\31768\.dsh\profiles\desktop"
$target  = "F:\AI Workspace\default_ai\dsh-mcp-installer"

# 1) 在 profile 的 node_modules 里建立指向本包目录的目录联接（junction）
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-mcp-installer" -Target $target

# 2) 在 profile/package.json 中加入依赖与 bundle 项（原文件先备份）
node -e "const fs=require('fs');const p='$($profile -replace '\\','/')/package.json';const pkg=JSON.parse(fs.readFileSync(p,'utf8'));pkg.dependencies['dsh-mcp-installer']='link:${target}';if(!pkg.dsh.profile.bundles.includes('dsh-mcp-installer'))pkg.dsh.profile.bundles.push('dsh-mcp-installer');fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n')"
```

DSH 的 HMR 监听 profile manifest 变化，会立即重新组合并加载本插件；无需重启。卸载时反向删除 junction、`dependencies` 与 `bundles` 中的对应项即可。

---

## 4. 使用

打开 **设置 → MCP 安装**（设置导航第 25 位，在「Agent 预设」之后）。页面有两个标签页：

### 4.1 已安装（默认）

- 显示当前 profile 中**所有** `@deepseek-ai/dsh-mcp-client` 行（包括不是本安装器写入的、来自 home patch 或 bundle 层的行）。
- 表格列：名称/ID · 传输 · 目标（命令或 URL） · 来源层 · 工具数 · 状态；表格可横向/纵向滚动，首列固定，表头吸顶。
- 支持搜索过滤（名称、ID、命令、URL、传输方式），支持**点击整行展开**详情：Loader ID、command、URL、args、env 键名、header 键名、已注册工具名，以及连接状态说明。
- 状态列：`已连接`（Loader fiber 激活）/ `未激活`（行存在但 fiber 未启动，需查 DSH 日志）。
- 工具数来自 `ctx.tools` 注册表中 `mcp__<serverName>__*` 的实时数量；不可用时会隐藏并提示。

### 4.2 安装新服务器

1. 粘贴配置 / 选择文件 / 输入文档 URL，点击 **解析文本** 或 **读取并解析**。
2. 预览页展示解析结果（步骤条 1→2→3，可滚动表格）：
   - 绿色 `无问题`、黄色 `注意`、红色 `高风险`、虚线红 `不支持`；
   - 高风险行必须勾选「我已了解风险，确认安装该服务器」；
   - 不支持的服务器会默认不勾选且无法勾选，需返回修改来源；
   - 支持全选 / 清空、每行展开查看 command/URL/args/env 键/header 键与完整风险原因。
3. 点击 **安装所选服务器**；成功后显示写入路径、写入的行 id 与提示；可直接跳到「已安装」页查看（HMR 完成后自动刷新）。
4. 生效方式：
   - 若部署启用了 HMR（Web / Desktop 默认启用）：profile patch 变更自动重载，MCP 服务器立即连接；
   - 否则新建会话或重启 DSH；
   - 工具名形如 `mcp__<serverName>__<toolName>`。

### 示例输入

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"],
      "env": { "ALLOWED_DIRS": "C:\\work" }
    }
  }
}
```

写入结果（追加到 `cordis.patch.yml` 末尾）：

```yaml
# Added by dsh-mcp-installer on 2026-10-17T14:28:44.848Z
- insert:
    - id: "mcp-filesystem"
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: "filesystem"
        transport: "stdio"
        command: "npx"
        args:
          - "-y"
          - "@modelcontextprotocol/server-filesystem"
          - "C:\\work"
        env:
          "ALLOWED_DIRS": "C:\\work"
```

---

## 5. 数据契约（插件内部唯一契约）

```ts
interface McpServerSpec {
  name: string
  transport: 'stdio' | 'streamable-http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  source: 'paste' | 'markdown' | 'web'
}
```

`/parse` 返回 `{ ok, source, specs, warnings, risks }`；`risks` 按 `name` 索引：

```ts
interface RiskAssessment {
  level: 'none' | 'warning' | 'high' | 'blocked'
  reasons: string[]
  requiresAcknowledgement: boolean
  installable: boolean
  networkAccess: boolean
  credentialKeys: string[]
}
```

---

## 6. Host HTTP API（同源，仅插件自己的 Web 页面调用）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/_dsh/mcp-installer/status` | — | `{ ok, profile, via, file, writable, existing[] }` |
| GET | `/_dsh/mcp-installer/servers` | — | `{ ok, profile, file, homeFile, toolsAvailable, warnings, servers[] }`；每个 server：`{ id, serverName, transport, command?, args?, envKeys[], url?, headerKeys[], layer, active, toolCount, tools[] }` |
| POST | `/_dsh/mcp-installer/parse` | `{ raw: string, type: 'text' }` 或 `{ url: string, type: 'url' }` | `{ ok: true, source, specs, warnings, risks }` / `4xx { ok:false, error, checked? }` |
| POST | `/_dsh/mcp-installer/install` | `{ specs: McpServerSpec[], acknowledged: string[] }` | `{ ok, message, file?, entries?, error? }` |

`/servers` 用 **DSH Loader 条目**作为“当前已安装”的权威来源（profile patch / home patch / bundle 层都在内），再用 profile / home patch 扫描得出 `layer` 归属；`envKeys`/`headerKeys` 只给键名，**不下发任何凭证值**。

安全约束：非 `application/json` 的请求被拒；`Origin` 存在且与 `ctx.webServer.getOrigin()` 不同源时返回 403；请求体上限 2 MiB；`/install` 在 Host 侧重新做字段校验、重名/冲突检测与风险评估。

---

## 7. 已确认的 DSH API（本插件实际依赖）

| 用途 | API / 事实 | 确认途径 |
|---|---|---|
| Host 路由 | `ctx.webServer.register({ kind: 'exact' \| 'prefix', path, handler })`，handler 是 Node `(req: IncomingMessage, res: ServerResponse)` | Cordis Inspect host `Service` → `webServer`；`@deepseek-ai/dsh-host-webserver` README |
| 生命周期 | `ctx.effect(() => ctx.webServer.register(...), label)` 返回清理函数 | `@deepseek-ai/dsh-config-editor/lib/index.js` 等插件用法 |
| profile 定位 | `ctx.get('profileContext')` → `{ name, dir, patchPath, installAnchor, ... }`；`patchPath` 即当前 profile 的 `cordis.patch.yml` | `@deepseek-ai/dsh/lib/profile-boot-*.js` 中 `profileContext` 的构造 |
| 兜底定位 | loader 的 `cordis:include` 行 `config.path`（`cordis.yml` → 同名 `cordis.patch.yml`）；再兜底 `$DSH_HOME/profiles/$DSH_PROFILE/cordis.patch.yml` | `@deepseek-ai/dsh-config-editor`；loader README |
| MCP 客户端配置 | 每服务器一行 `@deepseek-ai/dsh-mcp-client`，`config.serverName/transport(stdio|streamable-http)/command/args/env/url/headers` | 运行中 `Config.listConfigs` 的 JSON Schema；`@deepseek-ai/dsh-mcp-client` README |
| 工具命名 | `mcp__<serverName>__<toolName>` | mcp-client README；本机实测 `mcp__demo-echo__echo` 可调用 |
| Client 模块格式 | `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => { ... return module.exports } })`，factory 内 `require('react')` / `require('react/jsx-runtime')` 来自共享模块表 | 内置客户端 bundle（如 `@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js`）；`dsh-client-modules` README |
| `dsh.client` 清单 | `{ platform: 'web', immediately?: boolean, inject?: string[], external?: string[] }` | `@deepseek-ai/dsh-client-modules/lib/index.js` 的校验逻辑；内置包 package.json |
| `settings.section` | `ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id, order, label, locale, inject, children }, Component))`；owner props `{ close }`，`locale` 命名空间提供 `t` | Cordis Inspect client `Slots`；`@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js` |
| Client 服务 | `ctx.locale.bind(ns)` / `ctx.locale.register(ns, { en, zh })` / `ctx.slots.*` / `ctx.effect` | 观测到的 Client Service 契约 + 内置设置页用法 |
| 插件行 | bundle patch：`- insert: [{ id, name }]`；`dsh.bundle.patch` 指向 patch 文件 | `cordis-plugin-development` skill；`@deepseek-ai/dsh-base/cordis.patch.yml` |

> 没有把握的 API 一律没有使用。Host/Client 的类型在 `src/dsh-api.ts` 与 `src/client/*` 中做了最小化本地声明（DSH 未向第三方发布这些运行时类型）。

---

## 8. 开发与构建

```powershell
cd "F:\AI Workspace\default_ai\dsh-mcp-installer"
npm install            # devDeps: esbuild / js-yaml / typescript / @types/*
npm run build          # 生成 lib/index.js（Host）与 lib/client.js（Client）
npm run typecheck      # tsc --noEmit
npm test               # 构建 + node --test test/parse.test.mjs（29 项）
```

构建说明：

- Host：esbuild `platform=node, format=esm`，把 `js-yaml` 内联进产物，所以安装后**没有运行时依赖解析问题**（本地 `link:` 安装同样可运行）。
- Client：esbuild `format=cjs` + `external: ['react', 'react/jsx-runtime']`，再包一层
  `window.__ModuleLoader__.load({ id: 'dsh-mcp-installer', factory })`；React 由浏览器共享模块表提供，不重复打包。

### 本地调试（不改 profile）

在 DSH 源码/安装目录下建一个 scratch patch 覆盖层，把插件行指向本地绝对路径，用 `--patch` 启动：

```yaml
# scratch/mcp-installer.yml
- insert:
    - id: mcp-installer
      name: 'F:/AI Workspace/default_ai/dsh-mcp-installer'
```

```powershell
pnpm dsh web --patch ./scratch/mcp-installer.yml
```

对已安装的链接包，修改 `lib/*.js` 后 HMR 会按 profile 重新组合；修改 `src/` 需先 `npm run build`。

调试建议：

- Host 路由可直接用 PowerShell 验证：`Invoke-RestMethod http://127.0.0.1:56372/_dsh/mcp-installer/status`；
- 解析器单测覆盖 JSON / YAML / TOML / Markdown / CLI / 风险分级 / patch 渲染；
- 观察写入是否生效：Cordis Inspect Host `Config.listConfigs({ name: '@deepseek-ai/dsh-mcp-client' })` 应出现新行；`Tool.listTools` 应出现 `mcp__<serverName>__<toolName>`。

---

## 9. 验证记录（本机，2026-10-17）

| 验证项 | 结果 |
|---|---|
| Host 插件行激活 | ✅ `Config.listConfigs({name:'dsh-mcp-installer'})` 返回 `include:mcp-installer`（`absent` = 无 Config schema，正常） |
| Client 设置页注册 | ✅ 连接中的 Client `Slots.listSubTree('settings.section')` 列出 `mcp-installer`，order 25，`active: true` |
| `GET /status` | ✅ 解析出 `profile=desktop`、`via=profileContext`、`file=...\cordis.patch.yml`、`writable=true`、已有 `port-detective` |
| `GET /servers`（已安装视图数据） | ✅ 返回 `port-detective`：stdio、命令/args、`layer=profile`、`active=true`、`toolCount=4`，并列出 4 个 `mcp__port-detective__*` 工具名；env/header 只给键名 |
| 已安装视图 · 安装后即时刷新 | ✅ 安装 `demo-echo` 后 `/servers` 变为 2 台（`demo-echo` 1 个工具、`port-detective` 4 个工具，均 active）；还原 patch 后恢复 1 台 |
| 已安装视图 · 表格 / 搜索 / 展开 | ✅ Client 设置页注册保持 `active: true`；`/servers` 数据字段完整（名称/ID/传输/目标/来源层/工具数/状态/详情），表格与展开交互由同一份数据渲染（视觉外观见下方未验证项） |
| `POST /parse`（混合样例） | ✅ 3 个 spec；sse→`blocked`、`bash -c 'rm -rf ...'`→`high`（需确认）、`node` 本地脚本→`warning` |
| 未确认高风险安装 | ✅ 422 拒绝（不写文件） |
| 重名服务器安装 | ✅ 422 拒绝（`port-detective` 已存在，不覆盖） |
| 正常安装（`demo-echo` 本地 MCP stdio 服务器） | ✅ 返回 ok + 写入路径 + `entries: ['mcp-demo-echo']`；patch 只追加、注释与原有行保持 |
| HMR 热重载 | ✅ 写入后 `Config.listConfigs` 出现 `include:mcp-demo-echo`，无需重启；还原后行与工具消失 |
| MCP 工具端到端 | ✅ 工具列表出现 `mcp__demo-echo__echo` 且实际调用返回 `echo: ...`（两次验证） |
| 清理 | ✅ 已还原 profile patch（SHA-256 与安装前一致 `D4DCDD…B28E`），demo 行/工具/进程均消失；插件本身保持安装 |
| 构建 / 类型 / 单测 | ✅ `npm run build`、`tsc --noEmit`、29/29 tests 通过（包含 URL SSRF 防护、同源校验、配置冲突与 `readInstalledServers` 单测） |

**未验证项（如实说明）**：Desktop 的 GUI 渲染在 Electron 自绘窗口中，Chrome 扩展无法附加到该窗口；本次通过“连接中的 Client Slot 注册 + Host 路由实测 + 写盘/热重载/MCP 工具调用”完成功能验证，**设置页的像素级外观未截图验证**。请在 **设置 → MCP 安装** 中自行确认视觉呈现（浅色/深色主题均可）。

---

## 10. 限制与后续工作

- **已安装视图是只读的**：可以查看、搜索、展开详情，但本版本不提供删除/停用/编辑按钮（会误改他人写入的配置）；管理已有条目请直接用 profile patch 或其它 MCP 管理器。
- **工具数是快照**：来自 `ctx.tools` 的实时注册表；MCP 服务器连接中/重连中时数量可能为 0，刷新即可。工具注册表不可用时该列显示 `–`。
- **来源层归属**：`profile` / `home` 由扫描两份 patch 得出；其余统一显示为 `bundle 层`（来自 bundle 或其它 include 层，本插件不解析第三方 bundle 的 patch 内容）。
- **SSE 不支持**：DSH `@deepseek-ai/dsh-mcp-client` 仅接受 `stdio` 与 `streamable-http`；解析器保留 `sse` spec 但会阻止安装并说明原因。
- **凭证以明文写入**：来源中的 `env`/`headers` 原样写入 patch（UI 会提示）；更安全的做法是写入后改成 Loader `!!js` 表达式（如 `!!js process.env.GITHUB_TOKEN`）。已安装视图只显示键名，不显示值。
- **HMR 并发**：写 patch 使用“读-改-写 + 原子替换”，并与本插件进程内写操作串行；DSH 的 Config Editor / Plugin Manager 也有各自的串行机制，但没有跨进程文件锁。频繁并发写同一 patch 时仍可能竞争。
- **profile 定位兜底**：优先 `profileContext.patchPath`；拿不到时用 loader 的 `cordis:include`，最后才用 `$DSH_HOME/profiles/$DSH_PROFILE/`。如果未来 DSH 改变 profile 布局，优先检查 `profileContext` 契约。
- **页面文案**：Host 侧提示与风险原因为中文；页面静态文案支持中/英。英文界面下 Host 消息仍为中文（后续可做 Host 侧 i18n）。
- **本机安装状态**：因 pnpm/chrome-daemon 冲突，采用 junction + manifest 的链接安装；`profile/package.json.bak-mcp-installer` 为安装前备份。恢复官方安装状态需先结束 `chrome-daemon`，再执行 `install_bundle`。

---

## 11. 许可证

MIT。`icon.svg` 为本插件原创图形。

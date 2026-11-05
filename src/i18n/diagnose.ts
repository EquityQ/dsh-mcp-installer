/**
 * Connection-probe messages (`diagnose.*`).
 *
 * Owned by `src/diagnose.ts`: one entry per probe verdict, plus the
 * stage-specific failure text shown when a probe cannot get past a step.
 */
import type { MessageCatalog } from './types.js';

export const diagnoseMessages: MessageCatalog = {
  'diagnose.okTools': {
    zh: '连接成功，服务器暴露了 {count} 个工具。',
    en: 'Connected — the server exposes {count} tools.',
  },
  'diagnose.okNoTools': {
    zh: '连接成功，但服务器没有暴露任何工具。',
    en: 'Connected, but the server exposes no tools.',
  },
  'diagnose.sseUnsupported': {
    zh: 'DSH 的 MCP 客户端不支持 sse 传输，无法测试连接。',
    en: 'DSH\u2019s MCP client does not support the sse transport, so it cannot be probed.',
  },
  'diagnose.missingCommand': {
    zh: 'stdio 服务器缺少 command，无法启动。',
    en: 'The stdio server has no command, so it cannot be started.',
  },
  'diagnose.missingUrl': {
    zh: 'streamable-http 服务器缺少 url，无法连接。',
    en: 'The streamable-http server has no url, so it cannot be reached.',
  },
  'diagnose.invalidUrl': {
    zh: 'url 不是合法的 http(s) 地址。',
    en: 'The url is not a valid http(s) address.',
  },
  'diagnose.commandNotFound': {
    zh: '找不到命令 "{command}"：它不在 PATH 中，或尚未安装。',
    en: 'Command "{command}" was not found: it is not on PATH, or not installed.',
  },
  'diagnose.spawnFailed': {
    zh: '无法启动该命令。',
    en: 'The command could not be started.',
  },
  'diagnose.handshakeTimeout': {
    zh: '服务器在 {seconds} 秒内没有完成 MCP 握手，可能是启动过慢或在等待输入。',
    en: 'The server did not finish the MCP handshake within {seconds}s — it may start slowly or be waiting for input.',
  },
  'diagnose.handshakeRejected': {
    zh: '服务器拒绝了 MCP 握手。',
    en: 'The server rejected the MCP handshake.',
  },
  'diagnose.connectFailed': {
    zh: '无法连接到该地址。',
    en: 'Could not connect to the address.',
  },
  'diagnose.httpError': {
    zh: '服务器返回了 {status}，请检查地址、路径与鉴权 header。',
    en: 'The server returned {status}. Check the URL, path and authentication headers.',
  },
  'diagnose.stopped': {
    zh: '测试已中止。',
    en: 'The probe was stopped.',
  },
  'diagnose.detailLabel': {
    zh: '运行输出',
    en: 'Runtime output',
  },
};

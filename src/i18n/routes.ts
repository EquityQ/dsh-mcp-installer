/**
 * Route-level messages (`routes.*`).
 *
 * Owned by `src/index.ts`: method/origin/body rejections and the wrapper's
 * internal-error text. Kept separate from `config.*` so the HTTP layer can be
 * reworded without touching the persistence layer.
 */
import type { MessageCatalog } from './types.js';

export const routesMessages: MessageCatalog = {
  'routes.methodNotAllowed': {
    zh: '该路由不支持此 HTTP 方法。',
    en: 'This route does not support that HTTP method.',
  },
  'routes.crossOrigin': {
    zh: '拒绝跨源请求。',
    en: 'Cross-origin request rejected.',
  },
  'routes.internalError': {
    zh: '请求处理失败：{detail}',
    en: 'Request failed: {detail}',
  },
  'routes.urlRequired': {
    zh: '请提供要读取的网页链接。',
    en: 'Provide a URL to fetch.',
  },
  'routes.inputRequired': {
    zh: '请先粘贴 MCP 配置内容。',
    en: 'Paste an MCP configuration first.',
  },
  'routes.inputTooLarge': {
    zh: '输入内容超过 {limit} 字符上限。',
    en: 'The input exceeds the {limit}-character limit.',
  },
  'routes.diagnoseSpecInvalid': {
    zh: '待测试的服务器配置不合法：{detail}',
    en: 'The server to probe is not a valid configuration: {detail}',
  },
  'routes.bodyContentType': {
    zh: '请求必须使用 application/json。',
    en: 'The request must use application/json.',
  },
  'routes.bodyTooLarge': {
    zh: '请求体过大。',
    en: 'The request body is too large.',
  },
  'routes.bodyNotJson': {
    zh: '请求体不是合法 JSON。',
    en: 'The request body is not valid JSON.',
  },
  'routes.bodyNotObject': {
    zh: '请求体必须是 JSON 对象。',
    en: 'The request body must be a JSON object.',
  },
};

/**
 * Client half: register the "MCP 安装" page into the Settings navigation.
 *
 * The built artifact is wrapped in `window.__ModuleLoader__.load({ id, factory })`
 * by scripts/build.mjs. React (and react/jsx-runtime) stay external: the
 * browser module table supplies them, so the bundle ships no copy.
 */
import type { ClientContext } from '../dsh-api.js';
import { dictionaries } from './locale.js';
import { McpInstallerPage } from './page.js';

/** Locale namespace owned by this page. */
export const NS = 'settings.mcpInstaller';

/** Cordis services this Client half needs before `apply` runs. */
export const inject = ['slots', 'locale'];

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS);
  ctx.effect(
    () => ctx.locale.register(NS, dictionaries),
    'mcp-installer: settings dictionaries',
  );
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'mcp-installer',
            order: 25,
            label: () => t('nav'),
            locale: NS,
            // Pass the bound translator explicitly as well; the slot merges
            // this face into the component props.
            inject: () => ({ t: (key: string) => t(key) }),
          },
          McpInstallerPage,
        ),
      ),
    'mcp-installer: settings section',
  );
}

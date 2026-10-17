/**
 * Minimal local mirror of the DSH Host APIs this plugin touches.
 *
 * These are the exact shapes confirmed against the running DSH 0.2.1-rc.2
 * deployment by the Cordis Inspect providers (host `Service` for
 * `webServer` / `loader` / `profileContext`, and the installed
 * `@deepseek-ai/dsh-host-webserver` WebRoute contract). They are intentionally
 * narrow: a plugin only needs the members it calls, and DSH does not publish
 * these runtime types to third-party bundles.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** The slice of `ctx.webServer` this plugin uses. */
export interface WebServerFace {
  register(route: WebRoute): () => void;
  getOrigin(): string;
}

/** The plain-data `profileContext` service provided by the profile launcher. */
export interface ProfileContextFace {
  name?: string;
  dir: string;
  patchPath: string;
  /** `$DSH_HOME` (the home patch lives beside the profiles directory). */
  home?: string;
  installAnchor?: string;
}

/** A Cordis loader entry exposes its raw options and (once mounted) its fiber. */
export interface LoaderEntryFace {
  options?: {
    id?: string;
    name?: string;
    config?: unknown;
  };
  /** Cordis fiber; `state === 2` means the entry is active. */
  fiber?: { state?: number };
}

/** The slice of `ctx.loader` used to locate the profile include file. */
export interface LoaderFace {
  entries(): Iterable<LoaderEntryFace>;
}

/** The slice of the Host plugin context used by this bundle. */
export interface HostContext {
  webServer: WebServerFace;
  effect(callback: () => (() => void) | void, label?: string): () => void;
  get(name: string): unknown;
}

/** Options accepted by `ctx.slots.register` for a `settings.section` page. */
export interface SettingsSectionRegistration {
  name: 'settings.section';
  id: string;
  order?: number;
  label?: string | (() => string);
  /** Locale namespace whose dictionary supplies the component's `t` prop. */
  locale?: string;
  /** Face merged into the component props. */
  inject?: () => Record<string, unknown>;
}

/** The slice of the browser plugin context used by the Client half. */
export interface ClientContext {
  slots: {
    register(options: SettingsSectionRegistration, component: unknown): () => void;
    inject(key: 'settings.section', callback: () => () => void): () => void;
  };
  locale: {
    bind(namespace: string): (key: string) => string;
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
  };
  effect(callback: () => (() => void) | void, label?: string): () => void;
}

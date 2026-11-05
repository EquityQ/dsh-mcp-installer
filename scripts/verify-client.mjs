/**
 * Verify the built Client bundle registers itself into a DSH-like browser
 * context, without a browser.
 *
 * The Client half is a module-loader factory. This script evaluates that
 * factory with a stubbed React module table and a stubbed Cordis context, then
 * asserts the two effects the page depends on actually get registered: the
 * locale dictionaries and the settings section. It catches the class of bug a
 * typecheck cannot — a bundle that loads but never mounts.
 *
 * Run with: node scripts/verify-client.mjs
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(label, condition, detail) {
  if (!condition) failures += 1;
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

const source = readFileSync('lib/client.js', 'utf8');

// ── 1. The wrapper shape the shell expects ─────────────────────────────────
const definitions = [];
const windowStub = { __ModuleLoader__: { load: (definition) => definitions.push(definition) } };
new Function('window', 'require', `${source}\nreturn window;`)(windowStub, (name) => {
  throw new Error(`the factory must not require(${name}) at load time`);
});

check('exactly one module is registered', definitions.length === 1);
const definition = definitions[0];
check('the module id matches the package name', definition.id === 'dsh-mcp-installer', definition.id);
check('the factory is callable', typeof definition.factory === 'function');

// ── 2. The factory only needs React from the shared module table ───────────
const reactStub = {
  Fragment: Symbol('Fragment'),
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  createContext: () => ({ Provider: null, Consumer: null }),
  forwardRef: (fn) => fn,
  memo: (fn) => fn,
};
reactStub.default = reactStub;
const jsxRuntime = {
  jsx: () => null,
  jsxs: () => null,
  jsxDEV: () => null,
  Fragment: Symbol('Fragment'),
};

const externals = [];
const exports = definition.factory((name) => {
  externals.push(name);
  if (name === 'react') return reactStub;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  throw new Error(`unexpected external module: ${name}`);
});

check(
  'only react modules are external',
  externals.every((name) => name === 'react' || name === 'react/jsx-runtime'),
  [...new Set(externals)].join(', '),
);
check('the module exports apply', typeof exports.apply === 'function');
check('the module declares its injected services', Array.isArray(exports.inject), JSON.stringify(exports.inject));
check(
  'the locale namespace is exported',
  exports.NS === 'settings.mcpInstaller',
  exports.NS,
);

// ── 3. apply() mounts both effects into a Cordis-like context ──────────────
const registrations = [];
const dictionaries = [];
const locale = {
  bind: (namespace) => (key) => `${namespace}:${key}`,
  register: (namespace, dict) => {
    dictionaries.push({ namespace, dict });
    return () => {};
  },
};
const slots = {
  register: (options, component) => {
    registrations.push({ options, component });
    return () => {};
  },
  inject: (key, callback) => {
    check('slots.inject is used for settings.section', key === 'settings.section', key);
    void callback();
    return () => {};
  },
};
const ctx = {
  slots,
  locale,
  effect: (callback) => {
    const dispose = callback();
    return typeof dispose === 'function' ? dispose : () => {};
  },
};

exports.apply(ctx);

check('the locale dictionary is registered', dictionaries.length === 1);
const registered = dictionaries[0];
check('the dictionary uses the page namespace', registered?.namespace === 'settings.mcpInstaller');
check('the dictionary ships both languages', Boolean(registered?.dict?.en && registered?.dict?.zh));
const enKeys = Object.keys(registered?.dict?.en ?? {});
const zhKeys = Object.keys(registered?.dict?.zh ?? {});
check('both languages have the same keys', enKeys.join(',') === zhKeys.join(','), `${enKeys.length} vs ${zhKeys.length}`);
check('the dictionary is substantial', enKeys.length > 150, `${enKeys.length} keys`);

check('the settings section is registered', registrations.length === 1);
const section = registrations[0]?.options;
check('the section is a settings.section', section?.name === 'settings.section');
check('the section id matches the plugin', section?.id === 'mcp-installer');
check('the section has a nav label', typeof section?.label === 'function' && section.label() === 'settings.mcpInstaller:nav', section?.label?.());
check('the page component is a function', typeof registrations[0]?.component === 'function');

// The name the user sees must be the npm package name, in both languages, and
// must match what Plugin Manager reads from the exported locale JSON. This is
// the guard against a display name drifting away from the package again.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const lang of ['en', 'zh']) {
  check(
    `${lang} nav label is the package name`,
    registered.dict[lang].nav === pkg.name,
    `${registered.dict[lang].nav} != ${pkg.name}`,
  );
  check(
    `${lang} page title is the package name`,
    registered.dict[lang].title === pkg.name,
    `${registered.dict[lang].title} != ${pkg.name}`,
  );
  const meta = JSON.parse(readFileSync(`locale/${lang}.json`, 'utf8'));
  check(
    `${lang} Plugin Manager metadata shows the package name`,
    meta.meta.title === pkg.name,
    `${meta.meta.title} != ${pkg.name}`,
  );
}

// The page copy must be fully translated: no English key may contain Han text.
// The name keys are exempt because the name is intentionally untranslated.
const untranslated = enKeys.filter(
  (key) => !['nav', 'title'].includes(key) && /[\u4e00-\u9fff]/u.test(registered.dict.en[key]),
);
check('no English page copy contains Chinese', untranslated.length === 0, untranslated.slice(0, 5).join(', '));

console.log('');
if (failures > 0) {
  console.error(`${failures} client verification check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('all client verification checks passed');
}

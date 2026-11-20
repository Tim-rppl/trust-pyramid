// Project lint rules (ESLint-compatible plugin format; works with ESLint and oxlint jsPlugins).
// .mjs so it loads as ESM without a package.json "type": "module". Run linters from the repo root:
// oxlint rejects paths containing "..".
// Each rule encodes one mistake that actually happened. The message says what is wrong, how to
// fix it, and the sanctioned exception, so an agent can repair the code from the error alone.
//
// oxlint:  .oxlintrc.json -> "jsPlugins": ["./lint/project-plugin.mjs"], "rules": { "project/<rule>": "error" }
// ESLint:  eslint.config.js -> import project from './lint/project-plugin.mjs'; plugins: { project }

const TIMER_NAMES = new Set(['setTimeout', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask']);

/** Example rule: forbid "wait a tick" timing patches that hide ordering bugs. */
const noTimingPatch = {
  meta: { type: 'problem' },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (/[\\/]lib[\\/]timing\.[jt]sx?$/.test(filename)) return {};
    return {
      CallExpression(node) {
        const callee = node.callee.type === 'MemberExpression' ? node.callee.property : node.callee;
        if (callee?.type !== 'Identifier' || !TIMER_NAMES.has(callee.name)) return;
        const delay = node.arguments[1];
        const isZeroDelay = callee.name !== 'setTimeout' || !delay || (delay.type === 'Literal' && delay.value === 0);
        if (!isZeroDelay) return;
        context.report({
          node,
          message: `${callee.name}(…) used to "wait a tick" hides an ordering bug and gets copied across the codebase. `
            + 'Fix the order of operations instead: update state before reading it, await the promise that produces the value, '
            + 'or use the framework lifecycle (e.g. a ref callback). Real scheduling needs (animation, debouncing) belong in the '
            + 'shared helpers in src/lib/timing.ts, which are allowed to use timers.',
        });
      },
    };
  },
};

/** Example rule: user-visible text must go through i18n (adapt the character class to your source language). */
const NATURAL_LANGUAGE = /[A-Za-z㐀-鿿]{2,}/;
const VISIBLE_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt']);
const noRawUiText = {
  meta: { type: 'problem' },
  create(context) {
    const hasLang = element => element?.attributes?.some(attribute => attribute.type === 'JSXAttribute' && attribute.name?.name === 'lang');
    const report = (node, text) => context.report({
      node,
      message: `UI text "${text.trim().slice(0, 30)}" is not translated. Use {t('${text.trim()}')} (const t = useT()) and add `
        + 'the entry to every locale file. Text that must not be translated (e.g. a language name): add a lang attribute to the element.',
    });
    return {
      JSXText(node) {
        if (NATURAL_LANGUAGE.test(node.value) && !hasLang(node.parent?.openingElement)) report(node, node.value);
      },
      JSXAttribute(node) {
        if (!VISIBLE_ATTRIBUTES.has(node.name?.name) || node.value?.type !== 'Literal') return;
        if (NATURAL_LANGUAGE.test(String(node.value.value))) report(node, String(node.value.value));
      },
    };
  },
};

export default {
  meta: { name: 'project' },
  rules: {
    'no-timing-patch': noTimingPatch,
    'no-raw-ui-text': noRawUiText,
  },
};

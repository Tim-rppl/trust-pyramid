#!/usr/bin/env node
// Walks verify/feature-map.md, screenshots each step, writes verify/.state/artifacts/smoke-result.json.
// Requires `node verify/app.mjs up`. Exits 1 if any step fails.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const VERIFY_DIR = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(VERIFY_DIR, '.state', 'artifacts');
const ERRORS_FILE = join(VERIFY_DIR, '.state', 'page-errors.log');
const config = (await import(pathToFileURL(join(VERIFY_DIR, 'verify.config.mjs')).href)).default;
// Seeded user content that may legitimately contain any language (excluded from the leak check).
const USER_CONTENT = [];

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.cdpPort}`).catch(() => {
  console.error('Browser is not running. Run: node verify/app.mjs up');
  process.exit(2);
});
const context = browser.contexts()[0];
const page = context.pages().find(candidate => candidate.url().startsWith('http')) ?? context.pages()[0] ?? await context.newPage();
page.setDefaultTimeout(5000);
for (const file of readdirSync(ARTIFACTS)) if (file.startsWith('smoke-')) rmSync(join(ARTIFACTS, file));
const results = [];

async function step(name, action) {
  const startedAt = Date.now();
  try {
    await action();
    results.push({ step: name, ok: true, ms: Date.now() - startedAt });
    console.log(`✓ ${name}`);
  } catch (error) {
    results.push({ step: name, ok: false, error: error.message.split('\n')[0] });
    console.log(`✗ ${name}\n    ${error.message.split('\n')[0]}`);
  }
  await page.screenshot({ fullPage: true, path: join(ARTIFACTS, `smoke-${String(results.length).padStart(2, '0')}-${name.replace(/\W+/g, '-')}.png`) });
}

/** Visible text and labels that match `pattern` (e.g. CJK while the UI is in English). */
async function textMatching(pattern) {
  return page.evaluate(({ source, userContent }) => {
    const regex = new RegExp(source);
    const found = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim();
      if (regex.test(text) && !node.parentElement.closest('[lang]') && !userContent.some(item => text.includes(item))) found.add(text);
    }
    for (const element of document.querySelectorAll('[aria-label],[title],[placeholder]')) {
      if (element.closest('[lang]')) continue;
      for (const attribute of ['aria-label', 'title', 'placeholder']) {
        const value = element.getAttribute(attribute);
        if (value && regex.test(value) && !userContent.some(item => value.includes(item))) found.add(`[${attribute}] ${value}`);
      }
    }
    return [...found];
  }, { source: pattern.source, userContent: USER_CONTENT });
}

writeFileSync(ERRORS_FILE, '');
// Always start from the same state; a previous failed run must not affect this one.
await config.reset(page, { webUrl: config.webUrl });

// One step per row of verify/feature-map.md. Replace these examples.
await step('home', async () => {
  await page.getByRole('main').waitFor();
});

// Multilingual apps: switch language, visit each page, fail on untranslated text, switch back in finally.
// await step('no untranslated text in Chinese UI', async () => {
//   const leaks = [];
//   try { /* switch to zh, visit pages */ for (const text of await textMatching(/[A-Za-z]{3,}/)) leaks.push(text); }
//   finally { /* switch back */ }
//   if (leaks.length) throw new Error(`Untranslated: ${leaks.join(' | ')}`);
// });
void textMatching;

await step('no console errors', async () => {
  const errors = readFileSync(ERRORS_FILE, 'utf8').trim();
  if (errors) throw new Error(errors.split('\n').slice(0, 5).join(' | '));
});

await browser.close();
writeFileSync(join(ARTIFACTS, 'smoke-result.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: verify/.state/artifacts/`);
process.exit(failed.length ? 1 : 0);

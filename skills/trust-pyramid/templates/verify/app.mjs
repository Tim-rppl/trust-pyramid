#!/usr/bin/env node
// Runtime verification CLI: lets a coding agent start the app, use it like a person, and look at it.
// The browser starts once (`up`) and every later command attaches over CDP, so state carries over.
//
//   node verify/app.mjs up                      start the stack + browser and sign in
//   node verify/app.mjs goto <path>             navigate (relative to webUrl)
//   node verify/app.mjs click "<name>"          click a button/link/tab/menuitem by accessible name
//   node verify/app.mjs fill "<label>" "<text>" fill a labelled field
//   node verify/app.mjs press <key>             e.g. Escape, Enter
//   node verify/app.mjs snapshot                print the accessibility tree (read this, do not guess)
//   node verify/app.mjs screenshot <name>       save verify/.state/artifacts/<name>.png (then open it)
//   node verify/app.mjs errors                  console errors since the last call
//   node verify/app.mjs down                    stop everything
// Servers started by `up` do not reload: after backend changes run `down` then `up`.
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const VERIFY_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(VERIFY_DIR, '..');
const STATE_DIR = join(VERIFY_DIR, '.state');
const ARTIFACTS = join(STATE_DIR, 'artifacts');
const STATE_FILE = join(STATE_DIR, 'state.json');
const ERRORS_FILE = join(STATE_DIR, 'page-errors.log');
const config = (await import(pathToFileURL(join(VERIFY_DIR, 'verify.config.mjs')).href)).default;

mkdirSync(ARTIFACTS, { recursive: true });
const readState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {});
const writeState = state => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function startDetached(name, command, env = {}) {
  const logPath = join(STATE_DIR, `${name}.log`);
  const log = openSync(logPath, 'w');
  const child = spawn(command[0], command.slice(1), { cwd: REPO, detached: true, stdio: ['ignore', log, log], env: { ...process.env, ...env } });
  child.unref();
  closeSync(log);
  return { pid: child.pid, logPath };
}

async function waitFor(description, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${description}. See verify/.state/*.log`);
}

const portFree = port => new Promise(resolve => {
  const server = net.createServer().once('error', () => resolve(false)).once('listening', () => server.close(() => resolve(true)));
  server.listen(port, '127.0.0.1');
});

async function connect() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.cdpPort}`).catch(() => {
    throw new Error('Browser is not running. Run: node verify/app.mjs up');
  });
  const context = browser.contexts()[0];
  const page = context.pages().find(candidate => candidate.url().startsWith('http')) ?? context.pages()[0];
  return { browser, page };
}

async function watchErrors() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.cdpPort}`);
  const record = text => appendFileSync(ERRORS_FILE, `${new Date().toISOString()} ${String(text).slice(0, 500)}\n`);
  const attach = page => {
    page.on('console', message => { if (message.type() === 'error') record(`console.error: ${message.text()}`); });
    page.on('pageerror', error => record(`uncaught: ${error.message}`));
  };
  for (const context of browser.contexts()) {
    context.pages().forEach(attach);
    context.on('page', attach);
  }
  await new Promise(() => {});
}

async function up() {
  const state = readState();
  if (state.processes) throw new Error('Already running. Run: node verify/app.mjs down');
  const busy = [];
  for (const { name, port } of [...config.processes, { name: 'browser (cdpPort)', port: config.cdpPort }]) {
    if (port && !(await portFree(port))) busy.push(`${name}: ${port}`);
  }
  if (busy.length) throw new Error(`Ports already in use (another server would answer for us): ${busy.join(', ')}. Stop it or change the ports in verify.config.mjs.`);
  state.processes = {};
  const save = () => writeState(state);

  for (const processConfig of config.processes) {
    const started = startDetached(processConfig.name, processConfig.command, processConfig.env);
    state.processes[processConfig.name] = started.pid;
    save();
    const { ready, timeoutMs } = processConfig;
    if (ready?.url) await waitFor(`${processConfig.name} at ${ready.url}`, async () => (await fetch(ready.url)).ok, timeoutMs);
    if (ready?.log) await waitFor(`"${ready.log}" in ${processConfig.name}.log`, async () => readFileSync(started.logPath, 'utf8').includes(ready.log), timeoutMs);
  }

  const browserProcess = startDetached('browser', [chromium.executablePath(),
    '--headless=new', `--remote-debugging-port=${config.cdpPort}`, `--user-data-dir=${join(STATE_DIR, 'profile')}`,
    `--window-size=${config.viewport.width},${config.viewport.height}`, `--lang=${config.locale}`, `--accept-lang=${config.locale}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank']);
  state.processes.browser = browserProcess.pid;
  save();
  await waitFor('browser debugging port', async () => (await fetch(`http://127.0.0.1:${config.cdpPort}/json/version`)).ok);

  writeFileSync(ERRORS_FILE, '');
  state.processes.watcher = startDetached('error-watcher', [process.execPath, fileURLToPath(import.meta.url), '__watch']).pid;
  save();
  await sleep(1000);

  const { browser, page } = await connect();
  await page.setViewportSize(config.viewport);
  await config.signIn(page, { webUrl: config.webUrl });
  await browser.close();
  console.log(`Ready at ${config.webUrl}`);
}

function down() {
  const state = readState();
  for (const [name, pid] of Object.entries(state.processes ?? {})) {
    try { process.kill(-pid, 'SIGTERM'); console.log(`stopped ${name}`); } catch { /* already gone */ }
  }
  writeState({});
}

async function withPage(action) {
  const { browser, page } = await connect();
  try { await action(page); } finally { await browser.close(); }
}

const clickable = (page, name) => page.getByRole('button', { name, exact: true })
  .or(page.getByRole('link', { name, exact: true }))
  .or(page.getByRole('tab', { name, exact: true }))
  .or(page.getByRole('menuitem', { name, exact: true }))
  .first();

const commands = {
  up,
  down,
  goto: path => withPage(async page => { await page.goto(new URL(path, config.webUrl).href); console.log(page.url()); }),
  click: name => withPage(async page => { await clickable(page, name).click({ timeout: 5000 }); await page.waitForTimeout(300); }),
  fill: (label, text) => withPage(page => page.getByLabel(label, { exact: true }).fill(text)),
  press: key => withPage(page => page.keyboard.press(key)),
  snapshot: () => withPage(async page => console.log(await page.locator('body').ariaSnapshot())),
  screenshot: name => withPage(async page => {
    const file = join(ARTIFACTS, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }),
  errors: async () => {
    const text = existsSync(ERRORS_FILE) ? readFileSync(ERRORS_FILE, 'utf8').trim() : '';
    console.log(text || 'No new console errors');
    writeFileSync(ERRORS_FILE, '');
  },
  __watch: watchErrors,
};

const [command, ...args] = process.argv.slice(2);
if (!commands[command]) {
  console.error(`Unknown command: ${command ?? '(none)'}. Available: ${Object.keys(commands).filter(name => !name.startsWith('__')).join(', ')}`);
  process.exit(2);
}
await commands[command](...args);

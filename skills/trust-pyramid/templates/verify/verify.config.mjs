// Project-specific settings for verify/app.mjs. Everything stack-specific lives here.
// Paths are relative to the repository root.

export default {
  webUrl: 'http://127.0.0.1:5173/',
  cdpPort: 9333,
  locale: 'en-US',
  viewport: { width: 1440, height: 900 },

  // Long-running processes started by `up`, in order. `port` is checked before starting, so a
  // server from another project cannot silently answer the readiness probe. `ready` is either a
  // URL that must answer 2xx or a string that must appear in the process log.
  // Servers do not hot-reload here: after changing backend code, run `down` then `up`.
  processes: [
    {
      name: 'fake-openai',
      command: ['node', 'verify/fake-openai.mjs'],
      port: 4010,
      env: { FAKE_OPENAI_PORT: '4010' },
      ready: { url: 'http://127.0.0.1:4010/health' },
    },
    {
      name: 'backend',
      // Example for Firebase: emulators on isolated ports from firebase.verify.json.
      command: ['firebase', 'emulators:exec', '--config', 'firebase.verify.json', '--only', 'auth,firestore',
        '--project', 'demo-verify', 'npm --prefix server run dev'],
      port: 5001,
      env: { OPENAI_BASE_URL: 'http://127.0.0.1:4010/v1', OPENAI_API_KEY: 'fake-key' },
      ready: { log: 'server ready' },
      timeoutMs: 240_000,
    },
    {
      name: 'web',
      port: 5173,
      command: ['npm', '--prefix', 'web', 'run', 'dev', '--', '--port', '5173', '--strictPort'],
      ready: { url: 'http://127.0.0.1:5173/' },
    },
  ],

  // Sign in as the seeded test user. `page` is a Playwright Page. Credentials come from the
  // project's seed files, never from a real account.
  async signIn(page, { webUrl }) {
    await page.goto(webUrl);
    // await page.getByLabel('Email').fill('test@example.test');
    // await page.getByLabel('Password').fill('test-password-123');
    // await page.getByRole('button', { name: 'Sign in' }).click();
    // await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  },

  // Called by smoke.mjs before the first step: put data and UI state back to a known start so
  // earlier runs cannot leak into this one (duplicate rows, a switched language, open dialogs).
  async reset(page, { webUrl }) {
    // await fetch('http://127.0.0.1:5001/test/reset', { method: 'POST' });  // test-only endpoint, emulator only
    await page.goto(webUrl);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  },
};

// Shared helpers for the browser tests. They drive a real SillyTavern in
// Chromium (Playwright) against the fake model server in mock-llm.mjs.
//
// Configuration (all optional):
//   ST_URL         SillyTavern address            (default http://127.0.0.1:8000)
//   MOCK_PORT      main fake model port           (default 5005)
//   SIDECAR_PORT   sidecar fake model port        (default 5006)
//   PS_TEST_OUT    logs + screenshots directory   (default tests/.out)

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const ST_URL = process.env.ST_URL ?? 'http://127.0.0.1:8000';
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 5005);
const SIDECAR_PORT = Number(process.env.SIDECAR_PORT ?? 5006);
const OUT = path.resolve(process.env.PS_TEST_OUT ?? path.join(__dirname, '.out'));
fs.mkdirSync(OUT, { recursive: true });
const MAIN_LOG = path.join(OUT, 'requests.log');
const SIDE_LOG = path.join(OUT, 'requests-side.log');

// ─── Checks ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
/** Records one expectation. A failure marks the run as failed but keeps going. */
function check(name, ok, detail) {
    if (ok) passed++; else failed++;
    console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail !== undefined ? `  →  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    if (!ok) process.exitCode = 1;
    return ok;
}
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const section = (title) => console.log(`\n▸ ${title}`);
/** Runs a suite body with a browser; prints a summary and fails on page errors. */
async function suite(name, body, contextOptions) {
    console.log(`\n━━ ${name}`);
    await resetMocks();
    const { browser, page } = await open(contextOptions);
    try {
        await body(page);
    } catch (error) {
        check('suite finished without throwing', false, error.stack ?? String(error));
        await page.screenshot({ path: path.join(OUT, `${name}-failure.png`) }).catch(() => {});
    } finally {
        const errors = page.errors.filter(e => !page.allowed.some(re => re.test(e)));
        check('no page errors', errors.length === 0, errors.join('\n'));
        await browser.close();
    }
}
function summary() {
    console.log(`\n${passed} passed, ${failed} failed`);
}
process.on('beforeExit', () => { if (passed + failed) summary(); passed = failed = 0; });

// ─── Browser + SillyTavern ───────────────────────────────────────────

async function open(contextOptions) {
    const browser = await chromium.launch();
    const page = await browser.newPage(contextOptions ?? { viewport: { width: 1400, height: 950 } });
    page.errors = [];
    page.allowed = [];
    /** Errors matching this are part of the test (e.g. a deliberately broken sidecar). */
    page.allowErrors = (re) => page.allowed.push(re);
    page.on('pageerror', e => page.errors.push('PAGEERROR ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/500|aihorde|horde|Failed to load resource/i.test(m.text())) page.errors.push(m.text()); });
    await page.goto(ST_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.SillyTavern?.getContext && typeof globalThis.privateScenesInterceptor === 'function', null, { timeout: 60000 });
    await page.waitForTimeout(3000);
    // Every suite starts on the main model; the sidecar suites pick their own.
    await page.evaluate(() => { const s = SillyTavern.getContext().extensionSettings.privateScenes; if (s) Object.assign(s, { sidecarProfile: '', sidecarMode: 'main', sidecarModel: '', sidecarModeSet: true }); });
    return { browser, page };
}
const openMobile = () => open({ ...devices['iPhone 13'] });

/** Settings every suite resets, so one suite's toggles never leak into the next. */
const BASE_SETTINGS = { enabled: true, clockEnabled: true, clockAutoTrack: false, clockFromTracker: true, tidyText: true, leakCheck: false, leakAutoRegenerate: false, reviewBeforeSave: false, hideAfterSave: false, autoMemory: false, consolidate: false, autoSheets: true, worldCondense: true, showBadges: true, branchCopy: true };
async function configure(page, overrides = {}) {
    await page.evaluate((s) => Object.assign(SillyTavern.getContext().extensionSettings.privateScenes, s), { ...BASE_SETTINGS, ...overrides });
}

async function setupApi(page) {
    await page.evaluate(async (port) => {
        $('#main_api').val('openai').trigger('change');
        $('#chat_completion_source').val('custom').trigger('change');
        $('#custom_api_url_text').val(`http://127.0.0.1:${port}/v1`).trigger('input');
        $('#custom_model_id').val('mock').trigger('input');
        $('#stream_toggle').prop('checked', false).trigger('input');
        $('#api_button_openai').trigger('click');
    }, MOCK_PORT);
    await page.waitForFunction(() => SillyTavern.getContext().onlineStatus && SillyTavern.getContext().onlineStatus !== 'no_connection', null, { timeout: 30000 });
}

/** Creates (once) and opens a narrator character; a fresh name gives a fresh chat. */
async function ensureCharacter(page, name = 'Narrator ' + Date.now()) {
    await page.evaluate(async (name) => {
        const c = SillyTavern.getContext();
        if (!c.characters.some(x => x.name === name)) {
            const fd = new FormData();
            fd.append('ch_name', name);
            fd.append('description', 'The narrator of a court-intrigue story who plays every character: Ana, Kael, Bob.');
            fd.append('first_mes', 'The palace hall buzzes with whispers on the eve of the coronation.');
            for (const k of ['personality', 'scenario', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'tags', 'creator', 'character_version', 'talkativeness', 'fav', 'world', 'depth_prompt_prompt']) fd.append(k, '');
            fd.append('depth_prompt_depth', '4'); fd.append('depth_prompt_role', 'system');
            const h = c.getRequestHeaders(); delete h['Content-Type'];
            const r = await fetch('/api/characters/create', { method: 'POST', headers: h, body: fd });
            if (!r.ok) throw new Error('create failed ' + r.status);
            await c.getCharacters();
        }
        const idx = SillyTavern.getContext().characters.findIndex(x => x.name === name);
        await SillyTavern.getContext().selectCharacterById(idx);
    }, name);
    await page.waitForFunction(() => SillyTavern.getContext().chat.length >= 1, null, { timeout: 20000 });
    return name;
}

/** Fresh page, API, settings and character — the usual start of a suite. */
async function start(page, overrides = {}) {
    await dismissPopups(page);
    await configure(page, overrides);
    await setupApi(page);
    return ensureCharacter(page);
}

async function dismissPopups(page) {
    for (let i = 0; i < 5; i++) {
        const text = await page.evaluate(() => {
            const d = [...document.querySelectorAll('dialog.popup[open]')].at(-1);
            if (!d) return null;
            const t = d.innerText.slice(0, 120).replace(/\s+/g, ' ');
            (d.querySelector('.popup-button-ok') || d.querySelector('.popup-button-close') || d.querySelector('.popup-button-cancel'))?.click();
            return t;
        });
        if (!text) return;
        await page.waitForTimeout(500);
    }
}

async function closeAll(page) {
    for (let i = 0; i < 3; i++) {
        const b = page.locator('dialog[open] .popup-button-ok:visible');
        if (await b.count()) { await b.last().click(); await page.waitForTimeout(300); }
    }
}

async function send(page, text) {
    await dismissPopups(page);
    const before = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await page.fill('#send_textarea', text);
    await page.click('#send_but');
    await page.waitForFunction((n) => SillyTavern.getContext().chat.length >= n + 2 && !document.querySelector('#mes_stop:not([style*="none"])')?.offsetParent, before, { timeout: 30000 });
    await page.waitForTimeout(800);
}

/** Runs slash commands; returns the pipe. */
const run = (page, cmd) => page.evaluate(async (c) => (await SillyTavern.getContext().executeSlashCommandsWithOptions(c)).pipe, cmd);
const state = (page) => page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes);
const book = (page) => page.evaluate(async () => {
    const c = SillyTavern.getContext();
    const d = await c.loadWorldInfo(c.chatMetadata.world_info);
    return Object.values(d?.entries ?? {}).map(e => ({ comment: e.comment, constant: e.constant, key: e.key, content: e.content }));
});
const toasts = (page, kind = 'warning') => page.evaluate((k) => [...document.querySelectorAll(`#toast-container .toast-${k}`)].map(t => t.innerText.replace(/\n/g, ' ')), kind);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

/** Opens the extension's drawer in the Extensions panel, and a settings group. */
async function openSettings(page) {
    await page.click('#extensions-settings-button .drawer-toggle');
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('.private-scenes-settings .inline-drawer-toggle').click());
    await page.waitForTimeout(400);
}
async function openGroup(page, id) {
    await page.evaluate((id) => { const g = document.querySelector(`.ps-group[data-group="${id}"]`); if (g) g.open = true; }, id);
    await page.waitForTimeout(200);
}

// ─── Fake model logs ─────────────────────────────────────────────────

/** Clears both fake models' logs and counters (the sidecar one may not be running). */
async function resetMocks() {
    for (const port of [MOCK_PORT, SIDECAR_PORT]) {
        await fetch(`http://127.0.0.1:${port}/__reset`, { method: 'POST' }).catch(() => {});
    }
}

const readLog = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const requests = () => readLog(MAIN_LOG);
const sideRequests = () => readLog(SIDE_LOG);
/** What a logged request was for, by its prompt. */
function kindOf(r) {
    const s = JSON.stringify(r.body.messages ?? r.body.prompt ?? '');
    if (/story archivist/.test(s)) return /PRIVATE scene/.test(s) ? 'secret-summary' : /Merge them/.test(s) ? 'chapter' : 'story-summary';
    if (/leaked secrets/.test(s)) return 'leak';
    if (/character sheets/.test(s)) return 'sheets';
    if (/condense a/.test(s)) return 'condense';
    if (/in-story time/.test(s)) return 'clock';
    if (/connection test/.test(s)) return 'test';
    return 'chat';
}
/** The last real chat request (not one of the extension's own tasks). */
const chatPrompt = () => requests().filter(r => kindOf(r) === 'chat').at(-1)?.body.messages ?? [];

/** Tappable elements under 40px, for the touch checks. */
const smallTargets = (page, selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)]
    .filter(e => e.offsetParent && e.getBoundingClientRect().width > 0)
    .map(e => { const r = e.getBoundingClientRect(); return { c: (e.className || '').toString().split(' ').filter(x => x.startsWith('ps') || x === 'checkbox_label').join('.'), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(x => x.w < 40 || x.h < 40), selector);

module.exports = {
    ST_URL, MOCK_PORT, SIDECAR_PORT, OUT, devices,
    check, eq, section, suite, summary,
    open, openMobile, configure, setupApi, ensureCharacter, start, dismissPopups, closeAll, send, run, state, book, toasts, shot,
    openSettings, openGroup, requests, sideRequests, kindOf, chatPrompt, smallTargets,
};

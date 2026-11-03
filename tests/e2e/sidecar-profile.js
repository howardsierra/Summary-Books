// AI sidecar through a Connection Manager profile: routing, per-task switches, fallback.
const L = require('../lib');
const { check, eq, section } = L;
const tally = (rs) => rs.map(L.kindOf);

L.suite('sidecar-profile', async (page) => {
    await L.dismissPopups(page);
    await L.configure(page, { leakCheck: true, sidecarFallback: true, sidecarTasks: { summary: true, leak: true, sheets: true, condense: true, clock: true } });
    await L.setupApi(page);
    await page.evaluate((port) => {
        const cm = SillyTavern.getContext().extensionSettings.connectionManager;
        cm.profiles = cm.profiles.filter(p => p.id !== 'ps-test-sidecar');
        cm.profiles.push({ id: 'ps-test-sidecar', mode: 'cc', exclude: [], name: 'Cheap sidecar', api: 'custom', model: 'cheap-mock', 'api-url': `http://127.0.0.1:${port}/v1` });
    }, L.SIDECAR_PORT);

    section('pick the profile in settings');
    await L.openSettings(page);
    await L.openGroup(page, 'sidecar');
    await page.locator('.ps-sidecar-mode:has-text("Connection profile")').click();
    await page.waitForTimeout(200);
    check('profile is offered', (await page.locator('#ps_sidecar_profile option').allTextContents()).some(t => /Cheap sidecar/.test(t)));
    await page.selectOption('#ps_sidecar_profile', 'ps-test-sidecar');
    await page.waitForTimeout(300);
    eq('profile saved', await page.evaluate(() => SillyTavern.getContext().extensionSettings.privateScenes.sidecarProfile), 'ps-test-sidecar');
    await page.click('#ps_sidecar_test');
    await page.waitForSelector('#toast-container .toast-success', { timeout: 15000 });
    check('connection test succeeds', /cheap-mock|works|OK/i.test(await page.locator('#toast-container .toast-success').last().innerText()));
    await page.click('#extensions-settings-button .drawer-toggle');

    section('tasks go to the sidecar');
    await L.ensureCharacter(page);
    await L.send(page, 'Bob greets everyone in the hall.');
    await L.send(page, '@scene Ana, Kael: Ana whispers: "I stole the royal seal."');
    await L.send(page, '@endscene The music resumes.');
    await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.timeline).length > 0, null, { timeout: 30000 });
    await L.send(page, '@news: The coronation has been moved to dawn.');
    await L.send(page, 'LEAKME Bob approaches Ana.');
    await page.waitForSelector('.ps-leak', { timeout: 30000 });
    await L.run(page, '/memory-save');
    await page.waitForTimeout(1500);
    check('main model only gets chat', tally(L.requests()).every(k => k === 'chat'), tally(L.requests()));
    const side = tally(L.sideRequests());
    check('sidecar gets summaries, leak checks, sheets, condense', ['secret-summary', 'story-summary', 'leak', 'sheets', 'condense'].every(k => side.includes(k)), side);
    const req = L.sideRequests().find(r => L.kindOf(r) === 'secret-summary');
    eq('sidecar uses the profile model', req?.body.model, 'cheap-mock');
    check('sidecar request has no chat preset (system + user only)', req?.body.messages.every(m => ['system', 'user'].includes(m.role)), req?.body.messages.map(m => m.role));

    section('a task switched off goes back to main');
    await page.evaluate(() => { const s = SillyTavern.getContext().extensionSettings.privateScenes; s.sidecarTasks = { ...s.sidecarTasks, leak: false }; });
    const before = L.requests().length;
    await L.send(page, 'Kael mentions the royal seal to Bob.');
    await page.waitForTimeout(1500);
    check('leak check ran on main', tally(L.requests().slice(before)).includes('leak'), tally(L.requests().slice(before)));

    section('fallback when the sidecar is down');
    page.allowErrors(/Sidecar "Cheap sidecar" failed|ERR_CONNECTION_REFUSED|5099/);
    await page.evaluate(() => { const p = SillyTavern.getContext().extensionSettings.connectionManager.profiles.find(x => x.id === 'ps-test-sidecar'); p['api-url'] = 'http://127.0.0.1:5099/v1'; });
    const before2 = L.requests().length;
    check('memory still saves', !!(await L.run(page, '/memory-save')));
    await page.waitForTimeout(800);
    check('…through the main model', tally(L.requests().slice(before2)).includes('story-summary'));
    check('with a warning', (await L.toasts(page)).some(t => /sidecar/i.test(t)), await L.toasts(page));
});

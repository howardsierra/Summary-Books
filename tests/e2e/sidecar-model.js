// AI sidecar as "another model from the same provider".
const L = require('../lib');
const { check, eq, section } = L;
const byModel = (rs) => { const out = {}; for (const r of rs) (out[r.body.model] ??= new Set()).add(L.kindOf(r)); return out; };

L.suite('sidecar-model', async (page) => {
    await L.dismissPopups(page);
    await L.configure(page, { leakCheck: true, sidecarFallback: true, sidecarTasks: { summary: true, leak: true, sheets: true, condense: true, clock: true } });
    await L.setupApi(page);
    await page.waitForTimeout(1500);

    section('pick a model in settings');
    await L.openSettings(page);
    await L.openGroup(page, 'sidecar');
    await page.locator('.ps-sidecar-mode:has-text("Pick a model")').click();
    await page.waitForTimeout(300);
    check('provider is named', /Custom/i.test(await page.locator('#ps_sidecar_provider').innerText()));
    check('provider models are offered', (await page.locator('#ps_sidecar_model_list option').allTextContents()).includes('cheap-mock'));
    await page.selectOption('#ps_sidecar_model_list', 'cheap-mock');
    await page.waitForTimeout(300);
    eq('saved', await page.evaluate(() => { const s = SillyTavern.getContext().extensionSettings.privateScenes; return [s.sidecarMode, s.sidecarModel, s.sidecarSource]; }), ['model', 'cheap-mock', 'custom']);
    await page.click('#ps_sidecar_test');
    await page.waitForSelector('#toast-container .toast-success', { timeout: 15000 });
    await page.click('#extensions-settings-button .drawer-toggle');

    section('tasks use the cheap model');
    await L.ensureCharacter(page);
    await L.send(page, '@scene Ana, Kael: Ana whispers: "I stole the royal seal."');
    await L.send(page, '@endscene The music resumes.');
    await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.timeline).length > 0, null, { timeout: 30000 });
    await L.send(page, '@news: The coronation has been moved to dawn.');
    await L.send(page, 'LEAKME Bob approaches Ana.');
    await page.waitForSelector('.ps-leak', { timeout: 30000 });
    await L.run(page, '/memory-save');
    await page.waitForTimeout(1200);
    const models = byModel(L.requests().filter(r => L.kindOf(r) !== 'test'));
    eq('chat stays on the main model', [...(models.mock ?? [])], ['chat']);
    check('tasks go to cheap-mock', ['secret-summary', 'leak', 'story-summary'].every(k => models['cheap-mock']?.has(k)), [...(models['cheap-mock'] ?? [])]);

    section('provider changed since the model was picked');
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.privateScenes.sidecarSource = 'claude'; });
    const before = L.requests().length;
    await L.run(page, '/memory-save at=0-3');
    await page.waitForTimeout(800);
    eq('falls back to the main model', Object.keys(byModel(L.requests().slice(before))), ['mock']);
    check('with a warning', (await L.toasts(page)).some(t => /sidecar|provider/i.test(t)), await L.toasts(page));
});

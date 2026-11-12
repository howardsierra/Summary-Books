// AI sidecar as "pick a model": from the roleplay's provider, or from another provider.
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
    // The pills show the settings from page load: start from a different one.
    await page.locator('.ps-sidecar-mode:has-text(\"Same as the roleplay\")').click();
    await page.locator('.ps-sidecar-mode:has-text("Pick a model")').click();
    await page.waitForTimeout(300);
    // The panel was drawn at page load from the previous run's settings; redraw it.
    await page.selectOption('#ps_sidecar_source', '');
    await page.waitForTimeout(300);
    const why = await page.evaluate(() => ({ chosen: $('#ps_sidecar_source option:checked').text(), source: SillyTavern.getContext().chatCompletionSettings.chat_completion_source, saved: SillyTavern.getContext().extensionSettings.privateScenes.sidecarSource, models: $('#ps_sidecar_model_list option').map((i, o) => o.value).get() }));
    check('provider defaults to the roleplay\'s', /Same as my roleplay \(Custom/.test(why.chosen), why);
    check('every provider is offered', (await page.locator('#ps_sidecar_source option').count()) > 10);
    check('provider models are offered', (await page.locator('#ps_sidecar_model_list option').allTextContents()).includes('cheap-mock'));
    await page.selectOption('#ps_sidecar_model_list', 'cheap-mock');
    await page.waitForTimeout(300);
    eq('saved', await page.evaluate(() => { const s = SillyTavern.getContext().extensionSettings.privateScenes; return [s.sidecarMode, s.sidecarModel, s.sidecarSource]; }), ['model', 'cheap-mock', '']);
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

    section('another provider');
    // The roleplay moves to OpenAI (through a reverse proxy to the main fake model);
    // the sidecar uses the Custom provider on the second fake model.
    await page.evaluate((port) => {
        $('#chat_completion_source').val('openai').trigger('change');
        $('#openai_reverse_proxy').val(`http://127.0.0.1:${port}/v1`).trigger('input');
        $('#openai_proxy_password').val('test').trigger('input');
    }, L.MOCK_PORT);
    await page.waitForTimeout(800);
    await page.click('#extensions-settings-button .drawer-toggle'); // the extension's own drawer is still open
    await page.waitForTimeout(500);
    await L.openGroup(page, 'sidecar');
    await page.selectOption('#ps_sidecar_source', 'custom');
    await page.waitForTimeout(300);
    check('the URL field shows for Custom', await page.locator('#ps_sidecar_custom_url').isVisible());
    check('the key note names the provider', /API key you saved for Custom/.test(await page.locator('#ps_sidecar_provider').innerText()), await page.locator('#ps_sidecar_provider').innerText());
    await page.fill('#ps_sidecar_custom_url', `http://127.0.0.1:${L.SIDECAR_PORT}/v1`);
    await page.click('#ps_sidecar_load');
    await page.waitForFunction(() => [...document.querySelectorAll('#ps_sidecar_model_list option')].some(o => o.value === 'cheap-mock'), null, { timeout: 15000 })
        .then(() => check('Load models lists the provider\'s models', true), () => check('Load models lists the provider\'s models', false));
    await page.selectOption('#ps_sidecar_model_list', 'cheap-mock');
    eq('saved', await page.evaluate(() => { const s = SillyTavern.getContext().extensionSettings.privateScenes; return [s.sidecarSource, s.sidecarModel, s.sidecarCustomUrl]; }), ['custom', 'cheap-mock', `http://127.0.0.1:${L.SIDECAR_PORT}/v1`]);
    await page.click('#ps_sidecar_test');
    check('the test reaches the other provider', !!(await page.waitForSelector('#toast-container .toast-success:has-text("via Custom")', { timeout: 15000 }).catch(() => null)));
    await page.click('#extensions-settings-button .drawer-toggle');
    const sideBefore = L.sideRequests().length;
    const mainBefore = L.requests().length;
    await L.run(page, '/memory-save at=0-3');
    await page.waitForTimeout(800);
    const side = L.sideRequests().slice(sideBefore).filter(r => L.kindOf(r) !== 'test');
    check('summary went to the other provider', side.some(r => L.kindOf(r) === 'story-summary' && r.body.model === 'cheap-mock'), side.map(L.kindOf));
    eq('nothing went to the roleplay connection', L.requests().slice(mainBefore).length, 0);

    section('a provider that fails falls back');
    // Back to the usual roleplay connection, so the fallback has somewhere to go.
    await L.setupApi(page);
    page.allowErrors(/Sidecar|5099|ECONNREFUSED|500|failed/i);
    await page.evaluate(() => { SillyTavern.getContext().extensionSettings.privateScenes.sidecarCustomUrl = 'http://127.0.0.1:5099/v1'; });
    const before = L.requests().length;
    await L.run(page, '/memory-save at=0-3');
    await page.waitForTimeout(800);
    check('falls back to the roleplay connection', L.requests().slice(before).some(r => L.kindOf(r) === 'story-summary'));
    check('with a warning', (await L.toasts(page)).some(t => /sidecar/i.test(t)), await L.toasts(page));
    await page.evaluate(() => SillyTavern.getContext().saveSettingsDebounced());
    await page.waitForTimeout(2500); // let the restored connection save before the browser closes

});

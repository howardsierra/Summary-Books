// Phone (iPhone 13 emulation): everything works by tap and tap targets are >= 40px.
const L = require('../lib');
const { check, eq, section } = L;
const OURS = '.ps-group-head, .private-scenes-settings .checkbox_label, .ps-radio-body, .ps-btn, .ps-bar-button, .ps-tab, .ps-chip-toggle .ps-chip, .ps-kchip.ps-clickable, .ps-link, .ps-list-check, .ps-advanced > summary, .ps-resolved > summary, .ps-cell.ps-clickable';
const targets = async (page, where) => { const small = await L.smallTargets(page, OURS); check(`${where}: tap targets >= 40px`, !small.length, small); };

L.suite('touch', async (page) => {
    await L.start(page, { leakCheck: true });
    await L.send(page, '@time Day 2, evening: @place the palace hall: Bob greets everyone in the hall.');

    section('visibility picker by tap');
    await page.locator('#chat .mes[mesid="1"] .extraMesButtonsHint').tap();
    await page.locator('#chat .mes[mesid="1"] .ps_toggle').tap();
    await page.locator('dialog[open] [data-action="visibility"]').tap();
    await page.waitForSelector('.ps-modes');
    await targets(page, 'visibility popup');
    await page.locator('.ps-mode-private').tap();
    await page.waitForSelector('.ps-chip-grid');
    await page.fill('.ps-add-row input', 'Ana, Kael, Bob');
    await page.locator('.ps-add-row .menu_button').tap();
    await page.waitForTimeout(300);
    await targets(page, 'name picker');
    await page.locator('dialog[open] .popup-button-ok').last().tap();
    await page.waitForTimeout(500);
    eq('flag set by taps', await page.evaluate(() => SillyTavern.getContext().chat[1].extra?.private_scene?.members), ['Ana', 'Kael', 'Bob']);
    await L.run(page, '/public at=1');

    section('scene bar by tap');
    await L.run(page, '/private-scene Ana, Kael');
    await L.send(page, 'Ana pulls Kael aside: "I stole the royal seal."');
    await targets(page, 'scene bar');
    await page.locator('#ps_scene_bar .ps-scene-end').tap();
    await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.timeline).length > 0, null, { timeout: 30000 });
    check('scene ended by tap', await page.evaluate(() => !document.querySelector('#ps_scene_bar.ps-visible')));

    section('leak banner by tap');
    await L.send(page, 'LEAKME Bob approaches Ana.');
    await page.waitForSelector('.ps-leak', { timeout: 30000 });
    await targets(page, 'leak banner');
    await page.locator('.ps-leak-dismiss').tap();
    await page.waitForTimeout(400);
    check('leak dismissed by tap', (await page.locator('.ps-leak').count()) === 0);

    section('story memory by tap');
    await L.run(page, '/thread Bob promised to find the missing guard');
    await L.run(page, '/memory-save');
    await L.run(page, '/memory timeline');
    await page.waitForSelector('.ps-memory');
    await page.waitForTimeout(400);
    await targets(page, 'timeline tab');
    for (const name of ['Characters', 'Threads', 'Knowledge', 'Secrets']) {
        await page.locator(`.ps-tab:has-text("${name}")`).tap();
        await page.waitForTimeout(400);
        await targets(page, `${name} tab`);
    }
    await page.locator('.ps-kchip-unknown').first().tap();
    await page.waitForTimeout(600);
    check('reveal by tapping a chip', await page.evaluate(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.reveals).length === 1));
    await page.locator('.ps-tab:has-text("Threads")').tap();
    await page.waitForTimeout(300);
    await page.locator('.ps-list-check').first().tap();
    await page.waitForTimeout(600);
    check('thread resolved by tap', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.threads.some(t => t.status === 'resolved')));
    await page.locator('dialog[open] .popup-button-ok:visible').last().tap();
    await page.waitForTimeout(400);

    section('settings by tap');
    await page.tap('#extensions-settings-button .drawer-toggle');
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('.private-scenes-settings .inline-drawer-toggle').click());
    await page.waitForTimeout(500);
    await page.locator('.ps-group[data-group="prompts"] > summary').tap();
    await page.locator('.ps-group[data-group="leak"] > summary').tap();
    await page.waitForTimeout(300);
    eq('groups open by tap', await page.evaluate(() => ['prompts', 'leak'].map(id => document.querySelector(`.ps-group[data-group="${id}"]`).open)), [true, true]);
    const before = await page.evaluate(() => document.querySelector('#ps_leak_regen').checked);
    await page.locator('#ps_leak_regen').tap();
    check('switch toggles by tap', (await page.evaluate(() => document.querySelector('#ps_leak_regen').checked)) !== before);
    await page.locator('#ps_leak_regen').tap();
    await targets(page, 'settings');
    eq('inputs are 16px (no iOS zoom)', await page.evaluate(() => getComputedStyle(document.querySelector('#ps_prompt_summaryPrompt')).fontSize), '16px');
}, { ...L.devices['iPhone 13'] });

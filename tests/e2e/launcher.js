// The wand-menu launcher and the per-message action sheet.
const L = require('../lib');
const { check, eq, section } = L;
const SHEET = 'dialog[open] .ps-tile, dialog[open] .ps-action, dialog[open] .ps-window-close';

(async () => {
    for (const [name, opts, touch] of [
        ['desktop', { viewport: { width: 1400, height: 950 } }, false],
        ['ipad', L.devices['iPad (gen 7)'], true],
        ['iphone', L.devices['iPhone 13'], true],
    ]) {
        await L.suite(`launcher: ${name}`, async (page) => {
            const act = (loc) => touch ? loc.tap() : loc.click();
            const openLauncher = async () => {
                await act(page.locator('#extensionsMenuButton'));
                await page.waitForTimeout(300);
                await act(page.locator('#ps_wand_open'));
                await page.waitForSelector('dialog[open] .ps-launcher');
                await page.waitForTimeout(300);
            };
            await L.start(page);
            await L.send(page, 'Bob greets everyone in the hall.');
            await L.run(page, '/thread Bob promised to find the missing guard');
            await L.run(page, '/private-scene Ana, Kael');
            await page.waitForTimeout(800);

            section('launcher');
            await act(page.locator('#extensionsMenuButton'));
            await page.waitForTimeout(300);
            eq('one wand item', (await page.evaluate(() => [...document.querySelectorAll('#extensionsMenu [id^="ps_wand"]')].length)), 1);
            await act(page.locator('#ps_wand_open'));
            await page.waitForSelector('dialog[open] .ps-launcher');
            await page.waitForTimeout(300);
            check('has tiles', (await page.locator('dialog[open] .ps-tile').count()) >= 6);
            if (touch) { const small = await L.smallTargets(page, SHEET); check('tap targets >= 40px', !small.length, small); }
            await L.shot(page, `launcher-${name}`);
            await act(page.locator('dialog[open] .ps-tile[data-action="memory"]'));
            check('memory tile opens Story Memory', !!(await page.waitForSelector('dialog[open] .ps-memory', { timeout: 5000 }).catch(() => null)));
            await act(page.locator('dialog[open] .ps-banner .ps-window-close'));
            await page.waitForTimeout(400);

            await L.run(page, '/private-end');
            await page.waitForTimeout(800);
            const before = (await L.state(page)).memories.length;
            await openLauncher();
            await act(page.locator('dialog[open] .ps-tile[data-action="summarize"]'));
            await page.waitForSelector('dialog[open] .ps-summarize-sheet');
            await page.waitForTimeout(300);
            if (touch) { const small = await L.smallTargets(page, SHEET); check('summarize sheet: tap targets >= 40px', !small.length, small); }
            await act(page.locator('dialog[open] .ps-action[data-action="new"]'));
            check('summarize tile → sheet → saves a memory', await page.waitForFunction((n) => SillyTavern.getContext().chatMetadata.privateScenes.memories.length > n, before, { timeout: 20000 }).then(() => true, () => false));

            await openLauncher();
            await act(page.locator('dialog[open] .ps-tile[data-action="scene"]'));
            check('scene tile opens the name picker', !!(await page.waitForSelector('dialog[open] .ps-chip-grid', { timeout: 5000 }).catch(() => null)));
            await page.locator('dialog[open] .popup-button-cancel').last().click();
            await page.waitForTimeout(400);

            section('message sheet');
            await act(page.locator('#chat .mes[mesid="1"] .extraMesButtonsHint'));
            await act(page.locator('#chat .mes[mesid="1"] .ps_toggle'));
            await page.waitForSelector('dialog[open] .ps-message-sheet');
            await page.waitForTimeout(400);
            // Message 1 was just summarized above, so its sheet offers "summarize again".
            check('has visibility, pin and summarize-again rows', (await Promise.all(['visibility', 'pin', 'resummarize'].map(a => page.locator(`dialog[open] .ps-action[data-action="${a}"]`).count()))).every(n => n === 1));
            if (touch) { const small = await L.smallTargets(page, SHEET); check('tap targets >= 40px', !small.length, small); }
            await act(page.locator('dialog[open] .ps-action[data-action="pin"]'));
            const pin = page.locator('dialog[open] textarea.popup-input').last();
            await pin.waitFor();
            await pin.fill('Bob is the hall steward.');
            await page.locator('dialog[open] .popup-button-ok').last().click();
            await page.waitForTimeout(600);
            eq('pin row pins a fact', (await L.state(page)).facts.map(f => f.text), ['Bob is the hall steward.']);
        }, opts);
    }
})();

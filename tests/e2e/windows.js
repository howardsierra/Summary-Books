// Settings and Story Memory windows on desktop, iPad (both ways) and iPhone.
const L = require('../lib');
const { check, section } = L;
const IN_DIALOG = 'dialog[open] .ps-group-head, dialog[open] .checkbox_label, dialog[open] .ps-btn, dialog[open] .ps-window-close, dialog[open] .ps-tab, dialog[open] .ps-radio-body';
const box = (page) => page.evaluate(() => { const r = [...document.querySelectorAll('dialog[open]')].at(-1).getBoundingClientRect(); return { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; });

(async () => {
    for (const [name, opts, touch] of [
        ['desktop', { viewport: { width: 1400, height: 950 } }, false],
        ['ipad', L.devices['iPad (gen 7)'], true],
        ['ipad-landscape', L.devices['iPad (gen 7) landscape'], true],
        ['iphone', L.devices['iPhone 13'], true],
    ]) {
        await L.suite(`windows: ${name}`, async (page) => {
            const act = (loc) => touch ? loc.tap() : loc.click();
            const launch = async (tile) => {
                await act(page.locator('#extensionsMenuButton'));
                await page.waitForTimeout(400);
                await act(page.locator('#ps_wand_open'));
                await page.waitForSelector('dialog[open] .ps-launcher');
                await act(page.locator(`dialog[open] .ps-tile[data-action="${tile}"]`));
            };
            await L.start(page);
            await L.send(page, '@scene Ana, Kael: Ana whispers: "I stole the royal seal."');
            await L.run(page, '/private-end');
            await L.run(page, '/thread Bob promised to find the missing guard');
            await page.waitForTimeout(1500);

            section('settings window');
            await launch('settings');
            await page.waitForSelector('dialog[open] .ps-settings-window');
            await page.waitForTimeout(600);
            await L.openGroup(page, 'leak');
            await L.openGroup(page, 'sidecar');
            const b = await box(page);
            if (name === 'iphone') check('full screen on a phone', b.w >= b.vw - 2 && b.h >= b.vh - 2, b);
            else check('fits the screen', b.w <= b.vw && b.h <= b.vh, b);
            if (touch) { const small = await L.smallTargets(page, IN_DIALOG); check('tap targets >= 40px', !small.length, small); }
            await L.shot(page, `windows-${name}-settings`);
            const before = await page.evaluate(() => document.querySelector('#ps_leak_regen').checked);
            await act(page.locator('dialog[open] #ps_leak_regen'));
            await act(page.locator('dialog[open] .ps-settings-window .ps-window-close'));
            await page.waitForTimeout(700);
            check('closes', await page.evaluate(() => !document.querySelector('dialog[open] .ps-settings-window')));
            check('controls go back to the extension panel', await page.evaluate(() => !!document.querySelector('.private-scenes-settings .inline-drawer-content #ps_leak_regen')));
            check('changed switch is kept', (await page.evaluate(() => document.querySelector('#ps_leak_regen').checked)) !== before);
            await page.evaluate(() => document.querySelector('#ps_leak_regen').click());
            await L.run(page, '/private-settings');
            check('/private-settings opens it', !!(await page.waitForSelector('dialog[open] .ps-settings-window', { timeout: 5000 }).catch(() => null)));
            await L.closeAll(page);

            section('story memory window');
            await launch('memory');
            await page.waitForSelector('dialog[open] .ps-memory');
            await page.waitForTimeout(600);
            if (touch) { const small = await L.smallTargets(page, IN_DIALOG); check('tap targets >= 40px', !small.length, small); }
            await L.shot(page, `windows-${name}-memory`);
            await act(page.locator('dialog[open] .ps-banner .ps-window-close'));
            await page.waitForTimeout(500);
            check('closes with ✕', await page.evaluate(() => !document.querySelector('dialog[open] .ps-memory')));
        }, opts);
    }
})();

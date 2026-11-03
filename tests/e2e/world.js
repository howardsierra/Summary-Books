// Common knowledge: news, rumors, announcements known by everyone.
const L = require('../lib');
const { check, eq, section } = L;

L.suite('world', async (page) => {
    await L.start(page);
    const marks = () => page.evaluate(() => SillyTavern.getContext().chat.map(m => m.extra?.ps_common?.kind ?? (m.extra?.private_scene ? 'private' : '-')).join(' '));
    const worldEntry = () => page.evaluate(async () => { const c = SillyTavern.getContext(); const d = await c.loadWorldInfo(c.chatMetadata.world_info); const e = Object.values(d.entries).find(x => x.comment.includes('World knowledge')); return e ? { constant: e.constant, content: e.content } : null; });
    const openVisibility = async (id) => {
        await page.locator(`#chat .mes[mesid="${id}"] .extraMesButtonsHint`).click();
        await page.locator(`#chat .mes[mesid="${id}"] .ps_toggle`).click();
        await page.locator('dialog[open] [data-action="visibility"]').click();
        await page.waitForSelector('.ps-modes');
    };

    section('message → Everyone → News');
    await L.send(page, 'BREAKING: Ana spotted leaving the palace at midnight, sources say.');
    await openVisibility(1);
    await page.locator('.ps-mode-common').click();
    await page.locator('.ps-kind:has-text("News")').click();
    await page.locator('dialog[open] .popup-button-ok').last().click();
    await page.waitForFunction(() => SillyTavern.getContext().chatMetadata.privateScenes.world?.length === 1, null, { timeout: 20000 });
    await page.waitForTimeout(800);
    eq('marks', await marks(), '- news -');
    eq('condensed into world knowledge', (await L.state(page)).world.map(w => `${w.kind}: ${w.text}`), ['news: The Daily Star reports that Ana was seen leaving the palace at midnight.']);

    section('@rumor tag');
    await L.send(page, '@rumor: Word around the tavern is that Kael lost his estate at cards.');
    await page.waitForTimeout(1500);
    eq('marks', await marks(), '- news - rumor -');
    const entry = await worldEntry();
    check('world entry is always on and has both', entry?.constant && /palace/.test(entry.content) && /estate/.test(entry.content), entry);

    section('prompt');
    await L.send(page, 'Bob walks in from the stables.');
    const prompt = JSON.stringify(L.chatPrompt());
    check('common messages are labelled in the prompt', /NEWS|COMMON|RUMOR/.test(prompt));

    section('@news inside a private scene stays common');
    await L.run(page, '/private-scene Ana, Kael');
    await L.send(page, '@news: The coronation has been moved to dawn.');
    await page.waitForTimeout(1200);
    check('the @news message is news, its reply private', (await marks()).endsWith('news private'), await marks());
    await L.run(page, '/private-end');
    await page.waitForTimeout(1500);

    section('news made private leaves world knowledge');
    const newsBefore = (await L.state(page)).world.filter(w => w.kind === 'news').length;
    await openVisibility(1);
    eq('popup opens on the current choice', await page.locator('.ps-modes input:checked').inputValue(), 'common');
    await page.locator('.ps-mode-private').click();
    await page.fill('.ps-panel-private .ps-add-row input', 'Ana');
    await page.locator('.ps-panel-private .ps-add-row .menu_button').click();
    await page.locator('dialog[open] .popup-button-ok').last().click();
    await page.waitForTimeout(1000);
    check('message 1 is private now', (await marks()).startsWith('- private'), await marks());
    eq('its world item is gone', (await L.state(page)).world.filter(w => w.kind === 'news').length, newsBefore - 1);

    section('edited common message is flagged');
    await page.evaluate(async () => { const c = SillyTavern.getContext(); const i = c.chat.findIndex(m => m.extra?.ps_common?.kind === 'rumor'); c.chat[i].mes += ' (corrected)'; await c.eventSource.emit(c.eventTypes.MESSAGE_EDITED, i); });
    await L.run(page, '/memory facts');
    await page.waitForSelector('.ps-world-item');
    await page.waitForTimeout(500);
    check('knowledge tab warns about the edit', (await page.locator('.ps-world-status.ps-warn-text').count()) >= 1);
    await L.closeAll(page);

    section('commands');
    await L.run(page, '/common kind=announcement at=4');
    await page.waitForTimeout(1200);
    check('/common marks an announcement', (await marks()).split(' ')[4] === 'announcement', await marks());
    await L.run(page, '/public at=4');
    await page.waitForTimeout(800);
    check('/public clears it', (await marks()).split(' ')[4] === '-' && !(await L.state(page)).world.some(w => w.kind === 'announcement'));
});

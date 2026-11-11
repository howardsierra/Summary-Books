// Forced summaries (redo, save secrets now, rebuild) and forcing a lorebook of this chat's own.
const L = require('../lib');
const { check, eq, section } = L;
const mems = (page) => page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.memories.map(m => `L${m.level ?? 0} ${m.from}-${m.to}`));
const openSummarize = async (page) => {
    await page.locator('#extensionsMenuButton').click();
    await page.waitForTimeout(300);
    await page.locator('#ps_wand_open').click();
    await page.waitForSelector('dialog[open] .ps-launcher');
    await page.locator('dialog[open] .ps-tile[data-action="summarize"]').click();
    await page.waitForSelector('dialog[open] .ps-summarize-sheet');
    await page.waitForTimeout(300);
};
const okPopup = async (page, text) => {
    if (text !== undefined) {
        const input = page.locator('dialog[open] .popup-input').last();
        await input.waitFor();
        await input.fill(text);
    }
    await page.locator('dialog[open] .popup-button-ok').last().click();
};

L.suite('force', async (page) => {
    await L.start(page, { autoSheets: false, memoryEvery: 4, consolidate: false });
    for (const text of ['Bob greets everyone.', 'Ana curtsies.', 'Kael bows.']) await L.send(page, text); // 1-6
    await L.run(page, '/memory-save');
    eq('one story entry', await mems(page), ['L0 0-6']);

    section('summarize tile when up to date');
    await openSummarize(page);
    check('tile opens the sheet even when up to date', true);
    const rows = await page.locator('dialog[open] .ps-action').evaluateAll(els => els.map(e => `${e.dataset.action}${e.classList.contains('disabled') ? ':off' : ''}`));
    eq('rows', rows, ['everything:off', 'new:off', 'secrets:off', 'redo', 'rebuild', 'own-copy', 'own-fresh']);
    await L.shot(page, 'force-sheet');

    section('redo a range');
    const before = L.requests().filter(r => L.kindOf(r) === 'story-summary').length;
    await page.locator('dialog[open] .ps-action[data-action="redo"]').click();
    await okPopup(page, '2-3');
    await page.waitForFunction((n) => SillyTavern.getContext().chatMetadata.privateScenes.memories.length === 1 && n, before, { timeout: 20000 });
    await page.waitForTimeout(1500);
    eq('the whole overlapping entry is redone, not split', await mems(page), ['L0 0-6']);
    check('a new summary request was made', L.requests().filter(r => L.kindOf(r) === 'story-summary').length === before + 1);

    section('redo a long stretch in parts');
    for (const text of ['Bob checks the doors.', 'Ana sips wine.', 'Kael yawns.', 'Bob counts guards.', 'Ana leaves.']) await L.send(page, text); // 7-16
    await L.run(page, '/memory-redo');
    await page.waitForTimeout(1000);
    const parts = await mems(page);
    check('split into several entries covering the whole chat', parts.length >= 3 && parts[0].startsWith('L0 0-') && parts.at(-1).endsWith('-16'), parts);
    eq('cursor at the end', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.memoryCursor), 17);

    section('message sheet: summarize this part again');
    await page.locator('#chat .mes[mesid="2"] .extraMesButtonsHint').click();
    await page.locator('#chat .mes[mesid="2"] .ps_toggle').click();
    await page.waitForSelector('dialog[open] .ps-message-sheet');
    check('saved message offers "summarize again"', await page.locator('dialog[open] .ps-action[data-action="resummarize"]').count() === 1);
    await page.locator('dialog[open] .ps-action[data-action="resummarize"]').click();
    await page.waitForTimeout(1500);
    eq('same entries after redoing one', (await mems(page)).length, parts.length);

    section('save secrets now, while a scene is running');
    await L.run(page, '/private-scene Ana, Kael');
    await L.send(page, 'Ana whispers: "I stole the royal seal."');
    await openSummarize(page);
    check('secrets row counts the running scene', /running scene/.test(await page.locator('dialog[open] .ps-action[data-action="secrets"]').innerText()));
    await page.locator('dialog[open] .ps-action[data-action="secrets"]').click();
    await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.timeline).length === 1, null, { timeout: 20000 });
    check('scene still running after saving', await page.evaluate(() => !!SillyTavern.getContext().chatMetadata.privateScenes.scene));
    await L.run(page, '/private-end');
    await page.waitForTimeout(1500);

    section('summarize everything new');
    await L.send(page, 'Bob opens the gates.');
    await L.run(page, '/private-scene Bob, Kael');
    await L.send(page, 'Bob tells Kael the gate code.');
    await L.run(page, '/private-end');
    await page.waitForTimeout(500);
    await L.configure(page, { autoSave: false });
    await L.run(page, '/private-scene Ana, Bob');
    await L.send(page, 'Ana hands Bob a key.');
    await openSummarize(page);
    check('row names both kinds', /messages .*\+ .*secret/.test(await page.locator('dialog[open] .ps-action[data-action="everything"]').innerText()));
    const cursor = await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.memoryCursor);
    await page.locator('dialog[open] .ps-action[data-action="everything"]').click();
    await page.waitForFunction((c) => SillyTavern.getContext().chatMetadata.privateScenes.memoryCursor > c, cursor, { timeout: 30000 });
    await page.waitForTimeout(1000);
    eq('nothing left unsaved', await page.evaluate(async () => (await import('/scripts/extensions/third-party/private-scenes/src/lorebook.js')).unsavedScenes().length), 0);
    eq('story caught up', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.memoryCursor), await page.evaluate(() => SillyTavern.getContext().chat.length));
    await L.run(page, '/private-end');
    await L.configure(page, { autoSave: true });

    section('rebuild');
    const secretsBefore = L.requests().filter(r => L.kindOf(r) === 'secret-summary').length;
    await L.run(page, '/memory-rebuild');
    await page.waitForTimeout(1000);
    check('every secret summarized again', L.requests().filter(r => L.kindOf(r) === 'secret-summary').length > secretsBefore);
    check('story rebuilt from message 0', (await mems(page))[0]?.startsWith('L0 0-'), await mems(page));

    section('a lorebook linked by hand counts as empty');
    const handBook = 'Linked by hand ' + Date.now();
    await page.evaluate(async (b) => { const c = SillyTavern.getContext(); await c.saveWorldInfo(b, { entries: {} }, true); await c.updateWorldInfoList(); c.chatMetadata.world_info = b; await c.saveMetadata(); }, handBook);
    await openSummarize(page);
    const everything = await page.locator('dialog[open] .ps-action[data-action="everything"]');
    check('"Summarize everything new" is offered', !(await everything.getAttribute('class')).includes('disabled'), await everything.innerText());
    const oldEntriesKept = await page.evaluate(async () => { const c = SillyTavern.getContext(); const s = c.chatMetadata.privateScenes; return s.memories[0]?.book; });
    await page.evaluate(() => toastr.remove());
    await everything.click();
    await page.waitForFunction(() => [...document.querySelectorAll('#toast-container .toast-success')].some(t => /Saved \d+ secrets? and \d+ story/.test(t.innerText)), null, { timeout: 60000 });
    await page.waitForTimeout(500);
    const handBooks = await page.evaluate(() => { const set = new Set(); JSON.stringify(SillyTavern.getContext().chatMetadata.privateScenes, (k, v) => { if (k === 'book' && v) set.add(v); return v; }); return [...set]; });
    eq('every record now points at the new lorebook', handBooks, [handBook]);
    const filled = (await L.book(page)).map(e => e.comment);
    check('the new lorebook gets the secrets and the story', filled.some(c => /Private/.test(c)) && filled.some(c => /Story|Chapter/.test(c)), filled);
    check('the old lorebook keeps its entries', (await page.evaluate(async (b) => Object.keys((await SillyTavern.getContext().loadWorldInfo(b))?.entries ?? {}).length, oldEntriesKept)) > 0);

    section('own copy of the lorebook');
    const oldBook = await page.evaluate(() => SillyTavern.getContext().chatMetadata.world_info);
    const oldEntries = (await L.book(page)).map(e => e.comment).sort();
    const name = await L.run(page, '/private-own-book');
    const now = await page.evaluate(() => { const c = SillyTavern.getContext(); return { book: c.chatMetadata.world_info, owner: c.chatMetadata.privateScenes.bookOwner, chatId: c.chatId }; });
    check('switched to a new lorebook', now.book === name && name !== oldBook, { name, oldBook });
    eq('owned by this chat', now.owner, now.chatId);
    eq('same entries in the copy', (await L.book(page)).map(e => e.comment).sort(), oldEntries);
    const books = await page.evaluate(() => { const set = new Set(); JSON.stringify(SillyTavern.getContext().chatMetadata.privateScenes, (k, v) => { if (k === 'book' && v) set.add(v); return v; }); return [...set]; });
    eq('records point at the copy', books, [name]);

    section('start over with an empty lorebook');
    await openSummarize(page);
    await page.locator('dialog[open] .ps-action[data-action="own-fresh"]').click();
    await okPopup(page);
    await page.waitForFunction((b) => SillyTavern.getContext().chatMetadata.world_info !== b, name, { timeout: 15000 });
    await page.waitForTimeout(800);
    const fresh = await page.evaluate(() => { const s = SillyTavern.getContext().chatMetadata.privateScenes; return { memories: s.memories.length, secrets: Object.keys(s.timeline).length, cursor: s.memoryCursor, flagged: SillyTavern.getContext().chat.filter(m => m.extra?.private_scene).length }; });
    eq('memories forgotten, flags kept', fresh, { memories: 0, secrets: 0, cursor: 0, flagged: 6 });
    eq('new lorebook is empty', (await L.book(page)).length, 0);
    check('previous lorebook still exists', await page.evaluate((b) => SillyTavern.getContext().getWorldInfoNames().includes(b), name));
});

// Story clock, threads, character sheets, chapters, pins, rewind safety, review queue.
const L = require('../lib');
const { check, eq, section } = L;
const pick = (clock) => ({ time: clock?.time, place: clock?.place });

L.suite('memory', async (page) => {
    await L.start(page, { consolidate: true, consolidateEvery: 2, consolidateKeep: 0 });

    section('clock tags');
    await L.send(page, '@time Day 2, afternoon: @place the palace hall: Bob greets everyone in the hall.');
    const first = await page.evaluate(() => SillyTavern.getContext().chat[1].mes);
    eq('tags removed from the text', first, 'Bob greets everyone in the hall.');
    eq('clock set from tags', pick((await L.state(page)).clock), { time: 'Day 2, afternoon', place: 'the palace hall' });
    check('clock is in the prompt', /\[Story time: Day 2, afternoon/.test(JSON.stringify(L.chatPrompt())));

    section('memory → threads, sheets, clock');
    await L.send(page, 'Bob promises to find the missing guard.');
    await L.run(page, '/memory-save');
    let s = await L.state(page);
    eq('thread opened', s.threads.map(t => `${t.status}:${t.text}`), ['open:Bob promised to find the missing guard']);
    eq('clock moved by the summary', pick(s.clock), { time: 'Day 2, evening', place: 'the palace hall' });
    check('sheets written for Bob and Ana', s.sheets.bob?.state && s.sheets.ana?.state, Object.keys(s.sheets));

    section('second memory → resolves, relationship history, chapter');
    await L.send(page, 'Bob searches the stables.');
    await L.run(page, '/memory-save');
    s = await L.state(page);
    eq('first thread resolved, new one opened', s.threads.map(t => t.status).sort(), ['open', 'resolved']);
    check('relationship keeps its history', s.sheets.bob.rels.ana.history?.[0]?.text === 'friendly acquaintance' && s.sheets.bob.rels.ana.text === 'suspicious of her', s.sheets.bob.rels.ana);
    eq('two memories merged into a chapter', s.memories.map(m => `L${m.level} parts=${m.parts?.length ?? 0}`), ['L1 parts=2']);
    check('chapter entry in the lorebook', (await L.book(page)).some(e => /Chapter/.test(e.comment)));

    section('pin from a message');
    await page.locator('#chat .mes[mesid="1"] .extraMesButtonsHint').click();
    await page.locator('#chat .mes[mesid="1"] .ps_toggle').click();
    await page.locator('dialog[open] [data-action="pin"]').click();
    const pinInput = page.locator('dialog[open] textarea.popup-input').last();
    await pinInput.waitFor();
    await pinInput.fill('Bob is the hall steward.');
    await page.locator('dialog[open] .popup-button-ok').last().click();
    await page.waitForTimeout(800);
    eq('fact pinned', (await L.state(page)).facts.map(f => f.text), ['Bob is the hall steward.']);

    section('private scene → private thread');
    await L.send(page, '@scene Ana, Kael: Ana pulls Kael aside: "I stole the royal seal."');
    await L.send(page, '@endscene The music resumes.');
    await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.timeline).length > 0, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const threads = (await L.book(page)).find(e => e.comment.includes('Open threads'))?.content ?? '';
    check('scene thread is grouped under its knowers', /Ana and Kael/.test(threads) && /keep the seal secret/.test(threads), threads);
    await L.send(page, 'Bob asks Ana about the stables.');
    const prompt = JSON.stringify(L.chatPrompt());
    check('prompt has facts, threads, sheet and clock', ['Bob is the hall steward', 'Someone drugged the guard', 'Bob — current state', 'Story time'].every(x => prompt.includes(x)));

    section('memory window tabs');
    await L.run(page, '/memory timeline');
    await page.waitForSelector('.ps-memory .ps-timeline');
    for (const t of ['Characters', 'Threads', 'Knowledge', 'Secrets']) {
        await page.locator(`.ps-tab:has-text("${t}")`).click();
        await page.waitForTimeout(300);
    }
    check('tabs switch', await page.locator('.ps-tab.active, .ps-tab[aria-selected="true"]').innerText().then(t => /Secrets/.test(t)).catch(() => false));
    await L.closeAll(page);

    section('rewind: delete + edit');
    await L.run(page, '/cut 2');
    await page.waitForTimeout(800);
    await page.evaluate(async () => { const c = SillyTavern.getContext(); const i = c.chat.findIndex(m => m.extra?.private_scene); c.chat[i].mes += ' (edited)'; await c.eventSource.emit(c.eventTypes.MESSAGE_EDITED, i); });
    await page.waitForTimeout(800);
    check('stale toast shown', (await L.toasts(page)).some(t => /changed|out of date|edited|deleted/i.test(t)), await L.toasts(page));
    await L.run(page, '/memory timeline');
    await page.waitForSelector('.ps-notice-warn');
    const stale = await page.locator('.ps-status-stale').count();
    check('stale records marked', stale >= 1, stale);
    await page.locator('.ps-act-keep').first().click();
    await page.waitForTimeout(600);
    check('"keep as is" clears one', (await page.locator('.ps-status-stale').count()) === stale - 1);

    section('split chapter');
    await page.locator('.ps-card-more').filter({ has: page.locator('.ps-act-split') }).first().locator('summary').click();
    await page.locator('.ps-act-split').first().click();
    await page.waitForTimeout(1000);
    eq('chapter split back into parts', (await L.state(page)).memories.map(m => `L${m.level}`), ['L0', 'L0']);
    await L.closeAll(page);

    section('review queue');
    await L.configure(page, { reviewBeforeSave: true, consolidate: false });
    await L.send(page, 'The guards change shifts.');
    await L.run(page, '/memory-save');
    s = await L.state(page);
    eq('memory waits as a draft', s.drafts.map(d => d.kind), ['memory']);
    await L.run(page, '/memory timeline');
    await page.waitForSelector('.ps-draft');
    await page.locator('.ps-draft .ps-act-approve').click();
    await page.waitForFunction(() => SillyTavern.getContext().chatMetadata.privateScenes.drafts.length === 0, null, { timeout: 20000 });
    eq('approved draft becomes a memory', (await L.state(page)).memories.length, 3);
    await L.closeAll(page);
});

// Private scenes, inline tags, keywords, leak checker, reveals, who-knows grid, story memory.
const L = require('../lib');
const { check, eq, section } = L;

L.suite('core', async (page) => {
    await L.start(page, { leakCheck: true, consolidate: true, consolidateEvery: 5, consolidateKeep: 3 });
    const idle = () => page.waitForFunction(() => !document.querySelector('.ps-checking') && !document.querySelector('.ps-status-saving'), null, { timeout: 30000 });
    const flags = () => page.evaluate(() => SillyTavern.getContext().chat.map(m => m.extra?.private_scene?.members?.join('+') ?? '-'));
    await L.send(page, 'Bob greets everyone in the hall.');

    section('inline tags');
    await L.send(page, '@scene Ana, Kael: Ana pulls Kael behind a pillar: "I stole the royal seal."');
    await L.send(page, 'Kael swears to keep her secret until the coronation.');
    await L.send(page, '@endscene The music resumes in the hall.');
    await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes?.timeline ?? {}).length > 0, null, { timeout: 30000 });
    check('tags are stripped from the message', await page.evaluate(() => !/@scene|@endscene/.test(SillyTavern.getContext().chat.map(m => m.mes).join(' '))));
    await L.send(page, '@private Ana, Bob: Ana slips Bob a note about the guards.');
    const pending = L.chatPrompt();
    check('the reply to an @private message is generated as private', /PRIVATE — known only to: Ana and Bob/.test(JSON.stringify(pending)));
    await idle();
    eq('flags per message', await flags(), ['-', '-', '-', 'Ana+Kael', 'Ana+Kael', 'Ana+Kael', 'Ana+Kael', '-', '-', 'Ana+Bob', 'Ana+Bob']);

    section('lorebook entry with keywords');
    const scene = (await L.book(page)).find(e => e.comment.includes('Ana and Kael'));
    check('scene entry was written', !!scene);
    check('entry content is the summary', /stole the royal seal/.test(scene?.content ?? ''), scene?.content);
    check('entry keys include names and keywords', ['Ana', 'Kael', 'royal seal'].every(k => scene?.key.includes(k)), scene?.key);

    section('leak checker');
    await L.send(page, 'LEAKME Bob approaches Ana.');
    await page.waitForSelector('.ps-leak', { timeout: 30000 });
    check('leak banner names the secret', /royal seal/.test(await page.locator('.ps-leak').innerText()));
    await page.click('.ps-leak-regen');
    await page.waitForFunction(() => SillyTavern.getContext().chat.at(-1).swipes?.length === 2, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    await idle();
    const after = await page.evaluate(() => { const m = SillyTavern.getContext().chat.at(-1); return { mes: m.mes, leak: m.extra?.ps_leak?.leak, banners: document.querySelectorAll('.ps-leak').length }; });
    check('regenerate makes a clean swipe and clears the banner', !/royal seal/.test(after.mes) && !after.leak && after.banners === 0, after);

    section('reveal');
    await L.run(page, '/private-reveal at=3 Bob');
    await page.waitForTimeout(800);
    const revealed = (await L.book(page)).find(e => e.comment.includes('Ana and Kael'));
    check('entry keys gain Bob after the reveal', revealed?.key.includes('Bob'), revealed?.key);
    await L.send(page, 'Later, Bob mentions the royal seal to Kael.');
    check('prompt label mentions the reveal', /known only to: Ana and Kael[^\]]*Bob/.test(JSON.stringify(L.chatPrompt())));

    section('who-knows grid');
    await L.run(page, '/who-knows');
    await page.waitForSelector('.ps-grid');
    await page.waitForTimeout(400);
    await page.locator('.ps-grid .ps-cell-unknown').first().click();
    await page.waitForTimeout(800);
    const reveals = await page.evaluate(() => Object.values(SillyTavern.getContext().chatMetadata.privateScenes.reveals).flat().length);
    check('clicking a grid cell adds a reveal', reveals >= 2, reveals);
    await L.closeAll(page);

    section('story memory');
    const summary = await L.run(page, '/memory-save');
    check('/memory-save returns a summary', !!summary);
    const memReq = L.requests().filter(r => L.kindOf(r) === 'story-summary').at(-1);
    const transcript = memReq?.body.messages.at(-1).content ?? '';
    check('story memory transcript leaves out private messages', transcript && !/stole the royal seal|note about the guards|swears/.test(transcript), transcript.slice(0, 200));
    check('memory entry is in the lorebook', (await L.book(page)).some(e => /Story so far|Story/.test(e.comment) && /coronation/.test(e.content)));
    await L.run(page, '/memory timeline');
    await page.waitForSelector('.ps-timeline');
    check('timeline shows the scene', await page.locator('.ps-timeline').innerText().then(t => /Ana/.test(t)));
    await L.shot(page, 'core-timeline');
    await L.closeAll(page);
});

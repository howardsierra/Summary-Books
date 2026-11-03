// Prompt & budget: token meter, over-budget warning, trimming, last prompt sent.
const L = require('../lib');
const { check, eq, section } = L;
const TAPPABLE = 'dialog[open] .ps-btn, dialog[open] .ps-tab, dialog[open] .ps-window-close, dialog[open] .ps-sent-message > summary';

(async () => {
    await L.suite('budget', async (page) => {
        await L.start(page, { memoryConstant: true, entryConstant: false, memoryBudget: 60, budgetWarn: true });
        await L.send(page, 'Bob greets everyone in the hall.');
        await L.send(page, '@scene Ana, Kael: Ana whispers: "I stole the royal seal."');
        await L.send(page, '@endscene The music resumes.');
        await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.timeline).length === 1, null, { timeout: 30000 });
        await L.run(page, '/pin Bob is the hall steward');
        await L.run(page, '/memory-save');

        section('warning');
        await page.waitForFunction(() => [...document.querySelectorAll('#toast-container .toast-warning')].some(t => /over your budget/.test(t.innerText)), null, { timeout: 15000 })
            .then(() => check('warns once when over budget', true), () => check('warns once when over budget', false));

        section('next reply');
        await L.run(page, '/private-prompt');
        await page.waitForSelector('dialog[open] .ps-budget .ps-meter-card');
        check('meter shows over budget', await page.locator('.ps-meter-card.ps-meter-over').count() === 1);
        const rows = await page.locator('.ps-budget-row').evaluateAll(els => els.map(e => ({ label: e.querySelector('.ps-budget-label').innerText, meta: e.querySelector('.ps-budget-meta').innerText, tokens: Number(e.querySelector('.ps-budget-tokens').innerText.replace(/\D/g, '')) })));
        const find = (re) => rows.find(r => re.test(r.label));
        check('rules row, always', /Always/i.test(find(/Secret-keeping rules/)?.meta ?? ''), rows);
        check('pinned facts, always', /Always/i.test(find(/Pinned facts/)?.meta ?? ''), rows);
        check('story entry, always', /Always/i.test(find(/Story/)?.meta ?? ''), rows);
        check('secret entry, triggered', /When|Triggered/i.test(find(/Private —/)?.meta ?? ''), rows);
        check('every row has a token count', rows.every(r => r.tokens > 0), rows);
        await page.evaluate(() => toastr.clear());
        await page.waitForTimeout(600);
        await L.shot(page, 'budget-next');

        section('trim: story entries only when triggered');
        const before = Number((await page.locator('.ps-meter-value').innerText()).replace(/\D/g, ''));
        await page.locator('.ps-trim-story').click();
        await page.waitForFunction((n) => Number(document.querySelector('.ps-meter-value')?.innerText.replace(/\D/g, '')) < n, before, { timeout: 10000 }).catch(() => {});
        const after = Number((await page.locator('.ps-meter-value').innerText()).replace(/\D/g, ''));
        check('always-on tokens drop', after < before, { before, after });
        const story = (await L.book(page)).find(e => /Story/.test(e.comment));
        check('story entry is no longer constant', story && !story.constant, story);
        eq('setting follows', await page.evaluate(() => SillyTavern.getContext().extensionSettings.privateScenes.memoryConstant), false);
        await L.closeAll(page);

        section('last sent');
        await L.configure(page, { leakCheck: true }); // a background call after the reply must not replace it
        await L.send(page, 'Bob asks Ana about the seal.');
        await page.waitForFunction(() => !document.querySelector('.ps-checking'), null, { timeout: 30000 });
        check('a leak check ran after the reply', L.kindOf(L.requests().at(-1)) === 'leak');
        await L.run(page, '/private-prompt sent');
        await page.waitForSelector('dialog[open] .ps-sent-list');
        const marks = await page.locator('.ps-mark').allInnerTexts();
        check('highlights the private label', marks.some(t => /PRIVATE — known only to/.test(t)), marks.slice(0, 5));
        check('highlights the pinned facts', marks.some(t => /hall steward/.test(t)), marks.slice(0, 5));
        const sent = JSON.stringify(L.chatPrompt());
        check('shows exactly what was sent', marks.every(t => sent.includes(JSON.stringify(t).slice(1, -1))));
        await page.locator('.ps-sent-filter input').check();
        check('filter hides other messages', await page.locator('.ps-sent-message:not(.ps-sent-ours)').evaluateAll(els => els.every(e => !e.offsetParent)));
        await page.evaluate(() => toastr.clear());
        await page.waitForTimeout(600);
        await L.shot(page, 'budget-sent');
        await L.closeAll(page);

        section('launcher tile');
        await page.locator('#extensionsMenuButton').click();
        await page.waitForTimeout(300);
        await page.locator('#ps_wand_open').click();
        await page.waitForSelector('dialog[open] .ps-launcher');
        check('tile shows the token count', /tokens always on/.test(await page.locator('dialog[open] .ps-tile[data-action="budget"]').innerText()));
        await page.locator('dialog[open] .ps-tile[data-action="budget"]').click();
        check('tile opens the window', !!(await page.waitForSelector('dialog[open] .ps-budget', { timeout: 5000 }).catch(() => null)));
    });

    await L.suite('budget: iphone', async (page) => {
        await L.start(page, { memoryConstant: true });
        await L.send(page, '@scene Ana, Kael: Ana whispers: "I stole the royal seal."');
        await L.run(page, '/private-end');
        await L.run(page, '/pin Bob is the hall steward');
        await page.waitForTimeout(1000);
        await L.run(page, '/private-prompt');
        await page.waitForSelector('dialog[open] .ps-budget-row');
        let small = await L.smallTargets(page, TAPPABLE);
        check('next reply: tap targets >= 40px', !small.length, small);
        const box = await page.evaluate(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return r.right <= innerWidth + 1 && document.querySelector('.ps-budget').scrollWidth <= document.querySelector('.ps-budget').clientWidth + 1; });
        check('no sideways scrolling', box);
        await page.evaluate(() => toastr.clear());
        await page.waitForTimeout(600);
        await L.shot(page, 'budget-iphone');
        await page.locator('dialog[open] .ps-tab[data-tab="sent"]').tap();
        await page.waitForSelector('dialog[open] .ps-sent-list');
        small = await L.smallTargets(page, TAPPABLE);
        check('last sent: tap targets >= 40px', !small.length, small);
    }, { ...L.devices['iPhone 13'] });
})();

// Several saves at once must create one lorebook, not several.
const L = require('../lib');
const { eq } = L;

L.suite('race', async (page) => {
    await L.start(page);
    await L.send(page, '@scene Ana, Kael: Ana whispers: "I stole the royal seal."');
    await L.run(page, '/private-end');
    await L.run(page, '/thread Bob promised to find the missing guard');
    await L.run(page, '/pin Ana is left-handed');
    await page.waitForTimeout(2500);
    const result = await page.evaluate(() => {
        const c = SillyTavern.getContext();
        const prefix = `Private Timeline - ${c.chatId}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 60);
        return { books: c.getWorldInfoNames().filter(n => n.startsWith(prefix)).length, toasts: [...document.querySelectorAll('#toast-container .toast')].filter(t => /Created lorebook/.test(t.innerText)).length };
    });
    eq('one lorebook, one toast', result, { books: 1, toasts: 1 });
});

// Branches and checkpoints get their own lorebook, without what came after the split.
const L = require('../lib');
const { check, eq, section } = L;
const info = (page) => page.evaluate(async () => {
    const c = SillyTavern.getContext();
    const s = c.chatMetadata.privateScenes;
    const book = c.chatMetadata.world_info;
    const data = await c.loadWorldInfo(book);
    const books = new Set();
    JSON.stringify(s, (k, v) => { if (k === 'book' && v) books.add(v); return v; });
    return {
        chatId: c.getCurrentChatId(), book, owner: s.bookOwner, entries: Object.values(data?.entries ?? {}).map(e => e.comment).sort(),
        scenes: Object.keys(s.timeline).length, memories: s.memories.length, facts: s.facts.map(f => f.text), threads: s.threads.map(t => `${t.status}:${t.text}`),
        recordBooks: [...books],
    };
});
const entriesOf = (page, book) => page.evaluate(async (b) => Object.values((await SillyTavern.getContext().loadWorldInfo(b))?.entries ?? {}).map(e => e.comment).sort(), book);
const openChat = (page, name) => page.evaluate(async (n) => { await SillyTavern.getContext().openCharacterChat(n); }, name);

L.suite('branches', async (page) => {
    await L.start(page, { autoSheets: false });
    await L.send(page, 'Bob greets everyone in the hall.');                                   // 1, 2
    await L.send(page, '@scene Ana, Kael: Ana whispers: "I stole the royal seal."');          // 3, 4
    await L.send(page, '@endscene The music resumes.');                                       // 5, 6
    await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.timeline).length === 1, null, { timeout: 30000 });
    await L.run(page, '/memory-save at=0-2');
    await L.send(page, '@scene Ana, Bob: Ana hands Bob the guard roster.');                   // 7, 8
    await L.send(page, '@endscene Bob leaves for the stables.');                              // 9, 10
    await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.timeline).length === 2, null, { timeout: 30000 });
    await L.run(page, '/pin at=9 Bob is the hall steward');
    await L.run(page, '/thread Bob must return the roster');
    await L.run(page, '/memory-save at=9-10');
    await page.waitForTimeout(1000);
    const original = await info(page);
    check('original chat owns its lorebook', original.owner === original.chatId && original.book.startsWith('Private Timeline'), original);

    section('branch from message 6');
    await L.run(page, '/branch-create 6');
    await page.waitForFunction((id) => SillyTavern.getContext().getCurrentChatId() !== id, original.chatId, { timeout: 20000 });
    await page.waitForFunction((b) => SillyTavern.getContext().chatMetadata.world_info !== b, original.book, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const branch = await info(page);
    check('the branch got a new lorebook', branch.book && branch.book !== original.book, branch.book);
    eq('the branch owns it', branch.owner, branch.chatId);
    eq('every record points at the new lorebook', branch.recordBooks, [branch.book]);
    eq('secrets: only the one before the split', branch.scenes, 1);
    eq('memories: only the one before the split', branch.memories, 1);
    eq('no pin from after the split', branch.facts, []);
    check('no thread from after the split', !branch.threads.some(t => /roster/.test(t)) && branch.threads.length === 2, branch.threads);
    check('the copy has no entry for the later secret', !branch.entries.some(e => /Ana and Bob/.test(e)), branch.entries);
    check('…but keeps the earlier one', branch.entries.some(e => /Ana and Kael/.test(e)), branch.entries);
    check('a toast explains it', (await L.toasts(page, 'success')).some(t => /branch/i.test(t)));
    eq('the original lorebook is untouched', await entriesOf(page, original.book), original.entries);

    section('saving in the branch only touches its copy');
    await L.run(page, '/pin Ana is left-handed');
    await page.waitForTimeout(800);
    check('branch copy has the pin', (await entriesOf(page, branch.book)).some(e => /Pinned/.test(e)));
    eq('original still unchanged', await entriesOf(page, original.book), original.entries);

    section('back to the original');
    await openChat(page, original.chatId);
    await page.waitForTimeout(2000);
    const back = await info(page);
    eq('original keeps its lorebook and records', [back.book, back.scenes, back.memories], [original.book, 2, 2]);

    section('with the setting off, a branch shares the lorebook');
    await L.configure(page, { branchCopy: false });
    await L.run(page, '/branch-create 6');
    await page.waitForFunction((id) => SillyTavern.getContext().getCurrentChatId() !== id, original.chatId, { timeout: 20000 });
    await page.waitForTimeout(1500);
    eq('shared lorebook', (await info(page)).book, original.book);
});

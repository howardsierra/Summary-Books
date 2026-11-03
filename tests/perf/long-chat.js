// Times the extension's hot paths on a synthetic long chat.
//   node tests/perf/long-chat.js [messages]
// Not a pass/fail suite: prints milliseconds (median of 5 runs). refreshUi
// includes waiting for the next frame (see frameWait).
const L = require('../lib');
const N = Number(process.argv[2] ?? 3000);

(async () => {
    const { browser, page } = await L.open();
    try {
        await L.dismissPopups(page);
        await L.configure(page);
        await L.setupApi(page);
        await L.ensureCharacter(page);
        const result = await page.evaluate(async (N) => {
            const c = SillyTavern.getContext();
            const base = '/scripts/extensions/third-party/private-scenes';
            const core = await import(`${base}/src/core.js`);
            const lore = await import(`${base}/src/lorebook.js`);
            const ui = await import(`${base}/src/ui.js`);
            // Build the chat: a private scene of 6 messages every 40, mids on everything.
            const chat = c.chat;
            chat.length = 0;
            for (let i = 0; i < N; i++) {
                const inScene = i % 40 >= 30 && i % 40 < 36;
                const m = { name: i % 2 ? 'Narrator' : 'User', is_user: i % 2 === 0, mes: `Message ${i}: ${'lorem ipsum dolor sit amet '.repeat(20)}`, extra: { ps_mid: `m_${i}` }, swipes: undefined };
                if (inScene) m.extra.private_scene = { members: ['Ana', 'Kael'], sceneId: `ps_${Math.floor(i / 40)}` };
                chat.push(m);
            }
            const state = core.chatState();
            state.memories = [];
            for (let from = 0; from + 20 <= N; from += 20) {
                const ids = Array.from({ length: 20 }, (_, k) => from + k);
                state.memories.push({ id: `mem_${from}`, level: 0, from, to: from + 19, summary: 'x', ...core.sourcesOf(ids) });
            }
            for (const scene of core.findScenes()) state.timeline[scene.id] = { summary: 'x', members: scene.members, ...core.sourcesOf(scene.ids) };
            await c.printMessages();
            const time = async (fn) => { const runs = []; for (let k = 0; k < 5; k++) { const t = performance.now(); await fn(); runs.push(performance.now() - t); } return +runs.sort((a, b) => a - b)[2].toFixed(1); };
            const coreChat = () => chat.map(m => ({ ...m }));
            return {
                messages: chat.length, memories: state.memories.length, scenes: Object.keys(state.timeline).length, rendered: document.querySelectorAll('#chat .mes').length,
                findScenes: await time(() => core.findScenes()),
                staleItems: await time(() => lore.staleItems()),
                frameWait: await time(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)))),
                refreshUi: await time(() => { ui.refreshUi(); return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); }),
                tenRefreshes: await time(() => { for (let k = 0; k < 10; k++) ui.refreshUi(); return new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); }),
                interceptor: await time(() => globalThis.privateScenesInterceptor(coreChat(), 0, () => {}, 'normal')),
                messageEdited: await time(() => { chat[N - 1].mes += '!'; return c.eventSource.emit(c.eventTypes.MESSAGE_EDITED, N - 1); }),
            };
        }, N);
        console.log(JSON.stringify(result, null, 1));
    } finally {
        await browser.close();
    }
})();

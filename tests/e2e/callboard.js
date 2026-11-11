// Replies in the CALLBOARD preset's format: the story clock follows its tracker
// card, background tasks get plain text, and the API other extensions read.
const L = require('../lib');
const { check, eq, section } = L;

L.suite('callboard', async (page) => {
    await L.start(page, { leakCheck: true, clockEnabled: true, clockAutoTrack: true, clockFromTracker: true, tidyText: true });

    section('a secret to check against');
    await L.send(page, '@scene Ana, Kael: Ana pulls Kael aside: "I stole the royal seal."');
    await L.send(page, '@endscene The music resumes.');
    await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.timeline).length > 0, null, { timeout: 30000 });

    section('a CALLBOARD reply');
    const seen = L.requests().length;
    await L.send(page, 'CBREPLY Bob joins them at the bar.');
    await page.waitForFunction(() => SillyTavern.getContext().chat.at(-1).extra?.ps_leak, null, { timeout: 30000 });
    const clock = (await L.state(page)).clock;
    eq('clock read from the tracker card', { time: clock.time, place: clock.place }, { time: 'Day 3, 9:47 PM', place: 'the rooftop bar' });
    const fresh = L.requests().slice(seen);
    const kinds = fresh.map(L.kindOf);
    check('no extra clock generation', !kinds.includes('clock'), kinds);
    const leak = fresh.find(r => L.kindOf(r) === 'leak');
    const asked = JSON.stringify(leak?.body.messages ?? '');
    check('leak check sees the tidied reply', /\[Tracker\]/.test(asked) && /Bob orders another round/.test(asked) && /Kael: you up\?/.test(asked), asked.slice(-600));
    check('…without markup, reasoning, cues or images', !/\[\[TRK|<think|CUE>|data-iig|<div|<img/.test(asked), asked.slice(-600));
    eq('reply judged OK', await page.evaluate(() => SillyTavern.getContext().chat.at(-1).extra.ps_leak.status), 'ok');

    section('API');
    const api = await page.evaluate(() => {
        const ps = window.PrivateScenes;
        const c = SillyTavern.getContext();
        const privateId = c.chat.findIndex(m => m.extra?.private_scene);
        return { version: ps.version, status: ps.status(), privateTo: ps.privateTo(privateId), publicTo: ps.privateTo(c.chat.length - 1), tidy: ps.tidyText('<b>Hi</b>') };
    });
    check('version', /^\d+\.\d+\.\d+$/.test(api.version), api.version);
    eq('status', { secrets: api.status.secrets, scene: api.status.scene, place: api.status.clock.place }, { secrets: 1, scene: null, place: 'the rooftop bar' });
    eq('privateTo', [api.privateTo, api.publicTo], [['Ana', 'Kael'], null]);
    eq('tidyText', api.tidy, 'Hi');
});

// Both extensions in one SillyTavern, with the real CALLBOARD preset and its regex.
// Needs CALLBOARD Suite installed as extensions/callboard and the preset saved
// as "CALLBOARD v…" (see tests/README.md). Skipped when they're missing.
const L = require('../lib');
const { check, eq, section } = L;

L.suite('with-callboard', async (page) => {
    await L.dismissPopups(page);
    const preset = await page.evaluate(() => SillyTavern.getContext().getPresetManager('openai').getAllPresets().find(n => /^CALLBOARD v/.test(n)) ?? null);
    const hasSuite = await page.evaluate(() => !!SillyTavern.getContext().SlashCommandParser?.commands?.['cb-check']);
    if (!preset || !hasSuite) {
        check('CALLBOARD Suite and preset installed (skipped otherwise)', true);
        return;
    }
    const previous = await L.selectPreset(page, preset);
    // L.start would switch back to the default preset, so do its steps after choosing CALLBOARD.
    await L.configure(page, { leakCheck: true, clockAutoTrack: false, clockFromTracker: true, tidyText: true });
    await L.setupApi(page);
    await L.ensureCharacter(page);
    eq('CALLBOARD preset selected', await page.evaluate(() => SillyTavern.getContext().getPresetManager('openai').getSelectedPresetName()), preset);

    section('CALLBOARD board');
    for (const cmd of ['/cb-on private scenes', '/cb-pick tracker modern']) await L.run(page, cmd);
    const lit = await page.evaluate(() => {
        const c = SillyTavern.getContext();
        return c.executeSlashCommandsWithOptions('/cb-check').then(r => r.pipe);
    });
    check('no Private Scenes warning in Notes', !/Private Scenes/.test(lit), lit);

    section('a private scene');
    await L.send(page, '@scene Ana, Kael: Ana pulls Kael aside: "I stole the royal seal."');
    // Opens the CALLBOARD board, reads its Private Scenes cue, and closes it again.
    const cue = async () => {
        await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/cb'));
        await page.waitForTimeout(800);
        const text = await page.evaluate(() => document.querySelector('#cb_board [data-cb-secrets]')?.innerText.replace(/\s+/g, ' ') ?? null);
        await page.evaluate(() => SillyTavern.getContext().executeSlashCommandsWithOptions('/cb'));
        await page.waitForTimeout(400);
        return text;
    };
    const live = await cue();
    check('board shows the live scene', /Live: Ana & Kael/i.test(live ?? ''), live);
    let prompt = JSON.stringify(L.chatPrompt());
    check('CALLBOARD\'s Private Scenes prompt is sent', /<private_scenes/.test(prompt));
    check('Private Scenes labels are in the same prompt', /\[PRIVATE — known only to: Ana and Kael/.test(prompt));
    await L.send(page, '@endscene The music resumes.');
    await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.timeline).length > 0, null, { timeout: 30000 });
    await page.waitForTimeout(600);
    const counted = await cue();
    check('board counts the saved secret', /1 secret/i.test(counted ?? ''), counted);

    section('a CALLBOARD reply');
    const seen = L.requests().length;
    await L.send(page, 'CBREPLY Bob joins them at the bar.');
    await page.waitForFunction(() => SillyTavern.getContext().chat.at(-1).extra?.ps_leak, null, { timeout: 30000 });
    const shown = await page.evaluate(() => document.querySelector('#chat .mes:last-child .mes_text').innerText);
    check('tracker card drawn by the preset regex', !/\[\[TRK\]\]|T> time/.test(shown) && /9:47 PM/.test(shown), shown.slice(0, 300));
    const clock = (await L.state(page)).clock;
    eq('story clock from the tracker card', { time: clock.time, place: clock.place }, { time: 'Day 3, 9:47 PM', place: 'the rooftop bar' });
    const leak = L.requests().slice(seen).find(r => L.kindOf(r) === 'leak');
    const asked = JSON.stringify(leak?.body.messages ?? '');
    check('leak check got plain text', /\[Tracker\]/.test(asked) && !/\[\[TRK|<think|CUE>|<img|<div/.test(asked), asked.slice(-500));
    await L.send(page, 'Ana checks the time.');
    prompt = JSON.stringify(L.chatPrompt());
    check('next prompt carries the story clock', /\[Story time: Day 3, 9:47 PM\. Location: the rooftop bar\.\]/.test(prompt));
    section('scene notes and private parts under CALLBOARD');
    check('preset teaches scene notes and parts', /SCENE> private\|Name, Name/.test(prompt) && /<private with=/.test(prompt));
    await L.send(page, 'PARTREPLY The ball goes on.');
    const part = await page.evaluate(() => {
        const box = document.querySelector('#chat .mes:last-child .mes_text');
        return { who: box.querySelector('[data-ps-part]')?.dataset.psPart, text: box.innerText };
    });
    check('part tinted, tag hidden, regex untouched', part.who === 'Ana, Kael' && !/<private/.test(part.text) && /waltz/.test(part.text), part);
    await L.send(page, 'SCENESTART Ana pulls Kael into the study.');
    eq('model-started scene', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene?.members ?? null), ['Ana', 'Kael']);
    check('no SCENE> line on screen', !/SCENE>/.test(await page.evaluate(() => document.querySelector('#chat .mes:last-child .mes_text').innerText)));
    await L.send(page, 'SCENEEND The music swells.');
    eq('model-ended scene', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene), null);
    await L.shot(page, 'with-callboard');

    // Put the previous preset back, so later suites run on SillyTavern's own prompt.
    await L.selectPreset(page, /^CALLBOARD/.test(previous) ? 'Default' : previous);
});

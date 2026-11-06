// Private parts (<private with="…">…</private> inside a public message) and
// scene notes (SCENE> private|… / SCENE> end) that a preset asks the model to write.
// Runs twice: on SillyTavern's own prompt, and on the CALLBOARD preset with its
// regex and 🤫 Private Scenes lit (skipped when CALLBOARD isn't installed).
const L = require('../lib');
const { check, eq, section } = L;

const SETTINGS = { autoSave: true, aiScenes: true, leakCheck: true };

const body = (withCallboard) => async (page) => {
    let previous = null;
    if (withCallboard) {
        const preset = await page.evaluate(() => SillyTavern.getContext().getPresetManager('openai').getAllPresets().find(n => /^CALLBOARD v/.test(n)) ?? null);
        const hasSuite = await page.evaluate(() => !!SillyTavern.getContext().SlashCommandParser?.commands?.['cb-check']);
        if (!preset || !hasSuite) {
            check('CALLBOARD Suite and preset installed (skipped otherwise)', true);
            return;
        }
        await L.dismissPopups(page);
        previous = await L.selectPreset(page, preset);
        await L.configure(page, SETTINGS);
        await L.setupApi(page);
        await L.ensureCharacter(page);
        await L.run(page, '/cb-on private scenes');
        eq('CALLBOARD preset selected', await page.evaluate(() => SillyTavern.getContext().getPresetManager('openai').getSelectedPresetName()), preset);
    } else {
        await L.start(page, SETTINGS);
    }
    const chat = () => page.evaluate(() => SillyTavern.getContext().chat.map(m => ({ mes: m.mes, flag: m.extra?.private_scene?.members ?? null })));

    section('a private part in a reply');
    await L.send(page, 'PARTREPLY The ball goes on.');
    let messages = await chat();
    const partId = messages.length - 1;
    check('saved text keeps the tag', /<private with="Ana, Kael"[^>]*>/.test(messages[partId].mes));
    eq('message itself is not private', messages[partId].flag, null);
    const shown = await page.evaluate((id) => {
        const box = document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
        const part = box.querySelector('[data-ps-part]');
        return { who: part?.dataset.psPart, inside: part?.innerText ?? '', all: box.innerText };
    }, partId);
    eq('part tinted with its people', shown.who, 'Ana, Kael');
    check('only the whisper is inside it', /royal seal/.test(shown.inside) && !/terrible joke|waltz/.test(shown.inside), shown.inside);
    check('public text stays outside', /terrible joke/.test(shown.all) && /waltz/.test(shown.all) && !/<private/.test(shown.all));
    await page.waitForFunction(() => Object.keys(SillyTavern.getContext().chatMetadata.privateScenes.timeline).some(k => k.startsWith('pp_')), null, { timeout: 30000 });
    check('saved as a secret', (await L.book(page)).some(e => /part of msg/.test(e.comment) && /royal seal/.test(e.content)));
    const secrets = await page.evaluate(() => window.PrivateScenes.status().secrets);
    eq('counts as one secret', secrets, 1);

    section('what the model sees next');
    const seen = L.requests().length;
    await L.send(page, 'Bob asks Ana to dance.');
    const prompt = JSON.stringify(L.chatPrompt());
    const reply = L.chatPrompt().map(m => m.content).find(c => /terrible joke/.test(c)) ?? '';
    eq('labels wrap just the part', reply, 'The party roars. Bob tells a terrible joke.\n\n[PRIVATE — known only to: Ana and Kael]\nAna leans close to Kael: "I stole the royal seal."\n[END PRIVATE]\n\nBack inside, the band strikes up a waltz.');
    check('no raw tags in the prompt', !/<\/?private/.test(reply));
    const leak = L.requests().slice(seen).find(r => L.kindOf(r) === 'leak');
    check('leak check knows the secret', /#1 \(known only to: Ana and Kael\)[^#]*royal seal/.test(JSON.stringify(leak?.body.messages ?? '')));

    section('public story memory leaves it out');
    const before = L.requests().length;
    await L.run(page, '/memory-save');
    const memory = L.requests().slice(before).find(r => L.kindOf(r) === 'story-summary');
    const told = JSON.stringify(memory?.body.messages ?? '');
    check('summary request has the party but not the whisper', /terrible joke/.test(told) && !/royal seal/.test(told), told.slice(-400));

    section('scene notes from the model');
    await L.send(page, 'SCENESTART Ana pulls Kael into the study.');
    messages = await chat();
    let scene = await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene?.members ?? null);
    eq('scene started', scene, ['Ana', 'Kael']);
    eq('the reply belongs to it', messages.at(-1).flag, ['Ana', 'Kael']);
    check('note removed from the reply', !/SCENE>/.test(messages.at(-1).mes) && /study door/.test(messages.at(-1).mes), messages.at(-1).mes);
    check('undo offered', (await L.toasts(page, 'info')).some(t => /Private scene started: Ana and Kael/.test(t)));

    await L.send(page, 'SCENEEND The music swells.');
    messages = await chat();
    scene = await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene);
    eq('scene ended', scene, null);
    eq('the reply is public again', messages.at(-1).flag, null);
    check('note removed', !/SCENE>/.test(messages.at(-1).mes));

    section('undo');
    await page.evaluate(() => toastr.clear());
    await page.waitForTimeout(500);
    await L.send(page, 'SCENESTART Again.');
    await page.locator('#toast-container .toast-info', { hasText: 'Private scene started' }).first().click();
    await page.waitForTimeout(500);
    eq('undo stops the scene', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene), null);
    eq('and unflags the reply', (await chat()).at(-1).flag, null);

    section('stable part ids');
    const firstSecret = await page.evaluate((id) => {
        const c = SillyTavern.getContext();
        return { mes: c.chat[id].mes, keys: Object.keys(c.chatMetadata.privateScenes.timeline).filter(k => k.startsWith('pp_')) };
    }, partId);
    check('tag got an id', /<private with="Ana, Kael" id="[\w-]+">/.test(firstSecret.mes), firstSecret.mes);
    const secretsBefore = await page.evaluate(() => window.PrivateScenes.status().secrets);
    await page.evaluate(async (id) => {
        const c = SillyTavern.getContext();
        c.chat[id].mes = c.chat[id].mes.replace('The party roars.', 'The party roars. <private with="Bob">Bob pockets a spoon.</private>');
        await c.eventSource.emit(c.eventTypes.MESSAGE_EDITED, id);
        c.updateMessageBlock(id, c.chat[id]);
    }, partId);
    await page.waitForTimeout(500);
    const after = await page.evaluate((id) => {
        const scenes = window.PrivateScenes.status();
        const c = SillyTavern.getContext();
        return { mes: c.chat[id].mes, secrets: scenes.secrets };
    }, partId);
    check('new part stamped too', (after.mes.match(/ id="/g) ?? []).length === 2, after.mes);
    const sealId = after.mes.match(/<private with="Ana, Kael" id="([\w-]+)">/)?.[1];
    eq('the seal keeps its secret id', firstSecret.keys, [`pp_${sealId}`]);
    eq('one more secret', after.secrets, secretsBefore + 1);

    section('pin a fact from a private part');
    await page.evaluate((id) => {
        const part = document.querySelector(`#chat .mes[mesid="${id}"] [data-ps-part="Ana, Kael"]`);
        const range = document.createRange();
        range.selectNodeContents(part.querySelector('p') ?? part);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }, partId);
    await page.locator(`#chat .mes[mesid="${partId}"] .extraMesButtonsHint`).click();
    await page.locator(`#chat .mes[mesid="${partId}"] .ps_toggle`).click();
    await page.locator('dialog[open] [data-action="pin"]').click();
    const pinInput = page.locator('dialog[open] textarea.popup-input').last();
    await pinInput.waitFor();
    await pinInput.fill('Ana has the royal seal.');
    await page.locator('dialog[open] .popup-button-ok').last().click();
    await page.waitForTimeout(800);
    const fact = (await L.state(page)).facts.find(f => /royal seal/.test(f.text));
    eq('fact is private to the part\'s people', fact?.members, ['Ana', 'Kael']);
    eq('and follows that secret', fact?.sceneId, `pp_${sealId}`);

    section('swipe or delete takes a scene note back');
    await L.send(page, 'SCENEONCE Ana pulls Kael aside again.');
    eq('scene started', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene?.members ?? null), ['Ana', 'Kael']);
    const len = await page.evaluate(() => SillyTavern.getContext().chat.length);
    await page.locator('#chat .mes.last_mes .swipe_right').first().click();
    await page.waitForFunction(() => {
        const m = SillyTavern.getContext().chat.at(-1);
        return (m.swipes?.length ?? 0) > 1 && !document.querySelector('#mes_stop:not([style*="none"])')?.offsetParent;
    }, null, { timeout: 30000 });
    await page.waitForTimeout(800);
    eq('swiping the opening reply undoes the scene', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene), null);
    eq('and the new reply is public', (await chat()).at(-1).flag, null);
    eq('same message slot', await page.evaluate(() => SillyTavern.getContext().chat.length), len);

    await L.send(page, 'SCENESTART Into the study.');
    await L.run(page, '/del 1');
    await page.waitForTimeout(800);
    eq('deleting the opening reply undoes the scene', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene), null);

    await L.send(page, 'SCENESTART Into the study, for real.');
    await L.send(page, 'Ana: "Lock it."');
    await L.send(page, 'SCENEEND Back to the ball.');
    eq('scene ended', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene), null);
    await L.run(page, '/del 1');
    await page.waitForTimeout(800);
    eq('deleting the closing reply brings the scene back', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene?.members ?? null), ['Ana', 'Kael']);
    await L.run(page, '/private-end');
    await page.waitForTimeout(500);

    section('turned off');
    await L.configure(page, { aiScenes: false });
    await L.send(page, 'SCENESTART Once more.');
    eq('no scene', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene), null);
    check('note still hidden from the text', !/SCENE>/.test((await chat()).at(-1).mes));
    await L.shot(page, withCallboard ? 'parts-callboard' : 'parts');
    if (withCallboard) await L.selectPreset(page, /^CALLBOARD/.test(previous) ? 'Default' : previous);
};

(async () => {
    await L.suite('parts', body(false));
    await L.suite('parts: callboard', body(true));
})();

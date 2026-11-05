// Private parts (<private with="…">…</private> inside a public message) and
// scene notes (SCENE> private|… / SCENE> end) that a preset asks the model to write.
const L = require('../lib');
const { check, eq, section } = L;

L.suite('parts', async (page) => {
    await L.start(page, { autoSave: true, aiScenes: true, leakCheck: true });
    const chat = () => page.evaluate(() => SillyTavern.getContext().chat.map(m => ({ mes: m.mes, flag: m.extra?.private_scene?.members ?? null })));

    section('a private part in a reply');
    await L.send(page, 'PARTREPLY The ball goes on.');
    let messages = await chat();
    const partId = messages.length - 1;
    check('saved text keeps the tag', /<private with="Ana, Kael">/.test(messages[partId].mes));
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
    check('no raw tags in the prompt', !/<\/?private/.test(prompt));
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

    section('turned off');
    await L.configure(page, { aiScenes: false });
    await L.send(page, 'SCENESTART Once more.');
    eq('no scene', await page.evaluate(() => SillyTavern.getContext().chatMetadata.privateScenes.scene), null);
    check('note still hidden from the text', !/SCENE>/.test((await chat()).at(-1).mes));
    await L.shot(page, 'parts');
});

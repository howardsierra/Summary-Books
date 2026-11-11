import test from 'node:test';
import assert from 'node:assert/strict';
import { fromHtml, hideSceneNotes, mapParts, parseParts, takeSceneNotes, toDisplayMarkers, withoutParts } from '../../src/parts.js';

const TEXT = 'The party roars.\n\n<private with="Ana, Kael">\nAna whispers: "I stole the seal."\n</private>\n\nBack inside. <private with=\'Bob\'>Bob winks.</private> End.';

test('parseParts finds each part with its people', () => {
    const parts = parseParts(TEXT);
    assert.deepEqual(parts.map(p => [p.members, p.body, p.closed]), [
        [['Ana', 'Kael'], 'Ana whispers: "I stole the seal."', true],
        [['Bob'], 'Bob winks.', true],
    ]);
    assert.equal(TEXT.slice(parts[1].start, parts[1].end), '<private with=\'Bob\'>Bob winks.</private>');
});

test('an unclosed part runs to the next part or the end', () => {
    const parts = parseParts('A <private with="Ana and Kael">secret one <private with="Bob">secret two');
    assert.deepEqual(parts.map(p => [p.members, p.body, p.closed]), [[['Ana', 'Kael'], 'secret one', false], [['Bob'], 'secret two', false]]);
    assert.deepEqual(parseParts('<private>no names</private> and plain text'), []);
});

test('withoutParts is the message as everyone else knows it', () => {
    assert.equal(withoutParts(TEXT), 'The party roars.\n\nBack inside.  End.');
    assert.equal(withoutParts('No secrets.'), 'No secrets.');
});

test('mapParts swaps parts for labels', () => {
    const out = mapParts(TEXT, (p) => `[PRIVATE ${p.members.join('+')}] ${p.body} [END]`);
    assert.match(out, /\[PRIVATE Ana\+Kael\] Ana whispers: "I stole the seal\." \[END\]/);
    assert.match(out, /Back inside\. \[PRIVATE Bob\] Bob winks\. \[END\] End\./);
});

test('display markers become a wrapping block after markdown', () => {
    const md = toDisplayMarkers(TEXT + '\n</private> stray');
    assert.ok(!/<\/?private/.test(md), md);
    // Rough stand-in for showdown: paragraphs.
    const html = md.split(/\n{2,}/).map(x => x.trim()).filter(Boolean).map(x => `<p>${x}</p>`).join('\n');
    const out = fromHtml(html);
    assert.match(out, /<div class="ps-part" data-ps-part="Ana, Kael">\n<p>Ana whispers: "I stole the seal\."<\/p>\n<\/div>/);
    assert.equal((out.match(/<div/g) ?? []).length, (out.match(/<\/div>/g) ?? []).length);
    assert.ok(!out.includes('⁣'));
    assert.equal(fromHtml('<p>plain</p>'), '<p>plain</p>');
});

test('names in the display attribute are escaped', () => {
    const out = fromHtml(toDisplayMarkers('<private with="A&quot;><img src=x onerror=alert(1)>">x</private>'));
    assert.ok(!/<img/.test(out.split('data-ps-part="')[1]?.split('"')[0] ?? ''), out);
});

test('scene notes are read and removed', () => {
    const { notes, text } = takeSceneNotes('SCENE> private|Ana, Kael\nThe door clicks shut.');
    assert.deepEqual(notes, [{ kind: 'private', members: ['Ana', 'Kael'] }]);
    assert.equal(text, 'The door clicks shut.');
    assert.deepEqual(takeSceneNotes('  scene> END\n\nBack at the party.').notes, [{ kind: 'end', members: [] }]);
    assert.deepEqual(takeSceneNotes('SCENE> private|\nNo names.').notes, []);
    assert.equal(takeSceneNotes('Nothing here.').text, 'Nothing here.');
    assert.equal(hideSceneNotes('SCENE> end\nHi').trim(), 'Hi');
});

test('stampPartIds gives each part a lasting id, once', async () => {
    const { stampPartIds } = await import('../../src/parts.js');
    let n = 0;
    const once = stampPartIds('A <private with="Ana">x</private> B <private with="Bob" id="kept">y</private> C <private with=Cy>z', () => `id${++n}`);
    assert.equal(once, 'A <private with="Ana" id="id2">x</private> B <private with="Bob" id="kept">y</private> C <private with=Cy id="id1">z');
    assert.deepEqual(parseParts(once).map(p => [p.id, p.members, p.body]), [['id2', ['Ana'], 'x'], ['kept', ['Bob'], 'y'], ['id1', ['Cy'], 'z']]);
    assert.equal(stampPartIds(once, () => 'new'), once, 'already stamped: unchanged');
    assert.equal(stampPartIds('No parts.', () => 'new'), 'No parts.');
});

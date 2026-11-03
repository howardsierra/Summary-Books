// The long-chat caches must never hand back stale answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ctx } from './setup.mjs';
import { chatChanged, findScenes, positionOf, setFlag, sourceStatus, sourcesOf } from '../../src/core.js';

const message = (i, extra = {}) => ({ mes: `Message ${i}`, is_user: i % 2 === 0, extra: { ps_mid: `m${i}`, ...extra } });
const fresh = (n) => { ctx.chat = Array.from({ length: n }, (_, i) => message(i)); ctx.chatMetadata = {}; chatChanged(); };

test('findScenes follows flag changes', () => {
    fresh(6);
    assert.equal(findScenes().length, 0);
    setFlag(ctx.chat[2], { members: ['Ana', 'Kael'], sceneId: 's1' });
    setFlag(ctx.chat[3], { members: ['Ana', 'Kael'], sceneId: 's1' });
    assert.deepEqual(findScenes().map(s => s.ids), [[2, 3]]);
    setFlag(ctx.chat[3], null);
    assert.deepEqual(findScenes().map(s => s.ids), [[2]]);
});

test('findScenes results can be changed by callers without hurting the cache', () => {
    fresh(4);
    setFlag(ctx.chat[1], { members: ['Ana'], sceneId: 's1' });
    findScenes()[0].ids.push(99);
    assert.deepEqual(findScenes()[0].ids, [1]);
});

test('positions follow deletions and a new chat', () => {
    fresh(5);
    assert.equal(positionOf('m3'), 3);
    ctx.chat.splice(1, 1); // length change alone resets the cache
    assert.equal(positionOf('m3'), 2);
    assert.equal(positionOf('m1'), -1);
    ctx.chat = [message(7)];
    assert.equal(positionOf('m7'), 0);
    assert.equal(positionOf(undefined), -1);
});

test('sourceStatus spots edits after a chat event, and recovers when undone', () => {
    fresh(6);
    const record = sourcesOf([1, 2, 3]);
    assert.equal(sourceStatus(record).state, 'ok');
    ctx.chat[2].mes = 'Changed';
    chatChanged();
    assert.equal(sourceStatus(record).state, 'edited');
    ctx.chat[2].mes = 'Message 2';
    chatChanged();
    assert.equal(sourceStatus(record).state, 'ok');
    ctx.chat.splice(2, 1);
    assert.deepEqual(sourceStatus(record), { state: 'missing', ids: [1, 2], missing: 1 });
});

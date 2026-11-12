import test from 'node:test';
import assert from 'node:assert/strict';
import { ctx } from './setup.mjs';
import { llm } from '../../src/llm.js';
import { upsertEntry } from '../../src/lorebook.js';

test('a model response from the previous chat never reaches its caller', async () => {
    let complete;
    ctx.generateRaw = () => new Promise(resolve => { complete = resolve; });
    const request = llm('summary', { systemPrompt: 'Summarize', prompt: 'Old chat' });
    ctx.chatMetadata = {};
    complete('A summary from the previous chat');
    await assert.rejects(request, /chat changed/);
});

test('concurrent lorebook updates preserve both entries with independent loaded copies', async () => {
    let stored = { entries: { 1: { uid: 1 }, 2: { uid: 2 } } };
    ctx.loadWorldInfo = async () => structuredClone(stored);
    ctx.saveWorldInfo = async (_book, data) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        stored = structuredClone(data);
    };
    ctx.reloadWorldInfoEditor = () => {};
    await Promise.all([
        upsertEntry('one book', 1, { content: 'first update' }),
        upsertEntry('one book', 2, { content: 'second update' }),
    ]);
    assert.equal(stored.entries[1].content, 'first update');
    assert.equal(stored.entries[2].content, 'second update');
});

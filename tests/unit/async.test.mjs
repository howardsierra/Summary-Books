import test from 'node:test';
import assert from 'node:assert/strict';
import { chatGuard, keyedQueue } from '../../src/async.js';

test('delayed work rejects a different chat, including a reopened chat with the same id', () => {
    let current = { chatId: 'one', chatMetadata: {} };
    const guard = chatGuard(() => current);
    guard();
    current = { ...current, chatId: 'two' };
    assert.throws(guard, /chat changed/);
    current = { chatId: 'one', chatMetadata: {} };
    assert.throws(guard, /chat changed/);
});

test('writes to one book are ordered while other books can proceed', async () => {
    const queue = keyedQueue();
    const events = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = queue('book', async () => { events.push('first'); await gate; events.push('saved'); });
    const second = queue('book', () => { events.push('second'); });
    await queue('other', () => { events.push('other'); });
    assert.deepEqual(events, ['first', 'other']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first', 'other', 'saved', 'second']);
});

test('a rejected write does not prevent the next write', async () => {
    const queue = keyedQueue();
    const failed = queue('book', () => { throw new Error('disk failure'); });
    const next = queue('book', () => 'recovered');
    await assert.rejects(failed, /disk failure/);
    assert.equal(await next, 'recovered');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSummary, joinSummary, extrasInstructions } from '../../src/extract.js';
import { parseVerdict } from '../../src/leaks.js';
import { parseSheets } from '../../src/memory.js';
import { parseNames, formatMembers } from '../../src/core.js';

test('parseSummary splits labelled lines off the summary', () => {
    const r = parseSummary('Ana told Kael.\nThey swore secrecy.\nKEYWORDS: royal seal, garden.\nTHREAD: Kael must keep quiet\n**TIME**: Day 2, night\nPLACE: unknown\nRESOLVED: 1, 3');
    assert.equal(r.summary, 'Ana told Kael.\nThey swore secrecy.');
    assert.deepEqual(r.keywords, ['royal seal', 'garden']);
    assert.deepEqual(r.threads, ['Kael must keep quiet']);
    assert.deepEqual(r.resolved, [1, 3]);
    assert.equal(r.time, 'Day 2, night');
    assert.equal(r.place, null, '"unknown" is ignored');
});

test('parseSummary tolerates empty input and plain text', () => {
    assert.equal(parseSummary(undefined).summary, '');
    assert.deepEqual(parseSummary('Just a summary.').keywords, []);
});

test('joinSummary round-trips keywords', () => {
    const text = joinSummary('A summary.', ['seal', 'garden']);
    assert.deepEqual(parseSummary(text).keywords, ['seal', 'garden']);
    assert.equal(joinSummary('A summary.', []), 'A summary.');
});

test('extrasInstructions only asks for what is tracked', () => {
    assert.equal(extrasInstructions({}), '');
    const text = extrasInstructions({ keywords: true, threads: ['Find the guard'], clock: { time: 'Day 1', place: '' } });
    assert.match(text, /KEYWORDS:/);
    assert.match(text, /1\. Find the guard/);
    assert.match(text, /"Day 1".*"unknown"/);
});

test('parseVerdict reads OK and LEAK lines', () => {
    assert.deepEqual(parseVerdict('OK'), { leak: false });
    assert.deepEqual(parseVerdict('LEAK 2: Bob mentions the seal'), { leak: true, secret: 2, reason: 'Bob mentions the seal' });
    assert.deepEqual(parseVerdict('**LEAK** #1 — names it'), { leak: true, secret: 1, reason: 'names it' });
    assert.deepEqual(parseVerdict('Thinking...\nLEAK: vague'), { leak: true, secret: null, reason: 'vague' });
});

test('parseSheets reads === blocks with STATE and REL lines', () => {
    const blocks = parseSheets('=== Bob\nSTATE: Worried.\nREL Ana: suspicious of her\n- REL Kael: old friend\n=== Ana\nnothing useful\n=== Kael\nSTATE: Calm');
    assert.deepEqual(blocks, [
        { name: 'Bob', state: 'Worried.', rels: [{ name: 'Ana', text: 'suspicious of her' }, { name: 'Kael', text: 'old friend' }] },
        { name: 'Kael', state: 'Calm', rels: [] },
    ]);
});

test('parseSheets uses the fallback name without headers', () => {
    assert.deepEqual(parseSheets('STATE: Tired\nRELATIONSHIP Bob: brother', 'Ana'), [{ name: 'Ana', state: 'Tired', rels: [{ name: 'Bob', text: 'brother' }] }]);
});

test('parseNames dedupes and trims; formatMembers joins', () => {
    assert.deepEqual(parseNames('Ana, kael ,Ana, , Bob'), ['Ana', 'kael', 'Bob']);
    assert.equal(formatMembers(['Ana', 'Kael', 'Bob']), 'Ana, Kael and Bob');
});

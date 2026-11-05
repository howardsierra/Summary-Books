import test from 'node:test';
import assert from 'node:assert/strict';
import { tidyText, trackerClock } from '../../src/tidy.js';
import { ctx } from './setup.mjs';
import { settings, storyText } from '../../src/core.js';

const REPLY = `<think>Plan: Ana hides the letter.</think>
CUE> 📊|Tracker card|a new day begins|
<cb_state>
[[TRK]]
T> time|9:47 PM, Friday
T> place|the rooftop bar
T> mood|wired and guilty
T> affinity|Kael|62|she kept his secret
[[/TRK]]
</cb_state>
[[PROGRAM]]
PG> title|Tonight
[[/PROGRAM]]
Ana slides the letter into her coat &amp; smiles.
<img data-iig-instruction='{"prompt":"Ana on the rooftop"}' src="user/images/a.png">
<!--cb-clover:done:abc-->
<div class="phone"><style>.x{color:red}</style><p>Kael: you up?</p><p>Ana: always</p></div>
[[PRIVATE]]
PX> head|Snap|Kael
PX> pic|in|9:50|a mirror selfie, hoodie half-zipped||view once
[[/PRIVATE]]`;

test('tidyText turns a CALLBOARD reply into plain story lines', () => {
    const out = tidyText(REPLY);
    assert.ok(!/think|Plan:|CUE>|PROGRAM|Tonight|<|data-iig|cb-clover|color:red/.test(out), out);
    assert.match(out, /\[Tracker\]\ntime: 9:47 PM, Friday\nplace: the rooftop bar/);
    assert.match(out, /affinity: Kael · 62 · she kept his secret/);
    assert.match(out, /Ana slides the letter into her coat & smiles\./);
    assert.match(out, /Kael: you up\?\nAna: always/);
    assert.match(out, /\[Private photos\]\nhead: Snap · Kael\npic: in · 9:50 · a mirror selfie, hoodie half-zipped · view once/);
    assert.ok(!/\n{3,}/.test(out));
});

test('tidyText leaves plain prose alone', () => {
    assert.equal(tidyText('  Ana waits by the gate. <3 \n'), 'Ana waits by the gate. <3');
    assert.equal(tidyText('Plain text.'), 'Plain text.');
    assert.equal(tidyText(undefined), '');
});

test('trackerClock reads the last tracker card', () => {
    assert.deepEqual(trackerClock(REPLY), { time: '9:47 PM, Friday', place: 'the rooftop bar' });
    assert.deepEqual(trackerClock('[[TRK]]\nT> time|Day 3, dawn\nT> place|(current location)\n[[/TRK]]\n[[TRK]]\nT> place|the stables\n[[/TRK]]'), { place: 'the stables' });
    assert.equal(trackerClock('No tracker here.'), null);
    assert.equal(trackerClock('[[TRK]]\nT> mood|calm\n[[/TRK]]'), null);
});

test('storyText follows the tidy setting', () => {
    ctx.extensionSettings = {};
    const message = { mes: '<b>Ana</b> nods.' };
    assert.equal(storyText(message), 'Ana nods.');
    settings().tidyText = false;
    assert.equal(storyText(message), '<b>Ana</b> nods.');
    settings().tidyText = true;
});

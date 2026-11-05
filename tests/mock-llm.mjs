// Fake OpenAI-compatible endpoint: logs each request body and answers by
// what the prompt asks for (summaries, leak checks, sheets, ...).
//   node mock-llm.mjs <log file> [port]
// POST /__reset clears the log and the per-run counters.
import http from 'node:http';
import fs from 'node:fs';
const log = process.argv[2];
let n = 0;
let leakedOnce = false;
let memoryCalls = 0;
let sheetCalls = 0;
function reset() {
  n = 0; leakedOnce = false; memoryCalls = 0; sheetCalls = 0;
  fs.writeFileSync(log, '');
}
// A reply in the CALLBOARD preset's format: reasoning, a cue line, a tracker card, a panel, HTML and an image.
const CALLBOARD_REPLY = `<think>Bob should stay clueless.</think>
CUE> 📊|Tracker card|a new hour|
<cb_state>
[[TRK]]
T> time|Day 3, 9:47 PM
T> place|the rooftop bar
T> mood|wired
[[/TRK]]
</cb_state>
Bob orders another round and talks about the weather.
<div class="phone"><p>Kael: you up?</p></div>
<img data-iig-instruction='{"prompt":"Bob at the bar"}' src="user/images/bob.png">`;
// Presets may add their own user-role prompts after the chat, so a trigger word
// counts in any message newer than the last assistant turn.
function asked(messages, word) {
  const lastAssistant = messages.map(m => m.role).lastIndexOf('assistant');
  return messages.some((m, i) => i > lastAssistant && word.test(typeof m.content === 'string' ? m.content : ''));
}
function reply(messages) {
  const all = JSON.stringify(messages);
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
  if (/leaked secrets/.test(sys)) {
    const newReply = lastUser.split('NEW REPLY')[1] ?? '';
    return /royal seal/i.test(newReply) ? 'LEAK 1: Bob mentions the royal seal, which only Ana and Kael know about.' : 'OK';
  }
  if (/PRIVATE scene below/.test(sys)) return 'Ana confessed to Kael that she stole the royal seal. Kael promised to keep it secret until the coronation.\nKEYWORDS: royal seal, palace garden\nTHREAD: Kael must keep the seal secret until the coronation';
  if (/part of the story below/.test(sys)) {
    memoryCalls++;
    if (memoryCalls === 1) return 'The court gathered in the palace hall on the eve of the coronation, and Bob greeted everyone. Bob promised to find the missing guard.\nKEYWORDS: coronation, palace hall\nTHREAD: Bob promised to find the missing guard\nTIME: Day 2, evening\nPLACE: the palace hall';
    return `Story part ${memoryCalls}: Bob found the missing guard asleep in the stables and told Ana.\nKEYWORDS: stables, guard\n${/Open threads:/.test(sys) ? 'RESOLVED: 1\n' : ''}THREAD: Someone drugged the guard\nTIME: Day 2, night\nPLACE: the stables`;
  }
  if (/Merge them into one shorter chapter/.test(sys)) return 'Chapter: On the eve of the coronation, Bob searched for a missing guard and found him drugged in the stables.\nKEYWORDS: coronation, stables';
  if (/keep character sheets/.test(sys)) {
    sheetCalls++;
    return sheetCalls === 1
      ? '=== Bob\nSTATE: Cheerful host of the hall, searching for a missing guard.\nREL Ana: friendly acquaintance\n=== Ana\nSTATE: Nervous but composed on the eve of the coronation.\nREL Bob: polite distance'
      : '=== Bob\nSTATE: Worried after finding the guard drugged.\nREL Ana: suspicious of her';
  }
  if (/condense a rumor/.test(sys)) return 'People are whispering that Kael gambled away his family estate.';
  if (/You condense a/.test(sys)) return 'The Daily Star reports that Ana was seen leaving the palace at midnight.';
  if (/track the in-story time/.test(sys)) return 'TIME: Day 2, late night\nPLACE: the courtyard';
  if (asked(messages, /CBREPLY/)) return CALLBOARD_REPLY;
  if (asked(messages, /LEAKME/) && !leakedOnce) { leakedOnce = true; return 'Bob smirks at Ana: "So, how is the royal seal doing?"'; }
  return `Mock reply #${n}.`;
}
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url === '/__reset') { reset(); res.writeHead(204); return res.end(); }
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }, { id: 'cheap-mock', object: 'model' }] }));
    }
    n++;
    const parsed = body ? JSON.parse(body) : {};
    fs.appendFileSync(log, JSON.stringify({ n, url: req.url, body: parsed }) + '\n');
    const text = reply(parsed.messages ?? []);
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
  });
}).listen(Number(process.argv[3] ?? 5005), '127.0.0.1', () => console.log('mock on', process.argv[3] ?? 5005));

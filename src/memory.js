// Things the story should keep remembering besides the timeline: pinned facts,
// open threads, the story clock, and character sheets with relationships.
// Each list lives in chat metadata and is mirrored to one lorebook entry
// (one per character for sheets).

import {
    COMMON_KINDS, MID, chatState, commonKind, ctx, ensureMid, flagMessages, formatTemplate, getCommon, hashText, hooks,
    membersKey, newId, parseNames, revealedNames, saveSoon, setCommon, settings,
} from './core.js';
import { deleteEntry, getBook, upsertEntry } from './lorebook.js';
import { parseSummary } from './extract.js';

const lastId = () => Math.max(0, ctx().chat.length - 1);

/**
 * Writes (or removes, when content is empty) one always-included entry
 * tracked under chatState().entries[kind].
 */
async function writeListEntry(kind, content, fields) {
    const state = chatState();
    const record = state.entries[kind];
    if (!content) {
        if (record) await deleteEntry(record.book, record.uid);
        delete state.entries[kind];
        await ctx().saveMetadata();
        return;
    }
    const book = await getBook(true);
    const uid = await upsertEntry(book, record?.book === book ? record.uid : null, { constant: true, content, ...fields });
    state.entries[kind] = { book, uid };
    await ctx().saveMetadata();
}

/**
 * Public items as a list, private ones grouped inside private labels. Items
 * from a private scene follow its reveals, like the scene's own entry.
 */
function groupedContent(title, items) {
    if (!items.length) return '';
    const s = settings();
    const lines = [title];
    const groups = new Map();
    for (const item of items) {
        if (!item.members?.length) {
            lines.push(`- ${item.text}`);
            continue;
        }
        const revealed = item.sceneId ? revealedNames(item.sceneId) : [];
        const key = `${membersKey(item.members)}|${membersKey(revealed)}`;
        if (!groups.has(key)) groups.set(key, { members: item.members, revealed, texts: [] });
        groups.get(key).texts.push(item.text);
    }
    for (const { members, revealed, texts } of groups.values()) {
        lines.push(formatTemplate(s.labelStart, members, revealed), ...texts.map(t => `- ${t}`), formatTemplate(s.labelEnd, members, revealed));
    }
    return lines.join('\n');
}

/** Rewrites the facts and threads entries (after a reveal changes who knows). */
export async function refreshListEntries() {
    if (chatState().entries.facts) await saveList(writeFactsEntry);
    if (chatState().entries.threads) await saveList(writeThreadsEntry);
}

const report = (error, what) => {
    console.error('[Private Scenes]', what, error);
    toastr.error(String(error?.message ?? error), `Private Scenes: ${what}`);
};

// ─── Pinned facts ────────────────────────────────────────────────────

async function writeFactsEntry() {
    await writeListEntry('facts', groupedContent('Established facts in this story:', chatState().facts), {
        comment: '📌 Pinned facts',
        order: Number(settings().entryOrder) - 50,
    });
}

export async function addFact(text, members = null, sourceMid = null, sceneId = null) {
    text = String(text ?? '').trim();
    if (!text) return null;
    const fact = { id: newId('fact'), text, members: members?.length ? [...members] : null, sceneId, sourceMid, createdAt: Date.now() };
    chatState().facts.push(fact);
    await saveList(writeFactsEntry);
    return fact;
}

export async function editFact(id, text) {
    const fact = chatState().facts.find(x => x.id === id);
    if (!fact || !String(text ?? '').trim()) return;
    fact.text = String(text).trim();
    await saveList(writeFactsEntry);
}

export async function removeFact(id) {
    const state = chatState();
    state.facts = state.facts.filter(x => x.id !== id);
    await saveList(writeFactsEntry);
}

async function saveList(write) {
    try {
        await write();
    } catch (error) {
        report(error, 'could not update the lorebook');
    }
    hooks.changed();
}

// ─── Open threads ────────────────────────────────────────────────────

async function writeThreadsEntry() {
    const open = chatState().threads.filter(x => x.status === 'open');
    await writeListEntry('threads', groupedContent('Unresolved story threads (promises, plans, debts, and open questions):', open), {
        comment: '🧵 Open threads',
        order: Number(settings().entryOrder) - 40,
    });
}

/**
 * Open threads a summarizer may see. For a private scene, only threads every
 * member already knows; for public text, only public threads.
 */
export function visibleThreads(members = null) {
    const keys = members?.length ? members.map(x => x.toLowerCase()) : null;
    return chatState().threads.filter(thread => thread.status === 'open' && (
        !thread.members?.length
        || (keys && keys.every(k => thread.members.some(m => m.toLowerCase() === k)))
    ));
}

export async function addThread(text, members = null, { at = lastId(), write = true, sceneId = null } = {}) {
    text = String(text ?? '').trim();
    if (!text) return null;
    const thread = { id: newId('th'), text, members: members?.length ? [...members] : null, sceneId, status: 'open', openedAt: at, resolvedAt: null };
    chatState().threads.push(thread);
    if (write) await saveList(writeThreadsEntry);
    return thread;
}

export async function setThreadStatus(id, status, { at = lastId(), write = true } = {}) {
    const thread = chatState().threads.find(x => x.id === id);
    if (!thread) return;
    thread.status = status;
    thread.resolvedAt = status === 'resolved' ? at : null;
    if (write) await saveList(writeThreadsEntry);
}

export async function editThread(id, text) {
    const thread = chatState().threads.find(x => x.id === id);
    if (!thread || !String(text ?? '').trim()) return;
    thread.text = String(text).trim();
    await saveList(writeThreadsEntry);
}

export async function removeThread(id) {
    const state = chatState();
    state.threads = state.threads.filter(x => x.id !== id);
    await saveList(writeThreadsEntry);
}

// ─── Story clock ─────────────────────────────────────────────────────

export const getClock = () => chatState().clock;

export function clockText() {
    const { time, place } = getClock();
    const parts = [];
    if (time) parts.push(`Story time: ${time}.`);
    if (place) parts.push(`Location: ${place}.`);
    return parts.length ? `[${parts.join(' ')}]` : '';
}

export function setClock({ time, place }) {
    const clock = getClock();
    let changed = false;
    if (typeof time === 'string' && time.trim() !== clock.time) {
        clock.time = time.trim();
        changed = true;
    }
    if (typeof place === 'string' && place.trim() !== clock.place) {
        clock.place = place.trim();
        changed = true;
    }
    if (changed) {
        clock.at = lastId();
        ctx().saveMetadataDebounced();
        hooks.changed();
    }
    return changed;
}

const CLOCK_PROMPT = 'You track the in-story time and place of a roleplay. Read the LATEST MESSAGES and reply with exactly two lines:\n'
    + 'TIME: <the current in-story time, for example "Day 3, evening">\nPLACE: <the current location>\n'
    + 'Repeat the previous value when it did not change.';

/** Optional per-reply tracking: asks the model where and when the story is now. */
export async function trackClock(messageId) {
    const s = settings();
    if (!s.enabled || !s.clockEnabled || !s.clockAutoTrack) return;
    const chat = ctx().chat;
    const recent = chat.slice(Math.max(0, messageId - 1), messageId + 1).map(m => `${m.name}: ${m.mes}`).join('\n\n');
    const clock = getClock();
    try {
        const answer = await ctx().generateRaw({
            systemPrompt: CLOCK_PROMPT,
            prompt: `Previous time: ${clock.time || 'unknown'}\nPrevious place: ${clock.place || 'unknown'}\n\nLATEST MESSAGES:\n${recent}`,
        });
        const parsed = parseSummary(answer);
        setClock({ time: parsed.time ?? undefined, place: parsed.place ?? undefined });
    } catch (error) {
        console.error('[Private Scenes] Clock tracking failed', error);
    }
}

// ─── Extras from summaries ───────────────────────────────────────────

/**
 * Applies the extra lines of a committed summary: new threads, resolved
 * threads (numbered as in threadIds), and the clock.
 */
export async function applyExtras(parsed, { threadIds = [], members = null, sceneId = null, at = lastId() } = {}) {
    const s = settings();
    let threadsChanged = false;
    if (s.trackThreads) {
        for (const number of parsed.resolved ?? []) {
            const id = threadIds[number - 1];
            if (id) {
                await setThreadStatus(id, 'resolved', { at, write: false });
                threadsChanged = true;
            }
        }
        const existing = new Set(chatState().threads.map(x => x.text.toLowerCase()));
        for (const text of parsed.threads ?? []) {
            if (existing.has(text.toLowerCase())) continue;
            await addThread(text, members, { at, write: false, sceneId });
            threadsChanged = true;
        }
    }
    if (threadsChanged) await saveList(writeThreadsEntry);
    if (s.clockEnabled && !members?.length) setClock({ time: parsed.time ?? undefined, place: parsed.place ?? undefined });
}

// ─── Character sheets & relationships ────────────────────────────────

const SHEET_PROMPT = 'You keep character sheets for an ongoing roleplay up to date. Read the NEW EVENTS and update the sheet of every '
    + 'character whose condition or relationships changed. Add a sheet for an important named character who has none yet. '
    + 'Do not invent anything that is not in the text.\n'
    + 'For each changed character, write a block:\n'
    + '=== <Name>\n'
    + 'STATE: <1 to 3 sentences on their current condition, mood, goals, and notable possessions>\n'
    + 'REL <Other name>: <a few words on how they currently relate to that character>\n'
    + 'Write one REL line for every relationship that exists, not only the changed ones. '
    + 'If nothing changed for anyone, write only: NONE';

const sheetKey = (name) => name.trim().toLowerCase();

export const sheetList = () => Object.values(chatState().sheets).sort((a, b) => a.name.localeCompare(b.name));

/** The editable text form of a sheet (same format the model writes). */
export function sheetToText(sheet) {
    const lines = [`STATE: ${sheet.state ?? ''}`];
    for (const rel of Object.values(sheet.rels ?? {})) lines.push(`REL ${rel.name}: ${rel.text}`);
    return lines.join('\n');
}

/** Parses "=== Name" blocks with STATE / REL lines. A text without "===" is one block for fallbackName. */
export function parseSheets(text, fallbackName = null) {
    const blocks = [];
    let current = fallbackName ? { name: fallbackName, state: null, rels: [] } : null;
    for (const raw of String(text ?? '').split('\n')) {
        const line = raw.replace(/^[\s*_-]+|[*_]+$/g, '').trim();
        const header = line.match(/^===\s*(.+?)\s*=*$/);
        if (header) {
            current = { name: header[1].trim(), state: null, rels: [] };
            blocks.push(current);
            continue;
        }
        if (!current) continue;
        if (fallbackName && !blocks.includes(current)) blocks.push(current);
        const state = line.match(/^STATE\s*:\s*(.+)$/i);
        const rel = line.match(/^REL(?:ATIONSHIP)?\s+(.+?)\s*:\s*(.+)$/i);
        if (state) current.state = state[1].trim();
        else if (rel) current.rels.push({ name: rel[1].trim(), text: rel[2].trim() });
    }
    return blocks.filter(b => b.state || b.rels.length);
}

async function writeSheetEntry(sheet) {
    const lines = [`[${sheet.name} — current state]`, sheet.state || '(unknown)'];
    const rels = Object.values(sheet.rels ?? {});
    if (rels.length) lines.push('Relationships:', ...rels.map(r => `- ${r.name}: ${r.text}`));
    const book = await getBook(true);
    sheet.uid = await upsertEntry(book, sheet.book === book ? sheet.uid : null, {
        comment: `👤 ${sheet.name} — character sheet`,
        content: lines.join('\n'),
        key: [sheet.name],
        constant: false,
        order: Number(settings().entryOrder) - 100,
    });
    sheet.book = book;
}

/**
 * Merges a parsed block into a sheet. Changed relationships keep their old
 * wording in history, so the Characters tab can show how they evolved.
 */
async function applySheet(block, at, { replaceRels = false } = {}) {
    const sheets = chatState().sheets;
    const key = sheetKey(block.name);
    const sheet = sheets[key] ??= { name: block.name, state: '', rels: {}, book: null, uid: null };
    if (block.state) sheet.state = block.state;
    const seen = new Set();
    for (const rel of block.rels) {
        const relKey = sheetKey(rel.name);
        seen.add(relKey);
        const current = sheet.rels[relKey];
        if (!current) {
            sheet.rels[relKey] = { name: rel.name, text: rel.text, since: at, history: [] };
        } else if (current.text !== rel.text) {
            current.history = [...(current.history ?? []), { text: current.text, since: current.since }].slice(-5);
            Object.assign(current, { text: rel.text, since: at });
        }
    }
    if (replaceRels) {
        for (const relKey of Object.keys(sheet.rels)) if (!seen.has(relKey)) delete sheet.rels[relKey];
    }
    sheet.updatedAt = at;
    await writeSheetEntry(sheet);
}

export const sheetsBusy = new Set();

/**
 * Updates character sheets from public text. Never call this with private
 * material: sheets are triggered by a character's name in any context.
 */
export async function updateSheets(text, { names = null, at = lastId(), quiet = true } = {}) {
    const known = parseNames([...(names ?? []), ...sheetList().map(x => x.name), ...chatState().names]);
    const lower = text.toLowerCase();
    const involved = (names ?? known).filter(name => lower.includes(name.toLowerCase()) || names);
    const current = involved.map(name => chatState().sheets[sheetKey(name)]).filter(Boolean)
        .map(sheet => `=== ${sheet.name}\n${sheetToText(sheet)}`);

    const busyKey = names?.join(',') ?? '*';
    sheetsBusy.add(busyKey);
    hooks.changed();
    try {
        const answer = await ctx().generateRaw({
            systemPrompt: SHEET_PROMPT,
            prompt: (names ? `Only update these characters: ${names.join(', ')}\n\n` : '')
                + `Known characters: ${known.join(', ') || 'none yet'}\n\nCURRENT SHEETS:\n${current.join('\n\n') || 'none'}\n\nNEW EVENTS:\n${text}`,
        });
        const blocks = parseSheets(answer).filter(b => !names || names.some(n => sheetKey(n) === sheetKey(b.name)));
        for (const block of blocks) await applySheet(block, at);
        await ctx().saveMetadata();
        if (!quiet) toastr.success(blocks.length ? `Updated ${blocks.length} character sheet${blocks.length === 1 ? '' : 's'}.` : 'No character changes found.', 'Private Scenes');
    } catch (error) {
        report(error, 'could not update character sheets');
    } finally {
        sheetsBusy.delete(busyKey);
        hooks.changed();
    }
}

/** Public story text to rebuild sheets from: story memories plus public facts. */
export function publicStoryText() {
    const state = chatState();
    const parts = [...state.memories].sort((a, b) => a.from - b.from).map(m => m.summary);
    const facts = state.facts.filter(f => !f.members?.length).map(f => `Fact: ${f.text}`);
    return [...parts, ...facts].join('\n\n').slice(-6000);
}

export async function addSheet(name) {
    const key = sheetKey(name);
    if (!name.trim() || chatState().sheets[key]) return;
    await applySheet({ name: name.trim(), state: '', rels: [] }, lastId());
    await ctx().saveMetadata();
    hooks.changed();
}

/** Replaces a sheet from its edited text form. */
export async function setSheetText(name, text) {
    const [block] = parseSheets(text, name);
    if (!block) return;
    try {
        await applySheet({ ...block, name }, lastId(), { replaceRels: true });
        await ctx().saveMetadata();
    } catch (error) {
        report(error, 'could not save the character sheet');
    }
    hooks.changed();
}

export async function removeSheet(name) {
    const sheets = chatState().sheets;
    const sheet = sheets[sheetKey(name)];
    if (!sheet) return;
    if (sheet.book) await deleteEntry(sheet.book, sheet.uid);
    delete sheets[sheetKey(name)];
    await ctx().saveMetadata();
    hooks.changed();
}

/** Every relationship as "from → to", for the overview. */
export function relationshipList() {
    return sheetList().flatMap(sheet => Object.values(sheet.rels ?? {}).map(rel => ({ from: sheet.name, ...rel })));
}

/** True when private facts or threads exist, so the rules prompt is needed. */
export const hasPrivateLists = () => chatState().facts.some(x => x.members?.length)
    || chatState().threads.some(x => x.status === 'open' && x.members?.length);

// ─── World knowledge (common knowledge, news, rumors) ────────────────

const CONDENSE_PROMPT = {
    rumor: 'Condense this rumor from a roleplay into 1 or 2 sentences describing what people are saying. '
        + 'Keep names and claims, and make clear it is a rumor. Output only the sentences.',
    other: 'Condense this {{kind}} from a roleplay into 1 or 2 sentences stating what everyone now knows. '
        + 'Keep names, dates, and claims. Output only the sentences.',
};

/** World items being condensed right now (by id). */
export const condensing = new Set();

const positionOf = (mid) => ctx().chat.findIndex(m => m.extra?.[MID] === mid);

/**
 * How a world item relates to its message now:
 * 'ok', 'changed' (the message text changed), or 'gone' (deleted).
 */
export function worldStatus(item) {
    if (!item.sourceMid) return 'ok';
    const index = positionOf(item.sourceMid);
    if (index === -1) return 'gone';
    return hashText(ctx().chat[index].mes ?? '') === item.hash ? 'ok' : 'changed';
}

/** Items whose message still exists but is no longer marked common (made private or normal). */
function isWithdrawn(item) {
    const index = item.sourceMid ? positionOf(item.sourceMid) : -1;
    return index !== -1 && !getCommon(ctx().chat[index]);
}

async function writeWorldEntry() {
    const items = chatState().world.filter(item => !isWithdrawn(item));
    const content = items.length
        ? ['Common knowledge: every character in the world knows these, including characters who were not there.',
            ...items.map(item => `- ${item.kind === 'rumor' ? 'Rumor (may not be true)' : COMMON_KINDS[item.kind].label}: ${item.text}`)].join('\n')
        : '';
    await writeListEntry('world', content, {
        comment: '🌍 World knowledge',
        order: Number(settings().entryOrder) - 60,
    });
}

/** Condenses a message into a short line for the world entry (or uses its text when condensing is off). */
async function condense(message, kind) {
    const text = String(message.mes ?? '').trim();
    if (!settings().worldCondense) return text.length > 600 ? `${text.slice(0, 600)}…` : text;
    const label = COMMON_KINDS[kind].label.toLowerCase();
    const prompt = (kind === 'rumor' ? CONDENSE_PROMPT.rumor : CONDENSE_PROMPT.other).replace('{{kind}}', label);
    const answer = String(await ctx().generateRaw({ systemPrompt: prompt, prompt: text }) ?? '').trim();
    return answer || (text.length > 600 ? `${text.slice(0, 600)}…` : text);
}

/** Creates or refreshes the world item for a message. */
async function upsertWorldItem(message, kind) {
    const world = chatState().world;
    const mid = ensureMid(message);
    let item = world.find(x => x.sourceMid === mid);
    if (!item) {
        item = { id: newId('world'), sourceMid: mid, createdAt: Date.now() };
        world.push(item);
    }
    Object.assign(item, { kind: commonKind(kind), hash: hashText(message.mes ?? '') });
    item.text ??= String(message.mes ?? '').slice(0, 200);
    condensing.add(item.id);
    hooks.changed();
    try {
        item.text = await condense(message, item.kind);
    } catch (error) {
        report(error, 'could not condense the message');
    } finally {
        condensing.delete(item.id);
    }
}

/**
 * Sets who knows about messages:
 *  { mode: 'common', kind } — every character in the world,
 *  { mode: 'normal' }       — whoever was there (the default),
 *  { mode: 'private', members } — only these characters.
 */
export async function setVisibility(ids, visibility) {
    const chat = ctx().chat;
    const messages = ids.map(id => chat[id]).filter(Boolean);
    if (visibility.mode === 'common') {
        messages.forEach(message => setCommon(message, visibility.kind));
        saveSoon();
        hooks.changed();
        for (const message of messages) await upsertWorldItem(message, visibility.kind);
    } else {
        messages.forEach(message => setCommon(message, null));
        flagMessages(ids, visibility.mode === 'private' ? visibility.members : []);
        const mids = new Set(messages.map(m => m.extra?.[MID]).filter(Boolean));
        chatState().world = chatState().world.filter(item => !mids.has(item.sourceMid));
    }
    await saveList(writeWorldEntry);
    await ctx().saveMetadata();
}

/** Re-condenses an item from its (changed) message. */
export async function refreshWorldItem(id) {
    const item = chatState().world.find(x => x.id === id);
    const index = item ? positionOf(item.sourceMid) : -1;
    if (index === -1) return;
    await upsertWorldItem(ctx().chat[index], item.kind);
    await saveList(writeWorldEntry);
    await ctx().saveMetadata();
}

export async function editWorldItem(id, text, kind = null) {
    const item = chatState().world.find(x => x.id === id);
    if (!item || !String(text ?? '').trim()) return;
    item.text = String(text).trim();
    if (kind) item.kind = commonKind(kind);
    await saveList(writeWorldEntry);
    await ctx().saveMetadata();
}

/** Adds world knowledge that isn't tied to a message (typed in by hand). */
export async function addWorldText(text, kind = 'common') {
    text = String(text ?? '').trim();
    if (!text) return;
    chatState().world.push({ id: newId('world'), kind: commonKind(kind), text, sourceMid: null, createdAt: Date.now() });
    await saveList(writeWorldEntry);
    await ctx().saveMetadata();
}

/** Removes an item and un-marks its message, if the message still exists. */
export async function removeWorldItem(id) {
    const state = chatState();
    const item = state.world.find(x => x.id === id);
    if (!item) return;
    const index = item.sourceMid ? positionOf(item.sourceMid) : -1;
    if (index !== -1) setCommon(ctx().chat[index], null);
    state.world = state.world.filter(x => x.id !== id);
    saveSoon();
    await saveList(writeWorldEntry);
    await ctx().saveMetadata();
}

export const hasCommonKnowledge = () => chatState().world.length > 0;

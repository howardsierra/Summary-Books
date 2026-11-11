// Lorebook timeline: summarizes private scenes and public story stretches into
// entries in the chat-bound lorebook, merges old story entries into chapters,
// queues summaries for review, and notices when the chat changed under them.

import { createWorldInfoEntry } from '../../../../world-info.js';
import {
    BOOK_KEY, adoptScene, chatState, ctx, findScenes, formatMembers, formatTemplate, getFlag, hooks,
    newId, parseNames, positionOf, revealedNames, sceneTranscript, settings, sourceStatus, sourcesOf, storyText,
} from './core.js';
import { extrasInstructions, parseSummary } from './extract.js';
import { applyExtras, getClock, refreshListEntries, updateSheets, visibleThreads } from './memory.js';
import { llm } from './llm.js';

// world_info_position.after (after character definitions)
const WI_AFTER_CHAR = 1;

/** Scene ids, memory ids and drafts currently being summarized. */
export const saving = new Set();

/** A lorebook being created right now, per chat, so simultaneous saves share it. */
const creatingBook = new Map();

/** The chat-bound lorebook; creates and binds one when missing. */
export async function getBook(create) {
    // A branch that was just opened gets its own copy first; don't write into the shared one.
    if (branching) await branching;
    const c = ctx();
    const existing = c.chatMetadata[BOOK_KEY];
    if (existing && c.getWorldInfoNames().includes(existing)) return existing;
    if (!create) return null;
    if (!c.chatId) throw new Error('Open a chat first.');
    // Two saves finishing together (a scene and a thread, say) must not create two lorebooks.
    if (!creatingBook.has(c.chatId)) {
        creatingBook.set(c.chatId, createBook().finally(() => creatingBook.delete(c.chatId)));
    }
    return creatingBook.get(c.chatId);
}

/** An unused lorebook name for the current chat. */
function newBookName() {
    const c = ctx();
    const base = `${BOOK_PREFIX}${c.chatId}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 60);
    let name = base;
    for (let n = 2; c.getWorldInfoNames().includes(name); n++) name = `${base} ${n}`;
    return name;
}
const BOOK_PREFIX = 'Private Timeline - ';

async function createBook() {
    const c = ctx();
    const name = newBookName();
    await c.saveWorldInfo(name, { entries: {} }, true);
    await c.updateWorldInfoList();
    c.chatMetadata[BOOK_KEY] = name;
    chatState().bookOwner = c.chatId;
    await c.saveMetadata();
    $('.chat_lorebook_button').addClass('world_set');
    toastr.success(`Created lorebook "${name}" and linked it to this chat.`, 'Private Scenes');
    return name;
}

// ─── Branches & checkpoints ──────────────────────────────────────────
// SillyTavern copies a chat's metadata into a branch or checkpoint, so both
// chats would point at one lorebook and each would overwrite the other's
// entries. The chat that made the lorebook owns it; any other chat that
// opens with it gets its own copy, minus what happened after the split.

let branching = null;

/** Run when a chat opens. Resolves once this chat has a lorebook of its own. */
export function checkBranch() {
    const run = adoptBranch()
        .catch(error => reportError(error, 'could not copy the lorebook for this branch'))
        .finally(() => { if (branching === run) branching = null; });
    branching = run;
    return run.then(result => result?.lists ? refreshListEntries({ world: true }) : null);
}

/**
 * Gives this chat a lorebook of its own on demand, even if it already owns
 * the one it uses (for a branch that claimed its parent's lorebook).
 * fresh: start over with an empty lorebook and forget the saved memories
 * (private and common flags on messages stay); otherwise copy the current one,
 * minus anything from messages this chat doesn't have.
 */
export async function forceOwnBook({ fresh = false } = {}) {
    if (branching) await branching;
    const c = ctx();
    if (!c.chatId) throw new Error('Open a chat first.');
    const state = chatState();
    const book = c.chatMetadata?.[BOOK_KEY];
    const hasBook = book && c.getWorldInfoNames().includes(book);
    const name = newBookName();
    let pruned = { count: 0, lists: false };
    if (fresh || !hasBook) {
        await c.saveWorldInfo(name, { entries: {} }, true);
        Object.assign(state, { timeline: {}, memories: [], memoryCursor: 0, drafts: [], threads: [], facts: [], world: [], sheets: {}, entries: {} });
    } else {
        const copy = structuredClone(await c.loadWorldInfo(book));
        pruned = pruneFuture(state, copy, book);
        await c.saveWorldInfo(name, copy, true);
        repoint(state, book, name);
    }
    await c.updateWorldInfoList();
    state.bookOwner = c.chatId;
    c.chatMetadata[BOOK_KEY] = name;
    await c.saveMetadata();
    $('.chat_lorebook_button').addClass('world_set');
    if (pruned.lists) await refreshListEntries({ world: true });
    hooks.changed();
    hooks.entriesChanged();
    toastr.success(fresh || !hasBook
        ? `This chat now uses a new, empty lorebook: "${name}". Messages keep their private and common marks; summarize again to fill it.`
        : `This chat now uses its own copy: "${name}". The old lorebook is unchanged.${pruned.count ? ` Left out ${pruned.count} saved ${pruned.count === 1 ? 'memory' : 'memories'} from messages this chat doesn't have.` : ''}`,
    'Private Scenes', { timeOut: 9000 });
    return name;
}

async function adoptBranch() {
    const c = ctx();
    const book = c.chatMetadata?.[BOOK_KEY];
    if (!c.chatId || !book || !c.getWorldInfoNames().includes(book)) return null;
    const state = chatState();
    if (!state.bookOwner) {
        // Lorebooks made before owners were recorded: the first chat to open one claims it.
        if (book.startsWith(BOOK_PREFIX)) {
            state.bookOwner = c.chatId;
            await c.saveMetadata();
        }
        return null;
    }
    if (state.bookOwner === c.chatId || !settings().branchCopy) return null;

    const data = await c.loadWorldInfo(book);
    if (!data?.entries) return null;
    const copy = structuredClone(data);
    const pruned = pruneFuture(state, copy, book);
    const name = newBookName();
    await c.saveWorldInfo(name, copy, true);
    await c.updateWorldInfoList();
    repoint(state, book, name);
    state.bookOwner = c.chatId;
    c.chatMetadata[BOOK_KEY] = name;
    await c.saveMetadata();
    $('.chat_lorebook_button').addClass('world_set');
    const note = pruned.count ? ` Left out ${pruned.count} saved ${pruned.count === 1 ? 'memory' : 'memories'} from after the branch point.` : '';
    toastr.success(`This chat is a branch, so it got its own lorebook: "${name}".${note}`, 'Private Scenes', { timeOut: 8000 });
    hooks.changed();
    return pruned;
}

/**
 * Drops what the branch never reached: memories and secrets whose messages
 * are all missing, threads opened later (and reopens ones resolved later),
 * pins, world knowledge and reveals from later messages.
 */
function pruneFuture(state, data, book) {
    const length = ctx().chat.length;
    let count = 0;
    let lists = false;
    const dropEntry = (record) => { if (record.book === book) delete data.entries[record.uid]; };

    state.memories = state.memories.filter(memory => {
        if (sourceStatus(memory).state !== 'gone') return true;
        dropEntry(memory);
        count++;
        return false;
    });
    // "Story so far" picks up where the remaining memories end.
    if (count) state.memoryCursor = Math.max(0, ...state.memories.map(m => m.to + 1));
    state.memoryCursor = Math.min(state.memoryCursor ?? 0, length);
    const live = new Set(findScenes().map(x => x.id));
    for (const [id, record] of Object.entries(state.timeline)) {
        if (live.has(id)) continue;
        dropEntry(record);
        delete state.timeline[id];
        count++;
    }
    state.drafts = state.drafts.filter(d => d.to === undefined || d.to < length);

    const before = state.threads.length + state.facts.length + state.world.length;
    state.threads = state.threads.filter(t => !(t.openedAt >= length));
    for (const thread of state.threads) {
        if (!(thread.resolvedAt >= length)) continue;
        Object.assign(thread, { status: 'open', resolvedAt: null });
        lists = true;
    }
    const exists = (mid) => !mid || positionOf(mid) !== -1;
    state.facts = state.facts.filter(f => exists(f.sourceMid));
    state.world = state.world.filter(w => exists(w.sourceMid));
    lists ||= before !== state.threads.length + state.facts.length + state.world.length;
    for (const [sceneId, reveals] of Object.entries(state.reveals)) {
        state.reveals[sceneId] = reveals.filter(r => !(r.at >= length));
    }
    return { count, lists };
}

/** Points every saved record at the copied lorebook. */
function repoint(node, from, to) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(x => repoint(x, from, to));
    for (const [key, value] of Object.entries(node)) {
        if (key === 'book' && value === from) node[key] = to;
        else repoint(value, from, to);
    }
}

/** Creates or updates an entry; returns its uid. */
export async function upsertEntry(book, uid, fields) {
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`Could not load lorebook "${book}".`);
    let entry = uid !== undefined && uid !== null ? data.entries[uid] : null;
    entry ??= createWorldInfoEntry(book, data);
    if (!entry) throw new Error('Could not create a lorebook entry.');
    Object.assign(entry, { position: WI_AFTER_CHAR, addMemo: true, disable: false }, fields);
    await c.saveWorldInfo(book, data, true);
    c.reloadWorldInfoEditor(book);
    hooks.entriesChanged();
    return entry.uid;
}

export async function deleteEntry(book, uid) {
    if (!book) return;
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (data?.entries?.[uid]) {
        delete data.entries[uid];
        await c.saveWorldInfo(book, data, true);
        c.reloadWorldInfoEditor(book);
        hooks.entriesChanged();
    }
}

async function hideMessages(ids) {
    // Hide contiguous runs with one command each.
    const runs = [];
    for (const id of ids.filter(i => !ctx().chat[i]?.is_system)) {
        if (runs.length && runs.at(-1)[1] === id - 1) runs.at(-1)[1] = id;
        else runs.push([id, id]);
    }
    for (const [from, to] of runs) {
        await ctx().executeSlashCommandsWithOptions(`/hide ${from === to ? from : `${from}-${to}`}`, { showOutput: false });
    }
}

function reportError(error, title) {
    console.error('[Private Scenes]', title, error);
    toastr.error(String(error?.message ?? error), `Private Scenes: ${title}`);
}

function transcript(ids) {
    const chat = ctx().chat;
    return ids.map(id => `${chat[id].name}: ${storyText(chat[id])}`).join('\n\n');
}

/**
 * Asks for a summary plus the extra lines that apply.
 * threadMembers: undefined = no thread tracking, null = public, [...] = private to these members.
 */
async function summarize(systemPrompt, text, { threadMembers, clock = false } = {}) {
    const s = settings();
    const threads = s.trackThreads && threadMembers !== undefined ? visibleThreads(threadMembers) : null;
    const instructions = systemPrompt + extrasInstructions({
        keywords: s.keywords,
        threads: threads?.map(t => t.text) ?? null,
        clock: clock && s.clockEnabled ? getClock() : null,
    });
    const parsed = parseSummary(await llm('summary', { systemPrompt: instructions, prompt: text }));
    if (!parsed.summary) throw new Error('The model returned an empty summary.');
    return { parsed, threadIds: threads?.map(t => t.id) ?? [] };
}

/** When and where a summarized stretch ends: what the summary says, else the current clock. */
const clockAfter = (parsed) => ({ time: parsed.time ?? getClock().time, place: parsed.place ?? getClock().place });

const toastClick = (message, onclick) => toastr.info(message, 'Private Scenes', { onclick, timeOut: 8000 });

// ─── Review queue ────────────────────────────────────────────────────

/** Draft kinds and how to commit them once approved. */
const committers = {
    scene: commitSceneDraft,
    memory: commitMemoryDraft,
    chapter: commitChapterDraft,
};

/** Queues a summary for review instead of saving it. Replaces an older draft for the same target. */
function queueDraft(draft) {
    const state = chatState();
    state.drafts = state.drafts.filter(d => !(d.kind === draft.kind && d.targetId === draft.targetId));
    state.drafts.push({ id: newId('draft'), createdAt: Date.now(), ...draft });
    ctx().saveMetadataDebounced();
    hooks.changed();
    toastClick('A new summary is waiting for your review. Click to open Story Memory.', () => hooks.openMemory?.('timeline'));
}

/** Saves a draft, optionally with edited text (summary plus KEYWORDS line). */
export async function approveDraft(draftId, editedText = null) {
    const state = chatState();
    const draft = state.drafts.find(d => d.id === draftId);
    if (!draft || saving.has(draftId)) return;
    if (editedText !== null) {
        const edited = parseSummary(editedText);
        draft.parsed = { ...draft.parsed, summary: edited.summary, keywords: edited.keywords };
    }
    saving.add(draftId);
    hooks.changed();
    try {
        await committers[draft.kind](draft);
        state.drafts = state.drafts.filter(d => d.id !== draftId);
        await ctx().saveMetadata();
    } catch (error) {
        reportError(error, 'could not save the summary');
    } finally {
        saving.delete(draftId);
        hooks.changed();
    }
}

export function discardDraft(draftId) {
    const state = chatState();
    const draft = state.drafts.find(d => d.id === draftId);
    // A discarded story draft can be summarized again by "story so far".
    if (draft?.kind === 'memory' && state.memoryCursor === draft.to + 1) state.memoryCursor = draft.from;
    state.drafts = state.drafts.filter(d => d.id !== draftId);
    ctx().saveMetadataDebounced();
    hooks.changed();
}

const reviewing = () => !!settings().reviewBeforeSave;

// ─── Private scenes ──────────────────────────────────────────────────

/**
 * Writes a scene's entry from a summary, using everyone who knows the secret now.
 * meta (sources, hash, clock) is kept from the existing record when not given.
 */
export async function writeSceneEntry(scene, summary, keywords = [], meta = {}) {
    const s = settings();
    scene = adoptScene(scene);
    const timeline = chatState().timeline;
    const record = timeline[scene.id];
    const revealed = revealedNames(scene.id);

    const book = await getBook(true);
    const uid = await upsertEntry(book, record?.book === book ? record.uid : null, {
        // No scene number: numbers shift when an earlier message gets flagged later.
        comment: `🕵️ Private — ${formatMembers(scene.members)} (${scene.part ? `part of msg ${scene.ids[0]}` : `msgs ${scene.ids[0]}–${scene.ids.at(-1)}`})`,
        content: `${formatTemplate(s.labelStart, scene.members, revealed)}\n${summary}\n${formatTemplate(s.labelEnd, scene.members, revealed)}`,
        key: parseNames([...scene.members, ...revealed, ...keywords]),
        constant: !!s.entryConstant,
        // Chronological: later scenes sit closer to the end of the prompt.
        order: Number(s.entryOrder) + scene.ids[0],
    });

    timeline[scene.id] = {
        ...record,
        book, uid, summary, keywords: [...keywords], members: [...scene.members],
        count: scene.ids.length, anchor: scene.ids[0], savedAt: Date.now(),
        ...meta,
    };
    await ctx().saveMetadata();
    hooks.changed();
    return scene;
}

/** Rewrites a scene's entry and its threads and facts without re-summarizing (after a reveal changes). */
export async function refreshSceneEntry(sceneId) {
    const record = chatState().timeline[sceneId];
    const scene = findScenes().find(x => x.id === sceneId);
    try {
        if (record && scene) await writeSceneEntry(scene, record.summary, record.keywords);
        await refreshListEntries();
    } catch (error) {
        reportError(error, 'could not update the lorebook entry');
    }
}

async function commitScene(scene, parsed, threadIds) {
    await writeSceneEntry(scene, parsed.summary, parsed.keywords, { ...sourcesOf(scene.ids), clock: clockAfter(parsed) });
    await applyExtras(parsed, { threadIds, members: scene.members, sceneId: scene.id, at: scene.ids.at(-1) });
    // A private part shares its message with public text, so its message stays visible.
    if (settings().hideAfterSave && !scene.part) await hideMessages(scene.ids);
}

async function commitSceneDraft(draft) {
    const scene = findScenes().find(x => x.id === draft.targetId);
    if (!scene) throw new Error('That private scene no longer exists in the chat.');
    await commitScene(scene, draft.parsed, draft.threadIds);
}

export async function saveScene(scene, { quiet = false } = {}) {
    if (saving.has(scene.id)) return;
    scene = adoptScene(scene);
    saving.add(scene.id);
    hooks.changed();
    try {
        const { parsed, threadIds } = await summarize(formatTemplate(settings().summaryPrompt, scene.members), sceneTranscript(scene),
            { threadMembers: scene.members });
        if (reviewing()) {
            queueDraft({ kind: 'scene', targetId: scene.id, parsed, threadIds, members: [...scene.members], from: scene.ids[0], to: scene.ids.at(-1) });
            return parsed.summary;
        }
        await commitScene(scene, parsed, threadIds);
        if (!quiet) toastr.success(`Saved private scene #${scene.index} to the lorebook.`, 'Private Scenes');
        return parsed.summary;
    } catch (error) {
        reportError(error, 'could not save scene');
    } finally {
        saving.delete(scene.id);
        hooks.changed();
    }
}

export function autoSaveScene(sceneId) {
    if (!settings().autoSave || !settings().enabled) return;
    const scene = findScenes().find(x => x.id === sceneId);
    if (scene) saveScene(scene);
}

export async function removeSceneEntry(sceneId) {
    const timeline = chatState().timeline;
    const record = timeline[sceneId];
    if (!record) return;
    await deleteEntry(record.book, record.uid);
    delete timeline[sceneId];
    await ctx().saveMetadata();
    hooks.changed();
}

export const hasSavedScenes = () => Object.keys(chatState().timeline).length > 0;

// ─── Story memory (public stretches) ─────────────────────────────────

/** Public (unflagged) messages in a range. Private ones never go into public memory. */
function publicIds(from, to) {
    const chat = ctx().chat;
    const ids = [];
    for (let i = Math.max(0, from); i <= Math.min(to, chat.length - 1); i++) {
        if (!getFlag(chat[i]) && chat[i].mes) ids.push(i);
    }
    return ids;
}

/** Characters from this chat whose names appear in the text, used as entry triggers. */
function namesIn(text) {
    const lower = text.toLowerCase();
    const names = [...chatState().names, ...Object.values(chatState().sheets).map(x => x.name)];
    return parseNames(names.filter(name => lower.includes(name.toLowerCase())));
}

const LEVEL_LABEL = ['📜 Story', '📚 Chapter', '🏛️ Arc'];
export const levelName = (level) => ['Story', 'Chapter', 'Arc'][level ?? 0] ?? 'Story';

export async function writeMemoryEntry(memory, summary, keywords = [], meta = {}) {
    const s = settings();
    const state = chatState();
    const book = await getBook(true);
    Object.assign(memory, meta);
    const uid = await upsertEntry(book, memory.book === book ? memory.uid : null, {
        comment: `${LEVEL_LABEL[memory.level ?? 0] ?? LEVEL_LABEL[0]} — msgs ${memory.from}–${memory.to}`,
        content: summary,
        key: parseNames([...namesIn(summary), ...keywords]),
        constant: !!s.memoryConstant,
        order: Number(s.entryOrder) + memory.from,
    });
    Object.assign(memory, { book, uid, summary, keywords: [...keywords], savedAt: Date.now() });
    if (!state.memories.includes(memory)) state.memories.push(memory);
    state.memories.sort((a, b) => a.from - b.from);
    await ctx().saveMetadata();
    hooks.changed();
}

async function commitMemory(memory, parsed, threadIds, ids) {
    const state = chatState();
    memory.level ??= 0;
    await writeMemoryEntry(memory, parsed.summary, parsed.keywords, { ...sourcesOf(ids), clock: clockAfter(parsed) });
    state.memoryCursor = Math.max(state.memoryCursor, memory.to + 1);
    await ctx().saveMetadata();
    await applyExtras(parsed, { threadIds, members: null, at: memory.to });
    if (settings().hideAfterSave) await hideMessages(ids);
    if (settings().autoSheets) await updateSheets(parsed.summary, { at: memory.to });
    await maybeConsolidate();
}

async function commitMemoryDraft(draft) {
    const existing = chatState().memories.find(m => m.id === draft.targetId);
    const ids = publicIds(draft.from, draft.to);
    if (!ids.length) throw new Error('Those messages are no longer in the chat.');
    await commitMemory(existing ?? { id: draft.targetId, from: draft.from, to: draft.to, level: 0 }, draft.parsed, draft.threadIds, ids);
}

/** Summarizes the public messages in [from, to] into a story entry. */
export async function saveMemory(from, to, { quiet = false, existing = null } = {}) {
    const ids = publicIds(from, to);
    if (!ids.length) {
        if (!quiet) toastr.info('There are no public messages in that range to summarize.', 'Private Scenes');
        return;
    }
    const memory = existing ?? { id: newId('mem'), from, to, level: 0 };
    if (saving.has(memory.id)) return;
    saving.add(memory.id);
    hooks.changed();
    try {
        const { parsed, threadIds } = await summarize(settings().memoryPrompt, transcript(ids), { threadMembers: null, clock: true });
        if (reviewing()) {
            queueDraft({ kind: 'memory', targetId: memory.id, parsed, threadIds, from, to });
            // Move on, so auto memory doesn't summarize the same stretch again while it waits.
            chatState().memoryCursor = Math.max(chatState().memoryCursor, to + 1);
            return parsed.summary;
        }
        Object.assign(memory, { from, to });
        await commitMemory(memory, parsed, threadIds, ids);
        if (!quiet) toastr.success(`Saved messages ${from}–${to} to the lorebook as story memory.`, 'Private Scenes');
        return parsed.summary;
    } catch (error) {
        reportError(error, 'could not save story memory');
    } finally {
        saving.delete(memory.id);
        hooks.changed();
    }
}

/** Saves the story so far: everything after the last memory up to the latest message. */
export function saveStorySoFar(options) {
    const state = chatState();
    const last = ctx().chat.length - 1;
    const from = Math.min(state.memoryCursor, last);
    return saveMemory(from, last, options);
}

// ─── Forced summaries ────────────────────────────────────────────────

/** Story entries (any level) that cover part of a range. */
const overlapping = (from, to) => chatState().memories.filter(m => m.from <= to && m.to >= from);

/** Grows a range until no story entry sticks out of it, so nothing is left half-covered. */
function coverRange(from, to) {
    for (let grown = true; grown;) {
        grown = false;
        for (const m of overlapping(from, to)) {
            if (m.from < from || m.to > to) {
                from = Math.min(from, m.from);
                to = Math.max(to, m.to);
                grown = true;
            }
        }
    }
    return [from, to];
}

let forcing = false;
let progressToast = null;
function progress(text) {
    if (progressToast) toastr.clear(progressToast);
    progressToast = text ? toastr.info(text, 'Private Scenes', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }) : null;
}

/**
 * Summarizes a stretch again even if it is already in story memory: the story
 * entries (and chapters) overlapping it are replaced. Long stretches are split
 * into parts of "Every N public messages", then merged into chapters as usual.
 * @returns {Promise<number>} how many story entries were saved
 */
export async function redoMemory(from, to, { quiet = false } = {}) {
    if (forcing) {
        toastr.info('Already summarizing; wait for it to finish.', 'Private Scenes');
        return 0;
    }
    const last = ctx().chat.length - 1;
    [from, to] = coverRange(Math.max(0, from), Math.min(last, to));
    if (to < from) return 0;
    forcing = true;
    const state = chatState();
    try {
        for (const memory of overlapping(from, to)) await removeMemory(memory.id);
        state.drafts = state.drafts.filter(d => !(d.kind === 'memory' && d.from <= to && d.to >= from));
        const size = Math.max(5, Number(settings().memoryEvery) || 20);
        const ids = publicIds(from, to);
        const parts = [];
        for (let i = 0; i < ids.length; i += size) parts.push(ids.slice(i, i + size));
        // A short last part joins the one before it.
        if (parts.length > 1 && parts.at(-1).length < size / 2) parts.at(-2).push(...parts.pop());
        let saved = 0;
        let start = from;
        for (const [n, part] of parts.entries()) {
            const end = n === parts.length - 1 ? to : part.at(-1);
            if (parts.length > 1) progress(`Summarizing part ${n + 1} of ${parts.length} (messages ${start}–${end})…`);
            const summary = await saveMemory(start, end, { quiet: true });
            if (!summary) break;
            saved++;
            start = end + 1;
        }
        progress(null);
        state.memoryCursor = Math.max(state.memoryCursor, start);
        await ctx().saveMetadata();
        await maybeConsolidate();
        if (!quiet && saved) toastr.success(`Summarized messages ${from}–${to} again: ${saved} story ${saved === 1 ? 'entry' : 'entries'}.`, 'Private Scenes');
        else if (!quiet && !ids.length) toastr.info('There are no public messages in that range to summarize.', 'Private Scenes');
        return saved;
    } finally {
        progress(null);
        forcing = false;
        hooks.changed();
    }
}

/** Secrets that have no entry yet, or whose messages changed since. */
export function unsavedScenes() {
    const timeline = chatState().timeline;
    return findScenes().filter(scene => !timeline[scene.id] || sourceStatus(timeline[scene.id]).state !== 'ok');
}

/**
 * Saves secrets now, including a scene that is still running.
 * @param {{all?: boolean}} options all: every secret, not only unsaved or changed ones
 * @returns {Promise<number>} how many were saved
 */
export async function saveSecretsNow({ all = false, quiet = false } = {}) {
    const scenes = all ? findScenes() : unsavedScenes();
    let saved = 0;
    for (const [n, scene] of scenes.entries()) {
        if (scenes.length > 1) progress(`Saving secret ${n + 1} of ${scenes.length}…`);
        if (await saveScene(scene, { quiet: true })) saved++;
    }
    progress(null);
    if (!quiet) {
        toastr[saved ? 'success' : 'info'](saved ? `Saved ${saved} ${saved === 1 ? 'secret' : 'secrets'} to the lorebook.` : 'No secrets needed saving.', 'Private Scenes');
    }
    return saved;
}

/** Rebuilds all memory: every secret and the whole public story, from the first message. */
export async function rebuildAll() {
    const secrets = await saveSecretsNow({ all: true, quiet: true });
    const entries = await redoMemory(0, ctx().chat.length - 1, { quiet: true });
    toastr.success(`Rebuilt memory: ${secrets} ${secrets === 1 ? 'secret' : 'secrets'} and ${entries} story ${entries === 1 ? 'entry' : 'entries'}.`, 'Private Scenes');
}

let autoMemoryRunning = false;

/** Called after each reply: saves a memory once enough public messages pile up. */
export async function maybeAutoMemory() {
    const s = settings();
    if (!s.enabled || !s.autoMemory || autoMemoryRunning) return;
    const state = chatState();
    const end = ctx().chat.length - 1 - Math.max(0, Number(s.memoryKeepRecent) || 0);
    const from = state.memoryCursor;
    if (end < from || publicIds(from, end).length < Math.max(2, Number(s.memoryEvery) || 20)) return;
    autoMemoryRunning = true;
    try {
        await saveMemory(from, end, { quiet: true });
    } finally {
        autoMemoryRunning = false;
    }
}

export async function removeMemory(memoryId) {
    const state = chatState();
    const memory = state.memories.find(x => x.id === memoryId);
    if (!memory) return;
    await deleteEntry(memory.book, memory.uid);
    state.memories = state.memories.filter(x => x.id !== memoryId);
    // Removing the newest memory lets "story so far" cover that stretch again.
    if (state.memoryCursor === memory.to + 1) state.memoryCursor = memory.from;
    await ctx().saveMetadata();
    hooks.changed();
}

// ─── Consolidation (chapters & arcs) ─────────────────────────────────

/** Groups ready to merge: the oldest N entries of a level, leaving the newest few detailed. */
function consolidationGroups() {
    const s = settings();
    const size = Math.max(2, Number(s.consolidateEvery) || 5);
    const keep = Math.max(0, Number(s.consolidateKeep) || 0);
    const groups = [];
    for (const level of [0, 1]) {
        const entries = chatState().memories.filter(m => (m.level ?? 0) === level).sort((a, b) => a.from - b.from);
        const mergeable = entries.slice(0, Math.max(0, entries.length - keep));
        if (mergeable.length >= size) groups.push({ level: level + 1, parts: mergeable.slice(0, size) });
    }
    return groups;
}

export const canConsolidate = () => consolidationGroups().length > 0;

let consolidating = false;

/** Merges old story entries into chapters, and old chapters into arcs. Secrets are never merged. */
export async function maybeConsolidate({ force = false } = {}) {
    const s = settings();
    if ((!s.consolidate && !force) || consolidating) return;
    consolidating = true;
    try {
        const pending = new Set(chatState().drafts.filter(d => d.kind === 'chapter').map(d => d.targetId));
        for (const { level, parts } of consolidationGroups()) {
            // With review on, a merge waiting for approval isn't summarized again.
            if (!pending.has(parts.map(p => p.id).join('+'))) await consolidate(level, parts);
        }
    } finally {
        consolidating = false;
    }
}

async function consolidate(level, parts) {
    const busyId = `consolidate_${level}`;
    saving.add(busyId);
    hooks.changed();
    try {
        const text = parts.map(p => `[Messages ${p.from}–${p.to}]\n${p.summary}`).join('\n\n');
        const { parsed } = await summarize(settings().chapterPrompt, text);
        const draft = { kind: 'chapter', targetId: parts.map(p => p.id).join('+'), parsed, partIds: parts.map(p => p.id), level, from: parts[0].from, to: parts.at(-1).to };
        if (reviewing()) queueDraft(draft);
        else await commitChapterDraft(draft);
    } catch (error) {
        reportError(error, `could not merge into a ${levelName(level).toLowerCase()}`);
    } finally {
        saving.delete(busyId);
        hooks.changed();
    }
}

async function commitChapterDraft(draft) {
    const state = chatState();
    const parts = draft.partIds.map(id => state.memories.find(m => m.id === id)).filter(Boolean);
    if (parts.length !== draft.partIds.length) throw new Error('Some of the entries to merge were removed meanwhile.');

    const sources = parts.flatMap(p => p.sources ?? []);
    const found = sourceStatus({ sources, hash: '' }).ids ?? [];
    const chapter = { id: newId('mem'), level: draft.level, from: parts[0].from, to: parts.at(-1).to };
    // Keep the parts (without their entries) so the chapter can be split again.
    chapter.parts = parts.map(({ book: _book, uid: _uid, ...rest }) => rest);
    for (const part of parts) await deleteEntry(part.book, part.uid);
    state.memories = state.memories.filter(m => !draft.partIds.includes(m.id));
    await writeMemoryEntry(chapter, draft.parsed.summary, draft.parsed.keywords,
        found.length ? sourcesOf(found) : { sources: [], hash: '' });
    toastr.success(`Merged ${parts.length} entries into a ${levelName(draft.level).toLowerCase()}.`, 'Private Scenes');
}

/** Undoes a merge: restores the parts' entries and removes the chapter. */
export async function splitChapter(chapterId) {
    const state = chatState();
    const chapter = state.memories.find(m => m.id === chapterId);
    if (!chapter?.parts?.length) return;
    try {
        await deleteEntry(chapter.book, chapter.uid);
        state.memories = state.memories.filter(m => m.id !== chapterId);
        for (const part of chapter.parts) await writeMemoryEntry({ ...part, book: null, uid: null }, part.summary, part.keywords);
    } catch (error) {
        reportError(error, 'could not split the chapter');
    }
    hooks.changed();
}

// ─── Staleness (rewind-safe memory) ──────────────────────────────────

/** How a saved record relates to the chat now. */
export function recordStatus(record) {
    return sourceStatus(record);
}

/** Timeline records whose private scene no longer exists at all. */
export function orphanScenes() {
    const live = new Set(findScenes().map(x => x.id));
    return Object.entries(chatState().timeline)
        .filter(([id]) => !live.has(id))
        .map(([id, record]) => ({ id, record }));
}

/** Everything saved that no longer matches the chat. */
export function staleItems() {
    const state = chatState();
    const items = [];
    for (const memory of state.memories) {
        const status = sourceStatus(memory);
        if (status.state !== 'ok') items.push({ kind: 'memory', id: memory.id, status });
    }
    const live = new Set(findScenes().map(x => x.id));
    for (const [id, record] of Object.entries(state.timeline)) {
        const status = live.has(id) ? sourceStatus(record) : { state: 'gone', ids: [] };
        if (status.state !== 'ok') items.push({ kind: 'scene', id, status });
    }
    return items;
}

/** Accepts a stale record as it is: re-fingerprints it against the messages that still exist. */
export async function acceptCurrent(kind, id) {
    const state = chatState();
    const record = kind === 'memory' ? state.memories.find(m => m.id === id) : state.timeline[id];
    const status = sourceStatus(record);
    if (!record || !status.ids?.length) return;
    Object.assign(record, sourcesOf(status.ids));
    if (kind === 'memory') {
        record.from = status.ids[0];
        record.to = status.ids.at(-1);
    } else {
        record.count = status.ids.length;
    }
    await ctx().saveMetadata();
    hooks.changed();
}

/** Re-summarizes a stale story entry from the messages that still exist. */
export async function resummarizeMemory(memoryId) {
    const memory = chatState().memories.find(m => m.id === memoryId);
    if (!memory) return;
    const ids = sourceStatus(memory).ids ?? [memory.from, memory.to];
    if (!ids.length) return;
    if (memory.parts?.length) {
        // A chapter is rebuilt from its parts' summaries.
        const text = memory.parts.map(p => `[Messages ${p.from}–${p.to}]\n${p.summary}`).join('\n\n');
        saving.add(memory.id);
        hooks.changed();
        try {
            const { parsed } = await summarize(settings().chapterPrompt, text);
            await writeMemoryEntry(memory, parsed.summary, parsed.keywords, sourcesOf(ids));
        } catch (error) {
            reportError(error, 'could not re-summarize');
        } finally {
            saving.delete(memory.id);
            hooks.changed();
        }
        return;
    }
    await saveMemory(Math.min(...ids), Math.max(...ids), { existing: memory });
}

let lastStale = { chat: null, count: 0, toast: null };

/** Tells the user once when edits or deletions make saved memories out of date. */
export function notifyStale() {
    const chatId = ctx().chatId;
    const count = staleItems().length;
    let toast = lastStale.toast;
    if (lastStale.chat === chatId && count > lastStale.count) {
        // Replace the previous warning rather than stacking them.
        if (toast) toastr.clear(toast);
        toast = toastr.warning(
            `${count} saved ${count === 1 ? 'memory no longer matches' : 'memories no longer match'} the chat because messages were edited or deleted. Click to review.`,
            'Private Scenes', { onclick: () => hooks.openMemory?.('timeline'), timeOut: 10000 });
    }
    lastStale = { chat: chatId, count, toast };
}

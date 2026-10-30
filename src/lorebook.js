// Lorebook timeline: summarizes private scenes and public story stretches into
// entries in the chat-bound lorebook.

import { createWorldInfoEntry } from '../../../../world-info.js';
import {
    BOOK_KEY, adoptScene, chatState, ctx, findScenes, formatMembers, formatTemplate, getFlag, hooks,
    newId, parseNames, revealedNames, settings,
} from './core.js';

// world_info_position.after (after character definitions)
const WI_AFTER_CHAR = 1;

const KEYWORDS_INSTRUCTION = 'After the summary, add one final line in the form "KEYWORDS: keyword1, keyword2, keyword3" '
    + 'listing 2 to 5 specific places, objects, or events from the text. Do not list character names or common words.';

/** Scene ids and memory ids currently being summarized. */
export const saving = new Set();

/** The chat-bound lorebook; creates and binds one when missing. */
export async function getBook(create) {
    const c = ctx();
    const existing = c.chatMetadata[BOOK_KEY];
    if (existing && c.getWorldInfoNames().includes(existing)) return existing;
    if (!create) return null;
    if (!c.chatId) throw new Error('Open a chat first.');

    const base = `Private Timeline - ${c.chatId}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 60);
    let name = base;
    for (let n = 2; c.getWorldInfoNames().includes(name); n++) name = `${base} ${n}`;

    await c.saveWorldInfo(name, { entries: {} }, true);
    await c.updateWorldInfoList();
    c.chatMetadata[BOOK_KEY] = name;
    await c.saveMetadata();
    $('.chat_lorebook_button').addClass('world_set');
    toastr.success(`Created lorebook "${name}" and linked it to this chat.`, 'Private Scenes');
    return name;
}

/** Splits a trailing "KEYWORDS: a, b" line off a summary. */
export function parseSummary(text) {
    const lines = String(text ?? '').trim().split('\n');
    let keywords = [];
    const index = lines.findLastIndex(line => /^\s*[*_]*keywords?[*_]*\s*:/i.test(line));
    if (index !== -1) {
        keywords = parseNames(lines[index].replace(/^\s*[*_]*keywords?[*_]*\s*:/i, '').replace(/[*_.]+$/g, ''));
        lines.splice(index, 1);
    }
    return { summary: lines.join('\n').trim(), keywords };
}

export const joinSummary = (summary, keywords) => keywords?.length ? `${summary}\n\nKEYWORDS: ${keywords.join(', ')}` : summary;

async function summarize(systemPrompt, transcript) {
    const instructions = settings().keywords ? `${systemPrompt}\n\n${KEYWORDS_INSTRUCTION}` : systemPrompt;
    const result = await ctx().generateRaw({ systemPrompt: instructions, prompt: transcript });
    const parsed = parseSummary(result);
    if (!parsed.summary) throw new Error('The model returned an empty summary.');
    return parsed;
}

function transcript(ids) {
    const chat = ctx().chat;
    return ids.map(id => `${chat[id].name}: ${chat[id].mes}`).join('\n\n');
}

/** Creates or updates an entry; returns its uid. */
async function upsertEntry(book, uid, fields) {
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`Could not load lorebook "${book}".`);
    let entry = uid !== undefined && uid !== null ? data.entries[uid] : null;
    entry ??= createWorldInfoEntry(book, data);
    if (!entry) throw new Error('Could not create a lorebook entry.');
    Object.assign(entry, { position: WI_AFTER_CHAR, addMemo: true, disable: false }, fields);
    await c.saveWorldInfo(book, data, true);
    c.reloadWorldInfoEditor(book);
    return entry.uid;
}

async function deleteEntry(book, uid) {
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    if (data?.entries?.[uid]) {
        delete data.entries[uid];
        await c.saveWorldInfo(book, data, true);
        c.reloadWorldInfoEditor(book);
    }
}

async function hideMessages(ids) {
    // Hide contiguous runs with one command each.
    const runs = [];
    for (const id of ids) {
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

// ─── Private scenes ──────────────────────────────────────────────────

/** Writes a scene's entry from a summary, using everyone who knows the secret now. */
export async function writeSceneEntry(scene, summary, keywords = []) {
    const s = settings();
    scene = adoptScene(scene);
    const timeline = chatState().timeline;
    const record = timeline[scene.id];
    const revealed = revealedNames(scene.id);

    const book = await getBook(true);
    const uid = await upsertEntry(book, record?.book === book ? record.uid : null, {
        // No scene number: numbers shift when an earlier message gets flagged later.
        comment: `🕵️ Private — ${formatMembers(scene.members)} (msgs ${scene.ids[0]}–${scene.ids.at(-1)})`,
        content: `${formatTemplate(s.labelStart, scene.members, revealed)}\n${summary}\n${formatTemplate(s.labelEnd, scene.members, revealed)}`,
        key: parseNames([...scene.members, ...revealed, ...keywords]),
        constant: !!s.entryConstant,
        // Chronological: later scenes sit closer to the end of the prompt.
        order: Number(s.entryOrder) + scene.ids[0],
    });

    timeline[scene.id] = {
        book, uid, summary, keywords: [...keywords], members: [...scene.members],
        count: scene.ids.length, savedAt: Date.now(),
    };
    await ctx().saveMetadata();
    if (s.hideAfterSave) await hideMessages(scene.ids.filter(id => !ctx().chat[id]?.is_system));
    hooks.changed();
    return scene;
}

/** Rewrites a saved scene's entry without re-summarizing (after a reveal changes). */
export async function refreshSceneEntry(sceneId) {
    const record = chatState().timeline[sceneId];
    const scene = findScenes().find(x => x.id === sceneId);
    if (!record || !scene) return;
    try {
        await writeSceneEntry(scene, record.summary, record.keywords);
    } catch (error) {
        reportError(error, 'could not update the lorebook entry');
    }
}

export async function saveScene(scene, { quiet = false } = {}) {
    if (saving.has(scene.id)) return;
    saving.add(scene.id);
    hooks.changed();
    try {
        const { summary, keywords } = await summarize(formatTemplate(settings().summaryPrompt, scene.members), transcript(scene.ids));
        await writeSceneEntry(scene, summary, keywords);
        if (!quiet) toastr.success(`Saved private scene #${scene.index} to the lorebook.`, 'Private Scenes');
        return summary;
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
    return chatState().names.filter(name => lower.includes(name.toLowerCase()));
}

export async function writeMemoryEntry(memory, summary, keywords = []) {
    const s = settings();
    const state = chatState();
    const book = await getBook(true);
    const uid = await upsertEntry(book, memory.book === book ? memory.uid : null, {
        comment: `📜 Story — msgs ${memory.from}–${memory.to}`,
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

/** Summarizes the public messages in [from, to] into a story entry. */
export async function saveMemory(from, to, { quiet = false, existing = null } = {}) {
    const ids = publicIds(from, to);
    const state = chatState();
    if (!ids.length) {
        if (!quiet) toastr.info('There are no public messages in that range to summarize.', 'Private Scenes');
        return;
    }
    const memory = existing ?? { id: newId('mem'), from, to };
    if (saving.has(memory.id)) return;
    saving.add(memory.id);
    hooks.changed();
    try {
        const { summary, keywords } = await summarize(settings().memoryPrompt, transcript(ids));
        await writeMemoryEntry(memory, summary, keywords);
        state.memoryCursor = Math.max(state.memoryCursor, to + 1);
        await ctx().saveMetadata();
        if (settings().hideAfterSave) await hideMessages(ids.filter(id => !ctx().chat[id]?.is_system));
        if (!quiet) toastr.success(`Saved messages ${from}–${to} to the lorebook as story memory.`, 'Private Scenes');
        return summary;
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
    if (memory.book) await deleteEntry(memory.book, memory.uid);
    state.memories = state.memories.filter(x => x.id !== memoryId);
    // Removing the newest memory lets "story so far" cover that stretch again.
    if (state.memoryCursor === memory.to + 1) state.memoryCursor = memory.from;
    await ctx().saveMetadata();
    hooks.changed();
}

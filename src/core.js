// Shared state, settings, names, message flags, scenes and reveals.
//
// Flags live in message.extra.private_scene = { members, sceneId } (saved in the chat file).
// Chat metadata (chatMetadata.privateScenes) holds the active scene, the names used,
// reveals per scene, and the timeline records for the lorebook.

export const MODULE = 'privateScenes';
export const FLAG = 'private_scene';
export const LEAK = 'ps_leak';
/** Stable id per message slot, so memories can find their source messages after edits and deletions. */
export const MID = 'ps_mid';
export const BOOK_KEY = 'world_info';

export const defaultSettings = Object.freeze({
    enabled: true,
    showBadges: true,
    inlineTags: true,
    labelStart: '[PRIVATE — known only to: {{members}}]',
    labelEnd: '[END PRIVATE]',
    rulesDepth: 1,
    rules: 'Some parts of this story are wrapped in [PRIVATE — known only to: ...] and [END PRIVATE]. '
        + 'Those events happened in private: only the listed characters saw, heard, or know about them. '
        + 'Every other character is completely unaware of them. Unlisted characters must not mention, hint at, react to, or act on that information, '
        + 'and must not guess it or "somehow" know it. They can only learn it if a listed character tells them, '
        + 'or if they discover it in a later part of the story that is not private. '
        + 'The listed characters remember it normally and may choose to keep it secret.',
    sceneRules: 'The scene happening right now is PRIVATE between {{members}}. Nobody else is present or can overhear it.',
    autoSave: true,
    hideAfterSave: false,
    entryConstant: false,
    entryOrder: 200,
    keywords: true,
    summaryPrompt: 'You are writing a memory entry for an ongoing roleplay. Summarize the PRIVATE scene below between {{members}}. '
        + 'Write 2 to 5 sentences in past tense. Keep every secret, confession, promise, plan, and change in the relationship. '
        + 'Use names instead of pronouns. Output only the summary, with no preamble.',
    autoMemory: false,
    memoryEvery: 20,
    memoryKeepRecent: 4,
    memoryConstant: false,
    memoryPrompt: 'You are writing a memory entry for an ongoing roleplay. Summarize the part of the story below. '
        + 'Write 3 to 6 sentences in past tense. Keep important events, decisions, promises, discoveries, and changes in relationships. '
        + 'Use names instead of pronouns. Output only the summary, with no preamble.',
    leakCheck: true,
    leakAutoRegenerate: false,
    reviewBeforeSave: false,
    consolidate: true,
    consolidateEvery: 5,
    consolidateKeep: 3,
    chapterPrompt: 'Combine these consecutive parts of a roleplay story into one shorter summary of 4 to 7 sentences in past tense. '
        + 'Keep major events, decisions, changes in relationships, and anything still unresolved. Drop minor details. '
        + 'Use names instead of pronouns. Output only the summary, with no preamble.',
    trackThreads: true,
    autoSheets: true,
    clockEnabled: true,
    clockAutoTrack: false,
});

export const ctx = () => SillyTavern.getContext();

/** Callbacks other modules plug in, so this module doesn't import the UI. */
export const hooks = {
    changed: () => { },
    sceneEnded: (_sceneId) => { },
    openMemory: (_tab) => { },
};

export function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= {};
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (all[MODULE][key] === undefined) all[MODULE][key] = value;
    }
    return all[MODULE];
}

export function chatState() {
    const meta = ctx().chatMetadata;
    meta[MODULE] ??= {};
    const state = meta[MODULE];
    state.scene ??= null;
    state.names ??= [];
    state.timeline ??= {};
    state.reveals ??= {};
    state.memories ??= [];
    state.memoryCursor ??= 0;
    state.drafts ??= [];
    state.facts ??= [];
    state.threads ??= [];
    state.sheets ??= {};
    state.clock ??= { time: '', place: '' };
    state.entries ??= {};
    return state;
}

export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let saveTimer = null;
export function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => ctx().saveChat(), 500);
}

// ─── Names ───────────────────────────────────────────────────────────

/** Split "Ana, Kael" into unique trimmed names (case-insensitive dedupe, first spelling wins). */
export function parseNames(input) {
    const raw = Array.isArray(input) ? input : String(input ?? '').split(',');
    const seen = new Set();
    const names = [];
    for (const part of raw) {
        const name = ctx().substituteParams(String(part)).trim();
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        names.push(name);
    }
    return names;
}

export function membersKey(members) {
    return members?.length ? members.map(x => x.toLowerCase()).sort().join('\u0000') : '';
}

export function formatMembers(members) {
    if (members.length <= 1) return members.join('');
    return `${members.slice(0, -1).join(', ')} and ${members.at(-1)}`;
}

/** "Ana and Kael" or "Ana and Kael, plus Bob who learned of it later". */
export function formatKnowers(members, revealed = []) {
    const base = formatMembers(members);
    return revealed.length ? `${base}, plus ${formatMembers(revealed)} who learned of it later` : base;
}

export function formatTemplate(template, members, revealed = []) {
    return String(template).replaceAll('{{members}}', formatKnowers(members, revealed));
}

export function rememberNames(members) {
    const state = chatState();
    state.names = parseNames([...state.names, ...members]);
}

/** Stable hue per name, so each character keeps the same chip color everywhere. */
export function nameHue(name) {
    let hash = 0;
    for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return hash % 360;
}

// ─── Message flags ───────────────────────────────────────────────────

/** @returns {{members: string[], sceneId?: string}|null} */
export function getFlag(message) {
    const flag = message?.extra?.[FLAG];
    return Array.isArray(flag?.members) && flag.members.length ? flag : null;
}

export const getMembers = (message) => getFlag(message)?.members ?? null;

/**
 * Flags a message (or clears it when flag is null). The flag is copied to
 * every swipe so it belongs to the message slot, not just the visible swipe.
 */
export function setFlag(message, flag) {
    const apply = (extra) => {
        if (flag) extra[FLAG] = { members: [...flag.members], sceneId: flag.sceneId };
        else delete extra[FLAG];
    };
    message.extra ??= {};
    apply(message.extra);
    if (Array.isArray(message.swipe_info)) {
        for (const info of message.swipe_info) {
            if (!info || typeof info !== 'object') continue;
            info.extra ??= {};
            apply(info.extra);
        }
    }
    if (flag) rememberNames(flag.members);
}

/** A new swipe starts with empty extras; carry the flag and message id over from its siblings. */
export function inheritSwipeFlag(message) {
    if (!message || !Array.isArray(message.swipe_info)) return;
    if (!getFlag(message)) {
        const flagged = message.swipe_info.find(info => getFlag(info));
        if (flagged) setFlag(message, getFlag(flagged));
    }
    if (!message.extra?.[MID]) {
        const mid = message.swipe_info.find(info => info?.extra?.[MID])?.extra[MID];
        if (mid) setMid(message, mid);
    }
}

// ─── Message ids & source tracking ───────────────────────────────────

function setMid(message, mid) {
    message.extra ??= {};
    message.extra[MID] = mid;
    for (const info of Array.isArray(message.swipe_info) ? message.swipe_info : []) {
        if (!info || typeof info !== 'object') continue;
        info.extra ??= {};
        info.extra[MID] = mid;
    }
}

export function ensureMid(message) {
    if (!message.extra?.[MID]) {
        setMid(message, newId('m'));
        saveSoon();
    }
    return message.extra[MID];
}

/** Small, stable string hash (djb2). */
export function hashText(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
    return hash.toString(36);
}

const textHash = (ids) => hashText(ids.map(id => ctx().chat[id]?.mes ?? '').join('\u0001'));

/** Fingerprint of the messages a memory was built from. */
export function sourcesOf(ids) {
    const chat = ctx().chat;
    return { sources: ids.map(id => ensureMid(chat[id])), hash: textHash(ids) };
}

/**
 * Whether a memory's source messages still match the chat.
 * state: 'ok' | 'edited' (text changed) | 'missing' (some deleted) | 'gone' (all deleted).
 * ids are the current positions of the sources that still exist.
 */
export function sourceStatus(record) {
    if (!record?.sources?.length) return { state: 'ok', ids: null };
    const positions = new Map();
    ctx().chat.forEach((message, i) => message.extra?.[MID] && positions.set(message.extra[MID], i));
    const ids = record.sources.map(mid => positions.get(mid)).filter(i => i !== undefined);
    if (!ids.length) return { state: 'gone', ids };
    if (ids.length < record.sources.length) return { state: 'missing', ids, missing: record.sources.length - ids.length };
    return { state: textHash(ids) === record.hash ? 'ok' : 'edited', ids };
}

/** Parse "12" or "12-18" into message ids; defaults to the last message. */
export function parseRange(at) {
    const chat = ctx().chat;
    if (at === undefined || at === null || String(at).trim() === '') {
        return chat.length ? [chat.length - 1] : [];
    }
    const match = String(at).trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error(`Invalid message id or range: "${at}"`);
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    const ids = [];
    for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
        if (i >= 0 && i < chat.length) ids.push(i);
    }
    if (!ids.length) throw new Error(`No messages found at "${at}"`);
    return ids;
}

/**
 * Flags messages for these members. Joins the scene of a neighbouring message
 * with the same members, otherwise starts a new scene. Returns the scene id.
 */
export function flagMessages(ids, members) {
    const chat = ctx().chat;
    let sceneId = null;
    if (!members.length) {
        ids.forEach(id => chat[id] && setFlag(chat[id], null));
    } else {
        const key = membersKey(members);
        const neighbour = [ids[0] - 1, ids.at(-1) + 1]
            .map(id => getFlag(chat[id]))
            .find(flag => flag?.sceneId && membersKey(flag.members) === key);
        sceneId = neighbour?.sceneId ?? newId('ps');
        ids.forEach(id => chat[id] && setFlag(chat[id], { members, sceneId }));
    }
    saveSoon();
    hooks.changed();
    return sceneId;
}

// ─── Scenes ──────────────────────────────────────────────────────────

export function getScene() {
    const scene = chatState().scene;
    return scene?.members?.length ? scene : null;
}

export function startScene(members) {
    if (!members.length) return endScene();
    const current = getScene();
    const sceneId = current && membersKey(current.members) === membersKey(members) ? current.sceneId : newId('ps');
    if (current && current.sceneId !== sceneId) hooks.sceneEnded(current.sceneId);
    chatState().scene = { members: [...members], sceneId };
    rememberNames(members);
    ctx().saveMetadataDebounced();
    hooks.changed();
}

export function endScene() {
    const scene = getScene();
    chatState().scene = null;
    ctx().saveMetadataDebounced();
    hooks.changed();
    if (scene) hooks.sceneEnded(scene.sceneId);
}

/**
 * Groups flagged messages into scenes, oldest first. Flags from version 0.1
 * have no sceneId; consecutive ones with the same members form one scene.
 * @returns {{id: string, index: number, members: string[], ids: number[], legacy: boolean}[]}
 */
export function findScenes() {
    const chat = ctx().chat;
    const scenes = new Map();
    let legacyRun = null;
    for (let i = 0; i < chat.length; i++) {
        const flag = getFlag(chat[i]);
        if (!flag) {
            legacyRun = null;
            continue;
        }
        let id = flag.sceneId;
        if (!id) {
            const key = membersKey(flag.members);
            if (legacyRun?.key !== key) legacyRun = { key, id: `legacy_${i}` };
            id = legacyRun.id;
        } else {
            legacyRun = null;
        }
        if (!scenes.has(id)) scenes.set(id, { id, members: flag.members, ids: [], legacy: !flag.sceneId });
        scenes.get(id).ids.push(i);
    }
    return [...scenes.values()].map((scene, i) => ({ ...scene, index: i + 1 }));
}

/** The scene containing a message id, or the latest scene. */
export function sceneAt(at) {
    const scenes = findScenes();
    if (at === undefined || at === null || String(at).trim() === '') return scenes.at(-1) ?? null;
    const id = parseRange(at)[0];
    return scenes.find(x => x.ids.includes(id)) ?? null;
}

/** Gives legacy scenes a real id so their records survive edits. */
export function adoptScene(scene) {
    if (!scene.legacy) return scene;
    const sceneId = newId('ps');
    for (const id of scene.ids) setFlag(ctx().chat[id], { members: scene.members, sceneId });
    const state = chatState();
    if (state.reveals[scene.id]) {
        state.reveals[sceneId] = state.reveals[scene.id];
        delete state.reveals[scene.id];
    }
    saveSoon();
    return { ...scene, id: sceneId, legacy: false };
}

// ─── Reveals ─────────────────────────────────────────────────────────

/** @returns {{name: string, at: number}[]} who learned the secret later, and at which message */
export function getReveals(sceneId) {
    return chatState().reveals[sceneId] ?? [];
}

/** Names that learned the secret at or before a message id. */
export function revealedNames(sceneId, uptoId = Infinity) {
    return getReveals(sceneId).filter(r => r.at <= uptoId).map(r => r.name);
}

/**
 * Replaces the reveal list for a scene. Names already revealed keep their
 * original message; new ones are dated to the latest message.
 */
export function setRevealedNames(scene, names) {
    const state = chatState();
    const existing = new Map(getReveals(scene.id).map(r => [r.name.toLowerCase(), r]));
    const memberKeys = new Set(scene.members.map(x => x.toLowerCase()));
    const at = Math.max(0, ctx().chat.length - 1);
    const reveals = parseNames(names)
        .filter(name => !memberKeys.has(name.toLowerCase()))
        .map(name => existing.get(name.toLowerCase()) ?? { name, at });
    if (reveals.length) state.reveals[scene.id] = reveals;
    else delete state.reveals[scene.id];
    rememberNames(reveals.map(r => r.name));
    ctx().saveMetadataDebounced();
}

/** Every character name known to this chat: picker history plus scene members and reveals. */
export function allNames() {
    const names = [...chatState().names];
    for (const scene of findScenes()) names.push(...scene.members, ...revealedNames(scene.id));
    return parseNames(names);
}

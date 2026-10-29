// Private Scenes — flag messages as private between certain characters, so the
// narrator knows those events happened out of everyone else's sight, and keep a
// timeline of those scenes as lorebook entries.
//
// Flags live in message.extra.private_scene = { members, sceneId } (saved in the chat file).
// The active scene, names used, and the timeline (scene → lorebook entry) live in chat metadata.
// At generation time the interceptor wraps each run of private messages in labels
// and injects a rules prompt explaining what the labels mean.

import { createWorldInfoEntry } from '../../../world-info.js';

const MODULE = 'privateScenes';
const FLAG = 'private_scene';
const PROMPT_KEY = 'private_scenes_rules';
const BOOK_KEY = 'world_info';

// extension_prompt_types.IN_CHAT / extension_prompt_roles.SYSTEM
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
// world_info_position.after (after character definitions)
const WI_AFTER_CHAR = 1;

const defaultSettings = Object.freeze({
    enabled: true,
    showBadges: true,
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
    summaryPrompt: 'You are writing a memory entry for an ongoing roleplay. Summarize the PRIVATE scene below between {{members}}. '
        + 'Write 2 to 5 sentences in past tense. Keep every secret, confession, promise, plan, and change in the relationship. '
        + 'Use names instead of pronouns. Output only the summary, with no preamble.',
});

const ctx = () => SillyTavern.getContext();

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] ??= {};
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (all[MODULE][key] === undefined) all[MODULE][key] = value;
    }
    return all[MODULE];
}

function chatState() {
    const meta = ctx().chatMetadata;
    meta[MODULE] ??= {};
    meta[MODULE].scene ??= null;
    meta[MODULE].names ??= [];
    meta[MODULE].timeline ??= {};
    return meta[MODULE];
}

const newSceneId = () => `ps_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ─── Names ───────────────────────────────────────────────────────────

/** Split "Ana, Kael" into unique trimmed names (case-insensitive dedupe, first spelling wins). */
function parseNames(input) {
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

function membersKey(members) {
    return members?.length ? members.map(x => x.toLowerCase()).sort().join('\u0000') : '';
}

function formatMembers(members) {
    if (members.length <= 1) return members.join('');
    return `${members.slice(0, -1).join(', ')} and ${members.at(-1)}`;
}

function formatTemplate(template, members) {
    return String(template).replaceAll('{{members}}', formatMembers(members));
}

function rememberNames(members) {
    const state = chatState();
    state.names = parseNames([...state.names, ...members]);
}

/** Stable hue per name, so each character keeps the same chip color everywhere. */
function nameHue(name) {
    let hash = 0;
    for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return hash % 360;
}

function chip(name, tag = 'span') {
    const el = document.createElement(tag);
    el.classList.add('ps-chip');
    el.style.setProperty('--ps-hue', String(nameHue(name)));
    el.textContent = name;
    return el;
}

function chips(members) {
    const wrap = document.createElement('span');
    wrap.classList.add('ps-chips');
    wrap.append(...members.map(name => chip(name)));
    return wrap;
}

// ─── Message flags ───────────────────────────────────────────────────

/** @returns {{members: string[], sceneId?: string}|null} */
function getFlag(message) {
    const flag = message?.extra?.[FLAG];
    return Array.isArray(flag?.members) && flag.members.length ? flag : null;
}

const getMembers = (message) => getFlag(message)?.members ?? null;

/**
 * Flags a message (or clears it when flag is null). The flag is copied to
 * every swipe so it belongs to the message slot, not just the visible swipe.
 */
function setFlag(message, flag) {
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

/** A new swipe starts with empty extras; carry the flag over from its siblings. */
function inheritSwipeFlag(message) {
    if (!message || getFlag(message) || !Array.isArray(message.swipe_info)) return;
    const flagged = message.swipe_info.find(info => getFlag(info));
    if (flagged) setFlag(message, getFlag(flagged));
}

let saveTimer = null;
function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => ctx().saveChat(), 500);
}

/** Parse "12" or "12-18" into message ids; defaults to the last message. */
function parseRange(at) {
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
        if (i >= 0 && i < ctx().chat.length) ids.push(i);
    }
    if (!ids.length) throw new Error(`No messages found at "${at}"`);
    return ids;
}

/**
 * Flags messages for these members. Joins the scene of a neighbouring message
 * with the same members, otherwise starts a new scene.
 */
function flagMessages(ids, members) {
    const chat = ctx().chat;
    if (!members.length) {
        ids.forEach(id => chat[id] && setFlag(chat[id], null));
    } else {
        const key = membersKey(members);
        const neighbour = [ids[0] - 1, ids.at(-1) + 1]
            .map(id => getFlag(chat[id]))
            .find(flag => flag?.sceneId && membersKey(flag.members) === key);
        const sceneId = neighbour?.sceneId ?? newSceneId();
        ids.forEach(id => chat[id] && setFlag(chat[id], { members, sceneId }));
    }
    saveSoon();
    refreshUi();
}

// ─── Scenes ──────────────────────────────────────────────────────────

function getScene() {
    const scene = chatState().scene;
    return scene?.members?.length ? scene : null;
}

function startScene(members) {
    if (!members.length) return endScene();
    const current = getScene();
    const sceneId = current && membersKey(current.members) === membersKey(members) ? current.sceneId : newSceneId();
    if (current && current.sceneId !== sceneId) maybeAutoSave(current.sceneId);
    chatState().scene = { members: [...members], sceneId };
    rememberNames(members);
    ctx().saveMetadataDebounced();
    refreshUi();
}

function endScene() {
    const scene = getScene();
    chatState().scene = null;
    ctx().saveMetadataDebounced();
    refreshUi();
    if (scene) maybeAutoSave(scene.sceneId);
}

function onNewMessage(id, type) {
    const message = ctx().chat[id];
    if (!message || message.is_system || type === 'first_message') return;
    const scene = getScene();
    if (scene) {
        scene.sceneId ??= newSceneId();
        setFlag(message, { members: scene.members, sceneId: scene.sceneId });
    } else {
        inheritSwipeFlag(message);
    }
    saveSoon();
    refreshUi();
}

function onSwiped(id) {
    inheritSwipeFlag(ctx().chat[id]);
    refreshUi();
}

/**
 * Groups flagged messages into scenes, oldest first. Flags from version 0.1
 * have no sceneId; consecutive ones with the same members form one scene.
 * @returns {{id: string, index: number, members: string[], ids: number[], legacy: boolean}[]}
 */
function findScenes() {
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

/** Gives legacy scenes a real id so their timeline record survives edits. */
function adoptScene(scene) {
    if (!scene.legacy) return scene;
    const sceneId = newSceneId();
    for (const id of scene.ids) setFlag(ctx().chat[id], { members: scene.members, sceneId });
    saveSoon();
    return { ...scene, id: sceneId, legacy: false };
}

// ─── Lorebook timeline ───────────────────────────────────────────────

/** The chat-bound lorebook; creates and binds one when missing. */
async function getBook(create) {
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

function transcript(scene) {
    const chat = ctx().chat;
    return scene.ids.map(id => `${chat[id].name}: ${chat[id].mes}`).join('\n\n');
}

async function summarize(scene) {
    const s = settings();
    const result = await ctx().generateRaw({
        systemPrompt: formatTemplate(s.summaryPrompt, scene.members),
        prompt: transcript(scene),
    });
    const summary = String(result ?? '').trim();
    if (!summary) throw new Error('The model returned an empty summary.');
    return summary;
}

function entryTitle(scene) {
    // No scene number: numbers shift when an earlier message gets flagged later.
    return `🕵️ Private — ${formatMembers(scene.members)} (msgs ${scene.ids[0]}–${scene.ids.at(-1)})`;
}

/** Creates or updates the lorebook entry for a scene and records it in the timeline. */
async function writeEntry(scene, summary) {
    const c = ctx();
    const s = settings();
    scene = adoptScene(scene);
    const timeline = chatState().timeline;
    const record = timeline[scene.id];

    const book = await getBook(true);
    const data = await c.loadWorldInfo(book);
    if (!data?.entries) throw new Error(`Could not load lorebook "${book}".`);
    let entry = record?.book === book ? data.entries[record.uid] : null;
    entry ??= createWorldInfoEntry(book, data);
    if (!entry) throw new Error('Could not create a lorebook entry.');

    Object.assign(entry, {
        comment: entryTitle(scene),
        content: `${formatTemplate(s.labelStart, scene.members)}\n${summary}\n${formatTemplate(s.labelEnd, scene.members)}`,
        key: [...scene.members],
        constant: !!s.entryConstant,
        // Chronological: later scenes sit closer to the end of the prompt.
        order: Number(s.entryOrder) + scene.ids[0],
        position: WI_AFTER_CHAR,
        addMemo: true,
        disable: false,
    });
    await c.saveWorldInfo(book, data, true);
    c.reloadWorldInfoEditor(book);

    timeline[scene.id] = { book, uid: entry.uid, summary, members: [...scene.members], count: scene.ids.length, savedAt: Date.now() };
    await c.saveMetadata();

    if (s.hideAfterSave) await hideMessages(scene.ids);
    refreshUi();
    return scene;
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

const saving = new Set();

async function saveScene(scene, { quiet = false } = {}) {
    if (saving.has(scene.id)) return;
    saving.add(scene.id);
    refreshTimeline();
    try {
        const summary = await summarize(scene);
        await writeEntry(scene, summary);
        if (!quiet) toastr.success(`Saved private scene #${scene.index} to the lorebook.`, 'Private Scenes');
        return summary;
    } catch (error) {
        console.error('[Private Scenes] Saving scene failed', error);
        toastr.error(String(error?.message ?? error), 'Private Scenes: could not save scene');
    } finally {
        saving.delete(scene.id);
        refreshTimeline();
    }
}

function maybeAutoSave(sceneId) {
    if (!settings().autoSave || !settings().enabled) return;
    const scene = findScenes().find(x => x.id === sceneId);
    if (scene) saveScene(scene);
}

async function removeEntry(sceneId) {
    const c = ctx();
    const timeline = chatState().timeline;
    const record = timeline[sceneId];
    if (!record) return;
    const data = await c.loadWorldInfo(record.book);
    if (data?.entries?.[record.uid]) {
        delete data.entries[record.uid];
        await c.saveWorldInfo(record.book, data, true);
        c.reloadWorldInfoEditor(record.book);
    }
    delete timeline[sceneId];
    await c.saveMetadata();
    refreshUi();
}

const hasSavedEntries = () => Object.keys(chatState().timeline).length > 0;

// ─── Prompt ──────────────────────────────────────────────────────────

/**
 * Generate interceptor: wraps each consecutive run of messages that share the
 * same members in start/end labels. Entries are replaced with copies so the
 * saved chat is never modified.
 */
globalThis.privateScenesInterceptor = async function (chat, _contextSize, _abort, type) {
    const s = settings();
    if (!s.enabled) {
        ctx().setExtensionPrompt(PROMPT_KEY, '', IN_CHAT, 0);
        return;
    }

    const scene = getScene();
    const sceneKey = membersKey(scene?.members);
    let anyPrivate = false;

    for (let i = 0; i < chat.length; i++) {
        const members = getMembers(chat[i]);
        if (!members) continue;
        anyPrivate = true;

        const key = membersKey(members);
        const isLast = i === chat.length - 1;
        const prevSame = i > 0 && membersKey(getMembers(chat[i - 1])) === key;
        const nextSame = !isLast && membersKey(getMembers(chat[i + 1])) === key;
        // Leave the run open when the reply being written continues it.
        const keepOpen = isLast && (type === 'continue' || key === sceneKey);

        let mes = chat[i].mes;
        if (!prevSame) mes = `${formatTemplate(s.labelStart, members)}\n${mes}`;
        if (!nextSame && !keepOpen) mes = `${mes}\n${formatTemplate(s.labelEnd, members)}`;
        chat[i] = { ...chat[i], mes };
    }

    const parts = [];
    if (anyPrivate || scene || hasSavedEntries()) parts.push(s.rules);
    if (scene) parts.push(formatTemplate(s.sceneRules, scene.members));
    ctx().setExtensionPrompt(PROMPT_KEY, parts.join('\n'), IN_CHAT, Number(s.rulesDepth) || 0, false, ROLE_SYSTEM);
};

// ─── UI: member picker ───────────────────────────────────────────────

function popupHeader(icon, title, subtitle) {
    const header = $(`
        <div class="ps-popup-header">
            <div class="ps-popup-icon"><i class="fa-solid"></i></div>
            <div><h3></h3><p></p></div>
        </div>`);
    header.find('i').addClass(icon);
    header.find('h3').text(title);
    header.find('p').text(subtitle);
    return header[0];
}

function chipToggle(name, checked) {
    const label = document.createElement('label');
    label.classList.add('ps-chip-toggle');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = name;
    box.checked = checked;
    const pill = chip(name);
    pill.prepend(Object.assign(document.createElement('i'), { className: 'fa-solid fa-check ps-check' }));
    label.append(box, pill);
    return label;
}

/** Popup with a toggle chip per known name plus a field for new names. Returns null on cancel. */
async function pickMembers(title, current = []) {
    const c = ctx();
    const known = parseNames([...current, ...chatState().names, c.name1]);
    const currentKeys = new Set(current.map(x => x.toLowerCase()));

    const root = document.createElement('div');
    root.classList.add('ps-popup');
    root.append(popupHeader('fa-user-secret', title, 'Only the characters you pick will know about this.'));

    const grid = document.createElement('div');
    grid.classList.add('ps-chip-grid');
    for (const name of known) grid.append(chipToggle(name, currentKeys.has(name.toLowerCase())));
    root.append(grid);

    const addRow = $(`
        <div class="ps-add-row">
            <input type="text" class="text_pole" placeholder="Add a character… (comma separates several)">
            <div class="menu_button menu_button_icon"><i class="fa-solid fa-plus"></i><span>Add</span></div>
        </div>`);
    const input = addRow.find('input');
    const add = () => {
        const existing = new Set([...grid.querySelectorAll('input')].map(x => x.value.toLowerCase()));
        for (const name of parseNames(input.val())) {
            if (existing.has(name.toLowerCase())) {
                const box = [...grid.querySelectorAll('input')].find(x => x.value.toLowerCase() === name.toLowerCase());
                if (box) box.checked = true;
                continue;
            }
            grid.append(chipToggle(name, true));
        }
        input.val('').trigger('focus');
    };
    addRow.find('.menu_button').on('click', add);
    input.on('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            add();
        }
    });
    root.append(addRow[0]);

    const hint = document.createElement('small');
    hint.classList.add('ps-hint');
    hint.textContent = 'Deselect everyone to make it public again.';
    root.append(hint);

    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel' });
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return null;

    const checked = [...grid.querySelectorAll('input:checked')].map(x => x.value);
    return parseNames([...checked, ...String(input.val()).split(',')]);
}

async function onMessageButtonClick(event) {
    const id = Number($(event.currentTarget).closest('.mes').attr('mesid'));
    const message = ctx().chat[id];
    if (!message) return;
    const members = await pickMembers('Who knows about this?', getMembers(message) ?? getScene()?.members ?? []);
    if (members === null) return;
    flagMessages([id], members);
}

async function onSceneButtonClick() {
    const members = await pickMembers(getScene() ? 'Edit private scene' : 'Start a private scene', getScene()?.members ?? []);
    if (members === null) return;
    startScene(members);
}

// ─── UI: timeline ────────────────────────────────────────────────────

let timelineRoot = null;

function sceneStatus(scene) {
    const record = chatState().timeline[scene.id];
    if (saving.has(scene.id)) return { cls: 'saving', icon: 'fa-spinner fa-spin', text: 'Saving…' };
    if (!record) return { cls: 'unsaved', icon: 'fa-circle-dot', text: 'Not saved' };
    if (record.count !== scene.ids.length || membersKey(record.members) !== membersKey(scene.members)) {
        return { cls: 'changed', icon: 'fa-rotate', text: 'Changed since saved' };
    }
    return { cls: 'saved', icon: 'fa-book-bookmark', text: 'In lorebook' };
}

function renderTimelineCard(scene) {
    const record = chatState().timeline[scene.id];
    const status = sceneStatus(scene);
    const first = ctx().chat[scene.ids[0]];
    const range = scene.ids.length > 1 ? `Messages ${scene.ids[0]}–${scene.ids.at(-1)}` : `Message ${scene.ids[0]}`;

    const item = $(`
        <li class="ps-tl-item">
            <div class="ps-tl-node"></div>
            <div class="ps-tl-card">
                <div class="ps-tl-top">
                    <span class="ps-tl-title"></span>
                    <span class="ps-tl-range"></span>
                    <span class="ps-status"><i class="fa-solid"></i><span></span></span>
                </div>
                <div class="ps-tl-members"></div>
                <p class="ps-tl-summary"></p>
                <div class="ps-tl-actions">
                    <div class="menu_button menu_button_icon ps-act-jump" title="Scroll to this scene"><i class="fa-solid fa-location-arrow"></i><span>Jump</span></div>
                    <div class="menu_button menu_button_icon ps-act-save"><i class="fa-solid fa-wand-magic-sparkles"></i><span></span></div>
                    <div class="menu_button menu_button_icon ps-act-edit" title="Edit the saved summary"><i class="fa-solid fa-pen"></i><span>Edit</span></div>
                    <div class="menu_button menu_button_icon ps-act-remove" title="Remove this scene's lorebook entry"><i class="fa-solid fa-trash-can"></i></div>
                </div>
            </div>
        </li>`);
    item.addClass(`ps-${status.cls}`);
    item.find('.ps-tl-title').text(`Scene ${scene.index}`);
    item.find('.ps-tl-range').text(`${range} · ${scene.ids.length} msg${scene.ids.length === 1 ? '' : 's'}`);
    item.find('.ps-status').addClass(`ps-status-${status.cls}`);
    item.find('.ps-status i').addClass(status.icon);
    item.find('.ps-status span').text(status.text);
    item.find('.ps-tl-members').append(chips(scene.members));

    const summary = item.find('.ps-tl-summary');
    if (record?.summary) {
        summary.text(record.summary);
    } else {
        const preview = String(first?.mes ?? '').replace(/\s+/g, ' ');
        summary.addClass('ps-preview').text(preview.length > 180 ? `${preview.slice(0, 180)}…` : preview);
    }

    item.find('.ps-act-save span').text(record ? 'Re-summarize' : 'Save to lorebook');
    item.find('.ps-act-save').toggleClass('disabled', saving.has(scene.id));
    item.find('.ps-act-edit, .ps-act-remove').toggle(!!record);

    item.find('.ps-act-jump').on('click', async () => {
        await ctx().executeSlashCommandsWithOptions(`/chat-jump ${scene.ids[0]}`, { showOutput: false });
    });
    item.find('.ps-act-save').on('click', () => saveScene(scene));
    item.find('.ps-act-edit').on('click', async () => {
        const c = ctx();
        const text = await c.callGenericPopup('Edit the summary saved in the lorebook:', c.POPUP_TYPE.INPUT, record.summary, { rows: 8, wide: true });
        if (typeof text !== 'string' || !text.trim()) return;
        try {
            await writeEntry(scene, text.trim());
        } catch (error) {
            toastr.error(String(error?.message ?? error), 'Private Scenes');
        }
    });
    item.find('.ps-act-remove').on('click', async () => {
        const c = ctx();
        const ok = await c.callGenericPopup(`Remove scene ${scene.index} from the lorebook? The chat messages stay flagged.`, c.POPUP_TYPE.CONFIRM);
        if (ok === c.POPUP_RESULT.AFFIRMATIVE) await removeEntry(scene.id);
    });
    return item;
}

function refreshTimeline() {
    if (!timelineRoot) return;
    const scenes = findScenes();
    const saved = scenes.filter(x => chatState().timeline[x.id]).length;
    const book = ctx().chatMetadata[BOOK_KEY];

    const body = $(timelineRoot).find('.ps-tl-body').empty();
    $(timelineRoot).find('.ps-popup-header p').text(scenes.length
        ? `${scenes.length} private scene${scenes.length === 1 ? '' : 's'} · ${saved} saved${book ? ` to “${book}”` : ''}`
        : 'Secrets kept in this chat, in story order.');

    if (!scenes.length) {
        body.append(`
            <div class="ps-empty">
                <i class="fa-solid fa-user-secret"></i>
                <b>No private scenes yet</b>
                <span>Flag a message with the <i class="fa-solid fa-user-secret"></i> button, or start a private scene from the bar above the chat box.</span>
            </div>`);
        return;
    }

    const unsaved = scenes.filter(x => sceneStatus(x).cls !== 'saved' && !saving.has(x.id));
    if (unsaved.length) {
        const all = $('<div class="menu_button menu_button_icon ps-save-all"><i class="fa-solid fa-book-medical"></i><span></span></div>');
        all.find('span').text(`Save ${unsaved.length} scene${unsaved.length === 1 ? '' : 's'} to lorebook`);
        all.on('click', async () => {
            for (const scene of unsaved) await saveScene(scene, { quiet: true });
            toastr.success('Timeline saved to the lorebook.', 'Private Scenes');
        });
        body.append(all);
    }

    const list = $('<ol class="ps-timeline"></ol>');
    scenes.forEach(scene => list.append(renderTimelineCard(scene)));
    body.append(list);
}

async function openTimeline() {
    const c = ctx();
    timelineRoot = document.createElement('div');
    timelineRoot.classList.add('ps-popup', 'ps-timeline-popup');
    timelineRoot.append(popupHeader('fa-timeline', 'Private Timeline', ''));
    timelineRoot.append(Object.assign(document.createElement('div'), { className: 'ps-tl-body' }));
    refreshTimeline();
    await c.callGenericPopup(timelineRoot, c.POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, okButton: 'Close' });
    timelineRoot = null;
}

// ─── UI: chat decorations ────────────────────────────────────────────

function refreshUi() {
    const chat = ctx().chat;
    const s = settings();

    $('#chat .mes').each(function () {
        const message = chat[Number($(this).attr('mesid'))];
        const members = s.enabled ? getMembers(message) : null;
        $(this).toggleClass('ps-private', !!members);
        $(this).find('.ps-badge').remove();
        if (members && s.showBadges) {
            const badge = $('<div class="ps-badge"><span class="ps-badge-label"><i class="fa-solid fa-user-secret"></i>Private</span></div>');
            badge.append(chips(members));
            $(this).find('.mes_text').before(badge);
        }
    });

    const scene = getScene();
    $('#ps_scene_bar').toggleClass('ps-visible', !!scene && s.enabled);
    $('#ps_scene_bar .ps-chips').replaceWith(chips(scene?.members ?? []));
    const status = $('#ps_scene_status').empty();
    if (scene) status.append('<span>Active: </span>', chips(scene.members));
    else status.text('No private scene running.');
    $('#ps_end_scene').toggle(!!scene);

    refreshTimeline();
}

function addMessageButton() {
    const button = '<div title="Private: choose who knows about this" class="mes_button ps_toggle fa-solid fa-user-secret"></div>';
    $('#message_template .extraMesButtons').prepend(button);
    // Messages rendered before this extension loaded.
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.ps_toggle').length) $(this).prepend(button);
    });
    $(document).on('click', '.ps_toggle', onMessageButtonClick);
}

function addSceneBar() {
    const bar = $(`
        <div id="ps_scene_bar">
            <span class="ps-pulse"></span>
            <span class="ps-bar-title"><i class="fa-solid fa-user-secret"></i>Private scene</span>
            <span class="ps-chips"></span>
            <span class="ps-bar-spacer"></span>
            <div class="ps-bar-button ps-scene-edit" title="Change who is in this scene"><i class="fa-solid fa-user-pen"></i></div>
            <div class="ps-bar-button ps-scene-timeline" title="Open the private timeline"><i class="fa-solid fa-timeline"></i></div>
            <div class="ps-bar-button ps-scene-end" title="End the scene (and save it to the lorebook if auto-save is on)"><i class="fa-solid fa-door-open"></i><span>End scene</span></div>
        </div>`);
    $('#send_form').before(bar);
    bar.find('.ps-scene-edit').on('click', onSceneButtonClick);
    bar.find('.ps-scene-timeline').on('click', openTimeline);
    bar.find('.ps-scene-end').on('click', endScene);
}

function addWandMenuItems() {
    const items = $(`
        <div class="list-group-item flex-container flexGap5 interactable" id="ps_wand_scene" tabindex="0">
            <div class="fa-solid fa-user-secret extensionsMenuExtensionButton"></div><span>Private scene…</span>
        </div>
        <div class="list-group-item flex-container flexGap5 interactable" id="ps_wand_timeline" tabindex="0">
            <div class="fa-solid fa-timeline extensionsMenuExtensionButton"></div><span>Private timeline</span>
        </div>`);
    $('#extensionsMenu').append(items);
    $('#ps_wand_scene').on('click', onSceneButtonClick);
    $('#ps_wand_timeline').on('click', openTimeline);
}

function addSettingsPanel() {
    const html = $(`
        <div class="private-scenes-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-user-secret"></i> Private Scenes</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="ps-section">
                        <label class="checkbox_label"><input id="ps_enabled" type="checkbox"> <span>Enabled</span></label>
                        <label class="checkbox_label"><input id="ps_show_badges" type="checkbox"> <span>Show the “Private” badge on messages</span></label>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-masks-theater"></i> This chat</div>
                        <div id="ps_scene_status"></div>
                        <div class="ps-button-row">
                            <div id="ps_start_scene" class="menu_button menu_button_icon"><i class="fa-solid fa-user-secret"></i><span>Start / edit scene</span></div>
                            <div id="ps_end_scene" class="menu_button menu_button_icon"><i class="fa-solid fa-door-open"></i><span>End scene</span></div>
                            <div id="ps_open_timeline" class="menu_button menu_button_icon"><i class="fa-solid fa-timeline"></i><span>Timeline</span></div>
                        </div>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-book-bookmark"></i> Lorebook timeline</div>
                        <label class="checkbox_label"><input id="ps_auto_save" type="checkbox"> <span>Summarize scenes into the lorebook when they end</span></label>
                        <label class="checkbox_label"><input id="ps_hide_after_save" type="checkbox"> <span>Hide the original messages after saving</span></label>
                        <label class="checkbox_label"><input id="ps_entry_constant" type="checkbox"> <span>Always include entries (otherwise: when a member is mentioned)</span></label>
                        <small>Entries go into the chat's lorebook. One is created and linked to the chat if it has none.</small>
                        <label for="ps_summary_prompt">Summary instructions</label>
                        <textarea id="ps_summary_prompt" class="text_pole textarea_compact" rows="4"></textarea>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-scroll"></i> Prompt</div>
                        <label for="ps_rules">Rules sent to the model</label>
                        <textarea id="ps_rules" class="text_pole textarea_compact" rows="5"></textarea>
                        <label for="ps_scene_rules">Active scene note (<code>{{members}}</code> = names)</label>
                        <textarea id="ps_scene_rules" class="text_pole textarea_compact" rows="2"></textarea>
                        <div class="ps-grid-2">
                            <div>
                                <label for="ps_label_start">Start label</label>
                                <input id="ps_label_start" class="text_pole" type="text">
                            </div>
                            <div>
                                <label for="ps_label_end">End label</label>
                                <input id="ps_label_end" class="text_pole" type="text">
                            </div>
                        </div>
                        <label for="ps_rules_depth">Rules depth (0 = after the last message)</label>
                        <input id="ps_rules_depth" class="text_pole" type="number" min="0" max="100">
                        <div id="ps_reset" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate-left"></i><span>Restore default text</span></div>
                    </div>
                </div>
            </div>
        </div>`);
    $('#extensions_settings2').append(html);

    const s = settings();
    const checkboxes = {
        '#ps_enabled': 'enabled',
        '#ps_show_badges': 'showBadges',
        '#ps_auto_save': 'autoSave',
        '#ps_hide_after_save': 'hideAfterSave',
        '#ps_entry_constant': 'entryConstant',
    };
    const fields = {
        '#ps_rules': 'rules',
        '#ps_scene_rules': 'sceneRules',
        '#ps_rules_depth': 'rulesDepth',
        '#ps_label_start': 'labelStart',
        '#ps_label_end': 'labelEnd',
        '#ps_summary_prompt': 'summaryPrompt',
    };
    const load = () => {
        for (const [selector, key] of Object.entries(checkboxes)) $(selector).prop('checked', s[key]);
        for (const [selector, key] of Object.entries(fields)) $(selector).val(s[key]);
    };
    load();

    for (const [selector, key] of Object.entries(checkboxes)) {
        $(selector).on('change', function () {
            s[key] = !!$(this).prop('checked');
            ctx().saveSettingsDebounced();
            refreshUi();
        });
    }
    for (const [selector, key] of Object.entries(fields)) {
        $(selector).on('input', function () {
            s[key] = key === 'rulesDepth' ? Number($(this).val()) || 0 : String($(this).val());
            ctx().saveSettingsDebounced();
        });
    }
    $('#ps_reset').on('click', () => {
        for (const key of Object.values(fields)) s[key] = defaultSettings[key];
        ctx().saveSettingsDebounced();
        load();
    });
    $('#ps_start_scene').on('click', onSceneButtonClick);
    $('#ps_end_scene').on('click', endScene);
    $('#ps_open_timeline').on('click', openTimeline);
}

// ─── Slash commands ──────────────────────────────────────────────────

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx();
    const atArg = (description = 'Message id or range, e.g. 12 or 12-18. Defaults to the last message.') => SlashCommandNamedArgument.fromProps({
        name: 'at',
        description,
        typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
    });
    const namesArg = (isRequired) => SlashCommandArgument.fromProps({
        description: 'Characters who know, comma separated, e.g. Ana, Kael',
        typeList: [ARGUMENT_TYPE.STRING],
        isRequired,
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'private',
        helpString: 'Marks messages as private between the named characters. Example: <code>/private at=12-18 Ana, Kael</code>',
        namedArgumentList: [atArg()],
        unnamedArgumentList: [namesArg(true)],
        callback: (args, value) => {
            const members = parseNames(value);
            if (!members.length) throw new Error('/private needs at least one name.');
            flagMessages(parseRange(args.at), members);
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'public',
        helpString: 'Removes the private flag so everyone knows. Example: <code>/public at=12-18</code>',
        namedArgumentList: [atArg()],
        callback: (args) => {
            flagMessages(parseRange(args.at), []);
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'private-scene',
        helpString: 'Starts a private scene: every new message is flagged for these characters until <code>/private-end</code>. '
            + 'With no names, returns the current scene\'s members.',
        unnamedArgumentList: [namesArg(false)],
        callback: (_args, value) => {
            const members = parseNames(value);
            if (!members.length) return getScene()?.members.join(', ') ?? '';
            startScene(members);
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'private-end',
        helpString: 'Ends the current private scene. If auto-save is on, the scene is summarized into the lorebook.',
        callback: () => {
            endScene();
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'private-save',
        helpString: 'Summarizes a private scene into the chat lorebook and returns the summary. '
            + 'Defaults to the most recent scene. Example: <code>/private-save at=14</code>',
        namedArgumentList: [atArg('Any message id inside the scene to save.')],
        callback: async (args) => {
            const scenes = findScenes();
            const scene = args.at === undefined || args.at === ''
                ? scenes.at(-1)
                : scenes.find(x => x.ids.includes(parseRange(args.at)[0]));
            if (!scene) throw new Error('No private scene found.');
            return await saveScene(scene) ?? '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'private-timeline',
        helpString: 'Opens the private timeline for this chat.',
        callback: () => {
            openTimeline();
            return '';
        },
    }));
}

// ─── Init ────────────────────────────────────────────────────────────

jQuery(() => {
    settings();
    addMessageButton();
    addSceneBar();
    addWandMenuItems();
    addSettingsPanel();
    registerCommands();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.MESSAGE_SENT, (id) => onNewMessage(id, 'normal'));
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onNewMessage);
    eventSource.on(eventTypes.MESSAGE_SWIPED, onSwiped);
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        ctx().setExtensionPrompt(PROMPT_KEY, '', IN_CHAT, 0);
        refreshUi();
    });
    for (const type of [
        eventTypes.USER_MESSAGE_RENDERED,
        eventTypes.CHARACTER_MESSAGE_RENDERED,
        eventTypes.MESSAGE_UPDATED,
        eventTypes.MESSAGE_DELETED,
        eventTypes.MORE_MESSAGES_LOADED,
    ]) {
        eventSource.on(type, refreshUi);
    }
    refreshUi();
});

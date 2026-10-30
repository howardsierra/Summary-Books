// Everything on screen: chips, popups (picker, timeline, who-knows grid),
// chat decorations, leak warnings, the scene bar and the settings panel.

import {
    allNames, chatState, ctx, defaultSettings, endScene, findScenes, flagMessages, formatMembers, getFlag,
    getMembers, getReveals, getScene, membersKey, nameHue, parseNames, revealedNames, setRevealedNames, settings,
    startScene, adoptScene,
} from './core.js';
import {
    joinSummary, parseSummary, refreshSceneEntry, removeMemory, removeSceneEntry, saveMemory, saveScene,
    saveStorySoFar, saving, writeMemoryEntry, writeSceneEntry,
} from './lorebook.js';
import { checking, currentLeak, dismissLeak, regenerate } from './leaks.js';

// ─── Chips ───────────────────────────────────────────────────────────

export function chip(name) {
    const el = document.createElement('span');
    el.classList.add('ps-chip');
    el.style.setProperty('--ps-hue', String(nameHue(name)));
    el.textContent = name;
    return el;
}

export function chips(members, extraClass = '') {
    const wrap = document.createElement('span');
    wrap.classList.add('ps-chips');
    for (const name of members) {
        const el = chip(name);
        if (extraClass) el.classList.add(extraClass);
        wrap.append(el);
    }
    return wrap;
}

// ─── Popup building blocks ───────────────────────────────────────────

function popupHeader(icon, title, subtitle) {
    const header = $(`
        <div class="ps-popup-header">
            <div class="ps-popup-icon"><i class="fa-solid"></i></div>
            <div class="ps-popup-titles"><h3></h3><p></p></div>
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

/**
 * Popup with a toggle chip per name plus a field for new names.
 * Returns the selected names, or null on cancel.
 */
async function pickNames({ title, subtitle, current = [], exclude = [], hint, icon = 'fa-user-secret' }) {
    const c = ctx();
    const excluded = new Set(exclude.map(x => x.toLowerCase()));
    const known = parseNames([...current, ...allNames(), c.name1]).filter(x => !excluded.has(x.toLowerCase()));
    const currentKeys = new Set(current.map(x => x.toLowerCase()));

    const root = document.createElement('div');
    root.classList.add('ps-popup');
    root.append(popupHeader(icon, title, subtitle));

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
        for (const name of parseNames(input.val())) {
            if (excluded.has(name.toLowerCase())) continue;
            const box = [...grid.querySelectorAll('input')].find(x => x.value.toLowerCase() === name.toLowerCase());
            if (box) box.checked = true;
            else grid.append(chipToggle(name, true));
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

    if (hint) root.append(Object.assign(document.createElement('small'), { className: 'ps-hint', textContent: hint }));

    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel' });
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return null;

    const checked = [...grid.querySelectorAll('input:checked')].map(x => x.value);
    return parseNames([...checked, ...String(input.val()).split(',')]).filter(x => !excluded.has(x.toLowerCase()));
}

async function editSummaryPopup(summary, keywords) {
    const c = ctx();
    const text = await c.callGenericPopup(
        'Edit the summary saved in the lorebook. The last line lists the extra trigger keywords.',
        c.POPUP_TYPE.INPUT, joinSummary(summary, keywords), { rows: 9, wide: true });
    if (typeof text !== 'string' || !text.trim()) return null;
    return parseSummary(text);
}

const confirm = async (text) => {
    const c = ctx();
    return await c.callGenericPopup(text, c.POPUP_TYPE.CONFIRM) === c.POPUP_RESULT.AFFIRMATIVE;
};

// ─── Flagging & scenes ───────────────────────────────────────────────

async function onMessageButtonClick(event) {
    const id = Number($(event.currentTarget).closest('.mes').attr('mesid'));
    const message = ctx().chat[id];
    if (!message) return;
    const members = await pickNames({
        title: 'Who knows about this?',
        subtitle: 'Only the characters you pick will know about this.',
        current: getMembers(message) ?? getScene()?.members ?? [],
        hint: 'Deselect everyone to make it public again.',
    });
    if (members !== null) flagMessages([id], members);
}

export async function onSceneButtonClick() {
    const scene = getScene();
    const members = await pickNames({
        title: scene ? 'Edit private scene' : 'Start a private scene',
        subtitle: 'Every new message is private between these characters until you end the scene.',
        current: scene?.members ?? [],
        hint: 'Tip: type “@scene Ana, Kael:” at the start of a message to do this without clicking.',
    });
    if (members !== null) startScene(members);
}

/** Popup to choose who else has learned a scene's secret. */
export async function openReveal(scene) {
    scene = adoptScene(scene);
    const names = await pickNames({
        title: 'Who else finds out?',
        subtitle: `Secret between ${formatMembers(scene.members)}. Characters you add know it from now on.`,
        current: revealedNames(scene.id),
        exclude: scene.members,
        icon: 'fa-eye',
        hint: 'Deselect someone to make them forget it again.',
    });
    if (names === null) return;
    setRevealedNames(scene, names);
    await refreshSceneEntry(scene.id);
    refreshUi();
}

// ─── Timeline ────────────────────────────────────────────────────────

let timelineRoot = null;

function statusPill(cls, icon, text) {
    const pill = $('<span class="ps-status"><i class="fa-solid"></i><span></span></span>');
    pill.addClass(`ps-status-${cls}`);
    pill.find('i').addClass(icon);
    pill.find('span').text(text);
    return pill;
}

function sceneStatus(scene) {
    const record = chatState().timeline[scene.id];
    if (saving.has(scene.id)) return ['saving', 'fa-spinner fa-spin', 'Saving…'];
    if (!record) return ['unsaved', 'fa-circle-dot', 'Not saved'];
    if (record.count !== scene.ids.length || membersKey(record.members) !== membersKey(scene.members)) {
        return ['changed', 'fa-rotate', 'Changed since saved'];
    }
    return ['saved', 'fa-book-bookmark', 'In lorebook'];
}

function keywordTags(keywords) {
    const wrap = $('<div class="ps-keywords"></div>');
    for (const keyword of keywords ?? []) wrap.append($('<span class="ps-keyword"></span>').text(keyword));
    return wrap;
}

function actionButton(cls, icon, label, title = '') {
    const button = $('<div class="menu_button menu_button_icon"><i class="fa-solid"></i></div>');
    button.addClass(cls).attr('title', title);
    button.find('i').addClass(icon);
    if (label) button.append($('<span></span>').text(label));
    return button;
}

const jumpTo = (id) => ctx().executeSlashCommandsWithOptions(`/chat-jump ${id}`, { showOutput: false });

function renderSceneCard(scene) {
    const record = chatState().timeline[scene.id];
    const [cls, icon, text] = sceneStatus(scene);
    const reveals = getReveals(scene.id);
    const range = scene.ids.length > 1 ? `Messages ${scene.ids[0]}–${scene.ids.at(-1)}` : `Message ${scene.ids[0]}`;

    const item = $(`
        <li class="ps-tl-item ps-kind-scene">
            <div class="ps-tl-node"><i class="fa-solid fa-user-secret"></i></div>
            <div class="ps-tl-card">
                <div class="ps-tl-top"><span class="ps-tl-title"></span><span class="ps-tl-range"></span></div>
                <div class="ps-tl-members"></div>
                <p class="ps-tl-summary"></p>
                <div class="ps-tl-actions"></div>
            </div>
        </li>`);
    item.addClass(`ps-${cls}`);
    item.find('.ps-tl-title').text(`Secret · Scene ${scene.index}`);
    item.find('.ps-tl-range').text(`${range} · ${scene.ids.length} msg${scene.ids.length === 1 ? '' : 's'}`);
    item.find('.ps-tl-top').append(statusPill(cls, icon, text));
    item.find('.ps-tl-members').append(chips(scene.members));
    if (reveals.length) {
        const learned = $('<div class="ps-tl-learned"><i class="fa-solid fa-eye"></i><span>Learned later:</span></div>');
        for (const reveal of reveals) {
            const pill = chip(reveal.name);
            pill.classList.add('ps-chip-revealed');
            pill.title = `Found out at message ${reveal.at}`;
            learned.append(pill);
        }
        item.find('.ps-tl-members').after(learned);
    }

    const summary = item.find('.ps-tl-summary');
    if (record?.summary) {
        summary.text(record.summary);
        summary.after(keywordTags(record.keywords));
    } else {
        const preview = String(ctx().chat[scene.ids[0]]?.mes ?? '').replace(/\s+/g, ' ');
        summary.addClass('ps-preview').text(preview.length > 180 ? `${preview.slice(0, 180)}…` : preview);
    }

    const actions = item.find('.ps-tl-actions');
    actions.append(actionButton('ps-act-jump', 'fa-location-arrow', 'Jump', 'Scroll to this scene').on('click', () => jumpTo(scene.ids[0])));
    actions.append(actionButton('ps-act-save', 'fa-wand-magic-sparkles', record ? 'Re-summarize' : 'Save to lorebook')
        .toggleClass('disabled', saving.has(scene.id)).on('click', () => saveScene(scene)));
    actions.append(actionButton('ps-act-reveal', 'fa-eye', 'Reveal…', 'Someone else found out').on('click', () => openReveal(scene)));
    if (record) {
        actions.append(actionButton('ps-act-edit', 'fa-pen', 'Edit', 'Edit the saved summary').on('click', async () => {
            const edited = await editSummaryPopup(record.summary, record.keywords);
            if (edited) await writeSceneEntry(scene, edited.summary, edited.keywords).catch(e => toastr.error(String(e?.message ?? e)));
        }));
        actions.append(actionButton('ps-act-remove', 'fa-trash-can', '', 'Remove this scene\'s lorebook entry').on('click', async () => {
            if (await confirm(`Remove scene ${scene.index} from the lorebook? The chat messages stay private.`)) await removeSceneEntry(scene.id);
        }));
    }
    return item;
}

function renderMemoryCard(memory) {
    const busy = saving.has(memory.id);
    const item = $(`
        <li class="ps-tl-item ps-kind-memory">
            <div class="ps-tl-node"><i class="fa-solid fa-scroll"></i></div>
            <div class="ps-tl-card">
                <div class="ps-tl-top"><span class="ps-tl-title">Story</span><span class="ps-tl-range"></span></div>
                <p class="ps-tl-summary"></p>
                <div class="ps-tl-actions"></div>
            </div>
        </li>`);
    item.addClass(busy ? 'ps-saving' : 'ps-saved');
    item.find('.ps-tl-range').text(`Messages ${memory.from}–${memory.to}`);
    item.find('.ps-tl-top').append(busy ? statusPill('saving', 'fa-spinner fa-spin', 'Saving…') : statusPill('saved', 'fa-book-bookmark', 'In lorebook'));
    item.find('.ps-tl-summary').text(memory.summary ?? '').after(keywordTags(memory.keywords));

    const actions = item.find('.ps-tl-actions');
    actions.append(actionButton('ps-act-jump', 'fa-location-arrow', 'Jump').on('click', () => jumpTo(memory.from)));
    actions.append(actionButton('ps-act-save', 'fa-wand-magic-sparkles', 'Re-summarize').toggleClass('disabled', busy)
        .on('click', () => saveMemory(memory.from, memory.to, { existing: memory })));
    actions.append(actionButton('ps-act-edit', 'fa-pen', 'Edit').on('click', async () => {
        const edited = await editSummaryPopup(memory.summary, memory.keywords);
        if (edited) await writeMemoryEntry(memory, edited.summary, edited.keywords).catch(e => toastr.error(String(e?.message ?? e)));
    }));
    actions.append(actionButton('ps-act-remove', 'fa-trash-can', '', 'Remove this memory from the lorebook').on('click', async () => {
        if (await confirm(`Remove the story memory for messages ${memory.from}–${memory.to}?`)) await removeMemory(memory.id);
    }));
    return item;
}

function refreshTimeline() {
    if (!timelineRoot) return;
    const state = chatState();
    const scenes = findScenes();
    const saved = scenes.filter(x => state.timeline[x.id]).length;
    const book = ctx().chatMetadata.world_info;

    $(timelineRoot).find('.ps-popup-header p').text(
        `${scenes.length} secret${scenes.length === 1 ? '' : 's'} (${saved} saved) · ${state.memories.length} story ${state.memories.length === 1 ? 'memory' : 'memories'}`
        + (book ? ` · lorebook “${book}”` : ''));

    const body = $(timelineRoot).find('.ps-tl-body').empty();
    const toolbar = $('<div class="ps-toolbar"></div>');
    const unsaved = scenes.filter(x => sceneStatus(x)[0] !== 'saved' && !saving.has(x.id));
    if (unsaved.length) {
        toolbar.append(actionButton('ps-save-all', 'fa-book-medical', `Save ${unsaved.length} secret${unsaved.length === 1 ? '' : 's'}`)
            .on('click', async () => {
                for (const scene of unsaved) await saveScene(scene, { quiet: true });
                toastr.success('Secrets saved to the lorebook.', 'Private Scenes');
            }));
    }
    const pending = ctx().chat.length - state.memoryCursor;
    if (pending > 0) {
        toolbar.append(actionButton('ps-save-story', 'fa-scroll', 'Summarize story so far', `Messages ${state.memoryCursor}–${ctx().chat.length - 1} (public parts only)`)
            .on('click', () => saveStorySoFar()));
    }
    toolbar.append(actionButton('ps-open-grid', 'fa-table-cells', 'Who knows what').on('click', openKnowledge));
    body.append(toolbar);

    const items = [
        ...scenes.map(scene => ({ start: scene.ids[0], el: () => renderSceneCard(scene) })),
        ...state.memories.map(memory => ({ start: memory.from, el: () => renderMemoryCard(memory) })),
    ].sort((a, b) => a.start - b.start);

    if (!items.length) {
        body.append(`
            <div class="ps-empty">
                <i class="fa-solid fa-feather-pointed"></i>
                <b>Nothing in the timeline yet</b>
                <span>Flag a message with <i class="fa-solid fa-user-secret"></i>, start a private scene, or summarize the story so far.</span>
            </div>`);
        return;
    }
    const list = $('<ol class="ps-timeline"></ol>');
    items.forEach(x => list.append(x.el()));
    body.append(list);
}

export async function openTimeline() {
    const c = ctx();
    timelineRoot = document.createElement('div');
    timelineRoot.classList.add('ps-popup', 'ps-timeline-popup');
    timelineRoot.append(popupHeader('fa-timeline', 'Private Timeline', ''));
    timelineRoot.append(Object.assign(document.createElement('div'), { className: 'ps-tl-body' }));
    refreshTimeline();
    await c.callGenericPopup(timelineRoot, c.POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, okButton: 'Close' });
    timelineRoot = null;
}

// ─── Who knows what ──────────────────────────────────────────────────

let knowledgeRoot = null;

function refreshKnowledge() {
    if (!knowledgeRoot) return;
    const body = $(knowledgeRoot).find('.ps-grid-body').empty();
    const scenes = findScenes();
    const names = allNames();
    if (!scenes.length) {
        body.append('<div class="ps-empty"><i class="fa-solid fa-user-secret"></i><b>No secrets yet</b><span>Private scenes show up here.</span></div>');
        return;
    }

    const compact = window.matchMedia('(max-width: 600px)').matches;
    const rows = scenes.map(scene => {
        const record = chatState().timeline[scene.id];
        const about = String(record?.summary ?? ctx().chat[scene.ids[0]]?.mes ?? '').replace(/\s+/g, ' ');
        return { scene, about, cells: names.map(name => knowledgeCell(scene, name)) };
    });
    body.append(compact ? knowledgeCards(rows) : knowledgeTable(rows, names));
    body.append(`
        <div class="ps-grid-legend">
            <span><span class="ps-cell ps-cell-member"></span> Was there</span>
            <span><span class="ps-cell ps-cell-revealed"></span> Found out later</span>
            <span><span class="ps-cell ps-cell-unknown"></span> Doesn't know (tap to reveal)</span>
        </div>`);
}

/** What one character knows about one secret, and what tapping it does. */
function knowledgeCell(scene, name) {
    const key = name.toLowerCase();
    const reveal = getReveals(scene.id).find(r => r.name.toLowerCase() === key);
    const update = async (names) => {
        const adopted = adoptScene(scene);
        setRevealedNames(adopted, names(adopted));
        await refreshSceneEntry(adopted.id);
        refreshUi();
    };
    if (scene.members.some(x => x.toLowerCase() === key)) {
        return { name, state: 'member', title: `${name} was there` };
    }
    if (reveal) {
        return {
            name, state: 'revealed', detail: `msg ${reveal.at}`,
            title: `${name} found out at message ${reveal.at}. Tap to undo.`,
            toggle: () => update(adopted => revealedNames(adopted.id).filter(x => x.toLowerCase() !== key)),
        };
    }
    return {
        name, state: 'unknown',
        title: `${name} doesn't know. Tap if ${name} finds out now.`,
        toggle: () => update(adopted => [...revealedNames(adopted.id), name]),
    };
}

function knowledgeTable(rows, names) {
    const table = $('<table class="ps-grid"><thead><tr><th class="ps-grid-secret">Secret</th></tr></thead><tbody></tbody></table>');
    for (const name of names) table.find('thead tr').append($('<th></th>').append(chip(name)));
    for (const { scene, about, cells } of rows) {
        const row = $('<tr><td class="ps-grid-secret"><b></b><small></small></td></tr>');
        row.find('b').text(`Scene ${scene.index}`);
        row.find('small').text(about.length > 70 ? `${about.slice(0, 70)}…` : about).attr('title', about);
        for (const cell of cells) {
            const dot = $('<span class="ps-cell"></span>').css('--ps-hue', String(nameHue(cell.name)))
                .addClass(`ps-cell-${cell.state}`).attr('title', cell.title);
            if (cell.toggle) dot.addClass('ps-clickable').on('click', cell.toggle);
            row.append($('<td></td>').append(dot));
        }
        table.find('tbody').append(row);
    }
    return $('<div class="ps-grid-scroll"></div>').append(table);
}

/** Phone layout: one card per secret, with a tappable chip per character. */
function knowledgeCards(rows) {
    const list = $('<div class="ps-kcards"></div>');
    for (const { scene, about, cells } of rows) {
        const card = $('<div class="ps-kcard"><b></b><small></small><div class="ps-kchips"></div></div>');
        card.find('b').text(`Scene ${scene.index}`);
        card.find('small').text(about.length > 110 ? `${about.slice(0, 110)}…` : about);
        for (const cell of cells) {
            const pill = $(chip(cell.name)).addClass(`ps-kchip ps-kchip-${cell.state}`).attr('title', cell.title);
            const icon = { member: 'fa-check', revealed: 'fa-eye', unknown: 'fa-plus' }[cell.state];
            pill.prepend($('<i class="fa-solid"></i>').addClass(icon));
            if (cell.detail) pill.append($('<small class="ps-kchip-detail"></small>').text(cell.detail));
            if (cell.toggle) pill.addClass('ps-clickable').attr('role', 'button').on('click', cell.toggle);
            card.find('.ps-kchips').append(pill);
        }
        list.append(card);
    }
    return list;
}

export async function openKnowledge() {
    const c = ctx();
    knowledgeRoot = document.createElement('div');
    knowledgeRoot.classList.add('ps-popup');
    knowledgeRoot.append(popupHeader('fa-table-cells', 'Who knows what', 'Every secret in this chat and who is in on it.'));
    knowledgeRoot.append(Object.assign(document.createElement('div'), { className: 'ps-grid-body' }));
    refreshKnowledge();
    await c.callGenericPopup(knowledgeRoot, c.POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true, okButton: 'Close' });
    knowledgeRoot = null;
}

// ─── Chat decorations ────────────────────────────────────────────────

function leakBanner(id, leak) {
    const banner = $(`
        <div class="ps-leak">
            <i class="fa-solid fa-triangle-exclamation ps-leak-icon"></i>
            <div class="ps-leak-text"><b>Possible secret leak</b><span class="ps-leak-reason"></span><small></small></div>
            <div class="ps-leak-actions"></div>
        </div>`);
    banner.find('.ps-leak-reason').text(leak.reason);
    banner.find('small').text(`That secret is known only to ${leak.knowers}.`);
    if (id === ctx().chat.length - 1) {
        banner.find('.ps-leak-actions').append(actionButton('ps-leak-regen', 'fa-rotate', 'Regenerate', 'Generate a new version of this reply')
            .on('click', () => regenerate(id)));
    }
    banner.find('.ps-leak-actions').append(actionButton('ps-leak-dismiss', 'fa-check', 'Looks fine').on('click', () => dismissLeak(id)));
    return banner;
}

export function refreshUi() {
    const chat = ctx().chat;
    const s = settings();

    $('#chat .mes').each(function () {
        const id = Number($(this).attr('mesid'));
        const message = chat[id];
        const members = s.enabled ? getMembers(message) : null;
        $(this).toggleClass('ps-private', !!members);
        $(this).find('.ps-badge, .ps-leak, .ps-checking').remove();
        if (members && s.showBadges) {
            const badge = $('<div class="ps-badge"><span class="ps-badge-label"><i class="fa-solid fa-user-secret"></i>Private</span></div>');
            badge.append(chips(members));
            const revealed = revealedNames(getFlag(message).sceneId);
            if (revealed.length) badge.append($('<span class="ps-badge-later"><i class="fa-solid fa-eye"></i></span>').attr('title', `Later learned by ${formatMembers(revealed)}`), chips(revealed, 'ps-chip-revealed'));
            $(this).find('.mes_text').before(badge);
        }
        if (!s.enabled) return;
        if (checking.has(id)) {
            $(this).find('.mes_text').after('<div class="ps-checking"><i class="fa-solid fa-spinner fa-spin"></i> Checking for secret leaks…</div>');
        } else if (currentLeak(message)?.status === 'leak') {
            $(this).find('.mes_text').after(leakBanner(id, currentLeak(message)));
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
    refreshKnowledge();
}

// ─── Fixed UI ────────────────────────────────────────────────────────

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
            <span class="ps-bar-title"><i class="fa-solid fa-user-secret"></i><span class="ps-bar-label">Private scene</span></span>
            <span class="ps-chips"></span>
            <span class="ps-bar-spacer"></span>
            <div class="ps-bar-button ps-scene-edit" title="Change who is in this scene"><i class="fa-solid fa-user-pen"></i></div>
            <div class="ps-bar-button ps-scene-timeline" title="Open the private timeline"><i class="fa-solid fa-timeline"></i></div>
            <div class="ps-bar-button ps-scene-end" title="End the scene (and save it to the lorebook if auto-save is on)"><i class="fa-solid fa-door-open"></i><span class="ps-bar-label">End scene</span></div>
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
        </div>
        <div class="list-group-item flex-container flexGap5 interactable" id="ps_wand_grid" tabindex="0">
            <div class="fa-solid fa-table-cells extensionsMenuExtensionButton"></div><span>Who knows what</span>
        </div>`);
    $('#extensionsMenu').append(items);
    $('#ps_wand_scene').on('click', onSceneButtonClick);
    $('#ps_wand_timeline').on('click', openTimeline);
    $('#ps_wand_grid').on('click', openKnowledge);
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
                        <label class="checkbox_label"><input id="ps_inline_tags" type="checkbox"> <span>Inline tags in your messages</span></label>
                        <ul class="ps-tag-help">
                            <li><code>@private Ana, Kael:</code> this message and the reply</li>
                            <li><code>@scene Ana, Kael:</code> start a private scene</li>
                            <li><code>@endscene</code> end it</li>
                        </ul>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-masks-theater"></i> This chat</div>
                        <div id="ps_scene_status"></div>
                        <div class="ps-button-row">
                            <div id="ps_start_scene" class="menu_button menu_button_icon"><i class="fa-solid fa-user-secret"></i><span>Start / edit scene</span></div>
                            <div id="ps_end_scene" class="menu_button menu_button_icon"><i class="fa-solid fa-door-open"></i><span>End scene</span></div>
                            <div id="ps_open_timeline" class="menu_button menu_button_icon"><i class="fa-solid fa-timeline"></i><span>Timeline</span></div>
                            <div id="ps_open_grid" class="menu_button menu_button_icon"><i class="fa-solid fa-table-cells"></i><span>Who knows what</span></div>
                        </div>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-shield-halved"></i> Leak checker</div>
                        <label class="checkbox_label"><input id="ps_leak_check" type="checkbox"> <span>Check public replies for leaked secrets</span></label>
                        <label class="checkbox_label"><input id="ps_leak_regen" type="checkbox"> <span>Regenerate automatically when a leak is found (up to 2 tries)</span></label>
                        <small>Uses one extra short generation per reply, only in chats that have secrets.</small>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-book-bookmark"></i> Lorebook timeline</div>
                        <label class="checkbox_label"><input id="ps_auto_save" type="checkbox"> <span>Summarize private scenes into the lorebook when they end</span></label>
                        <label class="checkbox_label"><input id="ps_keywords" type="checkbox"> <span>Ask for keywords (places, objects, events) as extra triggers</span></label>
                        <label class="checkbox_label"><input id="ps_hide_after_save" type="checkbox"> <span>Hide the original messages after saving</span></label>
                        <label class="checkbox_label"><input id="ps_entry_constant" type="checkbox"> <span>Always include secret entries (otherwise when triggered)</span></label>
                        <label for="ps_summary_prompt">Secret summary instructions</label>
                        <textarea id="ps_summary_prompt" class="text_pole textarea_compact" rows="4"></textarea>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-scroll"></i> Story memory</div>
                        <label class="checkbox_label"><input id="ps_auto_memory" type="checkbox"> <span>Automatically summarize the public story into the lorebook</span></label>
                        <div class="ps-grid-2">
                            <div>
                                <label for="ps_memory_every">Every N public messages</label>
                                <input id="ps_memory_every" class="text_pole" type="number" min="2" max="500">
                            </div>
                            <div>
                                <label for="ps_memory_keep">Leave the latest N alone</label>
                                <input id="ps_memory_keep" class="text_pole" type="number" min="0" max="100">
                            </div>
                        </div>
                        <label class="checkbox_label"><input id="ps_memory_constant" type="checkbox"> <span>Always include story entries (otherwise when triggered)</span></label>
                        <small>Private messages are never included in story memory.</small>
                        <label for="ps_memory_prompt">Story summary instructions</label>
                        <textarea id="ps_memory_prompt" class="text_pole textarea_compact" rows="4"></textarea>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-terminal"></i> Prompt</div>
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
        '#ps_inline_tags': 'inlineTags',
        '#ps_leak_check': 'leakCheck',
        '#ps_leak_regen': 'leakAutoRegenerate',
        '#ps_auto_save': 'autoSave',
        '#ps_keywords': 'keywords',
        '#ps_hide_after_save': 'hideAfterSave',
        '#ps_entry_constant': 'entryConstant',
        '#ps_auto_memory': 'autoMemory',
        '#ps_memory_constant': 'memoryConstant',
    };
    const numbers = new Set(['rulesDepth', 'memoryEvery', 'memoryKeepRecent']);
    const fields = {
        '#ps_rules': 'rules',
        '#ps_scene_rules': 'sceneRules',
        '#ps_rules_depth': 'rulesDepth',
        '#ps_label_start': 'labelStart',
        '#ps_label_end': 'labelEnd',
        '#ps_summary_prompt': 'summaryPrompt',
        '#ps_memory_prompt': 'memoryPrompt',
        '#ps_memory_every': 'memoryEvery',
        '#ps_memory_keep': 'memoryKeepRecent',
    };
    const textDefaults = ['rules', 'sceneRules', 'labelStart', 'labelEnd', 'summaryPrompt', 'memoryPrompt', 'rulesDepth'];
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
            s[key] = numbers.has(key) ? Number($(this).val()) || 0 : String($(this).val());
            ctx().saveSettingsDebounced();
        });
    }
    $('#ps_reset').on('click', () => {
        for (const key of textDefaults) s[key] = defaultSettings[key];
        ctx().saveSettingsDebounced();
        load();
    });
    $('#ps_start_scene').on('click', onSceneButtonClick);
    $('#ps_end_scene').on('click', endScene);
    $('#ps_open_timeline').on('click', openTimeline);
    $('#ps_open_grid').on('click', openKnowledge);
}

export function initUi() {
    addMessageButton();
    addSceneBar();
    addWandMenuItems();
    addSettingsPanel();
}

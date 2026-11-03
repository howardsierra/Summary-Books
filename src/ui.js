// Shared UI building blocks (chips, popups, buttons), chat decorations, leak
// warnings, the pin button, the scene bar and the settings panel.

import {
    COMMON_KINDS, adoptScene, allNames, chatState, commonKind, ctx, defaultSettings, endScene, ensureMid, findScenes,
    formatMembers, getCommon, getFlag, getMembers, getScene, nameHue, parseNames, revealedNames, setRevealedNames,
    settings, startScene,
} from './core.js';
import { refreshSceneEntry, saveMemory, saveStorySoFar, staleItems } from './lorebook.js';
import { joinSummary, parseSummary } from './extract.js';
import { addFact, getClock, setVisibility, sheetList } from './memory.js';
import { checking, currentLeak, dismissLeak, regenerate } from './leaks.js';
import {
    TASKS, currentSource, modelSidecarProblem, providerModels, sidecarProfiles, sourceName, testSidecar,
} from './llm.js';
import { PROMPTS, PROMPT_FIELDS } from './prompts.js';

/** Shown in the settings header; keep in step with manifest.json. */
const EXTENSION_VERSION = '0.9.0';
import { editClock, openMemory, refreshMemory } from './hub.js';
import { lastMeasure, openBudget } from './budget.js';

// ─── Chips ───────────────────────────────────────────────────────────

/** "Ana" → "A", "Lady Merriweather" → "LM". */
export function initials(name) {
    const words = String(name).trim().split(/\s+/).filter(Boolean);
    const first = (word) => Array.from(word)[0] ?? '';
    if (!words.length) return '?';
    return (words.length > 1 ? first(words[0]) + first(words.at(-1)) : first(words[0])).toUpperCase();
}

/** A round monogram in the character's color; an icon replaces the letters when given. */
export function avatar(name, { large = false, icon = null } = {}) {
    const el = document.createElement('span');
    el.classList.add('ps-avatar');
    if (large) el.classList.add('ps-avatar-lg');
    el.style.setProperty('--ps-hue', String(nameHue(name)));
    el.setAttribute('aria-hidden', 'true');
    if (icon) el.append(Object.assign(document.createElement('i'), { className: `fa-solid ${icon}` }));
    else el.textContent = initials(name);
    return el;
}

export function chip(name, { icon = null } = {}) {
    const el = document.createElement('span');
    el.classList.add('ps-chip');
    el.style.setProperty('--ps-hue', String(nameHue(name)));
    el.append(avatar(name, { icon }), Object.assign(document.createElement('span'), { className: 'ps-chip-name', textContent: name }));
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

export function popupHeader(icon, title, subtitle) {
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
    // When selected, the monogram turns into a tick.
    pill.querySelector('.ps-avatar').append(Object.assign(document.createElement('i'), { className: 'fa-solid fa-check ps-check' }));
    label.append(box, pill);
    return label;
}

/**
 * A toggle chip per known name plus a field for new names.
 * read() returns the selected names.
 */
function namePicker(current = [], exclude = []) {
    const c = ctx();
    const excluded = new Set(exclude.map(x => x.toLowerCase()));
    const known = parseNames([...current, ...allNames(), c.name1]).filter(x => !excluded.has(x.toLowerCase()));
    const currentKeys = new Set(current.map(x => x.toLowerCase()));

    const wrap = document.createElement('div');
    wrap.classList.add('ps-name-picker');
    const grid = document.createElement('div');
    grid.classList.add('ps-chip-grid');
    for (const name of known) grid.append(chipToggle(name, currentKeys.has(name.toLowerCase())));
    wrap.append(grid);

    const addRow = $(`
        <div class="ps-add-row">
            <input type="text" class="text_pole" placeholder="Add a character… (comma separates several)">
            <div class="menu_button menu_button_icon" role="button" tabindex="0" aria-label="Add"><i class="fa-solid fa-plus"></i><span>Add</span></div>
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
    wrap.append(addRow[0]);

    const read = () => {
        const checked = [...grid.querySelectorAll('input:checked')].map(x => x.value);
        return parseNames([...checked, ...String(input.val()).split(',')]).filter(x => !excluded.has(x.toLowerCase()));
    };
    return { element: wrap, read };
}

/**
 * Popup with a name picker. Returns the selected names, or null on cancel.
 */
async function pickNames({ title, subtitle, current = [], exclude = [], hint, icon = 'fa-user-secret' }) {
    const c = ctx();
    const root = document.createElement('div');
    root.classList.add('ps-popup');
    root.append(popupHeader(icon, title, subtitle));
    const picker = namePicker(current, exclude);
    root.append(picker.element);
    if (hint) root.append(Object.assign(document.createElement('small'), { className: 'ps-hint', textContent: hint }));

    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel' });
    return result === c.POPUP_RESULT.AFFIRMATIVE ? picker.read() : null;
}

const VISIBILITY = [
    ['common', 'fa-earth-americas', 'Everyone', 'Every character knows, even ones who weren\'t there'],
    ['normal', 'fa-users', 'Who was there', 'The usual: the characters present saw it'],
    ['private', 'fa-user-secret', 'Only…', 'Just the characters you pick'],
];

/** One choice in a group of pill-shaped radio buttons. */
function radioPill(group, value, icon, label, checked, extraClass = '') {
    const option = $('<label class="ps-radio"><input type="radio"><span class="ps-radio-body"><i class="fa-solid"></i><span class="ps-radio-text"><b></b></span></span></label>');
    option.addClass(extraClass);
    option.find('input').attr({ name: group, value }).prop('checked', checked);
    option.find('i').addClass(icon);
    option.find('b').text(label);
    return option;
}

/**
 * "Who knows about this?" for a message: everyone (common knowledge, with a
 * kind), whoever was there (normal), or only certain characters (private).
 * Returns a visibility for setVisibility(), or null on cancel.
 */
async function pickVisibility(message) {
    const c = ctx();
    const common = getCommon(message);
    const members = getMembers(message);
    const mode = common ? 'common' : members ? 'private' : 'normal';
    const group = `ps_vis_${Date.now()}`;

    const root = $('<div class="ps-popup ps-visibility"></div>');
    root.append(popupHeader('fa-eye', 'Who knows about this?', 'Choose which characters know what happens in this message.'));

    const modes = $('<div class="ps-modes" role="radiogroup" aria-label="Who knows"></div>');
    for (const [value, icon, label, description] of VISIBILITY) {
        const option = radioPill(group, value, icon, label, value === mode, `ps-mode ps-mode-${value}`);
        option.find('.ps-radio-text').append($('<small></small>').text(description));
        modes.append(option);
    }
    root.append(modes);

    const kinds = $('<div class="ps-mode-panel ps-panel-common"><div class="ps-panel-label">What kind?</div><div class="ps-kinds" role="radiogroup" aria-label="Kind of common knowledge"></div><small class="ps-hint"></small></div>');
    for (const [value, { icon, label }] of Object.entries(COMMON_KINDS)) {
        kinds.find('.ps-kinds').append(radioPill(`${group}_kind`, value, icon, label, value === (common?.kind ?? 'common'), 'ps-kind'));
    }
    kinds.find('.ps-hint').text('It is also saved, in short, to the World knowledge lorebook entry, so it is remembered later.');
    root.append(kinds);

    const picker = namePicker(members ?? getScene()?.members ?? []);
    const privatePanel = $('<div class="ps-mode-panel ps-panel-private"><div class="ps-panel-label">Who knows?</div></div>').append(picker.element);
    root.append(privatePanel);

    const sync = () => {
        const selected = root.find(`input[name="${group}"]:checked`).val();
        kinds.toggle(selected === 'common');
        privatePanel.toggle(selected === 'private');
    };
    root.on('change', `input[name="${group}"]`, sync);
    sync();

    const result = await c.callGenericPopup(root[0], c.POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel', wide: true });
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return null;
    const selected = root.find(`input[name="${group}"]:checked`).val();
    if (selected === 'common') return { mode: 'common', kind: root.find(`input[name="${group}_kind"]:checked`).val() ?? 'common' };
    if (selected === 'private') {
        const names = picker.read();
        return names.length ? { mode: 'private', members: names } : { mode: 'normal' };
    }
    return { mode: 'normal' };
}

export async function editSummaryPopup(summary, keywords) {
    const c = ctx();
    const text = await c.callGenericPopup(
        'Edit the summary saved in the lorebook. The last line lists the extra trigger keywords.',
        c.POPUP_TYPE.INPUT, joinSummary(summary, keywords), { rows: 9, wide: true });
    if (typeof text !== 'string' || !text.trim()) return null;
    return parseSummary(text);
}

export const confirm = async (text) => {
    const c = ctx();
    return await c.callGenericPopup(text, c.POPUP_TYPE.CONFIRM) === c.POPUP_RESULT.AFFIRMATIVE;
};

// ─── Flagging & scenes ───────────────────────────────────────────────

async function chooseVisibility(id) {
    const message = ctx().chat[id];
    if (!message) return;
    const visibility = await pickVisibility(message);
    if (visibility) await setVisibility([id], visibility);
}

/** The one Private Scenes button on each message: a small sheet of things to do with it. */
async function onMessageButtonClick(event) {
    const mes = $(event.currentTarget).closest('.mes');
    const id = Number(mes.attr('mesid'));
    const message = ctx().chat[id];
    if (!message) return;
    // Read the selection now; opening the sheet would clear it.
    const selection = window.getSelection();
    const selected = selection && mes[0].contains(selection.anchorNode) ? selection.toString().trim() : '';
    await openMessageSheet(id, selected);
}

export async function onSceneButtonClick() {
    const scene = getScene();
    const members = await pickNames({
        title: scene ? 'Edit private scene' : 'Start a private scene',
        subtitle: 'Every new message is private between these characters until you end the scene.',
        current: scene?.members ?? [],
        hint: scene
            ? 'Deselect everyone to end the scene.'
            : 'Tip: type “@scene Ana, Kael:” at the start of a message to do this without clicking.',
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

export function statusPill(cls, icon, text) {
    const pill = $('<span class="ps-status"><i class="fa-solid"></i><span></span></span>');
    pill.addClass(`ps-status-${cls}`);
    pill.find('i').addClass(icon);
    pill.find('span').text(text);
    return pill;
}

export function keywordTags(keywords) {
    const wrap = $('<div class="ps-keywords"></div>');
    for (const keyword of keywords ?? []) wrap.append($('<span class="ps-keyword"></span>').text(keyword));
    return wrap;
}

export function actionButton(cls, icon, label, title = '') {
    const button = $('<div class="menu_button menu_button_icon ps-btn" role="button" tabindex="0"><i class="fa-solid" aria-hidden="true"></i></div>');
    button.addClass(cls).attr('title', title).attr('aria-label', label || title);
    button.find('i').addClass(icon);
    if (label) button.append($('<span></span>').text(label));
    else button.addClass('ps-btn-icon');
    return button;
}

export const jumpTo = (id) => ctx().executeSlashCommandsWithOptions(`/chat-jump ${id}`, { showOutput: false });

// ─── Pinned facts ────────────────────────────────────────────────────

/** Pins a fact from a message, starting from the text that was selected in it. */
async function pinFromMessage(id, selected = '') {
    const message = ctx().chat[id];
    if (!message) return;
    const members = getMembers(message);

    const c = ctx();
    const header = popupHeader('fa-thumbtack', 'Pin a fact', members
        ? `From message ${id}. Private: only ${formatMembers(members)} will know it.`
        : `From message ${id}. The model will always remember it.`);
    const text = await c.callGenericPopup(header, c.POPUP_TYPE.INPUT, selected, { rows: 3, wide: true, okButton: 'Pin' });
    if (typeof text !== 'string' || !text.trim()) return;
    await addFact(text, members, ensureMid(message), getFlag(message)?.sceneId ?? null);
    toastr.success('Fact pinned.', 'Private Scenes');
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

let refreshQueued = false;
/**
 * Redraws badges, banners and status. Calls are batched: several events in
 * a row (send, render, save…) cause one redraw on the next frame.
 */
export function refreshUi() {
    if (refreshQueued) return;
    refreshQueued = true;
    const run = () => {
        if (!refreshQueued) return;
        refreshQueued = false;
        renderUi();
    };
    requestAnimationFrame(run);
    setTimeout(run, 100); // background tabs pause animation frames
}

function renderUi() {
    const chat = ctx().chat;
    const s = settings();

    $('#chat .mes').each(function () {
        const id = Number($(this).attr('mesid'));
        const message = chat[id];
        const members = s.enabled ? getMembers(message) : null;
        const common = s.enabled ? getCommon(message) : null;
        const leak = s.enabled && !checking.has(id) ? currentLeak(message) : null;
        // Skip messages whose decorations would come out the same.
        const signature = JSON.stringify([id, s.enabled, s.showBadges, members, common?.kind, members && revealedNames(getFlag(message).sceneId), checking.has(id), leak?.status, leak?.reason]);
        if (this.dataset.psSignature === signature && this.querySelector('.mes_text')) return;
        this.dataset.psSignature = signature;
        $(this).toggleClass('ps-private', !!members);
        $(this).toggleClass('ps-common', !!common).toggleClass('ps-common-rumor', common?.kind === 'rumor');
        $(this).find('.ps-badge, .ps-leak, .ps-checking').remove();
        if (common && s.showBadges) {
            const { icon, label } = COMMON_KINDS[commonKind(common.kind)];
            const badge = $('<div class="ps-badge ps-badge-common"><span class="ps-badge-label"><i class="fa-solid"></i><span></span></span><span class="ps-badge-note"></span></div>');
            badge.find('.ps-badge-label i').addClass(icon);
            badge.find('.ps-badge-label span').text(label);
            badge.find('.ps-badge-note').text(common.kind === 'rumor' ? 'Everyone has heard this · may not be true' : 'Everyone knows this');
            $(this).find('.mes_text').before(badge);
        }
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
        } else if (leak?.status === 'leak') {
            $(this).find('.mes_text').after(leakBanner(id, leak));
        }
    });

    const scene = getScene();
    $('#ps_scene_bar').toggleClass('ps-visible', !!scene && s.enabled);
    $('#ps_scene_bar .ps-chips').replaceWith(chips(scene?.members ?? []));
    const status = $('#ps_scene_status').empty();
    if (scene) status.append('<span>Active: </span>', chips(scene.members));
    else status.text('No private scene running.');
    $('#ps_end_scene').toggle(!!scene);

    const { time, place } = getClock();
    $('#ps_clock_status').text(settings().clockEnabled ? [time || 'time not set', place || 'place not set'].join(' · ') : 'Story clock is off.');

    refreshMemory();
    refreshSettingsSummary();
}

// ─── Fixed UI ────────────────────────────────────────────────────────

function addMessageButtons() {
    const buttons = '<div title="Private Scenes: who knows, pin a fact, summarize up to here" class="mes_button ps_toggle fa-solid fa-user-secret"></div>';
    $('#message_template .extraMesButtons').prepend(buttons);
    // Messages rendered before this extension loaded.
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.ps_toggle').length) $(this).prepend(buttons);
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
            <div class="ps-bar-button ps-scene-edit" role="button" tabindex="0" title="Change who is in this scene" aria-label="Change who is in this scene"><i class="fa-solid fa-user-pen" aria-hidden="true"></i></div>
            <div class="ps-bar-button ps-scene-timeline" role="button" tabindex="0" title="Open Story Memory" aria-label="Open Story Memory"><i class="fa-solid fa-book-open" aria-hidden="true"></i></div>
            <div class="ps-bar-button ps-scene-end" role="button" tabindex="0" title="End the scene (and save it to the lorebook if auto-save is on)" aria-label="End scene"><i class="fa-solid fa-door-open" aria-hidden="true"></i><span class="ps-bar-label">End scene</span></div>
        </div>`);
    $('#send_form').before(bar);
    bar.find('.ps-scene-edit').on('click', onSceneButtonClick);
    bar.find('.ps-scene-timeline').on('click', () => openMemory('timeline'));
    bar.find('.ps-scene-end').on('click', endScene);
}

function addWandMenuItems() {
    const item = $(`
        <div class="list-group-item flex-container flexGap5 interactable" id="ps_wand_open" tabindex="0">
            <div class="fa-solid fa-user-secret extensionsMenuExtensionButton"></div><span>Private Scenes</span>
        </div>`);
    $('#extensionsMenu').append(item);
    item.on('click', openLauncher);
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
                            <li><code>@news:</code> <code>@rumor:</code> <code>@announcement:</code> <code>@common:</code> everyone knows this message</li>
                        </ul>
                    </div>

                    <div class="ps-section ps-sidecar">
                        <div class="ps-section-title"><i class="fa-solid fa-microchip"></i> AI sidecar</div>
                        <small>Use a different, cheaper model for the background work (summaries, leak checks, character sheets…). Your roleplay keeps using your main model.</small>
                        <div id="ps_sidecar_modes" class="ps-sidecar-modes" role="radiogroup" aria-label="Model for background tasks"></div>

                        <div class="ps-sidecar-panel" data-mode="model">
                            <div class="ps-sidecar-provider"><i class="fa-solid fa-plug"></i><span id="ps_sidecar_provider"></span></div>
                            <label for="ps_sidecar_model_list">Model</label>
                            <select id="ps_sidecar_model_list" class="text_pole"></select>
                            <label for="ps_sidecar_model">Model ID <small>(pick above, or type any model your provider offers)</small></label>
                            <input id="ps_sidecar_model" class="text_pole" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. claude-haiku-5-5">
                            <small id="ps_sidecar_model_hint"></small>
                        </div>

                        <div class="ps-sidecar-panel" data-mode="profile">
                            <label for="ps_sidecar_profile">Connection profile</label>
                            <select id="ps_sidecar_profile" class="text_pole"></select>
                            <small id="ps_sidecar_hint"></small>
                        </div>

                        <div class="ps-sidecar-on">
                            <div id="ps_sidecar_test" class="menu_button menu_button_icon" role="button" tabindex="0" title="Send a tiny test request"><i class="fa-solid fa-vial"></i><span>Test the sidecar</span></div>
                            <div class="ps-sidecar-tasks">
                                <div class="ps-panel-label">Use it for</div>
                                <div id="ps_sidecar_tasks"></div>
                            </div>
                            <label class="checkbox_label"><input id="ps_sidecar_fallback" type="checkbox"> <span>If it fails, use the main connection instead</span></label>
                        </div>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-masks-theater"></i> This chat</div>
                        <div id="ps_scene_status"></div>
                        <div class="ps-button-row">
                            <div id="ps_start_scene" class="menu_button menu_button_icon"><i class="fa-solid fa-user-secret"></i><span>Start / edit scene</span></div>
                            <div id="ps_end_scene" class="menu_button menu_button_icon"><i class="fa-solid fa-door-open"></i><span>End scene</span></div>
                            <div id="ps_open_timeline" class="menu_button menu_button_icon"><i class="fa-solid fa-book-open"></i><span>Story memory</span></div>
                            <div id="ps_open_grid" class="menu_button menu_button_icon"><i class="fa-solid fa-table-cells"></i><span>Who knows what</span></div>
                        </div>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-clock"></i> Story clock</div>
                        <label class="checkbox_label"><input id="ps_clock_enabled" type="checkbox"> <span>Track the story time and place and tell the model</span></label>
                        <label class="checkbox_label"><input id="ps_clock_auto" type="checkbox"> <span>Update it after every reply (one extra short generation)</span></label>
                        <small>Otherwise it updates from summaries and from <code>@time …:</code> / <code>@place …:</code> tags.</small>
                        <div class="ps-clock-settings"><span id="ps_clock_status"></span><div id="ps_clock_edit" class="menu_button menu_button_icon"><i class="fa-solid fa-pen"></i><span>Set</span></div></div>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-earth-americas"></i> Common knowledge</div>
                        <small>Mark a message as something every character knows (news, announcements, rumors) with the <i class="fa-solid fa-user-secret"></i> button → Everyone, or a tag like <code>@news:</code>. It is saved to the 🌍 World knowledge lorebook entry.</small>
                        <label class="checkbox_label"><input id="ps_world_condense" type="checkbox"> <span>Condense each marked message into a short line (one extra short generation each)</span></label>
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
                        <label class="checkbox_label"><input id="ps_review" type="checkbox"> <span>Let me review summaries before they are saved</span></label>
                        <label class="checkbox_label"><input id="ps_keywords" type="checkbox"> <span>Ask for keywords (places, objects, events) as extra triggers</span></label>
                        <label class="checkbox_label"><input id="ps_hide_after_save" type="checkbox"> <span>Hide the original messages after saving</span></label>
                        <label class="checkbox_label"><input id="ps_branch_copy" type="checkbox"> <span>Branches and checkpoints get their own copy of the lorebook</span></label>
                        <label class="checkbox_label"><input id="ps_entry_constant" type="checkbox"> <span>Always include secret entries (otherwise when triggered)</span></label>
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
                        <div class="ps-grid-2">
                            <div>
                                <label for="ps_memory_budget">Memory budget (tokens always included)</label>
                                <input id="ps_memory_budget" class="text_pole" type="number" min="0" max="100000" step="100">
                            </div>
                            <label class="checkbox_label ps-budget-warn"><input id="ps_budget_warn" type="checkbox"> <span>Warn when over budget</span></label>
                        </div>
                        <label class="checkbox_label"><input id="ps_consolidate" type="checkbox"> <span>Merge old story entries into chapters (and chapters into arcs)</span></label>
                        <div class="ps-grid-2">
                            <div>
                                <label for="ps_consolidate_every">Entries per chapter</label>
                                <input id="ps_consolidate_every" class="text_pole" type="number" min="2" max="20">
                            </div>
                            <div>
                                <label for="ps_consolidate_keep">Keep the newest N detailed</label>
                                <input id="ps_consolidate_keep" class="text_pole" type="number" min="0" max="20">
                            </div>
                        </div>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-users"></i> Characters &amp; threads</div>
                        <label class="checkbox_label"><input id="ps_auto_sheets" type="checkbox"> <span>Keep character sheets and relationships up to date from story memory</span></label>
                        <label class="checkbox_label"><input id="ps_threads" type="checkbox"> <span>Track open threads (promises, plans, open questions)</span></label>
                        <small>Character sheets only use public story memory, so they never give away a secret.</small>
                    </div>

                    <div class="ps-section">
                        <details class="ps-advanced ps-advanced-section">
                            <summary><i class="fa-solid fa-wand-magic-sparkles"></i> AI prompts for background tasks</summary>
                            <small>The instructions sent to the sidecar (or main model) for each task. They are written so that smaller models follow them; keep the answer format the same when you edit them.</small>
                            <div id="ps_prompt_fields"></div>
                        </details>
                    </div>

                    <div class="ps-section">
                        <details class="ps-advanced ps-advanced-section">
                            <summary><i class="fa-solid fa-terminal"></i> What the model is told (advanced)</summary>
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
                        <label for="ps_common_rules">Common knowledge rules</label>
                        <textarea id="ps_common_rules" class="text_pole textarea_compact" rows="3"></textarea>
                        <label for="ps_common_start">Common knowledge label (<code>{{kind}}</code> = News, Rumor…)</label>
                        <input id="ps_common_start" class="text_pole" type="text">
                        <label for="ps_rumor_start">Rumor label</label>
                        <input id="ps_rumor_start" class="text_pole" type="text">
                        <label for="ps_common_end">Common knowledge end label</label>
                        <input id="ps_common_end" class="text_pole" type="text">
                        <label for="ps_rules_depth">Rules depth (0 = after the last message)</label>
                        <input id="ps_rules_depth" class="text_pole" type="number" min="0" max="100">
                        <div id="ps_reset" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate-left"></i><span>Restore default text</span></div>
                        </details>
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
        '#ps_branch_copy': 'branchCopy',
        '#ps_entry_constant': 'entryConstant',
        '#ps_auto_memory': 'autoMemory',
        '#ps_memory_constant': 'memoryConstant',
        '#ps_review': 'reviewBeforeSave',
        '#ps_consolidate': 'consolidate',
        '#ps_auto_sheets': 'autoSheets',
        '#ps_threads': 'trackThreads',
        '#ps_clock_enabled': 'clockEnabled',
        '#ps_clock_auto': 'clockAutoTrack',
        '#ps_world_condense': 'worldCondense',
        '#ps_sidecar_fallback': 'sidecarFallback',
    };
    const numbers = new Set(['memoryBudget', 'rulesDepth', 'memoryEvery', 'memoryKeepRecent', 'consolidateEvery', 'consolidateKeep']);
    const fields = {
        '#ps_rules': 'rules',
        '#ps_scene_rules': 'sceneRules',
        '#ps_rules_depth': 'rulesDepth',
        '#ps_label_start': 'labelStart',
        '#ps_label_end': 'labelEnd',
        '#ps_memory_every': 'memoryEvery',
        '#ps_memory_budget': 'memoryBudget',
        '#ps_budget_warn': 'budgetWarn',
        '#ps_memory_keep': 'memoryKeepRecent',
        '#ps_consolidate_every': 'consolidateEvery',
        '#ps_consolidate_keep': 'consolidateKeep',
        '#ps_common_rules': 'commonRules',
        '#ps_common_start': 'commonLabelStart',
        '#ps_rumor_start': 'rumorLabelStart',
        '#ps_common_end': 'commonLabelEnd',
    };
    const textDefaults = ['rules', 'sceneRules', 'labelStart', 'labelEnd', 'rulesDepth',
        'commonRules', 'commonLabelStart', 'rumorLabelStart', 'commonLabelEnd'];
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
    addSidecarControls();
    addPromptFields();
    $('#ps_start_scene').on('click', onSceneButtonClick);
    $('#ps_end_scene').on('click', endScene);
    $('#ps_open_timeline').on('click', () => openMemory('timeline'));
    $('#ps_open_grid').on('click', () => openMemory('secrets'));
    $('#ps_clock_edit').on('click', editClock);
}

export function initUi() {
    addMessageButtons();
    addSceneBar();
    addWandMenuItems();
    addSettingsPanel();
    arrangeSettings();
}

// ─── Settings layout: header card, collapsible groups, live summaries ─

const OPEN_GROUPS_KEY = 'privateScenes.openGroups';

const readOpenGroups = () => {
    try {
        return new Set(JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) ?? '[]'));
    } catch {
        return new Set();
    }
};

const saveOpenGroups = (open) => {
    try {
        localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify([...open]));
    } catch { /* private window or storage blocked: groups just start closed */ }
};

const onOff = (value) => value ? 'On' : 'Off';

/** One-line summaries shown on each closed group, so the setup is readable at a glance. */
const GROUP_SUMMARIES = {
    messages: (s) => `Badges ${onOff(s.showBadges).toLowerCase()} · @tags ${onOff(s.inlineTags).toLowerCase()}`,
    sidecar: (s) => s.sidecarMode === 'model' && s.sidecarModel ? `${s.sidecarModel}${modelSidecarProblem() ? ' · needs attention' : ` via ${sourceName()}`}`
        : s.sidecarMode === 'profile' && s.sidecarProfile ? `Profile: ${sidecarProfiles()?.find(p => p.id === s.sidecarProfile)?.name ?? 'missing'}`
            : 'Same model as the roleplay',
    clock: (s) => {
        if (!s.clockEnabled) return 'Off';
        const { time, place } = getClock();
        return [time, place].filter(Boolean).join(' · ') || 'On · not set yet';
    },
    common: (s) => s.worldCondense ? 'Condensed into World knowledge' : 'Message text kept as is',
    leak: (s) => !s.leakCheck ? 'Off' : s.leakAutoRegenerate ? 'On · regenerates automatically' : 'On · warns you',
    timeline: (s) => [s.autoSave ? 'Auto-save secrets' : 'Save secrets by hand', s.reviewBeforeSave ? 'review first' : null, s.hideAfterSave ? 'hide originals' : null].filter(Boolean).join(' · '),
    story: (s) => [s.autoMemory ? `Every ${s.memoryEvery} messages` : 'Summarize by hand', s.consolidate ? `chapters of ${s.consolidateEvery}` : null, Number(s.memoryBudget) ? `budget ${Number(s.memoryBudget).toLocaleString()}` : null].filter(Boolean).join(' · '),
    characters: (s) => `Sheets ${onOff(s.autoSheets).toLowerCase()} · threads ${onOff(s.trackThreads).toLowerCase()}`,
    prompts: () => 'Instructions for each background task',
    advanced: () => 'Labels, rules and where they go in the prompt',
};

/** Wraps a block of settings in a collapsible card with an icon, title and live summary. */
function makeGroup(id, icon, title, body) {
    const group = $(`
        <details class="ps-group">
            <summary class="ps-group-head">
                <span class="ps-group-icon"><i class="fa-solid"></i></span>
                <span class="ps-group-text"><b></b><small class="ps-group-summary"></small></span>
                <i class="fa-solid fa-chevron-down ps-group-chevron" aria-hidden="true"></i>
            </summary>
            <div class="ps-group-body"></div>
        </details>`);
    group.attr('data-group', id);
    group.find('.ps-group-icon i').addClass(icon);
    group.find('b').text(title);
    group.find('.ps-group-body').append(body);
    return group;
}

/**
 * Turns the plain settings list into a header card plus collapsible groups.
 * Elements are moved, not rebuilt, so every control keeps its handlers.
 */
function arrangeSettings() {
    const content = $('.private-scenes-settings .inline-drawer-content');
    const sections = content.children('.ps-section');
    const byTitle = (text) => sections.filter((_, el) => $(el).children('.ps-section-title').text().trim().startsWith(text));

    // Header card: master switch, live status, quick actions and this chat's scene.
    const hero = $(`
        <div class="ps-hero">
            <div class="ps-hero-top">
                <div class="ps-hero-icon"><i class="fa-solid fa-user-secret"></i></div>
                <div class="ps-hero-title"><b>Private Scenes</b><small></small></div>
                <div class="ps-hero-switch"></div>
            </div>
            <div class="ps-hero-stats"></div>
            <div class="ps-hero-scene"></div>
            <div class="ps-hero-actions"></div>
        </div>`);
    hero.find('.ps-hero-title small').text(`Secrets, memory and world knowledge · v${EXTENSION_VERSION}`);
    const enabled = $('#ps_enabled').closest('label');
    enabled.find('span').text('Enabled');
    hero.find('.ps-hero-switch').append(enabled);
    const chat = byTitle('This chat');
    hero.find('.ps-hero-scene').append($('#ps_scene_status'));
    hero.find('.ps-hero-actions').append(chat.find('.ps-button-row').children());
    content.prepend(hero);
    chat.remove();

    // The untitled first section (badges and tags) becomes a group too.
    const first = sections.first();
    first.replaceWith(makeGroup('messages', 'fa-tags', 'Messages & tags', first.children()).wrap('<div class="ps-section"></div>').parent());

    const titled = [
        ['AI sidecar', 'sidecar'], ['Story clock', 'clock'], ['Common knowledge', 'common'], ['Leak checker', 'leak'],
        ['Lorebook timeline', 'timeline'], ['Story memory', 'story'], ['Characters', 'characters'],
    ];
    for (const [title, id] of titled) {
        const section = byTitle(title);
        const heading = section.children('.ps-section-title');
        const icon = heading.find('i').attr('class')?.replace('fa-solid', '').trim();
        const label = heading.text().trim();
        heading.remove();
        section.append(makeGroup(id, icon, label, section.children().not('.ps-group')));
    }

    // The two "advanced" sections are <details> already: give them the same look.
    content.find('details.ps-advanced-section').each(function () {
        const summary = $(this).children('summary');
        const icon = summary.find('i').attr('class')?.replace('fa-solid', '').trim();
        const label = summary.text().trim();
        const id = label.startsWith('AI prompts') ? 'prompts' : 'advanced';
        summary.remove();
        $(this).replaceWith(makeGroup(id, icon, label.replace(' (advanced)', ''), $(this).children()));
    });

    // Remember which groups are open, per browser.
    const open = readOpenGroups();
    content.find('.ps-group').each(function () {
        const id = $(this).data('group');
        this.open = open.has(id);
        $(this).on('toggle', () => {
            const now = readOpenGroups();
            if (this.open) now.add(id);
            else now.delete(id);
            saveOpenGroups(now);
        });
    });
    content.addClass('ps-arranged');
    content.on('change input', () => refreshSettingsSummary());
    refreshSettingsSummary();
}

/** Updates the header card's status pills and every group's one-line summary. */
function refreshSettingsSummary() {
    const s = settings();
    for (const [id, summarize] of Object.entries(GROUP_SUMMARIES)) {
        $(`.ps-group[data-group="${id}"] .ps-group-summary`).text(summarize(s));
    }
    const state = chatState();
    const stats = $('.ps-hero-stats').empty();
    const stat = (icon, text, cls = '') => stats.append($('<span class="ps-hero-stat"><i class="fa-solid"></i><span></span></span>')
        .addClass(cls).find('i').addClass(icon).end().find('span').text(text).end());
    if (!s.enabled) {
        stat('fa-power-off', 'Turned off', 'ps-stat-off');
        return;
    }
    const secrets = findScenes().length;
    stat('fa-user-secret', `${secrets} secret${secrets === 1 ? '' : 's'}`);
    stat('fa-scroll', `${state.memories.length} story ${state.memories.length === 1 ? 'entry' : 'entries'}`);
    stat('fa-earth-americas', `${state.world.length} world`);
    stat('fa-microchip', GROUP_SUMMARIES.sidecar(s), s.sidecarMode !== 'main' ? 'ps-stat-accent' : '');
}

// ─── Settings: AI sidecar & prompts ──────────────────────────────────

const SIDECAR_MODES = [
    ['main', 'fa-equals', 'Same as the roleplay'],
    ['model', 'fa-microchip', 'Pick a model'],
    ['profile', 'fa-plug', 'Connection profile'],
];

/** Fills the profile dropdown (profiles can be added at any time in the Connection Manager). */
function fillSidecarProfiles() {
    const s = settings();
    const select = $('#ps_sidecar_profile').empty();
    const profiles = sidecarProfiles();
    select.append(new Option('Choose a profile…', ''));
    for (const profile of profiles ?? []) {
        select.append(new Option(profile.model ? `${profile.name} — ${profile.model}` : profile.name, profile.id));
    }
    const known = (profiles ?? []).some(p => p.id === s.sidecarProfile);
    if (s.sidecarProfile && !known) select.append(new Option('(profile was deleted)', s.sidecarProfile));
    select.val(s.sidecarProfile || '').prop('disabled', profiles === null);

    $('#ps_sidecar_hint').text(profiles === null
        ? 'Turn on the Connection Manager extension to use profiles.'
        : !profiles.length
            ? 'Save one first: open the plug icon, set up a connection, and save it under Connection Profile. Profiles can use any provider or a local model.'
            : 'Profiles can use any provider or a local model, separate from your roleplay connection.');
}

/** Fills the model dropdown from the provider your roleplay is connected to. */
function fillSidecarModels() {
    const s = settings();
    const source = currentSource();
    const models = providerModels(source);
    const mainModel = source ? ctx().getChatCompletionModel?.() : '';

    $('#ps_sidecar_provider').text(source
        ? `Uses your current provider, ${sourceName(source)}, and its API key.`
        : 'Your roleplay uses a Text Completion connection. Picking a model needs Chat Completion, so use a connection profile instead.');

    const select = $('#ps_sidecar_model_list').empty().prop('disabled', !models.length);
    select.append(new Option(models.length ? 'Choose a model…' : 'No model list yet', ''));
    const groups = new Map();
    for (const model of models) {
        const label = model.id === mainModel ? `${model.label}  (your roleplay model)` : model.label;
        const option = new Option(label, model.id);
        if (model.group) {
            if (!groups.has(model.group)) groups.set(model.group, $('<optgroup>').attr('label', model.group).appendTo(select));
            groups.get(model.group).append(option);
        } else {
            select.append(option);
        }
    }
    select.val(models.some(m => m.id === s.sidecarModel) ? s.sidecarModel : '');
    $('#ps_sidecar_model').val(s.sidecarModel);

    const problem = s.sidecarModel ? modelSidecarProblem() : '';
    $('#ps_sidecar_model_hint').toggleClass('ps-warn-text', !!problem).text(problem
        || (!models.length && source ? 'Connect in the API panel (plug icon) so SillyTavern loads the model list, or type a model ID.' : ''));
}

/** Shows the panel for the chosen mode. */
function syncSidecarMode() {
    const mode = settings().sidecarMode;
    $('#ps_sidecar_modes input').each(function () {
        $(this).prop('checked', $(this).val() === mode);
    });
    $('.ps-sidecar-panel').each(function () {
        $(this).toggle($(this).data('mode') === mode);
    });
    $('.ps-sidecar-on').toggle(mode !== 'main');
    if (mode === 'model') fillSidecarModels();
    if (mode === 'profile') fillSidecarProfiles();
}

function addSidecarControls() {
    const s = settings();
    const modes = $('#ps_sidecar_modes');
    for (const [value, icon, label] of SIDECAR_MODES) {
        modes.append(radioPill('ps_sidecar_mode', value, icon, label, s.sidecarMode === value, 'ps-kind ps-sidecar-mode'));
    }
    modes.on('change', 'input', function () {
        s.sidecarMode = String($(this).val());
        s.sidecarModeSet = true;
        ctx().saveSettingsDebounced();
        syncSidecarMode();
    });

    const tasks = $('#ps_sidecar_tasks');
    for (const [task, { label }] of Object.entries(TASKS)) {
        const row = $('<label class="checkbox_label"><input type="checkbox"> <span></span></label>');
        row.find('span').text(label);
        row.find('input').prop('checked', s.sidecarTasks?.[task] !== false).on('change', function () {
            s.sidecarTasks = { ...s.sidecarTasks, [task]: !!$(this).prop('checked') };
            ctx().saveSettingsDebounced();
        });
        tasks.append(row);
    }

    const chooseModel = (model) => {
        s.sidecarModel = String(model ?? '').trim();
        s.sidecarSource = s.sidecarModel ? currentSource() ?? '' : '';
        ctx().saveSettingsDebounced();
    };
    // Refresh lists when opened: the provider, its models, or the profiles may have changed meanwhile.
    $('#ps_sidecar_model_list').on('focus pointerdown', fillSidecarModels).on('change', function () {
        if (!$(this).val()) return;
        chooseModel($(this).val());
        fillSidecarModels();
    });
    $('#ps_sidecar_model').on('input', function () {
        chooseModel($(this).val());
    }).on('change', fillSidecarModels);
    $('#ps_sidecar_profile').on('focus pointerdown', fillSidecarProfiles).on('change', function () {
        s.sidecarProfile = String($(this).val() ?? '');
        ctx().saveSettingsDebounced();
    });
    $('#ps_sidecar_test').on('click', testSidecar);
    // Keep the provider line and model list current when the main connection changes.
    ctx().eventSource.on(ctx().eventTypes.CHATCOMPLETION_SOURCE_CHANGED ?? 'chatcompletion_source_changed', () => settings().sidecarMode === 'model' && fillSidecarModels());
    syncSidecarMode();
}

function addPromptFields() {
    const s = settings();
    const container = $('#ps_prompt_fields');
    for (const [key, label, note] of PROMPT_FIELDS) {
        const field = $(`
            <div class="ps-prompt-field">
                <div class="ps-prompt-head"><label></label><div class="menu_button menu_button_icon ps-btn ps-btn-icon" role="button" tabindex="0" title="Restore the default"><i class="fa-solid fa-rotate-left"></i></div></div>
                <small></small>
                <textarea class="text_pole textarea_compact" rows="6"></textarea>
            </div>`);
        const id = `ps_prompt_${key}`;
        field.find('label').text(label).attr('for', id);
        field.find('small').text(note).toggle(!!note);
        const area = field.find('textarea').attr('id', id).val(s[key]);
        area.on('input', () => {
            s[key] = String(area.val());
            ctx().saveSettingsDebounced();
        });
        field.find('.ps-btn').attr('aria-label', `Restore the default ${label} prompt`).on('click', () => {
            s[key] = PROMPTS[key];
            area.val(PROMPTS[key]);
            ctx().saveSettingsDebounced();
        });
        container.append(field);
    }
}

// ─── Settings window ─────────────────────────────────────────────────

let settingsWindowOpen = false;

/**
 * Shows one of our popups. The Popup is created here rather than through
 * callGenericPopup so it exists from the first frame: SillyTavern runs onOpen
 * only after the opening animation, and a quick tap before that was lost.
 * dialogClass styles it (ps-window-dialog: full screen on phones, roomy on
 * tablets; ps-sheet-dialog: a bottom sheet on phones), and every
 * .ps-window-close inside closes it. setup(popup) runs before it is shown.
 */
export function showPopup(content, { dialogClass, closeResult = 'affirmative', setup = null, ...options }) {
    const c = ctx();
    const popup = new c.Popup(content, c.POPUP_TYPE.TEXT, '', options);
    if (dialogClass) popup.dlg.classList.add(dialogClass);
    $(content).find('.ps-window-close').on('click', () => closeResult === 'cancel' ? popup.completeCancelled() : popup.completeAffirmative());
    setup?.(popup);
    return popup.show();
}

/** A round close button for a window's title bar or banner. */
export function windowCloseButton() {
    return $('<div class="ps-window-close" role="button" tabindex="0" title="Close" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></div>')
        .on('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                $(this).trigger('click');
            }
        });
}

/**
 * Opens the settings as a window (from the wand menu). The settings are
 * moved into it, not copied, and moved back to the Extensions panel on close,
 * so there is only ever one set of controls.
 */
export async function openSettingsWindow() {
    const drawer = $('.private-scenes-settings .inline-drawer-content');
    if (!drawer.length || settingsWindowOpen) return;
    settingsWindowOpen = true;

    const root = $(`
        <div class="ps-window ps-settings-window private-scenes-settings">
            <div class="ps-window-bar">
                <div class="ps-window-title"><i class="fa-solid fa-sliders"></i><b>Settings</b></div>
            </div>
            <div class="ps-window-body"></div>
        </div>`);
    root.find('.ps-window-bar').append(windowCloseButton());
    root.find('.ps-window-body').append(drawer.children().detach());
    refreshSettingsSummary();

    try {
        await showPopup(root[0], {
            dialogClass: 'ps-window-dialog',
            wide: true, large: true, allowVerticalScrolling: true, okButton: 'Done',
            // Put the controls back before the popup's DOM is removed.
            onClose: () => drawer.append(root.find('.ps-window-body').children().detach()),
        });
    } finally {
        settingsWindowOpen = false;
    }
}

// ─── Sheets: the launcher and the per-message actions ────────────────

/**
 * A small popup of choices (a bottom sheet on phones). Anything inside with
 * data-action closes it; the chosen action is returned (null when dismissed).
 */
async function openSheet(content, className) {
    let chosen = null;
    let popupRef = null;
    // ps-actionsheet, not ps-sheet: that class belongs to the character sheet cards.
    const root = $('<div class="ps-popup ps-actionsheet"><div class="ps-sheet-grabber" aria-hidden="true"></div></div>').addClass(className);
    root.append(content);
    const choose = (el) => {
        if ($(el).hasClass('disabled')) return;
        chosen = $(el).data('action');
        popupRef?.completeAffirmative();
    };
    root.on('click', '[data-action]', function () {
        choose(this);
    }).on('keydown', '[data-action]', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            choose(this);
        }
    });
    await showPopup(root[0], {
        dialogClass: 'ps-sheet-dialog', closeResult: 'cancel',
        okButton: false, cancelButton: false, allowVerticalScrolling: true, animation: 'fast',
        setup: (popup) => { popupRef = popup; },
    });
    return chosen;
}

function sheetHeader(icon, title, subtitle) {
    const header = $(popupHeader(icon, title, subtitle)).addClass('ps-sheet-header');
    header.append(windowCloseButton());
    return header;
}

/** A big square-ish tile for the launcher. */
function tile(action, icon, title, status, { tone = '', badge = 0, disabled = false } = {}) {
    const el = $('<div class="ps-tile" role="button" tabindex="0"><span class="ps-tile-icon"><i class="fa-solid"></i></span><b></b><small></small></div>');
    el.attr('data-action', action).addClass(tone ? `ps-tone-${tone}` : '').toggleClass('disabled', disabled).attr('aria-disabled', String(disabled));
    el.find('i').addClass(icon);
    el.find('b').text(title);
    el.find('small').text(status);
    if (badge) el.append($('<span class="ps-tile-badge"></span>').text(badge));
    return el;
}

/** A full-width row for the message sheet. */
function actionRow(action, icon, title, status, { tone = '', disabled = false } = {}) {
    const el = $('<div class="ps-action" role="button" tabindex="0"><span class="ps-tile-icon"><i class="fa-solid"></i></span><span class="ps-action-text"><b></b><small></small></span><i class="fa-solid fa-chevron-right ps-action-go" aria-hidden="true"></i></div>');
    el.attr('data-action', action).addClass(tone ? `ps-tone-${tone}` : '').toggleClass('disabled', disabled).attr('aria-disabled', String(disabled));
    el.find('.ps-tile-icon i').addClass(icon);
    el.find('b').text(title);
    el.find('small').text(status);
    return el;
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Everything the extension does, in one place (from the wand menu). */
export async function openLauncher() {
    const s = settings();
    const state = chatState();
    const scene = getScene();
    const secrets = findScenes().length;
    const pending = Math.max(0, ctx().chat.length - state.memoryCursor);
    const attention = state.drafts.length + staleItems().length;
    const openThreads = state.threads.filter(t => t.status === 'open').length;

    const content = $('<div class="ps-launcher"></div>');
    content.append(sheetHeader('fa-user-secret', 'Private Scenes', scene
        ? `Private scene running with ${formatMembers(scene.members)}`
        : 'Secrets, memory and world knowledge for this chat'));

    const grid = $('<div class="ps-tiles"></div>');
    grid.append(
        tile('scene', 'fa-masks-theater', scene ? 'Private scene' : 'Start a private scene',
            scene ? `With ${formatMembers(scene.members)} · edit or end` : 'Only the characters you pick see it', { tone: scene ? 'live' : '' }),
        tile('memory', 'fa-book-open', 'Story memory', `${count(state.memories.length, 'entry', 'entries')} · ${count(secrets, 'secret')}`, { badge: attention }),
        tile('summarize', 'fa-scroll', 'Summarize', pending ? `${count(pending, 'new message')} to save` : 'Up to date', { tone: 'story', disabled: !pending }),
        tile('secrets', 'fa-table-cells', 'Who knows what', secrets ? count(secrets, 'secret') : 'No secrets yet'),
        tile('characters', 'fa-users', 'Characters', count(sheetList().length, 'sheet')),
        tile('threads', 'fa-list-check', 'Threads & facts', `${count(openThreads, 'open thread')} · ${count(state.facts.length + state.world.length, 'fact')}`, { tone: 'world' }),
        tile('budget', 'fa-gauge-high', 'Prompt & budget', lastMeasure && lastMeasure.book === ctx().chatMetadata?.world_info
            ? `~${lastMeasure.always.toLocaleString()} / ${(Number(s.memoryBudget) || 0).toLocaleString()} tokens always on`
            : 'What the model gets, in tokens', { tone: lastMeasure && s.memoryBudget && lastMeasure.always > s.memoryBudget ? 'warn' : '' }),
        tile('settings', 'fa-sliders', 'Settings', GROUP_SUMMARIES.sidecar(s) === 'Same model as the roleplay' ? 'Sidecar, prompts, everything' : `Sidecar: ${GROUP_SUMMARIES.sidecar(s)}`),
    );
    content.append(grid);
    if (!s.enabled) content.append('<div class="ps-notice ps-notice-warn"><i class="fa-solid fa-power-off"></i><span>Private Scenes is turned off. Turn it on in Settings.</span></div>');

    const actions = {
        scene: onSceneButtonClick,
        memory: () => openMemory('timeline'),
        summarize: () => saveStorySoFar(),
        secrets: () => openMemory('secrets'),
        characters: () => openMemory('characters'),
        threads: () => openMemory('threads'),
        budget: () => openBudget(),
        settings: openSettingsWindow,
    };
    const chosen = await openSheet(content, 'ps-launcher-sheet');
    if (chosen) await actions[chosen]?.();
}

/** What a message's visibility is, in words. */
function visibilityLabel(message) {
    const common = getCommon(message);
    if (common) return `${COMMON_KINDS[commonKind(common.kind)].label}: every character knows`;
    const members = getMembers(message);
    if (members) return `Private: only ${formatMembers(members)}`;
    return 'Normal: whoever was there';
}

/** The per-message sheet: who knows, pin a fact, summarize up to here. */
async function openMessageSheet(id, selected) {
    const message = ctx().chat[id];
    const state = chatState();
    const from = Math.min(state.memoryCursor, id);
    const alreadySaved = id < state.memoryCursor;
    const tone = getCommon(message) ? 'world' : getMembers(message) ? '' : 'ok';

    const content = $('<div class="ps-message-sheet"></div>');
    content.append(sheetHeader('fa-user-secret', `Message ${id}`, `${message.name}: ${String(message.mes ?? '').replace(/\s+/g, ' ').slice(0, 80)}${String(message.mes ?? '').length > 80 ? '…' : ''}`));
    content.append(
        actionRow('visibility', getCommon(message) ? 'fa-earth-americas' : getMembers(message) ? 'fa-user-secret' : 'fa-users', 'Who knows about this?', visibilityLabel(message), { tone }),
        actionRow('pin', 'fa-thumbtack', 'Pin a fact', selected ? `“${selected.slice(0, 60)}${selected.length > 60 ? '…' : ''}”` : 'Something from this message the story must remember'),
        actionRow('summarize', 'fa-scroll', 'Summarize the story up to here',
            alreadySaved ? 'Already in story memory' : `Messages ${from}–${id}, public parts only`, { tone: 'story', disabled: alreadySaved }),
    );

    const chosen = await openSheet(content, 'ps-message-sheet-dialog');
    if (chosen === 'visibility') await chooseVisibility(id);
    if (chosen === 'pin') await pinFromMessage(id, selected);
    if (chosen === 'summarize') await saveMemory(from, id);
}

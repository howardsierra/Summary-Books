// Shared UI building blocks (chips, popups, buttons), chat decorations, leak
// warnings, the pin button, the scene bar and the settings panel.

import {
    COMMON_KINDS, adoptScene, allNames, commonKind, ctx, defaultSettings, endScene, ensureMid, formatMembers, getCommon,
    getFlag, getMembers, getScene, nameHue, parseNames, revealedNames, setRevealedNames, settings, startScene,
} from './core.js';
import { refreshSceneEntry } from './lorebook.js';
import { joinSummary, parseSummary } from './extract.js';
import { addFact, getClock, setVisibility } from './memory.js';
import { checking, currentLeak, dismissLeak, regenerate } from './leaks.js';
import {
    TASKS, currentSource, modelSidecarProblem, providerModels, sidecarProfiles, sourceName, testSidecar,
} from './llm.js';
import { PROMPTS, PROMPT_FIELDS } from './prompts.js';
import { editClock, openMemory, refreshMemory } from './hub.js';

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

async function onMessageButtonClick(event) {
    const id = Number($(event.currentTarget).closest('.mes').attr('mesid'));
    const message = ctx().chat[id];
    if (!message) return;
    const visibility = await pickVisibility(message);
    if (visibility) await setVisibility([id], visibility);
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

async function onPinClick(event) {
    const mes = $(event.currentTarget).closest('.mes');
    const id = Number(mes.attr('mesid'));
    const message = ctx().chat[id];
    if (!message) return;
    // Start from the selected text when it's inside this message.
    const selection = window.getSelection();
    const selected = selection && mes[0].contains(selection.anchorNode) ? selection.toString().trim() : '';
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

export function refreshUi() {
    const chat = ctx().chat;
    const s = settings();

    $('#chat .mes').each(function () {
        const id = Number($(this).attr('mesid'));
        const message = chat[id];
        const members = s.enabled ? getMembers(message) : null;
        const common = s.enabled ? getCommon(message) : null;
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

    const { time, place } = getClock();
    $('#ps_clock_status').text(settings().clockEnabled ? [time || 'time not set', place || 'place not set'].join(' · ') : 'Story clock is off.');

    refreshMemory();
}

// ─── Fixed UI ────────────────────────────────────────────────────────

function addMessageButtons() {
    const buttons = '<div title="Who knows about this? (everyone, who was there, or only certain characters)" class="mes_button ps_toggle fa-solid fa-user-secret"></div>'
        + '<div title="Pin a fact from this message" class="mes_button ps_pin fa-solid fa-thumbtack"></div>';
    $('#message_template .extraMesButtons').prepend(buttons);
    // Messages rendered before this extension loaded.
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.ps_toggle').length) $(this).prepend(buttons);
    });
    $(document).on('click', '.ps_toggle', onMessageButtonClick);
    $(document).on('click', '.ps_pin', onPinClick);
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
    const items = $(`
        <div class="list-group-item flex-container flexGap5 interactable" id="ps_wand_scene" tabindex="0">
            <div class="fa-solid fa-user-secret extensionsMenuExtensionButton"></div><span>Private scene…</span>
        </div>
        <div class="list-group-item flex-container flexGap5 interactable" id="ps_wand_timeline" tabindex="0">
            <div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div><span>Story memory</span>
        </div>
        <div class="list-group-item flex-container flexGap5 interactable" id="ps_wand_grid" tabindex="0">
            <div class="fa-solid fa-table-cells extensionsMenuExtensionButton"></div><span>Who knows what</span>
        </div>`);
    $('#extensionsMenu').append(items);
    $('#ps_wand_scene').on('click', onSceneButtonClick);
    $('#ps_wand_timeline').on('click', () => openMemory('timeline'));
    $('#ps_wand_grid').on('click', () => openMemory('secrets'));
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
    const numbers = new Set(['rulesDepth', 'memoryEvery', 'memoryKeepRecent', 'consolidateEvery', 'consolidateKeep']);
    const fields = {
        '#ps_rules': 'rules',
        '#ps_scene_rules': 'sceneRules',
        '#ps_rules_depth': 'rulesDepth',
        '#ps_label_start': 'labelStart',
        '#ps_label_end': 'labelEnd',
        '#ps_memory_every': 'memoryEvery',
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

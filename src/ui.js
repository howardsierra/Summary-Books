// Shared UI building blocks (chips, popups, buttons), chat decorations, leak
// warnings, the pin button, the scene bar and the settings panel.

import {
    adoptScene, allNames, ctx, defaultSettings, endScene, ensureMid, flagMessages, formatMembers, getFlag,
    getMembers, getScene, nameHue, parseNames, revealedNames, setRevealedNames, settings, startScene,
} from './core.js';
import { refreshSceneEntry } from './lorebook.js';
import { joinSummary, parseSummary } from './extract.js';
import { addFact, getClock } from './memory.js';
import { checking, currentLeak, dismissLeak, regenerate } from './leaks.js';
import { editClock, openMemory, refreshMemory } from './hub.js';

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

    const { time, place } = getClock();
    $('#ps_clock_status').text(settings().clockEnabled ? [time || 'time not set', place || 'place not set'].join(' · ') : 'Story clock is off.');

    refreshMemory();
}

// ─── Fixed UI ────────────────────────────────────────────────────────

function addMessageButtons() {
    const buttons = '<div title="Private: choose who knows about this" class="mes_button ps_toggle fa-solid fa-user-secret"></div>'
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
                        </ul>
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
                        <details class="ps-advanced">
                            <summary>Customize the secret summary instructions</summary>
                            <textarea id="ps_summary_prompt" class="text_pole textarea_compact" rows="4" aria-label="Secret summary instructions"></textarea>
                        </details>
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
                        <details class="ps-advanced">
                            <summary>Customize the story summary instructions</summary>
                            <textarea id="ps_memory_prompt" class="text_pole textarea_compact" rows="4" aria-label="Story summary instructions"></textarea>
                        </details>
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
                        <details class="ps-advanced">
                            <summary>Customize the chapter instructions</summary>
                            <textarea id="ps_chapter_prompt" class="text_pole textarea_compact" rows="3" aria-label="Chapter instructions"></textarea>
                        </details>
                    </div>

                    <div class="ps-section">
                        <div class="ps-section-title"><i class="fa-solid fa-users"></i> Characters &amp; threads</div>
                        <label class="checkbox_label"><input id="ps_auto_sheets" type="checkbox"> <span>Keep character sheets and relationships up to date from story memory</span></label>
                        <label class="checkbox_label"><input id="ps_threads" type="checkbox"> <span>Track open threads (promises, plans, open questions)</span></label>
                        <small>Character sheets only use public story memory, so they never give away a secret.</small>
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
    };
    const numbers = new Set(['rulesDepth', 'memoryEvery', 'memoryKeepRecent', 'consolidateEvery', 'consolidateKeep']);
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
        '#ps_consolidate_every': 'consolidateEvery',
        '#ps_consolidate_keep': 'consolidateKeep',
        '#ps_chapter_prompt': 'chapterPrompt',
    };
    const textDefaults = ['rules', 'sceneRules', 'labelStart', 'labelEnd', 'summaryPrompt', 'memoryPrompt', 'chapterPrompt', 'rulesDepth'];
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

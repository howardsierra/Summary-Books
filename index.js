// Private Scenes — flag messages as private between certain characters, so the
// narrator knows those events happened out of everyone else's sight.
//
// Flags live in message.extra.private_scene = { members: [...] } (saved in the chat file).
// The active scene and the list of names used in a chat live in chat metadata.
// At generation time the interceptor wraps each run of private messages in labels
// and injects a rules prompt explaining what the labels mean.

const MODULE = 'privateScenes';
const FLAG = 'private_scene';
const PROMPT_KEY = 'private_scenes_rules';

// extension_prompt_types.IN_CHAT / extension_prompt_roles.SYSTEM
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

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
    meta[MODULE] ??= { scene: null, names: [] };
    meta[MODULE].names ??= [];
    return meta[MODULE];
}

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

// ─── Message flags ───────────────────────────────────────────────────

/** @returns {string[]|null} */
function getMembers(message) {
    const members = message?.extra?.[FLAG]?.members;
    return Array.isArray(members) && members.length ? members : null;
}

/**
 * Flags a message (or clears it when members is empty). The flag is copied to
 * every swipe so it belongs to the message slot, not just the visible swipe.
 */
function setMembers(message, members) {
    const apply = (extra) => {
        if (members?.length) extra[FLAG] = { members: [...members] };
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
    if (members?.length) rememberNames(members);
}

/** A new swipe starts with empty extras; carry the flag over from its siblings. */
function inheritSwipeFlag(message) {
    if (!message || getMembers(message) || !Array.isArray(message.swipe_info)) return;
    const flagged = message.swipe_info.find(info => getMembers(info));
    if (flagged) setMembers(message, getMembers(flagged));
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
        if (i >= 0 && i < chat.length) ids.push(i);
    }
    if (!ids.length) throw new Error(`No messages found at "${at}"`);
    return ids;
}

function flagMessages(ids, members) {
    const chat = ctx().chat;
    for (const id of ids) {
        if (chat[id]) setMembers(chat[id], members);
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
    chatState().scene = { members: [...members] };
    rememberNames(members);
    ctx().saveMetadataDebounced();
    refreshUi();
}

function endScene() {
    chatState().scene = null;
    ctx().saveMetadataDebounced();
    refreshUi();
}

function onNewMessage(id, type) {
    const message = ctx().chat[id];
    if (!message || message.is_system || type === 'first_message') return;
    const scene = getScene();
    if (scene) setMembers(message, scene.members);
    else inheritSwipeFlag(message);
    saveSoon();
    refreshUi();
}

function onSwiped(id) {
    inheritSwipeFlag(ctx().chat[id]);
    refreshUi();
}

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
    if (anyPrivate || scene) parts.push(s.rules);
    if (scene) parts.push(formatTemplate(s.sceneRules, scene.members));
    ctx().setExtensionPrompt(PROMPT_KEY, parts.join('\n'), IN_CHAT, Number(s.rulesDepth) || 0, false, ROLE_SYSTEM);
};

// ─── UI ──────────────────────────────────────────────────────────────

/** Popup with a checkbox per known name plus a field for new names. Returns null on cancel. */
async function pickMembers(title, current = []) {
    const c = ctx();
    const known = parseNames([...current, ...chatState().names, c.name1]);
    const currentKeys = new Set(current.map(x => x.toLowerCase()));

    const root = document.createElement('div');
    root.classList.add('ps-picker');

    const heading = document.createElement('h3');
    heading.textContent = title;
    root.append(heading);

    const list = document.createElement('div');
    list.classList.add('ps-picker-list');
    for (const name of known) {
        const label = document.createElement('label');
        label.classList.add('checkbox_label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = name;
        box.checked = currentKeys.has(name.toLowerCase());
        const text = document.createElement('span');
        text.textContent = name;
        label.append(box, text);
        list.append(label);
    }
    root.append(list);

    const input = document.createElement('input');
    input.type = 'text';
    input.classList.add('text_pole');
    input.placeholder = 'Add names, comma separated';
    root.append(input);

    const hint = document.createElement('small');
    hint.textContent = 'Only the checked characters will know about this. Uncheck everyone to make it public.';
    root.append(hint);

    const result = await c.callGenericPopup(root, c.POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel' });
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return null;

    const checked = [...list.querySelectorAll('input:checked')].map(x => x.value);
    return parseNames([...checked, ...input.value.split(',')]);
}

async function onMessageButtonClick(event) {
    const id = Number($(event.currentTarget).closest('.mes').attr('mesid'));
    const message = ctx().chat[id];
    if (!message) return;
    const members = await pickMembers('Who knows about this message?', getMembers(message) ?? getScene()?.members ?? []);
    if (members === null) return;
    flagMessages([id], members);
}

async function onSceneButtonClick() {
    const members = await pickMembers('Private scene between…', getScene()?.members ?? []);
    if (members === null) return;
    startScene(members);
}

function refreshUi() {
    const chat = ctx().chat;
    const s = settings();

    $('#chat .mes').each(function () {
        const message = chat[Number($(this).attr('mesid'))];
        const members = s.enabled ? getMembers(message) : null;
        $(this).toggleClass('ps-private', !!members);
        $(this).find('.ps-badge').remove();
        if (members && s.showBadges) {
            const badge = $('<div class="ps-badge"><i class="fa-solid fa-user-secret"></i> <span></span></div>');
            badge.find('span').text(`Private: ${formatMembers(members)}`);
            $(this).find('.mes_text').before(badge);
        }
    });

    const scene = getScene();
    $('#ps_scene_bar').toggle(!!scene && s.enabled);
    $('#ps_scene_bar .ps-scene-names').text(scene ? formatMembers(scene.members) : '');
    $('#ps_scene_status').text(scene ? `Active: ${formatMembers(scene.members)}` : 'No private scene active.');
    $('#ps_end_scene').toggle(!!scene);
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
        <div id="ps_scene_bar" style="display: none;">
            <i class="fa-solid fa-user-secret"></i>
            <span>Private scene: <b class="ps-scene-names"></b></span>
            <div class="menu_button ps-scene-edit" title="Change who is in this scene"><i class="fa-solid fa-pen"></i></div>
            <div class="menu_button ps-scene-end">End</div>
        </div>`);
    $('#send_form').before(bar);
    bar.find('.ps-scene-edit').on('click', onSceneButtonClick);
    bar.find('.ps-scene-end').on('click', endScene);
}

function addSettingsPanel() {
    const html = $(`
        <div class="private-scenes-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Private Scenes</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label"><input id="ps_enabled" type="checkbox"> <span>Enabled</span></label>
                    <label class="checkbox_label"><input id="ps_show_badges" type="checkbox"> <span>Show "Private" badge on messages</span></label>

                    <h4>Private scene in this chat</h4>
                    <div id="ps_scene_status"></div>
                    <div class="flex-container">
                        <div id="ps_start_scene" class="menu_button">Start / edit private scene…</div>
                        <div id="ps_end_scene" class="menu_button">End scene</div>
                    </div>

                    <h4>Prompt</h4>
                    <label for="ps_rules">Rules sent to the model (when private messages are in context)</label>
                    <textarea id="ps_rules" class="text_pole textarea_compact" rows="6"></textarea>
                    <label for="ps_scene_rules">Active scene note (<code>{{members}}</code> = names)</label>
                    <textarea id="ps_scene_rules" class="text_pole textarea_compact" rows="2"></textarea>
                    <label for="ps_rules_depth">Rules depth (0 = after the last message)</label>
                    <input id="ps_rules_depth" class="text_pole" type="number" min="0" max="100">
                    <label for="ps_label_start">Start label</label>
                    <input id="ps_label_start" class="text_pole" type="text">
                    <label for="ps_label_end">End label</label>
                    <input id="ps_label_end" class="text_pole" type="text">
                    <div id="ps_reset" class="menu_button">Restore default prompt text</div>
                </div>
            </div>
        </div>`);
    $('#extensions_settings2').append(html);

    const s = settings();
    const fields = {
        '#ps_rules': 'rules',
        '#ps_scene_rules': 'sceneRules',
        '#ps_rules_depth': 'rulesDepth',
        '#ps_label_start': 'labelStart',
        '#ps_label_end': 'labelEnd',
    };
    const load = () => {
        $('#ps_enabled').prop('checked', s.enabled);
        $('#ps_show_badges').prop('checked', s.showBadges);
        for (const [selector, key] of Object.entries(fields)) $(selector).val(s[key]);
    };
    load();

    $('#ps_enabled').on('change', function () {
        s.enabled = !!$(this).prop('checked');
        ctx().saveSettingsDebounced();
        refreshUi();
    });
    $('#ps_show_badges').on('change', function () {
        s.showBadges = !!$(this).prop('checked');
        ctx().saveSettingsDebounced();
        refreshUi();
    });
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
}

// ─── Slash commands ──────────────────────────────────────────────────

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx();
    const atArg = () => SlashCommandNamedArgument.fromProps({
        name: 'at',
        description: 'Message id or range, e.g. 12 or 12-18. Defaults to the last message.',
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
        helpString: 'Ends the current private scene.',
        callback: () => {
            endScene();
            return '';
        },
    }));
}

// ─── Init ────────────────────────────────────────────────────────────

jQuery(() => {
    settings();
    addMessageButton();
    addSceneBar();
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

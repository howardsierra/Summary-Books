// Private Scenes — flag messages as private between certain characters, so the
// narrator knows those events happened out of everyone else's sight. Keeps the
// story's memory in the chat's lorebook (secrets, story summaries merged into
// chapters, character sheets, open threads, pinned facts, the story clock),
// tracks who found out later, marks common knowledge (news, rumors) that every
// character knows, and checks replies for leaked secrets.

import {
    COMMON_KINDS, ctx, endScene, flagMessages, formatTemplate, getCommon, getFlag, getScene, hooks, inheritSwipeFlag,
    membersKey, parseNames, parseRange, revealedNames, saveSoon, sceneAt, setFlag, setRevealedNames, settings, startScene,
    adoptScene, commonKind,
} from './src/core.js';
import {
    autoSaveScene, hasSavedScenes, maybeAutoMemory, maybeConsolidate, notifyStale, refreshSceneEntry, saveMemory, saveScene,
    saveStorySoFar,
} from './src/lorebook.js';
import {
    addFact, addThread, clockText, getClock, hasCommonKnowledge, hasPrivateLists, setClock, setVisibility, trackClock,
} from './src/memory.js';
import { checkLeak, clearRetries } from './src/leaks.js';
import { initUi, refreshUi } from './src/ui.js';
import { openMemory } from './src/hub.js';

const PROMPT_KEY = 'private_scenes_rules';
const CLOCK_KEY = 'private_scenes_clock';
// extension_prompt_types.IN_CHAT / extension_prompt_roles.SYSTEM
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

/** Set by "@private Ana, Kael:" so the reply to that message is private too. */
let pendingReply = null;

// ─── Prompt ──────────────────────────────────────────────────────────

/**
 * Generate interceptor: wraps each run of messages from the same private scene
 * in start/end labels. Entries are replaced with copies so the saved chat is
 * never modified.
 */
globalThis.privateScenesInterceptor = async function (chat, _contextSize, _abort, type) {
    const s = settings();
    if (!s.enabled) {
        clearPrompts();
        return;
    }

    const scene = getScene();
    const openKeys = new Set([scene?.sceneId, pendingReply?.sceneId].filter(Boolean));
    let anyPrivate = false;
    let anyCommon = false;

    /** The labelled run a message belongs to: a private scene or a kind of common knowledge. */
    const runOf = (message) => {
        const flag = getFlag(message);
        if (flag) {
            const revealed = flag.sceneId ? revealedNames(flag.sceneId) : [];
            return {
                key: flag.sceneId ?? `m:${membersKey(flag.members)}`,
                start: formatTemplate(s.labelStart, flag.members, revealed),
                end: formatTemplate(s.labelEnd, flag.members, revealed),
            };
        }
        const common = getCommon(message);
        if (common) {
            const kind = commonKind(common.kind);
            return {
                key: `common:${kind}`,
                start: kind === 'rumor' ? s.rumorLabelStart : String(s.commonLabelStart).replaceAll('{{kind}}', COMMON_KINDS[kind].label),
                end: s.commonLabelEnd,
            };
        }
        return null;
    };

    const runs = chat.map(runOf);
    for (let i = 0; i < chat.length; i++) {
        const run = runs[i];
        if (!run) continue;
        if (run.key.startsWith('common:')) anyCommon = true;
        else anyPrivate = true;

        const isLast = i === chat.length - 1;
        const prevSame = i > 0 && runs[i - 1]?.key === run.key;
        const nextSame = !isLast && runs[i + 1]?.key === run.key;
        // Leave the run open when the reply being written continues it.
        const keepOpen = isLast && (type === 'continue' || openKeys.has(run.key));

        let mes = chat[i].mes;
        if (!prevSame) mes = `${run.start}\n${mes}`;
        if (!nextSame && !keepOpen) mes = `${mes}\n${run.end}`;
        chat[i] = { ...chat[i], mes };
    }

    const parts = [];
    if (anyPrivate || scene || hasSavedScenes() || hasPrivateLists()) parts.push(s.rules);
    if (anyCommon || hasCommonKnowledge()) parts.push(s.commonRules);
    const current = scene ?? pendingReply;
    if (current) parts.push(formatTemplate(s.sceneRules, current.members));
    ctx().setExtensionPrompt(PROMPT_KEY, parts.join('\n'), IN_CHAT, Number(s.rulesDepth) || 0, false, ROLE_SYSTEM);
    ctx().setExtensionPrompt(CLOCK_KEY, s.clockEnabled ? clockText() : '', IN_CHAT, Number(s.rulesDepth) || 0, false, ROLE_SYSTEM);
};

function clearPrompts() {
    ctx().setExtensionPrompt(PROMPT_KEY, '', IN_CHAT, 0);
    ctx().setExtensionPrompt(CLOCK_KEY, '', IN_CHAT, 0);
}

// ─── Inline tags ─────────────────────────────────────────────────────

const TAG = /^\s*@(private|scene|time|place)\s+([^:\n]+?)\s*(?::|\n|$)\s*/i;
/** "@news:", "@rumor:", "@announcement:", "@common:" — the message becomes common knowledge. */
const COMMON_TAG = /^\s*@(news|rumou?r|announce(?:ment)?|common|known|everyone)\b\s*:?\s*/i;
const COMMON_TAG_KINDS = { news: 'news', rumor: 'rumor', rumour: 'rumor', announce: 'announcement', announcement: 'announcement' };
const END_TAG = /^\s*@(endscene|end-scene|public)\b\s*:?\s*/i;

/**
 * Handles tags at the start of a sent message, in any combination:
 * "@private Ana, Kael:", "@scene Ana, Kael:", "@endscene", "@time Day 4, dawn:", "@place the stables:".
 */
function applyInlineTags(id) {
    const message = ctx().chat[id];
    if (!settings().inlineTags || !message?.is_user) return;

    for (let guard = 0; guard < 5; guard++) {
        const end = message.mes.match(END_TAG);
        if (end) {
            message.mes = message.mes.slice(end[0].length);
            endScene();
            continue;
        }
        const common = message.mes.match(COMMON_TAG);
        if (common) {
            message.mes = message.mes.slice(common[0].length);
            // Not awaited: condensing it for the lorebook runs alongside the reply.
            setVisibility([id], { mode: 'common', kind: COMMON_TAG_KINDS[common[1].toLowerCase()] ?? 'common' });
            continue;
        }
        const tag = message.mes.match(TAG);
        if (!tag) return;
        const kind = tag[1].toLowerCase();
        message.mes = message.mes.slice(tag[0].length);

        if (kind === 'time' || kind === 'place') {
            setClock({ [kind]: tag[2] });
            continue;
        }
        const members = parseNames(tag[2]);
        if (!members.length) continue;
        if (kind === 'scene') {
            startScene(members);
        } else {
            const sceneId = flagMessages([id], members);
            pendingReply = { members, sceneId };
        }
    }
}

// ─── Events ──────────────────────────────────────────────────────────

function onMessageSent(id) {
    applyInlineTags(id);
    const message = ctx().chat[id];
    const scene = getScene();
    // A message tagged as common knowledge stays common even during a private scene.
    if (message && scene && !getCommon(message)) setFlag(message, { members: scene.members, sceneId: scene.sceneId });
    saveSoon();
    refreshUi();
}

async function onMessageReceived(id, type) {
    const message = ctx().chat[id];
    if (!message || message.is_system || type === 'first_message') return;

    const scene = getScene();
    if (scene) {
        setFlag(message, { members: scene.members, sceneId: scene.sceneId });
    } else if (pendingReply && !message.is_user && type !== 'impersonate') {
        setFlag(message, pendingReply);
        pendingReply = null;
    } else {
        inheritSwipeFlag(message);
    }
    saveSoon();
    refreshUi();

    if (!message.is_user && type !== 'impersonate') {
        await checkLeak(id);
        await trackClock(id);
        await maybeAutoMemory();
    }
}

function onSwiped(id) {
    inheritSwipeFlag(ctx().chat[id]);
    refreshUi();
    notifyStale();
}

function onChatChanged() {
    pendingReply = null;
    clearRetries();
    clearPrompts();
    refreshUi();
    notifyStale();
}

function onChatEdited() {
    refreshUi();
    notifyStale();
}

// ─── Slash commands ──────────────────────────────────────────────────

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx();
    const atArg = (description = 'Message id or range, e.g. 12 or 12-18. Defaults to the last message.') => SlashCommandNamedArgument.fromProps({
        name: 'at',
        description,
        typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
    });
    const namesArg = (isRequired, description = 'Characters, comma separated, e.g. Ana, Kael') => SlashCommandArgument.fromProps({
        description,
        typeList: [ARGUMENT_TYPE.STRING],
        isRequired,
    });
    const add = (props) => SlashCommandParser.addCommandObject(SlashCommand.fromProps(props));

    add({
        name: 'private',
        helpString: 'Marks messages as private between the named characters. Example: <code>/private at=12-18 Ana, Kael</code>',
        namedArgumentList: [atArg()],
        unnamedArgumentList: [namesArg(true)],
        callback: async (args, value) => {
            const members = parseNames(value);
            if (!members.length) throw new Error('/private needs at least one name.');
            await setVisibility(parseRange(args.at), { mode: 'private', members });
            return '';
        },
    });

    add({
        name: 'public',
        helpString: 'Makes messages normal again: no longer private or common knowledge. '
            + 'To record that someone found out a secret instead, use <code>/private-reveal</code>.',
        namedArgumentList: [atArg()],
        callback: async (args) => {
            await setVisibility(parseRange(args.at), { mode: 'normal' });
            return '';
        },
    });

    add({
        name: 'common',
        helpString: 'Marks messages as common knowledge that every character knows, even ones who were not there. '
            + 'Kinds: common, news, announcement, rumor. Example: <code>/common kind=news at=12</code>',
        namedArgumentList: [atArg(), SlashCommandNamedArgument.fromProps({
            name: 'kind',
            description: 'common, news, announcement, or rumor',
            typeList: [ARGUMENT_TYPE.STRING],
            enumList: Object.keys(COMMON_KINDS),
        })],
        callback: async (args) => {
            await setVisibility(parseRange(args.at), { mode: 'common', kind: commonKind(String(args.kind ?? 'common')) });
            return '';
        },
    });

    add({
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
    });

    add({
        name: 'private-end',
        helpString: 'Ends the current private scene. If auto-save is on, the scene is summarized into the lorebook.',
        callback: () => {
            endScene();
            return '';
        },
    });

    add({
        name: 'private-reveal',
        helpString: 'Records that characters found out a secret, from the latest message on. '
            + 'Defaults to the most recent secret. Example: <code>/private-reveal at=14 Bob</code>',
        namedArgumentList: [atArg('Any message id inside the secret scene.')],
        unnamedArgumentList: [namesArg(true, 'Characters who found out, comma separated')],
        callback: async (args, value) => {
            let scene = sceneAt(args.at);
            if (!scene) throw new Error('No private scene found.');
            scene = adoptScene(scene);
            setRevealedNames(scene, [...revealedNames(scene.id), ...parseNames(value)]);
            await refreshSceneEntry(scene.id);
            refreshUi();
            return revealedNames(scene.id).join(', ');
        },
    });

    add({
        name: 'private-save',
        helpString: 'Summarizes a private scene into the chat lorebook and returns the summary. '
            + 'Defaults to the most recent scene. Example: <code>/private-save at=14</code>',
        namedArgumentList: [atArg('Any message id inside the scene to save.')],
        callback: async (args) => {
            const scene = sceneAt(args.at);
            if (!scene) throw new Error('No private scene found.');
            return await saveScene(scene) ?? '';
        },
    });

    add({
        name: 'memory-save',
        helpString: 'Summarizes the public story into the lorebook. Without <code>at</code>, covers everything since the last memory. '
            + 'Example: <code>/memory-save at=0-40</code>',
        namedArgumentList: [atArg('Message range to summarize, e.g. 0-40.')],
        callback: async (args) => {
            if (args.at === undefined || args.at === '') return await saveStorySoFar() ?? '';
            const ids = parseRange(args.at);
            return await saveMemory(ids[0], ids.at(-1)) ?? '';
        },
    });

    add({
        name: 'memory',
        aliases: ['private-timeline'],
        helpString: 'Opens the Story Memory window. Optional tab: timeline, characters, threads, facts, secrets.',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'Tab to open', typeList: [ARGUMENT_TYPE.STRING] })],
        callback: (_args, value) => {
            openMemory(String(value ?? '').trim() || 'timeline');
            return '';
        },
    });

    add({
        name: 'private-knowledge',
        aliases: ['who-knows'],
        helpString: 'Opens the “who knows what” grid for this chat.',
        callback: () => {
            openMemory('secrets');
            return '';
        },
    });

    add({
        name: 'memory-merge',
        helpString: 'Merges the oldest story entries into a chapter now (and chapters into an arc), if there are enough.',
        callback: async () => {
            await maybeConsolidate({ force: true });
            return '';
        },
    });

    add({
        name: 'pin',
        helpString: 'Pins a fact the model should always remember. Example: <code>/pin Ana is left-handed</code>',
        unnamedArgumentList: [namesArg(true, 'The fact')],
        callback: async (_args, value) => {
            await addFact(String(value));
            return '';
        },
    });

    add({
        name: 'thread',
        helpString: 'Adds an open story thread (a promise, plan, debt, or open question). Example: <code>/thread Kael owes Bob a favor</code>',
        unnamedArgumentList: [namesArg(true, 'The thread')],
        callback: async (_args, value) => {
            await addThread(String(value));
            return '';
        },
    });

    for (const kind of ['time', 'place']) {
        add({
            name: `story-${kind}`,
            aliases: [kind === 'time' ? 'when' : 'where'],
            helpString: `Sets the story ${kind}. With no text, returns it. Example: <code>/story-${kind} ${kind === 'time' ? 'Day 4, dawn' : 'the stables'}</code>`,
            unnamedArgumentList: [namesArg(false, `The new ${kind}`)],
            callback: (_args, value) => {
                const text = String(value ?? '').trim();
                if (!text) return getClock()[kind] ?? '';
                setClock({ [kind]: text });
                return '';
            },
        });
    }
}

// ─── Init ────────────────────────────────────────────────────────────

jQuery(() => {
    settings();
    hooks.changed = refreshUi;
    hooks.sceneEnded = autoSaveScene;
    hooks.openMemory = openMemory;
    initUi();
    registerCommands();

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.MESSAGE_SENT, onMessageSent);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(eventTypes.MESSAGE_SWIPED, onSwiped);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    for (const type of [eventTypes.USER_MESSAGE_RENDERED, eventTypes.CHARACTER_MESSAGE_RENDERED, eventTypes.MORE_MESSAGES_LOADED]) {
        eventSource.on(type, refreshUi);
    }
    for (const type of [eventTypes.MESSAGE_UPDATED, eventTypes.MESSAGE_EDITED, eventTypes.MESSAGE_DELETED, eventTypes.MESSAGE_SWIPE_DELETED]) {
        eventSource.on(type, onChatEdited);
    }
    refreshUi();
});

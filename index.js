// Private Scenes — flag messages as private between certain characters, so the
// narrator knows those events happened out of everyone else's sight. Keeps the
// story's memory in the chat's lorebook (secrets, story summaries merged into
// chapters, character sheets, open threads, pinned facts, the story clock),
// tracks who found out later, marks common knowledge (news, rumors) that every
// character knows, and checks replies for leaked secrets.

import {
    COMMON_KINDS, ctx, endScene, flagMessages, formatTemplate, getCommon, getFlag, getScene, hooks, inheritSwipeFlag,
    membersKey, parseNames, parseRange, revealedNames, saveSoon, sceneAt, setFlag, setRevealedNames, settings, startScene,
    adoptScene, chatChanged, commonKind, ensureMid, findScenes, chatState, formatMembers, partId, messageParts, newId, positionOf,
} from './src/core.js';
import {
    autoSaveScene, checkBranch, forceOwnBook, saveEverythingNew, hasSavedScenes, rebuildAll, redoMemory, saveSecretsNow, maybeAutoMemory, maybeConsolidate, notifyStale, refreshSceneEntry, saveMemory, saveScene,
    saveStorySoFar,
} from './src/lorebook.js';
import {
    addFact, addThread, clockText, getClock, hasCommonKnowledge, hasPrivateLists, setClock, setVisibility, trackClock,
} from './src/memory.js';
import { checkLeak, clearRetries } from './src/leaks.js';
import { initUi, openSettingsWindow, refreshUi } from './src/ui.js';
import { openMemory } from './src/hub.js';
import { armCapture, captureChatPrompt, captureTextPrompt, openBudget, scheduleBudgetCheck } from './src/budget.js';
import { tidyText } from './src/tidy.js';
import { dropStrayTags, fromHtml, hideSceneNotes, mapParts, stampPartIds, takeSceneNotes, toDisplayMarkers } from './src/parts.js';

const VERSION = '0.14.0';

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

    // Private parts inside public messages: labels around just that stretch.
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (getFlag(message) || !/<\/?private\b/i.test(message?.mes ?? '')) continue;
        const mes = mapParts(message.mes, (part) => {
            anyPrivate = true;
            const revealed = revealedNames(partId(message, part));
            return `\n${formatTemplate(s.labelStart, part.members, revealed)}\n${part.body}\n${formatTemplate(s.labelEnd, part.members, revealed)}\n`;
        });
        chat[i] = { ...message, mes: dropStrayTags(mes).replace(/\n{3,}/g, '\n\n') };
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

// ─── Private parts and scene notes ───────────────────────────────────

/** Gives each private part an id in its tag, so it keeps its secret, reveals and summary through edits. */
function stampParts(ids) {
    const chat = ctx().chat;
    let changed = false;
    for (const id of ids ?? chat.keys()) {
        const message = chat[id];
        if (!/<private\b/i.test(message?.mes ?? '') || !messageParts(message).length) continue;
        ensureMid(message);
        const stamped = stampPartIds(message.mes, () => newId('p').slice(2));
        if (stamped === message.mes) continue;
        if (Array.isArray(message.swipes) && message.swipes[message.swipe_id] === message.mes) message.swipes[message.swipe_id] = stamped;
        message.mes = stamped;
        changed = true;
    }
    if (changed) {
        chatChanged();
        saveSoon();
    }
}

/** New private parts in a message go to the lorebook like an ended scene would. */
function autoSaveParts(id) {
    const message = ctx().chat[id];
    if (!message || !messageParts(message).length) return;
    const saved = chatState().timeline;
    for (const scene of findScenes()) {
        if (scene.part && scene.ids[0] === id && !saved[scene.id]) autoSaveScene(scene.id);
    }
}

const undoToast = (text, undo) => toastr.info(`${text} Tap to undo.`, 'Private Scenes', {
    timeOut: 12000,
    onclick: () => {
        undo();
        toastr.info('Undone.', 'Private Scenes');
    },
});

const copyScene = (scene) => scene ? { members: [...scene.members], sceneId: scene.sceneId } : null;

/**
 * Takes back what the model's last scene note did: the scene goes back to how
 * it was, and the reply that carried the note (if still there) gets the matching flag.
 */
function revertAiNote(note, message = null) {
    const state = chatState();
    if (note.kind === 'private' ? getScene()?.sceneId === note.sceneId : !getScene()) {
        state.scene = copyScene(note.before);
    }
    if (message) setFlag(message, copyScene(note.before));
    if (state.aiNote?.mid === note.mid) delete state.aiNote;
    chatChanged();
    saveSoon();
    ctx().saveMetadataDebounced();
    refreshUi();
}

/**
 * "SCENE> private|Ana, Kael" / "SCENE> end" lines a preset asks the model to
 * write: taken out of the reply, and (when allowed) acted on. Runs before the
 * reply is flagged, so a reply that starts a scene belongs to it. What it did
 * is remembered (chatState().aiNote) until the user's next message, so a swipe
 * or a delete of that reply can take it back.
 */
function applySceneNotes(id, message) {
    const { notes, text } = takeSceneNotes(message.mes);
    if (!notes.length) return;
    if (Array.isArray(message.swipes) && message.swipes[message.swipe_id] === message.mes) message.swipes[message.swipe_id] = text;
    message.mes = text;
    chatChanged();
    if (!settings().aiScenes) return;

    const before = copyScene(getScene());
    const last = notes.at(-1);
    if (last.kind === 'end' ? !before : before && membersKey(before.members) === membersKey(last.members)) return;
    if (last.kind === 'end') endScene();
    else startScene(last.members);
    const note = { kind: last.kind, mid: ensureMid(message), before, sceneId: getScene()?.sceneId ?? null };
    chatState().aiNote = note;
    ctx().saveMetadataDebounced();
    undoToast(last.kind === 'end'
        ? `🤫 Private scene ended: ${formatMembers(before.members)}.`
        : `🤫 Private scene started: ${formatMembers(last.members)}.`, () => revertAiNote(note, ctx().chat[positionOf(note.mid)] ?? null));
}

/** Swiping away from (or deleting) the reply whose note started or ended a scene takes the note back. */
function takeBackAiNote({ swipedId = null } = {}) {
    const note = chatState().aiNote;
    if (!note) return;
    const at = positionOf(note.mid);
    if (swipedId !== null) {
        if (at !== swipedId) return;
        revertAiNote(note, ctx().chat[at]);
    } else {
        if (at !== -1) return;
        // A deleted opening reply only undoes the scene if nothing else is in it yet.
        if (note.kind === 'private' && findScenes().some(scene => scene.id === note.sceneId)) {
            delete chatState().aiNote;
            return;
        }
        revertAiNote(note);
    }
    toastr.info(note.kind === 'end'
        ? `The reply that ended the scene with ${formatMembers(note.before.members)} is gone, so the scene is running again.`
        : 'The reply that started a private scene is gone, so that scene was undone.', 'Private Scenes');
}

function onMessageSent(id) {
    // The user carried on: the model's last scene note stands.
    delete chatState().aiNote;
    applyInlineTags(id);
    chatChanged(); // the tags were cut from the text
    const message = ctx().chat[id];
    const scene = getScene();
    // A message tagged as common knowledge stays common even during a private scene.
    if (message && scene && !getCommon(message)) setFlag(message, { members: scene.members, sceneId: scene.sceneId });
    stampParts([id]);
    saveSoon();
    refreshUi();
    autoSaveParts(id);
}

async function onMessageReceived(id, type) {
    const message = ctx().chat[id];
    if (!message || message.is_system || type === 'first_message') return;
    if (!message.is_user && type !== 'impersonate') applySceneNotes(id, message);
    stampParts([id]);

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

    autoSaveParts(id);
    if (!message.is_user && type !== 'impersonate') {
        await checkLeak(id);
        await trackClock(id);
        await maybeAutoMemory();
    }
}

function onSwiped(id) {
    takeBackAiNote({ swipedId: Number(id) });
    inheritSwipeFlag(ctx().chat[id]);
    refreshUi();
    notifyStale();
}

function onChatChanged() {
    stampParts();
    pendingReply = null;
    clearRetries();
    clearPrompts();
    refreshUi();
    // A branch's copied memories are pruned before counting what is out of date.
    checkBranch().finally(() => { notifyStale(); scheduleBudgetCheck(); });
}

function onChatEdited(id) {
    if (Number.isInteger(Number(id)) && ctx().chat[Number(id)]) stampParts([Number(id)]);
    takeBackAiNote();
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
        name: 'memory-redo',
        helpString: 'Summarizes messages again even if they are already in story memory, replacing the story entries that overlap them. '
            + 'Without <code>at</code>, redoes the whole chat. Example: <code>/memory-redo at=10-40</code>',
        namedArgumentList: [atArg('Message range to summarize again, e.g. 10-40. Defaults to the whole chat.')],
        callback: async (args) => {
            const ids = args.at === undefined || args.at === '' ? [0, ctx().chat.length - 1] : parseRange(args.at);
            return String(await redoMemory(ids[0], ids.at(-1)));
        },
    });

    add({
        name: 'secrets-save',
        helpString: 'Saves every secret that is not saved yet or has changed, including a scene that is still running. '
            + '<code>all=true</code> saves every secret again.',
        namedArgumentList: [SlashCommandNamedArgument.fromProps({ name: 'all', description: 'Save every secret again', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' })],
        callback: async (args) => String(await saveSecretsNow({ all: String(args.all) === 'true' })),
    });

    add({
        name: 'memory-all',
        helpString: 'Summarizes everything not saved yet: unsaved or changed secrets (including a running scene) and the story since the last summary.',
        callback: async () => {
            const { secrets, story } = await saveEverythingNew();
            return `${secrets} secrets, ${story} story entries`;
        },
    });

    add({
        name: 'memory-rebuild',
        helpString: 'Rebuilds all memory: summarizes every secret and the whole public story again.',
        callback: async () => {
            await rebuildAll();
            return '';
        },
    });

    add({
        name: 'private-own-book',
        helpString: 'Gives this chat its own lorebook: a copy of the current one (leaving out messages this chat does not have), '
            + 'or with <code>fresh=true</code> a new, empty one. Returns its name.',
        namedArgumentList: [SlashCommandNamedArgument.fromProps({ name: 'fresh', description: 'Start empty and forget saved memories', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' })],
        callback: async (args) => await forceOwnBook({ fresh: String(args.fresh) === 'true' }),
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
        name: 'private-prompt',
        aliases: ['prompt-budget'],
        helpString: 'Opens Prompt &amp; budget: what Private Scenes adds to the prompt, its token cost, and the last prompt sent. <code>/private-prompt sent</code> opens the last prompt.',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: '"next" or "sent"', typeList: [ARGUMENT_TYPE.STRING] })],
        callback: (_args, value) => {
            openBudget(String(value ?? '').trim() === 'sent' ? 'sent' : 'next');
            return '';
        },
    });

    add({
        name: 'private-settings',
        helpString: 'Opens the Private Scenes settings in a window.',
        callback: () => {
            openSettingsWindow();
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
        helpString: 'Pins a fact the model should always remember, as of the last message (or <code>at=</code>). Example: <code>/pin Ana is left-handed</code>',
        namedArgumentList: [atArg('The message the fact comes from. Defaults to the last message.')],
        unnamedArgumentList: [namesArg(true, 'The fact')],
        callback: async (args, value) => {
            const id = parseRange(args.at).at(-1);
            const message = ctx().chat[id];
            await addFact(String(value), null, message ? ensureMid(message) : null);
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

// ─── API for other extensions (CALLBOARD Suite reads it) ────────────

function exposeApi() {
    try {
        globalThis.PrivateScenes = Object.freeze({
            version: VERSION,
            /** What's going on in this chat right now. */
            status: () => {
                const scene = getScene();
                return {
                    enabled: settings().enabled,
                    scene: scene ? { members: [...scene.members] } : null,
                    secrets: findScenes().length,
                    clock: { time: getClock().time, place: getClock().place },
                };
            },
            /** Who a message is private to, or null. */
            privateTo: (id) => getFlag(ctx().chat[Number(id)])?.members?.slice() ?? null,
            /** The common-knowledge kind of a message (news, rumor…), or null. */
            commonKind: (id) => getCommon(ctx().chat[Number(id)])?.kind ?? null,
            /** Opens Story Memory: timeline, characters, threads, facts or secrets. */
            openMemory: (tab) => openMemory(tab),
            /** The plain text background tasks see for a formatted message. */
            tidyText,
        });
    } catch { /* never block init */ }
}

// ─── Init ────────────────────────────────────────────────────────────

jQuery(() => {
    settings();
    hooks.changed = refreshUi;
    hooks.sceneEnded = autoSaveScene;
    hooks.openMemory = openMemory;
    hooks.entriesChanged = scheduleBudgetCheck;
    initUi();
    registerCommands();
    exposeApi();

    // On screen: scene notes hidden (even while a reply streams), private parts tinted.
    const formatter = ctx().messageFormatter;
    if (formatter?.addHook) {
        const on = () => settings().enabled;
        formatter.addHook((mes) => on() ? hideSceneNotes(mes) : mes, { stage: formatter.stage.BEFORE_REGEX });
        formatter.addHook((mes) => on() ? toDisplayMarkers(mes) : mes, { stage: formatter.stage.AFTER_REGEX });
        formatter.addHook((mes) => fromHtml(mes), { stage: formatter.stage.AFTER_MARKDOWN });
    }

    const { eventSource, eventTypes } = ctx();
    // First, so every handler below sees fresh caches.
    for (const type of [eventTypes.MESSAGE_SENT, eventTypes.MESSAGE_RECEIVED, eventTypes.MESSAGE_SWIPED, eventTypes.CHAT_CHANGED,
        eventTypes.MESSAGE_UPDATED, eventTypes.MESSAGE_EDITED, eventTypes.MESSAGE_DELETED, eventTypes.MESSAGE_SWIPE_DELETED, eventTypes.MORE_MESSAGES_LOADED]) {
        eventSource.on(type, chatChanged);
    }
    eventSource.on(eventTypes.GENERATION_STARTED, armCapture);
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, captureChatPrompt);
    eventSource.on(eventTypes.GENERATE_AFTER_COMBINE_PROMPTS, captureTextPrompt);
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

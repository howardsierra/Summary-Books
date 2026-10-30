// Leak checker: after a public reply, asks the model whether a character who
// isn't in on a secret mentions, hints at, or acts on it.

import { LEAK, chatState, ctx, findScenes, formatKnowers, getFlag, hooks, revealedNames, saveSoon, settings } from './core.js';

const CHECK_PROMPT = 'You are a continuity checker for a roleplay. Each SECRET below is known only to the characters listed with it. '
    + 'Read the NEW REPLY and decide whether any character who is NOT listed for a secret mentions it, hints at it, reacts to it, '
    + 'or acts on knowledge of it. Characters who are listed may do anything. Ordinary public events are not leaks.\n'
    + 'Answer with exactly one line, either:\nOK\nor:\nLEAK <secret number>: <short reason naming the character>';

const MAX_SECRET_CHARS = 1500;
const MAX_AUTO_RETRIES = 2;

/** Message ids being checked right now. */
export const checking = new Set();
/** Auto-regenerate attempts per message slot this session. */
const retries = new Map();

/** Secrets that exist before a message, with who knew them at that point. */
function secretsBefore(messageId) {
    const chat = ctx().chat;
    const timeline = chatState().timeline;
    return findScenes()
        .filter(scene => scene.ids[0] < messageId)
        .map(scene => {
            let text = timeline[scene.id]?.summary;
            if (!text) {
                text = scene.ids.map(id => `${chat[id].name}: ${chat[id].mes}`).join('\n');
                if (text.length > MAX_SECRET_CHARS) text = `…${text.slice(-MAX_SECRET_CHARS)}`;
            }
            return { scene, knowers: formatKnowers(scene.members, revealedNames(scene.id, messageId)), text };
        });
}

export function shouldCheck(messageId) {
    const s = settings();
    const message = ctx().chat[messageId];
    return s.enabled && s.leakCheck && message && !message.is_user && !message.is_system
        && !getFlag(message) && secretsBefore(messageId).length > 0;
}

/** Parses "OK" / "LEAK 2: Bob mentions the seal". */
export function parseVerdict(text) {
    const match = String(text ?? '').match(/^\s*[*_]*LEAK[*_]*\s*#?\s*(\d+)?\s*[:\-–—]?\s*(.*)$/im);
    if (!match) return { leak: false };
    return { leak: true, secret: match[1] ? Number(match[1]) : null, reason: match[2].trim() };
}

export async function checkLeak(messageId) {
    if (checking.has(messageId) || !shouldCheck(messageId)) return;
    const message = ctx().chat[messageId];
    const text = message.mes;
    const secrets = secretsBefore(messageId);

    checking.add(messageId);
    hooks.changed();
    let retry = false;
    try {
        const prompt = 'SECRETS:\n'
            + secrets.map((x, i) => `#${i + 1} (known only to: ${x.knowers}): ${x.text}`).join('\n\n')
            + `\n\nNEW REPLY (by ${message.name}):\n${text}`;
        const verdict = parseVerdict(await ctx().generateRaw({ systemPrompt: CHECK_PROMPT, prompt }));

        // The message may have been edited, swiped or deleted meanwhile.
        if (ctx().chat[messageId] !== message || message.mes !== text) return;
        message.extra ??= {};
        // The verdict is tied to the text it judged: swipes copy extras, and edits change the text.
        if (!verdict.leak) {
            message.extra[LEAK] = { status: 'ok', text };
        } else {
            const secret = secrets[(verdict.secret ?? 1) - 1] ?? secrets[0];
            message.extra[LEAK] = {
                status: 'leak',
                text,
                sceneId: secret.scene.id,
                knowers: secret.knowers,
                reason: verdict.reason || 'A character seems to know a secret they were not told.',
            };
        }
        saveSoon();

        if (verdict.leak && settings().leakAutoRegenerate && messageId === ctx().chat.length - 1) {
            const count = retries.get(messageId) ?? 0;
            if (count < MAX_AUTO_RETRIES) {
                retries.set(messageId, count + 1);
                retry = true;
            } else {
                toastr.warning('The reply still seems to leak a secret after retrying. Check it yourself.', 'Private Scenes');
            }
        }
    } catch (error) {
        console.error('[Private Scenes] Leak check failed', error);
    } finally {
        checking.delete(messageId);
        hooks.changed();
    }

    // Outside the check, so the new swipe gets checked too.
    if (retry) {
        toastr.warning('Possible secret leak, regenerating the reply…', 'Private Scenes');
        await regenerate(messageId);
    }
}

/** The current leak verdict for a message, ignoring ones made for other text. */
export function currentLeak(message) {
    const leak = message?.extra?.[LEAK];
    return leak && leak.text === message.mes ? leak : null;
}

/** Generates a new swipe for the last message. */
export async function regenerate(messageId) {
    const c = ctx();
    const message = c.chat[messageId];
    if (messageId !== c.chat.length - 1 || !message) return;
    // Swiping right from the last swipe generates a new one.
    if (Array.isArray(message.swipes) && message.swipe_id !== message.swipes.length - 1) {
        await c.swipe.to(null, 'right', { forceSwipeId: message.swipes.length - 1 });
    }
    await c.swipe.right();
}

export function dismissLeak(messageId) {
    const message = ctx().chat[messageId];
    if (message?.extra?.[LEAK]) {
        message.extra[LEAK].status = 'dismissed';
        saveSoon();
        hooks.changed();
    }
}

export function clearRetries() {
    retries.clear();
}

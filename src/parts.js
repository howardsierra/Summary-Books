// Private parts: a stretch of one message that only some characters know about,
// written inline as <private with="Ana, Kael">…</private>. The saved message
// keeps the tag; the prompt gets the usual private labels around just that
// stretch, and the chat shows it tinted. A tag left open runs to the end of
// the message (the safe side: too private rather than too public).
//
// Also scene notes: a reply that starts with "SCENE> private|Ana, Kael" or
// "SCENE> end" asks the extension to start or end a private scene.
// Pure functions, so they load in plain Node for the unit tests.

const OPEN = /<private\b([^>]*)>/gi;
const CLOSE = /<\/private\s*>/i;
const WITH = /\bwith\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

const splitNames = (text) => {
    const seen = new Set();
    return String(text ?? '').split(/,|\s+&\s+|\s+and\s+/i).map(x => x.trim()).filter(x => {
        const key = x.toLowerCase();
        if (!x || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

/**
 * The private parts of a message, in order.
 * @returns {{index: number, members: string[], body: string, start: number, end: number, closed: boolean}[]}
 *   start/end span the whole tag, so text.slice(start, end) is the part as written.
 */
export function parseParts(text) {
    const source = String(text ?? '');
    const parts = [];
    OPEN.lastIndex = 0;
    let match;
    while ((match = OPEN.exec(source))) {
        const attrs = match[1].match(WITH);
        const members = splitNames(attrs ? attrs[1] ?? attrs[2] ?? attrs[3] : '');
        const bodyStart = match.index + match[0].length;
        const rest = source.slice(bodyStart);
        const close = rest.match(CLOSE);
        // A new opening tag before the close ends this part there (no nesting).
        OPEN.lastIndex = bodyStart;
        const nextOpen = OPEN.exec(source);
        OPEN.lastIndex = bodyStart;
        const closeAt = close ? bodyStart + close.index : Infinity;
        const openAt = nextOpen ? nextOpen.index : Infinity;
        let bodyEnd;
        let end;
        let closed = false;
        if (closeAt < openAt) {
            bodyEnd = closeAt;
            end = closeAt + close[0].length;
            closed = true;
        } else {
            bodyEnd = end = Math.min(openAt, source.length);
        }
        if (members.length) parts.push({ index: parts.length, members, body: source.slice(bodyStart, bodyEnd).trim(), start: match.index, end, closed });
        OPEN.lastIndex = end;
    }
    return parts;
}

export const hasParts = (text) => /<private\b/i.test(String(text ?? '')) && parseParts(text).length > 0;

/** Replaces each part with replace(part); text between parts is kept. */
export function mapParts(text, replace) {
    const source = String(text ?? '');
    const parts = parseParts(source);
    if (!parts.length) return source;
    let out = '';
    let at = 0;
    for (const part of parts) {
        out += source.slice(at, part.start) + replace(part);
        at = part.end;
    }
    return out + source.slice(at);
}

/** The message as everyone else knows it: private parts taken out. */
export const withoutParts = (text) => mapParts(text, () => '').replace(/\n{3,}/g, '\n\n').trim();

/** Tags that may be in the text but hold no usable part (no names, stray closes): dropped for display. */
export const dropStrayTags = (text) => text.replace(/<\/?private\b[^>]*>/gi, '');

/**
 * Display stage (plain markdown, before it becomes HTML): each part becomes
 * its own block between two marker paragraphs, so markdown inside still works.
 * fromHtml() then turns the markers into a wrapping element.
 */
export function toDisplayMarkers(text) {
    if (!/<\/?private\b/i.test(text)) return text;
    const out = mapParts(text, (part) => `\n\n⁣ps-open:${encodeURIComponent(part.members.join(', '))}⁣\n\n${part.body}\n\n⁣ps-close⁣\n\n`);
    return dropStrayTags(out);
}

const escapeAttr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** After markdown: marker paragraphs → <div data-ps-part="Ana, Kael">…</div>. */
export function fromHtml(html) {
    if (!html.includes('⁣ps-')) return html;
    let depth = 0;
    let out = html.replace(/(?:<p>\s*)?⁣ps-(open:([^⁣]*)|close)⁣(?:\s*<\/p>)?/g, (_, kind, names) => {
        if (kind === 'close') {
            if (!depth) return '';
            depth--;
            return '</div>';
        }
        depth++;
        return `<div class="ps-part" data-ps-part="${escapeAttr(decodeURIComponent(names))}">`;
    });
    while (depth-- > 0) out += '</div>';
    return out;
}

// ─── Scene notes ─────────────────────────────────────────────────────

const NOTE = /^[ \t]*SCENE>[ \t]*(private|end)[ \t]*(?:\|[ \t]*([^\n]*?))?[ \t]*$/gim;

/**
 * Scene notes in a reply, in order, and the text without them.
 * @returns {{notes: {kind: 'private'|'end', members: string[]}[], text: string}}
 */
export function takeSceneNotes(text) {
    const notes = [];
    const out = String(text ?? '').replace(NOTE, (_, kind, names) => {
        const note = { kind: kind.toLowerCase(), members: splitNames(names) };
        if (note.kind === 'end' || note.members.length) notes.push(note);
        return '';
    });
    return { notes, text: notes.length ? out.replace(/^\s*\n/, '').replace(/\n{3,}/g, '\n\n') : String(text ?? '') };
}

/** For display while a reply streams: scene note lines hidden. */
export const hideSceneNotes = (text) => String(text ?? '').replace(NOTE, '');

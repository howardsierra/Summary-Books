// Plain text for background tasks. Replies from presets like CALLBOARD carry
// panels ([[TAG]]…[[/TAG]] data lines), HTML artifacts, image tags, cue lines
// and reasoning blocks. Summaries, leak checks, the clock and condensing only
// need what happened, so these are turned into short readable lines first.
// Saves tokens and keeps smaller sidecar models on track.

/** CALLBOARD panel names → what a summarizer should call them. */
const PANELS = {
    TRK: 'Tracker', CAST: 'Cast board', WEB: 'Relationships', STATUS: 'Status', INV: 'Inventory', CODEX: 'Codex',
    TWITCH: 'Twitch chat', DISCORD: 'Discord', X: 'X posts', REDDIT: 'Reddit', TABLOID: 'Tabloid', BLOG: 'Gossip blog',
    MAG: 'Magazine', BLIND: 'Blind item', AIM: 'AIM chat', FLIP: 'Flip-phone texts', MYSPACE: 'MySpace', DATING: 'Dating app',
    BROWSER: 'Browser', INCOGNITO: 'Private browsing', INSTA: 'Instagram', PRIVATE: 'Private photos', CREATOR: 'Creator page',
    BUBBLE: 'Fan platform chat', LIVE: 'Livestream',
};
/** Out-of-story panels: the host's program of what's lit. */
const DROP_PANELS = new Set(['PROGRAM']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (text) => text
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, name) => ENTITIES[name])
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));

/** "T> time|9:47 PM, Friday" → "time: 9:47 PM, Friday". */
function dataLine(line) {
    const match = line.match(/^\s*[A-Z]{1,4}>\s*(.*)$/);
    if (!match) return line.trim();
    const [first, ...rest] = match[1].split('|').map(field => field.trim()).filter(Boolean);
    if (!first) return '';
    return rest.length ? `${first}: ${rest.join(' · ')}` : first;
}

function panel(_all, tag, body) {
    const name = tag.toUpperCase();
    if (DROP_PANELS.has(name)) return '\n';
    const lines = body.split('\n').map(dataLine).filter(Boolean);
    return `\n[${PANELS[name] ?? name}]\n${lines.join('\n')}\n`;
}

/**
 * Message text as plain, compact prose for a background model.
 * Text that is already plain comes back unchanged apart from spacing.
 */
export function tidyText(text) {
    let out = String(text ?? '');
    if (!/[<[>]/.test(out)) return out.trim();
    out = out
        // Reasoning, styles, scripts and hidden notes never describe the story.
        .replace(/<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        // Images: the prose around them already tells what happens.
        .replace(/<cb_img\b[^>]*>(?:[\s\S]*?<\/cb_img\s*>)?/gi, '')
        .replace(/<(img|video)\b[^>]*>/gi, '')
        .replace(/\[(?:IMG|VID):GEN(?::\{[\s\S]*?\})?\]/g, '')
        // Cue lines announce what's about to appear; they aren't story.
        .replace(/^[ \t]*CUE>.*$/gm, '')
        // Panels of data lines.
        .replace(/\[\[([A-Za-z]+)\]\]([\s\S]*?)\[\[\/\1\]\]/g, panel)
        // Any remaining HTML: keep its text, one block per line.
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|header|footer|figcaption)\s*>/gi, '\n')
        .replace(/<\/?[a-zA-Z][\w:-]*(?:\s[^<>]*)?\/?>/g, '');
    return decode(out)
        .replace(/[ \t]+$/gm, '')
        .replace(/^[ \t]+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Time and place from the last CALLBOARD tracker card in a message, if it has one. */
export function trackerClock(text) {
    const blocks = [...String(text ?? '').matchAll(/\[\[TRK\]\]([\s\S]*?)\[\[\/TRK\]\]/gi)];
    if (!blocks.length) return null;
    const clock = {};
    for (const line of blocks.at(-1)[1].split('\n')) {
        const match = line.match(/^\s*[A-Z]{1,4}>\s*(time|place|location)\s*\|\s*([^|\n]*)/i);
        if (!match) continue;
        const value = decode(match[2].replace(/<[^>]*>/g, '')).trim();
        if (!value || /^\(.*\)$/.test(value)) continue;
        clock[match[1].toLowerCase() === 'time' ? 'time' : 'place'] = value;
    }
    return clock.time || clock.place ? clock : null;
}

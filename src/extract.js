// Summary requests: the extra lines a summary may carry (keywords, threads,
// time and place), and parsing them back out of the model's answer.

import { parseNames } from './core.js';

const LINE = /^\s*[*_]*(KEYWORDS?|THREAD|RESOLVED|TIME|PLACE)[*_]*\s*:\s*(.*?)\s*[*_]*\s*$/i;
const UNKNOWN = /^(unknown|none|n\/a|-|unchanged)\.?$/i;

/**
 * Instructions appended to a summary prompt.
 * @param {{keywords?: boolean, threads?: string[]|null, clock?: {time: string, place: string}|null}} options
 *   threads: the open threads the model may mark as resolved (null = don't track threads)
 */
export function extrasInstructions({ keywords = false, threads = null, clock = null }) {
    const lines = [];
    if (keywords) {
        lines.push('KEYWORDS: 2 to 5 specific places, objects, or events from the text (not character names, not common words), comma separated');
    }
    if (threads) {
        lines.push('THREAD: one line per NEW unresolved promise, plan, debt, mystery, or question that is still open at the end (0 to 3 lines)');
        if (threads.length) lines.push('RESOLVED: the numbers of the open threads below that get resolved in the text, comma separated (omit if none)');
    }
    if (clock) {
        lines.push('TIME: the in-story time when the text ends, for example "Day 3, evening" (or "unknown")');
        lines.push('PLACE: where the text ends (or "unknown")');
    }
    if (!lines.length) return '';

    let text = `\n\nAfter the summary, add these lines, each starting with its label:\n${lines.join('\n')}`;
    if (threads?.length) text += `\n\nOpen threads:\n${threads.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
    if (clock) text += `\n\nBefore this text, the time was "${clock.time || 'unknown'}" and the place was "${clock.place || 'unknown'}".`;
    return text;
}

/**
 * Splits labelled lines off a summary.
 * @returns {{summary: string, keywords: string[], threads: string[], resolved: number[], time: string|null, place: string|null}}
 */
export function parseSummary(text) {
    const result = { summary: '', keywords: [], threads: [], resolved: [], time: null, place: null };
    const body = [];
    for (const line of String(text ?? '').trim().split('\n')) {
        const match = line.match(LINE);
        if (!match) {
            body.push(line);
            continue;
        }
        const value = match[2].replace(/^["']|["']$/g, '').trim();
        if (!value || UNKNOWN.test(value)) continue;
        switch (match[1].toUpperCase()) {
            case 'KEYWORD':
            case 'KEYWORDS':
                result.keywords = parseNames([...result.keywords, ...value.replace(/\.$/, '').split(',')]);
                break;
            case 'THREAD':
                result.threads.push(value);
                break;
            case 'RESOLVED':
                result.resolved.push(...(value.match(/\d+/g) ?? []).map(Number));
                break;
            case 'TIME':
                result.time = value;
                break;
            case 'PLACE':
                result.place = value;
                break;
        }
    }
    result.summary = body.join('\n').trim();
    return result;
}

/** Summary text plus its keyword line, for editing by hand. */
export const joinSummary = (summary, keywords) => keywords?.length ? `${summary}\n\nKEYWORDS: ${keywords.join(', ')}` : summary;

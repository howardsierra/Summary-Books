// Prompt & budget: what this extension adds to the model's prompt, how many
// tokens of it are always included, and the last prompt actually sent.

import { BOOK_KEY, chatState, ctx, findScenes, getCommon, getFlag, hooks, settings } from './core.js';
import { maybeConsolidate } from './lorebook.js';
import { clockText, hasCommonKnowledge, hasPrivateLists } from './memory.js';
import { actionButton, popupHeader, showPopup, statusPill, windowCloseButton } from './ui.js';

// ─── Measuring ───────────────────────────────────────────────────────

const KIND_OF_ENTRY = [
    [/^📜|Story —|Chapter —|Arc —/, 'story', 'Story memory'],
    [/^🕵️|Private —/, 'secret', 'Secrets'],
    [/^👤|character sheet/, 'sheet', 'Character sheets'],
    [/Pinned facts/, 'facts', 'Pinned facts'],
    [/Open threads/, 'threads', 'Open threads'],
    [/World knowledge/, 'world', 'World knowledge'],
];
const kindOf = (comment) => KIND_OF_ENTRY.find(([re]) => re.test(comment ?? '')) ?? [null, 'other', 'Other entries'];

/** Last measurement, for the launcher tile. */
export let lastMeasure = null;

const tokens = async (text) => text ? await ctx().getTokenCountAsync(String(text)) : 0;

/** Words the lorebook scans for keys: the last few messages. */
function recentText() {
    const depth = Math.max(1, Number($('#world_info_depth').val()) || 2);
    return ctx().chat.slice(-depth).map(m => m.mes ?? '').join('\n').toLowerCase();
}

/**
 * Everything this extension puts in the prompt for the next reply.
 * @returns {Promise<{always: number, budget: number, rows: object[], labels: {count: number, tokens: number}}>}
 */
export async function measure() {
    const c = ctx();
    const s = settings();
    const chat = c.chat;
    const rows = [];
    const anyPrivate = chat.some(m => getFlag(m)) || findScenes().some(x => x.part);
    const anyCommon = chat.some(m => getCommon(m));

    if (s.enabled) {
        if (anyPrivate || findScenes().length || hasPrivateLists() || Object.keys(chatState().timeline).length) {
            rows.push({ kind: 'rules', label: 'Secret-keeping rules', always: true, tokens: await tokens(s.rules) });
        }
        if (anyCommon || hasCommonKnowledge()) {
            rows.push({ kind: 'rules', label: 'Common-knowledge rules', always: true, tokens: await tokens(s.commonRules) });
        }
        if (s.clockEnabled && clockText()) rows.push({ kind: 'clock', label: 'Story clock', always: true, tokens: await tokens(clockText()) });
    }

    const book = c.chatMetadata?.[BOOK_KEY];
    const data = book && c.getWorldInfoNames().includes(book) ? await c.loadWorldInfo(book) : null;
    const recent = recentText();
    for (const [uid, entry] of Object.entries(data?.entries ?? {})) {
        if (entry.disable) continue;
        const [, kind, group] = kindOf(entry.comment);
        const keys = (entry.key ?? []).filter(Boolean);
        rows.push({
            kind, group, uid, label: entry.comment || `Entry ${uid}`, always: !!entry.constant, keys,
            triggeredNow: !entry.constant && keys.some(k => recent.includes(String(k).toLowerCase())),
            tokens: await tokens(entry.content),
        });
    }

    // Labels sit inside the chat text, around each run of flagged messages.
    let runs = 0;
    let previous = null;
    for (const m of chat) {
        const key = getFlag(m) ? `p:${getFlag(m).members.join()}` : getCommon(m) ? `c:${getCommon(m).kind}` : null;
        if (key && key !== previous) runs++;
        previous = key;
    }
    const labelTokens = runs ? runs * (await tokens(`${s.labelStart.replace('{{members}}', 'Ana and Kael')}\n${s.labelEnd}`)) : 0;

    const always = rows.filter(r => r.always).reduce((n, r) => n + r.tokens, 0);
    lastMeasure = { always, budget: Number(s.memoryBudget) || 0, rows, labels: { count: runs, tokens: labelTokens }, book };
    return lastMeasure;
}

// ─── Warning ─────────────────────────────────────────────────────────

let checkTimer = null;
const warned = new Set();

/** Re-measures a little after lorebook changes; warns once per chat when over budget. */
export function scheduleBudgetCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(async () => {
        const s = settings();
        if (!s.enabled || !s.budgetWarn || !Number(s.memoryBudget)) return;
        const chatId = ctx().chatId;
        try {
            const { always, budget } = await measure();
            if (always <= budget) {
                warned.delete(chatId);
                return;
            }
            if (warned.has(chatId)) return;
            warned.add(chatId);
            toastr.warning(`Memory that is always included is now about ${always.toLocaleString()} tokens, over your budget of ${budget.toLocaleString()}. Click to see what to trim.`,
                'Private Scenes', { onclick: () => openBudget(), timeOut: 12000 });
        } catch (error) {
            console.warn('[Private Scenes] budget check failed', error);
        }
    }, 2500);
}

// ─── Trimming ────────────────────────────────────────────────────────

/** Switches story or secret entries between always-on and triggered, in settings and in the lorebook. */
async function setAlwaysOn(kind, constant) {
    const c = ctx();
    const s = settings();
    const state = chatState();
    s[kind === 'story' ? 'memoryConstant' : 'entryConstant'] = constant;
    c.saveSettingsDebounced();
    const records = kind === 'story' ? state.memories : Object.values(state.timeline);
    const books = new Map();
    for (const record of records) {
        if (!record.book || record.uid === undefined || record.uid === null) continue;
        if (!books.has(record.book)) books.set(record.book, await c.loadWorldInfo(record.book));
        const entry = books.get(record.book)?.entries?.[record.uid];
        if (entry) entry.constant = constant;
    }
    for (const [book, data] of books) {
        if (!data) continue;
        await c.saveWorldInfo(book, data, true);
        c.reloadWorldInfoEditor(book);
    }
}

// ─── Last prompt sent ────────────────────────────────────────────────

let lastSent = null;
let armed = false;

/**
 * GENERATION_STARTED: only a real reply arms the capture. Background calls
 * (ours or other extensions' generateRaw) fire the same prompt events but
 * no GENERATION_STARTED, and quiet or dry runs aren't the roleplay prompt.
 */
export function armCapture(type, _options, dryRun) {
    armed = !dryRun && type !== 'quiet';
}

/** CHAT_COMPLETION_PROMPT_READY: {chat, dryRun} */
export function captureChatPrompt(data) {
    if (!armed || data?.dryRun || !Array.isArray(data?.chat)) return;
    armed = false;
    lastSent = { at: new Date(), messages: data.chat.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })) };
}

/** GENERATE_AFTER_COMBINE_PROMPTS (text completion): {prompt, dryRun} */
export function captureTextPrompt(data) {
    // Chat-completion APIs fire this too, before their real prompt is ready.
    if (!armed || ctx().mainApi === 'openai' || data?.dryRun || typeof data?.prompt !== 'string') return;
    armed = false;
    lastSent = { at: new Date(), messages: [{ role: 'prompt', content: data.prompt }] };
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A label template as a pattern: "{{members}}" and "{{kind}}" match anything on the line. */
const templatePattern = (template) => escapeRegex(String(template ?? '').trim()).replace(/\\\{\\\{(members|kind)\\\}\\\}/g, '[^\\n]*?');

/** Ranges in a text that came from this extension. */
function ourRanges(text, pieces, patterns) {
    const ranges = [];
    for (const piece of pieces) {
        for (let i = text.indexOf(piece); i !== -1; i = text.indexOf(piece, i + piece.length)) ranges.push([i, i + piece.length]);
    }
    for (const re of patterns) {
        for (const match of text.matchAll(re)) ranges.push([match.index, match.index + match[0].length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
        if (merged.length && r[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], r[1]);
        else merged.push([...r]);
    }
    return merged;
}

/** Text with this extension's parts wrapped in <mark>. */
function highlighted(text, ranges) {
    const out = $('<div class="ps-sent-text"></div>');
    let at = 0;
    for (const [from, to] of ranges) {
        if (from > at) out.append(document.createTextNode(text.slice(at, from)));
        out.append($('<mark class="ps-mark"></mark>').text(text.slice(from, to)));
        at = to;
    }
    if (at < text.length) out.append(document.createTextNode(text.slice(at)));
    return out;
}

// ─── Window ──────────────────────────────────────────────────────────

let root = null;
let tab = 'next';

export async function openBudget(startTab = 'next') {
    tab = startTab === 'sent' ? 'sent' : 'next';
    root = document.createElement('div');
    root.classList.add('ps-popup', 'ps-memory', 'ps-budget');
    const header = popupHeader('fa-gauge-high', 'Prompt & budget', 'What the model gets from Private Scenes.');
    header.classList.add('ps-banner');
    header.append(windowCloseButton()[0]);
    root.append(header);
    $(root).append('<div class="ps-tabs" role="tablist"></div><div class="ps-tab-body"></div>');
    render();
    await showPopup(root, { dialogClass: 'ps-window-dialog', wide: true, large: true, allowVerticalScrolling: true, okButton: 'Close' });
    root = null;
}

function render() {
    if (!root) return;
    const bar = $(root).find('.ps-tabs').empty();
    for (const [id, icon, label] of [['next', 'fa-gauge-high', 'Next reply'], ['sent', 'fa-paper-plane', 'Last sent']]) {
        const button = $('<div class="ps-tab" role="tab" tabindex="0"><i class="fa-solid" aria-hidden="true"></i><span></span></div>');
        button.toggleClass('ps-tab-active', id === tab).attr('aria-selected', String(id === tab)).attr('data-tab', id);
        button.find('i').addClass(icon);
        button.find('span').text(label);
        button.on('click keydown', (e) => {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            tab = id;
            render();
        });
        bar.append(button);
    }
    const body = $(root).find('.ps-tab-body').empty().append('<div class="ps-empty"><i class="fa-solid fa-spinner fa-spin"></i> Counting tokens…</div>');
    (tab === 'next' ? renderNext(body) : renderSent(body)).catch(error => {
        body.empty().append($('<div class="ps-notice ps-notice-warn"></div>').text(String(error?.message ?? error)));
    });
}

const fmt = (n) => Number(n).toLocaleString();

async function renderNext(body) {
    const s = settings();
    const m = await measure();
    body.empty();

    // Meter
    const ratio = m.budget ? m.always / m.budget : 0;
    const level = !m.budget ? 'ok' : ratio > 1 ? 'over' : ratio > 0.8 ? 'near' : 'ok';
    const meter = $(`
        <div class="ps-meter-card">
            <div class="ps-meter-head"><b class="ps-meter-value"></b><span class="ps-meter-of"></span></div>
            <div class="ps-meter" role="meter" aria-valuemin="0"><div class="ps-meter-fill"></div></div>
            <div class="ps-meter-foot">
                <label class="ps-budget-input">Budget <input type="number" class="text_pole" id="ps_budget" min="0" step="100"> tokens</label>
                <span class="ps-meter-note"></span>
            </div>
        </div>`);
    meter.addClass(`ps-meter-${level}`);
    meter.find('.ps-meter-value').text(`${fmt(m.always)} tokens`);
    meter.find('.ps-meter-of').text(m.budget ? `always included · ${Math.round(ratio * 100)}% of ${fmt(m.budget)}` : 'always included · no budget set');
    meter.find('.ps-meter').attr({ 'aria-valuenow': m.always, 'aria-valuemax': m.budget || m.always, 'aria-label': 'Memory always included in the prompt' });
    meter.find('.ps-meter-fill').css('width', `${Math.min(100, Math.round(ratio * 100))}%`);
    meter.find('#ps_budget').val(s.memoryBudget).on('change', function () {
        s.memoryBudget = Math.max(0, Number(this.value) || 0);
        ctx().saveSettingsDebounced();
        render();
    });
    const triggered = m.rows.filter(r => !r.always);
    const now = triggered.filter(r => r.triggeredNow).reduce((n, r) => n + r.tokens, 0);
    meter.find('.ps-meter-note').text(now ? `+ ${fmt(now)} from entries the latest messages trigger` : '');
    body.append(meter);

    if (level === 'over') {
        body.append($('<div class="ps-notice ps-notice-warn"><i class="fa-solid fa-triangle-exclamation"></i><span></span></div>')
            .find('span').text(`Over budget by ${fmt(m.always - m.budget)} tokens. Every reply pays for this, so trim it below.`).end());
    }

    // Trim actions
    const state = chatState();
    const trims = $('<div class="ps-trims"></div>');
    const trim = (cls, icon, label, hint, run) => trims.append(actionButton(cls, icon, label, hint).on('click', async function () {
        $(this).addClass('disabled');
        try { await run(); } finally { render(); }
    }));
    if (s.memoryConstant && state.memories.length) {
        trim('ps-trim-story', 'fa-bolt', 'Story entries only when triggered', 'Story entries go in only when their names or keywords come up', () => setAlwaysOn('story', false));
    }
    if (s.entryConstant && Object.keys(state.timeline).length) {
        trim('ps-trim-secrets', 'fa-bolt', 'Secrets only when triggered', 'Secret entries go in only when their names or keywords come up', () => setAlwaysOn('secret', false));
    }
    if (state.memories.filter(x => (x.level ?? 0) < 2).length >= 3) {
        trim('ps-trim-merge', 'fa-layer-group', 'Merge old entries into chapters', 'Summarizes older story entries into shorter chapters now', async () => {
            const before = state.memories.length;
            await maybeConsolidate({ force: true });
            const after = chatState().memories.length;
            if (after < before) toastr.success(`Merged ${before - after + 1} entries into chapters.`, 'Private Scenes');
            else toastr.info('Nothing to merge yet: there are not enough older entries (see "Entries per chapter" in Settings).', 'Private Scenes');
        });
    }
    if (state.world.length || state.facts.length) {
        trims.append(actionButton('ps-trim-knowledge', 'fa-earth-americas', 'Review knowledge & pins', 'Remove world knowledge or pins you no longer need').on('click', () => hooks.openMemory?.('facts')));
    }
    if (trims.children().length) {
        body.append('<div class="ps-section-title"><i class="fa-solid fa-scissors"></i> Ways to trim</div>', trims);
    }

    // Breakdown
    const table = $('<div class="ps-budget-rows"></div>');
    const addRow = (row) => {
        const el = $('<div class="ps-budget-row"><span class="ps-budget-label"></span><span class="ps-budget-meta"></span><span class="ps-budget-tokens"></span></div>');
        el.attr('data-kind', row.kind);
        el.find('.ps-budget-label').text(row.label);
        el.find('.ps-budget-tokens').text(fmt(row.tokens));
        const meta = el.find('.ps-budget-meta');
        if (row.always) meta.append(statusPill('saved', 'fa-thumbtack', 'Always'));
        else if (row.triggeredNow) meta.append(statusPill('review', 'fa-bolt', 'Triggered now'));
        else meta.append(statusPill('unsaved', 'fa-key', row.keys?.length ? `When: ${row.keys.slice(0, 3).join(', ')}${row.keys.length > 3 ? '…' : ''}` : 'Never (no keys)'));
        if (m.always && row.always) el.css('--ps-share', `${Math.round(row.tokens / Math.max(m.always, m.budget) * 100)}%`);
        table.append(el);
    };
    const sorted = [...m.rows].sort((a, b) => (b.always - a.always) || (b.tokens - a.tokens));
    sorted.forEach(addRow);
    if (m.labels.count) {
        addRow({ kind: 'labels', label: `Labels around ${m.labels.count} private or common ${m.labels.count === 1 ? 'stretch' : 'stretches'} (in the chat itself, whole chat)`, tokens: m.labels.tokens, always: false, keys: null, triggeredNow: true });
    }
    body.append('<div class="ps-section-title"><i class="fa-solid fa-list"></i> Everything Private Scenes adds</div>');
    body.append(sorted.length || m.labels.count ? table : '<div class="ps-empty">Nothing yet: this chat has no secrets, memories or knowledge.</div>');
    body.append($('<small class="ps-budget-help"></small>').text('Token counts use your current tokenizer. "Always" entries go into every prompt; the others only when their keys appear in the latest messages. The budget counts only the always-included part.'));
}

async function renderSent(body) {
    body.empty();
    if (!lastSent) {
        body.append('<div class="ps-empty"><i class="fa-solid fa-paper-plane"></i> Nothing sent yet in this session. Send a message, then come back here to see the exact prompt.</div>');
        return;
    }
    const s = settings();
    const m = lastMeasure ?? await measure();
    const c = ctx();
    const data = m.book ? await c.loadWorldInfo(m.book) : null;
    const pieces = [s.rules, s.commonRules, clockText(), ...Object.values(data?.entries ?? {}).map(e => e.content)]
        .map(x => String(x ?? '').trim()).filter(x => x.length > 8);
    const patterns = [s.labelStart, s.labelEnd, s.commonLabelStart, s.rumorLabelStart, s.commonLabelEnd]
        .filter(Boolean).map(t => new RegExp(templatePattern(t), 'g'));

    const total = await tokens(lastSent.messages.map(x => x.content).join('\n'));
    let ours = 0;
    const list = $('<div class="ps-sent-list"></div>');
    for (const message of lastSent.messages) {
        const ranges = ourRanges(message.content, pieces, patterns);
        const mine = ranges.map(([a, b]) => message.content.slice(a, b)).join('\n');
        const mineTokens = ranges.length ? await tokens(mine) : 0;
        ours += mineTokens;
        const item = $('<details class="ps-sent-message"><summary><span class="ps-sent-role"></span><span class="ps-sent-preview"></span></summary></details>');
        item.toggleClass('ps-sent-ours', ranges.length > 0).prop('open', ranges.length > 0);
        item.find('.ps-sent-role').text(message.role);
        item.find('.ps-sent-preview').text(message.content.slice(0, 90).replace(/\s+/g, ' '));
        if (ranges.length) item.find('summary').append(statusPill('saved', 'fa-user-secret', `${fmt(mineTokens)} from Private Scenes`));
        item.append(highlighted(message.content, ranges));
        list.append(item);
    }
    const head = $('<div class="ps-meter-card ps-sent-head"><div class="ps-meter-head"><b class="ps-meter-value"></b><span class="ps-meter-of"></span></div><label class="checkbox_label ps-sent-filter"><input type="checkbox"> <span>Only messages with Private Scenes parts</span></label></div>');
    head.find('.ps-meter-value').text(`${fmt(total)} tokens sent`);
    head.find('.ps-meter-of').text(`${lastSent.messages.length} messages · ${lastSent.at.toLocaleTimeString()} · about ${fmt(ours)} from Private Scenes (highlighted)`);
    head.find('input').on('change', function () { list.toggleClass('ps-sent-only-ours', this.checked); });
    body.append(head, list);
}

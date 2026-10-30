// The Story Memory window: one popup with tabs for the timeline, character
// sheets, open threads, pinned facts and secrets (who knows what).

import {
    MID, adoptScene, allNames, chatState, ctx, findScenes, formatMembers, getReveals, membersKey, nameHue,
    revealedNames, setRevealedNames, settings, sourceStatus,
} from './core.js';
import {
    acceptCurrent, approveDraft, canConsolidate, discardDraft, levelName, maybeConsolidate, orphanScenes,
    refreshSceneEntry, removeMemory, removeSceneEntry, resummarizeMemory, saveScene, saveStorySoFar, saving,
    splitChapter, staleItems, writeMemoryEntry, writeSceneEntry,
} from './lorebook.js';
import {
    addFact, addSheet, addThread, editFact, editThread, getClock, publicStoryText, relationshipList, removeFact,
    removeSheet, removeThread, setClock, setSheetText, setThreadStatus, sheetList, sheetToText, sheetsBusy, updateSheets,
} from './memory.js';
import { joinSummary } from './extract.js';
import {
    actionButton, avatar, chip, chips, confirm, editSummaryPopup, jumpTo, keywordTags, openReveal, popupHeader, refreshUi, statusPill,
} from './ui.js';

const TABS = [
    ['timeline', 'fa-timeline', 'Timeline'],
    ['characters', 'fa-users', 'Characters'],
    ['threads', 'fa-list-check', 'Threads'],
    ['facts', 'fa-thumbtack', 'Facts'],
    ['secrets', 'fa-user-secret', 'Secrets'],
];

let root = null;
let tab = 'timeline';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

const report = (error) => toastr.error(String(error?.message ?? error), 'Private Scenes');

export async function openMemory(startTab = 'timeline') {
    const c = ctx();
    tab = TABS.some(([id]) => id === startTab) ? startTab : 'timeline';
    root = document.createElement('div');
    root.classList.add('ps-popup', 'ps-memory');
    const header = popupHeader('fa-book-open', 'Story Memory', 'Everything this story remembers.');
    header.classList.add('ps-banner');
    $(header).find('.ps-popup-titles').append('<div class="ps-clock-row"></div>');
    root.append(header);
    $(root).append('<div class="ps-tabs" role="tablist"></div><div class="ps-tab-body"></div>');
    refreshMemory();
    await c.callGenericPopup(root, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Close' });
    root = null;
}

export function refreshMemory() {
    if (!root) return;
    renderClockRow();
    renderTabs();

    const body = $(root).find('.ps-tab-body').empty();
    ({ timeline: renderTimeline, characters: renderCharacters, threads: renderThreads, facts: renderFacts, secrets: renderSecrets })[tab](body);
}

function renderTabs() {
    const bar = $(root).find('.ps-tabs').empty();
    const state = chatState();
    const scenes = findScenes();
    const counts = {
        timeline: scenes.length + state.memories.length,
        characters: sheetList().length,
        threads: state.threads.filter(t => t.status === 'open').length,
        facts: state.facts.length,
        secrets: scenes.length,
    };
    // Reviews waiting or out-of-date entries put a dot on the timeline tab.
    const attention = { timeline: state.drafts.length + staleItems().length };
    for (const [id, icon, label] of TABS) {
        const button = $('<div class="ps-tab" role="tab" tabindex="0"><i class="fa-solid" aria-hidden="true"></i><span></span></div>');
        button.toggleClass('ps-tab-active', id === tab).attr('aria-selected', String(id === tab));
        button.find('i').addClass(icon);
        button.find('span').text(label);
        if (counts[id]) button.append($('<b class="ps-tab-count"></b>').text(counts[id]));
        if (attention[id]) {
            button.append($('<span class="ps-tab-alert"></span>').attr('title', `${attention[id]} need your attention`));
            button.attr('aria-label', `${label}, ${attention[id]} need your attention`);
        }
        button.on('click keydown', (e) => {
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            tab = id;
            refreshMemory();
        });
        bar.append(button);
    }
    // Keep the active tab visible when the bar scrolls sideways (phones).
    const active = bar.find('.ps-tab-active')[0];
    if (active) bar[0].scrollLeft = Math.max(0, active.offsetLeft - (bar[0].clientWidth - active.offsetWidth) / 2);
}

// ─── Story clock ─────────────────────────────────────────────────────

function renderClockRow() {
    const row = $(root).find('.ps-clock-row').empty();
    if (!settings().clockEnabled) return;
    const { time, place } = getClock();
    row.append(
        $('<span class="ps-clock-item"><i class="fa-solid fa-clock"></i><span></span></span>').find('span').text(time || 'Time not set').end(),
        $('<span class="ps-clock-item"><i class="fa-solid fa-location-dot"></i><span></span></span>').find('span').text(place || 'Place not set').end(),
        actionButton('ps-clock-edit', 'fa-pen', '', 'Set the story time and place').on('click', editClock),
    );
}

export async function editClock() {
    const c = ctx();
    const { time, place } = getClock();
    const form = $(`
        <div class="ps-popup">
            <label>Story time<input class="text_pole ps-in-time" placeholder="e.g. Day 3, evening"></label>
            <label>Place<input class="text_pole ps-in-place" placeholder="e.g. the palace garden"></label>
            <small class="ps-hint">Shown to the model with every reply. Tip: start a message with “@time Day 4, dawn:” or “@place the stables:”.</small>
        </div>`);
    form.prepend(popupHeader('fa-clock', 'Story clock', 'When and where the story is right now.'));
    form.find('.ps-in-time').val(time);
    form.find('.ps-in-place').val(place);
    const result = await c.callGenericPopup(form[0], c.POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel' });
    if (result === c.POPUP_RESULT.AFFIRMATIVE) setClock({ time: String(form.find('.ps-in-time').val()), place: String(form.find('.ps-in-place').val()) });
}

/** Time and place as items for a card's meta line. */
function clockTags(clock) {
    const items = [];
    if (clock?.time) items.push($('<span class="ps-meta-item"><i class="fa-solid fa-clock"></i></span>').append(document.createTextNode(clock.time)));
    if (clock?.place) items.push($('<span class="ps-meta-item"><i class="fa-solid fa-location-dot"></i></span>').append(document.createTextNode(clock.place)));
    return items;
}

// ─── Timeline tab ────────────────────────────────────────────────────

const STALE_TEXT = {
    edited: 'Out of date: messages were edited',
    missing: 'Out of date: some messages were deleted',
    gone: 'Out of date: its messages were deleted',
};

function sceneStatus(scene) {
    const record = chatState().timeline[scene.id];
    if (saving.has(scene.id)) return ['saving', 'fa-spinner fa-spin', 'Saving…'];
    if (!record) return ['unsaved', 'fa-circle-dot', 'Not saved'];
    const source = sourceStatus(record);
    if (source.state !== 'ok') return ['stale', 'fa-triangle-exclamation', STALE_TEXT[source.state]];
    if (record.count !== scene.ids.length || membersKey(record.members) !== membersKey(scene.members)) {
        return ['changed', 'fa-rotate', 'Changed since saved'];
    }
    return ['saved', 'fa-book-bookmark', 'In lorebook'];
}

function timelineCard(kind, icon) {
    return $(`
        <li class="ps-tl-item">
            <div class="ps-tl-node"><i class="fa-solid"></i></div>
            <div class="ps-tl-card">
                <div class="ps-tl-top"><span class="ps-tl-title"></span></div>
                <div class="ps-tl-members"></div>
                <p class="ps-tl-summary"></p>
                <div class="ps-card-meta"><span class="ps-meta-item ps-tl-range"><i class="fa-solid fa-message"></i><span></span></span></div>
                <div class="ps-tl-actions"></div>
            </div>
        </li>`).addClass(`ps-kind-${kind}`).find('.ps-tl-node i').addClass(icon).end();
}

function renderSceneCard(scene) {
    const record = chatState().timeline[scene.id];
    const [cls, icon, text] = sceneStatus(scene);
    const reveals = getReveals(scene.id);
    const range = scene.ids.length > 1 ? `Messages ${scene.ids[0]}–${scene.ids.at(-1)}` : `Message ${scene.ids[0]}`;

    const item = timelineCard('scene', 'fa-user-secret').addClass(`ps-${cls}`);
    item.find('.ps-tl-title').text(`Secret · Scene ${scene.index}`);
    item.find('.ps-tl-range span').text(`${range} · ${plural(scene.ids.length, 'msg')}`);
    item.find('.ps-tl-top').append(statusPill(cls, icon, text));
    item.find('.ps-tl-members').append(chips(scene.members));
    if (reveals.length) {
        const learned = $('<div class="ps-tl-learned"><i class="fa-solid fa-eye"></i><span>Learned later:</span></div>');
        for (const reveal of reveals) {
            const pill = chip(reveal.name);
            pill.classList.add('ps-chip-revealed');
            pill.title = `Found out at message ${reveal.at}`;
            learned.append(pill);
        }
        item.find('.ps-tl-members').after(learned);
    }

    const summary = item.find('.ps-tl-summary');
    if (record?.summary) {
        summary.text(record.summary);
        summary.after(keywordTags(record.keywords));
        item.find('.ps-card-meta').append(clockTags(record.clock));
    } else {
        const preview = String(ctx().chat[scene.ids[0]]?.mes ?? '').replace(/\s+/g, ' ');
        summary.addClass('ps-preview').text(preview.length > 180 ? `${preview.slice(0, 180)}…` : preview);
    }

    const actions = item.find('.ps-tl-actions');
    actions.append(actionButton('ps-act-jump', 'fa-location-arrow', 'Jump', 'Scroll to this scene').on('click', () => jumpTo(scene.ids[0])));
    actions.append(actionButton('ps-act-save', 'fa-wand-magic-sparkles', record ? 'Re-summarize' : 'Save to lorebook')
        .toggleClass('disabled', saving.has(scene.id)).on('click', () => saveScene(scene)));
    if (cls === 'stale') {
        actions.append(actionButton('ps-act-keep', 'fa-check', 'Keep as is', 'The saved summary is still right').on('click', () => acceptCurrent('scene', scene.id)));
    }
    actions.append(actionButton('ps-act-reveal', 'fa-eye', 'Reveal…', 'Someone else found out').on('click', () => openReveal(scene)));
    if (record) {
        actions.append(actionButton('ps-act-edit', 'fa-pen', 'Edit', 'Edit the saved summary').on('click', async () => {
            const edited = await editSummaryPopup(record.summary, record.keywords);
            if (edited) await writeSceneEntry(scene, edited.summary, edited.keywords).catch(report);
        }));
        actions.append(actionButton('ps-act-remove', 'fa-trash-can', '', 'Remove this scene\'s lorebook entry').on('click', async () => {
            if (await confirm(`Remove scene ${scene.index} from the lorebook? The chat messages stay private.`)) await removeSceneEntry(scene.id);
        }));
    }
    return item;
}

/** A saved secret whose messages are all gone (deleted, or a branch that never had them). */
function renderOrphanCard({ id, record }) {
    const item = timelineCard('scene', 'fa-user-secret').addClass('ps-stale');
    item.find('.ps-tl-title').text('Secret');
    item.find('.ps-tl-range span').text(`was at message ${record.anchor ?? '?'}`);
    item.find('.ps-tl-top').append(statusPill('stale', 'fa-triangle-exclamation', STALE_TEXT.gone));
    item.find('.ps-tl-members').append(chips(record.members ?? []));
    item.find('.ps-tl-summary').text(record.summary ?? '');
    item.find('.ps-tl-actions').append(actionButton('ps-act-remove', 'fa-trash-can', 'Remove from lorebook').on('click', async () => {
        if (await confirm('Remove this secret from the lorebook? Its messages are no longer in the chat.')) await removeSceneEntry(id);
    }));
    return item;
}

function renderMemoryCard(memory) {
    const busy = saving.has(memory.id);
    const source = sourceStatus(memory);
    const stale = source.state !== 'ok';
    const level = memory.level ?? 0;
    const from = stale && source.ids?.length ? Math.min(...source.ids) : memory.from;
    const to = stale && source.ids?.length ? Math.max(...source.ids) : memory.to;

    const item = timelineCard('memory', ['fa-scroll', 'fa-book', 'fa-landmark'][level] ?? 'fa-scroll')
        .addClass(busy ? 'ps-saving' : stale ? 'ps-stale' : 'ps-saved').addClass(`ps-level-${level}`);
    item.find('.ps-tl-title').text(levelName(level));
    item.find('.ps-tl-range span').text(`Messages ${from}–${to}${memory.parts?.length ? ` · merged from ${memory.parts.length} parts` : ''}`);
    item.find('.ps-tl-top').append(busy ? statusPill('saving', 'fa-spinner fa-spin', 'Saving…')
        : stale ? statusPill('stale', 'fa-triangle-exclamation', STALE_TEXT[source.state])
            : statusPill('saved', 'fa-book-bookmark', 'In lorebook'));
    item.find('.ps-tl-members').remove();
    item.find('.ps-tl-summary').text(memory.summary ?? '').after(keywordTags(memory.keywords));
    item.find('.ps-card-meta').append(clockTags(memory.clock));

    const actions = item.find('.ps-tl-actions');
    actions.append(actionButton('ps-act-jump', 'fa-location-arrow', 'Jump').on('click', () => jumpTo(from)));
    if (source.state !== 'gone') {
        actions.append(actionButton('ps-act-save', 'fa-wand-magic-sparkles', 'Re-summarize').toggleClass('disabled', busy)
            .on('click', () => resummarizeMemory(memory.id)));
    }
    if (stale && source.ids?.length) {
        actions.append(actionButton('ps-act-keep', 'fa-check', 'Keep as is', 'The saved summary is still right').on('click', () => acceptCurrent('memory', memory.id)));
    }
    actions.append(actionButton('ps-act-edit', 'fa-pen', 'Edit').on('click', async () => {
        const edited = await editSummaryPopup(memory.summary, memory.keywords);
        if (edited) await writeMemoryEntry(memory, edited.summary, edited.keywords).catch(report);
    }));
    if (memory.parts?.length) {
        actions.append(actionButton('ps-act-split', 'fa-object-ungroup', 'Split', `Restore the ${memory.parts.length} separate entries`)
            .on('click', () => splitChapter(memory.id)));
    }
    actions.append(actionButton('ps-act-remove', 'fa-trash-can', '', 'Remove this memory from the lorebook').on('click', async () => {
        if (await confirm(`Remove the ${levelName(level).toLowerCase()} entry for messages ${from}–${to}?`)) await removeMemory(memory.id);
    }));
    return item;
}

function draftLabel(draft) {
    if (draft.kind === 'scene') return `Secret · ${formatMembers(draft.members ?? [])}`;
    if (draft.kind === 'chapter') return `${levelName(draft.level)} · merging ${draft.partIds.length} entries`;
    return `Story · messages ${draft.from}–${draft.to}`;
}

function renderDraftCard(draft) {
    const busy = saving.has(draft.id);
    const card = $(`
        <div class="ps-draft">
            <div class="ps-tl-top"><span class="ps-tl-title"></span></div>
            <p class="ps-tl-summary"></p>
            <ul class="ps-draft-extras"></ul>
            <div class="ps-tl-actions"></div>
        </div>`);
    card.find('.ps-tl-title').text(draftLabel(draft));
    card.find('.ps-tl-top').append(statusPill('review', 'fa-hourglass-half', busy ? 'Saving…' : 'Waiting for review'));
    card.find('.ps-tl-summary').text(draft.parsed.summary).after(keywordTags(draft.parsed.keywords));
    const extras = card.find('.ps-draft-extras');
    for (const thread of draft.parsed.threads ?? []) extras.append($('<li></li>').text(`New thread: ${thread}`));
    const threads = chatState().threads;
    for (const number of draft.parsed.resolved ?? []) {
        const thread = threads.find(t => t.id === draft.threadIds?.[number - 1]);
        if (thread) extras.append($('<li></li>').text(`Resolves: ${thread.text}`));
    }
    if (draft.parsed.time || draft.parsed.place) extras.append($('<li></li>').text(`Time and place: ${[draft.parsed.time, draft.parsed.place].filter(Boolean).join(', ')}`));
    if (!extras.children().length) extras.remove();

    const actions = card.find('.ps-tl-actions');
    actions.append(actionButton('ps-act-approve', 'fa-check', 'Approve').toggleClass('disabled', busy).on('click', () => approveDraft(draft.id)));
    actions.append(actionButton('ps-act-edit', 'fa-pen', 'Edit & approve').toggleClass('disabled', busy).on('click', async () => {
        const c = ctx();
        const text = await c.callGenericPopup('Edit the summary before saving it. The last line lists the trigger keywords.',
            c.POPUP_TYPE.INPUT, joinSummary(draft.parsed.summary, draft.parsed.keywords), { rows: 9, wide: true, okButton: 'Approve' });
        if (typeof text === 'string' && text.trim()) await approveDraft(draft.id, text);
    }));
    actions.append(actionButton('ps-act-remove', 'fa-xmark', 'Discard').on('click', () => discardDraft(draft.id)));
    return card;
}

function renderTimeline(body) {
    const state = chatState();
    const scenes = findScenes();

    if (state.drafts.length) {
        const section = $('<section class="ps-section-block"><h4><i class="fa-solid fa-hourglass-half"></i> Waiting for your review</h4></section>');
        state.drafts.forEach(d => section.append(renderDraftCard(d)));
        body.append(section);
    }

    const stale = staleItems();
    if (stale.length) {
        body.append($('<div class="ps-notice ps-notice-warn"><i class="fa-solid fa-triangle-exclamation"></i><span></span></div>')
            .find('span').text(`${plural(stale.length, 'saved memory', 'saved memories')} no longer ${stale.length === 1 ? 'matches' : 'match'} the chat. `
                + 'Re-summarize, keep, or remove them below.').end());
    }

    const toolbar = $('<div class="ps-toolbar"></div>');
    const unsaved = scenes.filter(x => sceneStatus(x)[0] === 'unsaved');
    if (unsaved.length) {
        toolbar.append(actionButton('ps-save-all', 'fa-book-medical', `Save ${plural(unsaved.length, 'secret')}`).on('click', async () => {
            for (const scene of unsaved) await saveScene(scene, { quiet: true });
        }));
    }
    if (ctx().chat.length - state.memoryCursor > 0) {
        toolbar.append(actionButton('ps-save-story', 'fa-scroll', 'Summarize story so far', `Messages ${state.memoryCursor}–${ctx().chat.length - 1} (public parts only)`)
            .on('click', () => saveStorySoFar()));
    }
    if (canConsolidate()) {
        const busy = [...saving].some(x => String(x).startsWith('consolidate_'));
        toolbar.append(actionButton('ps-consolidate', busy ? 'fa-spinner fa-spin' : 'fa-layer-group', 'Merge old entries', 'Combine the oldest story entries into a chapter')
            .toggleClass('disabled', busy).on('click', () => maybeConsolidate({ force: true })));
    }
    if (toolbar.children().length) body.append(toolbar);

    const items = [
        ...scenes.map(scene => ({ start: scene.ids[0], el: () => renderSceneCard(scene) })),
        ...orphanScenes().map(orphan => ({ start: orphan.record.anchor ?? Infinity, el: () => renderOrphanCard(orphan) })),
        ...state.memories.map(memory => ({ start: memory.from, el: () => renderMemoryCard(memory) })),
    ].sort((a, b) => a.start - b.start);

    if (!items.length) {
        body.append(emptyState('fa-feather-pointed', 'Nothing in the timeline yet',
            'Flag a message with the secret-agent button, start a private scene, or summarize the story so far.'));
        return;
    }
    const list = $('<ol class="ps-timeline"></ol>');
    items.forEach(x => list.append(x.el()));
    body.append(list);
}

function emptyState(icon, title, text) {
    return $('<div class="ps-empty"><i class="fa-solid"></i><b></b><span></span></div>')
        .find('i').addClass(icon).end().find('b').text(title).end().find('span').text(text).end();
}

// ─── Characters tab ──────────────────────────────────────────────────

function renderCharacters(body) {
    const sheets = sheetList();
    const busy = sheetsBusy.size > 0;
    const story = publicStoryText();

    const toolbar = $('<div class="ps-toolbar"></div>');
    toolbar.append(actionButton('ps-sheets-update', busy ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles', busy ? 'Updating…' : 'Update all from story',
        'Rebuild every sheet from the saved story memory (public parts only)')
        .toggleClass('disabled', busy || !story).on('click', () => updateSheets(story, { quiet: false })));
    toolbar.append(actionButton('ps-sheets-add', 'fa-user-plus', 'Add character').on('click', async () => {
        const c = ctx();
        const name = await c.callGenericPopup('Character name:', c.POPUP_TYPE.INPUT, '');
        if (typeof name === 'string' && name.trim()) await addSheet(name);
    }));
    body.append(toolbar);
    body.append('<small class="ps-hint">Sheets are built only from public story memory, so they never give away a secret.</small>');

    if (!sheets.length) {
        body.append(emptyState('fa-users', 'No character sheets yet',
            'They are created and updated each time the story is summarized. You can also add a character yourself.'));
        return;
    }

    const grid = $('<div class="ps-sheets"></div>');
    for (const sheet of sheets) grid.append(renderSheet(sheet, busy));
    body.append(grid);

    const rels = relationshipList();
    if (rels.length) {
        const section = $('<section class="ps-section-block"><h4><i class="fa-solid fa-people-arrows"></i> Relationships</h4><div class="ps-rel-list"></div></section>');
        for (const rel of rels) {
            const row = $('<div class="ps-rel-row"><span class="ps-rel-pair"></span><span class="ps-rel-text"></span></div>');
            row.find('.ps-rel-pair').append(chip(rel.from), '<i class="fa-solid fa-arrow-right"></i>', chip(rel.name));
            row.find('.ps-rel-text').text(rel.text);
            if (rel.history?.length) {
                row.append($('<small class="ps-rel-history"></small>').text(`was: ${rel.history.map(h => h.text).reverse().join(' ← ')}`));
            }
            section.find('.ps-rel-list').append(row);
        }
        body.append(section);
    }
}

function renderSheet(sheet, busy) {
    const card = $(`
        <div class="ps-sheet">
            <div class="ps-sheet-top"></div>
            <p class="ps-sheet-state"></p>
            <ul class="ps-sheet-rels"></ul>
            <div class="ps-tl-actions"></div>
        </div>`);
    const who = $('<div class="ps-sheet-who"><b></b><small></small></div>');
    who.find('b').text(sheet.name);
    who.find('small').text(Number.isFinite(sheet.updatedAt) ? `Updated at message ${sheet.updatedAt}` : 'Not updated yet');
    card.find('.ps-sheet-top').append(avatar(sheet.name, { large: true }), who);
    card[0].style.setProperty('--ps-hue', String(nameHue(sheet.name)));
    card.find('.ps-sheet-state').text(sheet.state || 'Nothing known yet.').toggleClass('ps-preview', !sheet.state);
    for (const rel of Object.values(sheet.rels ?? {})) {
        const li = $('<li></li>').append(chip(rel.name), $('<span></span>').text(rel.text));
        if (rel.history?.length) li.append($('<small class="ps-rel-history"></small>').text(`was: ${rel.history.at(-1).text}`));
        card.find('.ps-sheet-rels').append(li);
    }
    if (!card.find('.ps-sheet-rels').children().length) card.find('.ps-sheet-rels').remove();

    const actions = card.find('.ps-tl-actions');
    actions.append(actionButton('ps-act-edit', 'fa-pen', 'Edit').on('click', async () => {
        const c = ctx();
        const text = await c.callGenericPopup(`Edit ${sheet.name}'s sheet. Use one “STATE:” line and one “REL Name:” line per relationship.`,
            c.POPUP_TYPE.INPUT, sheetToText(sheet), { rows: 8, wide: true });
        if (typeof text === 'string' && text.trim()) await setSheetText(sheet.name, text);
    }));
    actions.append(actionButton('ps-act-save', 'fa-wand-magic-sparkles', 'Update').toggleClass('disabled', busy || !publicStoryText())
        .on('click', () => updateSheets(publicStoryText(), { names: [sheet.name], quiet: false })));
    actions.append(actionButton('ps-act-remove', 'fa-trash-can', '', 'Remove this sheet').on('click', async () => {
        if (await confirm(`Remove ${sheet.name}'s character sheet from the lorebook?`)) await removeSheet(sheet.name);
    }));
    return card;
}

// ─── Threads & facts tabs ────────────────────────────────────────────

function addRow(placeholder, onAdd) {
    const row = $('<div class="ps-add-row"><input type="text" class="text_pole"><div class="menu_button menu_button_icon"><i class="fa-solid fa-plus"></i><span>Add</span></div></div>');
    const input = row.find('input').attr('placeholder', placeholder);
    const submit = async () => {
        const value = String(input.val()).trim();
        if (!value) return;
        input.val('');
        await onAdd(value);
    };
    row.find('.menu_button').on('click', submit);
    input.on('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            submit();
        }
    });
    return row;
}

async function editTextPopup(title, value) {
    const c = ctx();
    const text = await c.callGenericPopup(title, c.POPUP_TYPE.INPUT, value, { rows: 3, wide: true });
    return typeof text === 'string' && text.trim() ? text.trim() : null;
}

function listItem(text, members) {
    const li = $('<li class="ps-list-item"><div class="ps-list-main"><span class="ps-list-text"></span></div><div class="ps-list-actions"></div></li>');
    li.find('.ps-list-text').text(text);
    if (members?.length) {
        li.find('.ps-list-main').append($('<span class="ps-list-private"><i class="fa-solid fa-user-secret"></i></span>').append(chips(members)));
    }
    return li;
}

function renderThreads(body) {
    const threads = chatState().threads;
    body.append(addRow('Add a promise, plan, or open question…', (text) => addThread(text)));
    body.append('<small class="ps-hint">Open threads are always given to the model so it remembers to pay them off. New ones are found automatically when the story is summarized.</small>');

    const open = threads.filter(t => t.status === 'open');
    const done = threads.filter(t => t.status !== 'open');
    if (!threads.length) {
        body.append(emptyState('fa-list-check', 'No open threads', 'Promises, plans, debts and mysteries show up here.'));
        return;
    }

    const list = $('<ul class="ps-list"></ul>');
    for (const thread of open) {
        const li = listItem(thread.text, thread.members);
        li.prepend($('<input type="checkbox" class="ps-list-check" title="Mark as resolved" aria-label="Mark as resolved">')
            .on('change', () => setThreadStatus(thread.id, 'resolved')));
        li.find('.ps-list-main').append($('<small></small>').text(`since msg ${thread.openedAt}`));
        li.find('.ps-list-actions').append(
            actionButton('ps-act-edit', 'fa-pen', '', 'Edit').on('click', async () => {
                const text = await editTextPopup('Edit the thread:', thread.text);
                if (text) await editThread(thread.id, text);
            }),
            actionButton('ps-act-remove', 'fa-trash-can', '', 'Delete').on('click', () => removeThread(thread.id)),
        );
        list.append(li);
    }
    body.append(list);

    if (done.length) {
        const details = $('<details class="ps-resolved"><summary></summary><ul class="ps-list"></ul></details>');
        details.find('summary').text(`Resolved (${done.length})`);
        for (const thread of done) {
            const li = listItem(thread.text, thread.members).addClass('ps-list-done');
            li.find('.ps-list-main').append($('<small></small>').text(`resolved at msg ${thread.resolvedAt ?? '?'}`));
            li.find('.ps-list-actions').append(
                actionButton('ps-act-reopen', 'fa-rotate-left', '', 'Reopen').on('click', () => setThreadStatus(thread.id, 'open')),
                actionButton('ps-act-remove', 'fa-trash-can', '', 'Delete').on('click', () => removeThread(thread.id)),
            );
            details.find('ul').append(li);
        }
        body.append(details);
    }
}

function renderFacts(body) {
    const facts = chatState().facts;
    body.append(addRow('Add a fact the story must remember…', (text) => addFact(text)));
    body.append('<small class="ps-hint">Pinned facts are always given to the model. Pin one from any message with the thumbtack in its “…” menu.</small>');
    if (!facts.length) {
        body.append(emptyState('fa-thumbtack', 'No pinned facts', 'Small details that summaries tend to drop, like “Ana is left-handed”.'));
        return;
    }
    const positions = new Map(ctx().chat.map((m, i) => [m.extra?.[MID], i]));
    const list = $('<ul class="ps-list"></ul>');
    for (const fact of facts) {
        const li = listItem(fact.text, fact.members);
        const source = fact.sourceMid ? positions.get(fact.sourceMid) : undefined;
        if (source !== undefined) {
            li.find('.ps-list-main').append($('<small class="ps-link" role="button" tabindex="0"><i class="fa-solid fa-location-arrow"></i> </small>')
                .append(document.createTextNode(`from msg ${source}`)).on('click', () => jumpTo(source)));
        }
        li.find('.ps-list-actions').append(
            actionButton('ps-act-edit', 'fa-pen', '', 'Edit').on('click', async () => {
                const text = await editTextPopup('Edit the fact:', fact.text);
                if (text) await editFact(fact.id, text);
            }),
            actionButton('ps-act-remove', 'fa-trash-can', '', 'Unpin').on('click', () => removeFact(fact.id)),
        );
        list.append(li);
    }
    body.append(list);
}

// ─── Secrets tab (who knows what) ────────────────────────────────────

function renderSecrets(body) {
    const scenes = findScenes();
    const names = allNames();
    if (!scenes.length) {
        body.append(emptyState('fa-user-secret', 'No secrets yet', 'Private scenes show up here.'));
        return;
    }

    // Cards on phones and any touch screen: the table relies on small dots and hover tooltips.
    const compact = window.matchMedia('(max-width: 600px), (pointer: coarse)').matches;
    const rows = scenes.map(scene => {
        const record = chatState().timeline[scene.id];
        const about = String(record?.summary ?? ctx().chat[scene.ids[0]]?.mes ?? '').replace(/\s+/g, ' ');
        return { scene, about, cells: names.map(name => knowledgeCell(scene, name)) };
    });
    body.append(compact ? knowledgeCards(rows) : knowledgeTable(rows, names));
    body.append(`
        <div class="ps-grid-legend">
            <span><span class="ps-cell ps-cell-member"></span> Was there</span>
            <span><span class="ps-cell ps-cell-revealed"></span> Found out later</span>
            <span><span class="ps-cell ps-cell-unknown"></span> Doesn't know (tap to reveal)</span>
        </div>`);
}

/** What one character knows about one secret, and what tapping it does. */
function knowledgeCell(scene, name) {
    const key = name.toLowerCase();
    const reveal = getReveals(scene.id).find(r => r.name.toLowerCase() === key);
    const update = async (names) => {
        const adopted = adoptScene(scene);
        setRevealedNames(adopted, names(adopted));
        await refreshSceneEntry(adopted.id);
        refreshUi();
    };
    if (scene.members.some(x => x.toLowerCase() === key)) {
        return { name, state: 'member', title: `${name} was there` };
    }
    if (reveal) {
        return {
            name, state: 'revealed', detail: `msg ${reveal.at}`,
            title: `${name} found out at message ${reveal.at}. Tap to undo.`,
            toggle: () => update(adopted => revealedNames(adopted.id).filter(x => x.toLowerCase() !== key)),
        };
    }
    return {
        name, state: 'unknown',
        title: `${name} doesn't know. Tap if ${name} finds out now.`,
        toggle: () => update(adopted => [...revealedNames(adopted.id), name]),
    };
}

function knowledgeTable(rows, names) {
    const table = $('<table class="ps-grid"><thead><tr><th class="ps-grid-secret">Secret</th></tr></thead><tbody></tbody></table>');
    for (const name of names) table.find('thead tr').append($('<th></th>').append(chip(name)));
    for (const { scene, about, cells } of rows) {
        const row = $('<tr><td class="ps-grid-secret"><b></b><small></small></td></tr>');
        row.find('b').text(`Scene ${scene.index}`);
        row.find('small').text(about.length > 70 ? `${about.slice(0, 70)}…` : about).attr('title', about);
        for (const cell of cells) {
            const dot = $('<span class="ps-cell"></span>').css('--ps-hue', String(nameHue(cell.name)))
                .addClass(`ps-cell-${cell.state}`).attr('title', cell.title);
            if (cell.toggle) dot.addClass('ps-clickable').on('click', cell.toggle);
            row.append($('<td></td>').append(dot));
        }
        table.find('tbody').append(row);
    }
    return $('<div class="ps-grid-scroll"></div>').append(table);
}

/** Phone layout: one card per secret, with a tappable chip per character. */
function knowledgeCards(rows) {
    const list = $('<div class="ps-kcards"></div>');
    for (const { scene, about, cells } of rows) {
        const card = $('<div class="ps-kcard"><b></b><small></small><div class="ps-kchips"></div></div>');
        card.find('b').text(`Scene ${scene.index}`);
        card.find('small').text(about.length > 110 ? `${about.slice(0, 110)}…` : about);
        for (const cell of cells) {
            const icon = { member: 'fa-check', revealed: 'fa-eye', unknown: 'fa-plus' }[cell.state];
            const pill = $(chip(cell.name, { icon })).addClass(`ps-kchip ps-kchip-${cell.state}`).attr('title', cell.title);
            if (cell.detail) pill.append($('<small class="ps-kchip-detail"></small>').text(cell.detail));
            if (cell.toggle) pill.addClass('ps-clickable').attr('role', 'button').on('click', cell.toggle);
            card.find('.ps-kchips').append(pill);
        }
        list.append(card);
    }
    return list;
}

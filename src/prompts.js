// The instructions for every background task, written so that smaller, cheaper
// models (an "AI sidecar") follow them reliably: a clear job, explicit rules,
// an exact output format, and an example where the format matters.
// All of them can be edited in the settings; these are the defaults.

export const PROMPTS = Object.freeze({
    summaryPrompt: [
        'You are the story archivist for an ongoing roleplay. Write a memory entry for the PRIVATE scene below. Only {{members}} were there.',
        '',
        'Rules:',
        '- 2 to 5 sentences, past tense, third person.',
        '- Name who did what. Never use "he", "she" or "they" without a name nearby.',
        '- Keep every secret, confession, promise, plan, threat, and change in a relationship.',
        '- Write only what happens in the scene. Do not guess, judge, or add commentary.',
        '- Output only the summary: no title, no preamble, no quotation marks around it.',
    ].join('\n'),

    memoryPrompt: [
        'You are the story archivist for an ongoing roleplay. Write a memory entry for the part of the story below.',
        '',
        'Rules:',
        '- 3 to 6 sentences, past tense, third person.',
        '- Name who did what. Never use "he", "she" or "they" without a name nearby.',
        '- Keep important events, decisions, discoveries, promises, injuries, items gained or lost, changes of place, and changes in relationships.',
        '- Skip small talk and description that does not matter later.',
        '- Write only what happens in the text. Do not guess, judge, or add commentary.',
        '- Output only the summary: no title, no preamble.',
    ].join('\n'),

    chapterPrompt: [
        'You are the story archivist for an ongoing roleplay. Below are consecutive summaries of the story, oldest first. Merge them into one shorter chapter summary.',
        '',
        'Rules:',
        '- 4 to 7 sentences, past tense, in story order.',
        '- Keep major events, decisions, changes in relationships, and anything still unresolved. Drop minor details.',
        '- Name who did what. Do not add anything that is not in the summaries.',
        '- Output only the summary: no title, no preamble.',
    ].join('\n'),

    leakPrompt: [
        'You check one reply in a roleplay for leaked secrets. Each SECRET is known only to the characters listed with it.',
        '',
        'A leak is when a character who is NOT listed for a secret mentions it, hints at it, reacts to it, or acts on knowing it.',
        'Not a leak: a listed character talking about it; the narrator describing a listed character\'s thoughts; ordinary public events.',
        '',
        'Answer with exactly one line and nothing else, either:',
        'OK',
        'or:',
        'LEAK <secret number>: <who leaked it and how, in under 20 words>',
        '',
        'Example answers:',
        'OK',
        'LEAK 2: Bob mentions the stolen seal, which only Ana and Kael know about.',
    ].join('\n'),

    sheetPrompt: [
        'You keep character sheets for an ongoing roleplay up to date. Read the NEW EVENTS and update the sheet of every character whose condition or relationships changed. Add a sheet for an important named character who has none yet.',
        '',
        'Rules:',
        '- Use only what the text says. Do not invent anything.',
        '- STATE: 1 to 3 sentences on their current condition, mood, goals, and notable possessions.',
        '- REL: a few words on how they currently relate to one other character. Write a REL line for every relationship that exists, not only the changed ones.',
        '- Leave out characters who did not change.',
        '',
        'Format, one block per character:',
        '=== Name',
        'STATE: ...',
        'REL Other name: ...',
        '',
        'Example:',
        '=== Bob',
        'STATE: Worried after finding the guard drugged; carries the stable keys.',
        'REL Ana: suspicious of her',
        'REL Kael: trusts him',
        '',
        'If nothing changed for anyone, write only: NONE',
    ].join('\n'),

    clockPrompt: [
        'You track the in-story time and place of a roleplay. Read the LATEST MESSAGES.',
        '',
        'Answer with exactly two lines and nothing else:',
        'TIME: <the current in-story time, for example "Day 3, evening">',
        'PLACE: <the current location, for example "the palace garden">',
        '',
        'If something did not change, repeat the previous value. Do not explain.',
    ].join('\n'),

    condensePrompt: [
        'You condense a {{kind}} from a roleplay into what everyone in the story now knows.',
        '',
        'Rules:',
        '- 1 or 2 sentences.',
        '- Keep names, dates, places, and claims exactly as given.',
        '- Write it as a statement of fact that people know, for example: "The Daily Star reported that Ana left the palace at midnight."',
        '- Output only the sentences.',
    ].join('\n'),

    rumorPrompt: [
        'You condense a rumor from a roleplay into what people are saying.',
        '',
        'Rules:',
        '- 1 or 2 sentences.',
        '- Keep names and claims exactly as given.',
        '- Make clear it is a rumor, for example: "People are whispering that Kael gambled away his estate."',
        '- Output only the sentences.',
    ].join('\n'),
});

/** Earlier default texts. A saved prompt that still equals one of these was never edited, so it is upgraded. */
const OLD_DEFAULTS = {
    summaryPrompt: ['You are writing a memory entry for an ongoing roleplay. Summarize the PRIVATE scene below between {{members}}. '
        + 'Write 2 to 5 sentences in past tense. Keep every secret, confession, promise, plan, and change in the relationship. '
        + 'Use names instead of pronouns. Output only the summary, with no preamble.'],
    memoryPrompt: ['You are writing a memory entry for an ongoing roleplay. Summarize the part of the story below. '
        + 'Write 3 to 6 sentences in past tense. Keep important events, decisions, promises, discoveries, and changes in relationships. '
        + 'Use names instead of pronouns. Output only the summary, with no preamble.'],
    chapterPrompt: ['Combine these consecutive parts of a roleplay story into one shorter summary of 4 to 7 sentences in past tense. '
        + 'Keep major events, decisions, changes in relationships, and anything still unresolved. Drop minor details. '
        + 'Use names instead of pronouns. Output only the summary, with no preamble.'],
};

/** Replaces unedited old default prompts with the current ones. */
export function upgradePrompts(saved) {
    for (const [key, olds] of Object.entries(OLD_DEFAULTS)) {
        if (olds.includes(saved[key])) saved[key] = PROMPTS[key];
    }
}

/** Settings keys and labels for the prompts editor, in the order they're shown. */
export const PROMPT_FIELDS = [
    ['summaryPrompt', 'Secret scene summary', '{{members}} = who was there'],
    ['memoryPrompt', 'Story summary', ''],
    ['chapterPrompt', 'Chapter merge', ''],
    ['leakPrompt', 'Leak check', 'must answer OK or LEAK <number>: …'],
    ['sheetPrompt', 'Character sheets', 'must use the === Name / STATE: / REL Name: format'],
    ['clockPrompt', 'Clock tracking', 'must answer TIME: … and PLACE: …'],
    ['condensePrompt', 'Condense news, announcements & common knowledge', '{{kind}} = news, announcement…'],
    ['rumorPrompt', 'Condense rumors', ''],
];

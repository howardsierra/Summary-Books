# Private Scenes

A SillyTavern extension for keeping secrets in a story. It marks messages as **private between certain characters**, so the narrator knows those events happened out of everyone else's sight and doesn't make them public knowledge. It also keeps a **Private Timeline**: each private scene is summarized and saved as a lorebook entry, so it's remembered long after it has scrolled out of the context window.

It's built for **one narrator card that plays every character**.

## How it works

Private messages stay in the prompt so the narrator remembers them. At generation time they get labels like these:

```
[PRIVATE — known only to: Ana and Kael]
...the private messages...
[END PRIVATE]
```

The extension also adds a short rules note telling the model that unlisted characters must not know, hint at, or act on anything inside those labels.

Your saved chat is never changed. The labels exist only in the prompt sent to the model.

## Install

SillyTavern → **Extensions** → **Install extension** → paste this repository's URL. Tested with SillyTavern 1.19.0.

## Flagging messages as private

- **Button on a message.** Open a message's `…` menu and click 🕵️. Pick who knows from the character chips, or add new names. Deselect everyone to make the message public again.
- **Private scene.** Use the wand menu → *Private scene…*, or run `/private-scene Ana, Kael`. Every new message is flagged until you end the scene. A glowing bar above the chat input shows who's in the scene, with buttons to edit it, open the timeline, or end it.
- **Slash commands** (see the table below).

Flagged messages get a violet tint and a **PRIVATE** badge with colored chips for each character. Each character keeps the same color everywhere.

## Private Timeline (lorebook)

When a private scene ends, the extension asks your current model to summarize it. The summary is saved as an entry in the **chat's lorebook**. If the chat has no lorebook, one named `Private Timeline - <chat>` is created and linked to the chat automatically.

Each entry:
- is wrapped in the same `[PRIVATE — known only to: …]` labels, so the secret stays secret when the entry is used;
- triggers when one of its characters is mentioned. You can switch entries to *always included* instead;
- is ordered by where the scene happened, so the lorebook reads like a timeline.

Open the timeline from the wand menu, the scene bar, the settings panel, or `/private-timeline`. It lists every private scene in story order. For each one you can:
- see whether it's saved;
- jump to it in the chat;
- save or re-summarize it;
- edit the summary by hand;
- remove its lorebook entry.

Scenes you flagged after the fact (with the button or `/private at=…`) appear there too, with a **Save to lorebook** button.

Turn on **Hide the original messages after saving** to keep the context small. The lorebook summary then stands in for the hidden messages.

## Slash commands

| Command | What it does |
|---|---|
| `/private Ana, Kael` | Flags the last message |
| `/private at=12-18 Ana, Kael` | Flags messages 12 to 18 |
| `/public at=12-18` | Removes the flag, for when the secret comes out |
| `/private-scene Ana, Kael` | Starts a private scene |
| `/private-scene` | Returns who is in the current scene |
| `/private-end` | Ends the scene, and saves it to the lorebook if auto-save is on |
| `/private-save` | Summarizes the latest scene into the lorebook and returns the summary. `at=14` picks the scene containing message 14 |
| `/private-timeline` | Opens the timeline |

`{{user}}` works in names.

## Settings

All of these are under Extensions → Private Scenes:

- **Lorebook timeline:** auto-save when a scene ends, hide messages after saving, always-include entries, and the summary instructions.
- **Prompt:** the rules text, the active-scene note, and the start and end labels. All are editable, and `{{members}}` is replaced with the names.
- **Rules depth:** how close to the end of the prompt the rules note goes. 1 means just before the last message.

## Limitations

- Private messages are **labelled, not removed**. One narrator plays everyone, so it has to remember the secret to write the characters who know it. This works well with capable models, but no prompt is airtight.
- Other extensions read the raw messages without the labels. Summaries from the built-in Summarize, Memory Books, or vector storage won't know a message was private.
- Interceptors don't run during SillyTavern's dry runs (token counting and prompt inspection), so the labels don't show up there.

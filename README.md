# Private Scenes

A SillyTavern extension for keeping secrets in a story, built for **one narrator card that plays every character**.

- **Private messages.** Mark messages as private between certain characters, so the narrator knows those events happened out of everyone else's sight.
- **Leak checker.** Warns you when a reply lets a character know something they weren't told, and can regenerate the reply automatically.
- **Reveals.** Record when someone finds out a secret later. From then on, they're treated as knowing it.
- **Who knows what.** A grid of every secret and every character.
- **Private Timeline.** Saves private scenes, and optionally the public story, as summaries in the chat's lorebook, with keywords as triggers.
- **Inline tags.** Type `@private Ana, Kael:` in a message instead of clicking.

Tested with SillyTavern 1.19.0.

## Install

SillyTavern → **Extensions** → **Install extension** → paste this repository's URL.

## How secrets reach the model

Private messages stay in the prompt so the narrator remembers them. At generation time they get labels like these:

```
[PRIVATE — known only to: Ana and Kael, plus Bob who learned of it later]
...the private messages...
[END PRIVATE]
```

The extension also adds a short rules note telling the model that unlisted characters must not know, hint at, or act on anything inside those labels. Your saved chat is never changed; the labels exist only in the prompt.

## Marking things private

| How | What it does |
|---|---|
| 🕵️ button in a message's `…` menu | Pick who knows from the character chips. Deselect everyone to make it public again |
| `@private Ana, Kael:` at the start of your message | Makes this message **and the reply to it** private |
| `@scene Ana, Kael:` at the start of your message | Starts a private scene. Every message after it is private |
| `@endscene` at the start of your message | Ends the scene. The rest of that message is public |
| Wand menu → *Private scene…*, or `/private-scene Ana, Kael` | Starts a scene |
| `/private at=12-18 Ana, Kael` | Flags a range of messages after the fact |

While a scene is running, a glowing bar above the chat box shows who's in it, with buttons to edit it, open the timeline, or end it.

## Leak checker

After each public reply, if the chat has secrets, the extension asks the model one short question: *did someone who isn't in on a secret mention, hint at, or act on it?* If the answer is yes, the reply gets a warning that says who leaked what. You can **Regenerate** the reply, or mark it **Looks fine**.

Turn on *Regenerate automatically* to retry leaking replies on their own, up to 2 tries.

This costs one small extra generation per reply, and only in chats that have secrets. You can switch it off in settings.

## Reveals: when secrets spread

Use **Reveal…** on a timeline card, click an empty dot in the *Who knows what* grid, or run `/private-reveal Bob`. This records that Bob found out at the current message. From then on:
- the private labels and the lorebook entry say *"plus Bob who learned of it later"*;
- Bob's name triggers the entry;
- the leak checker stops flagging Bob for that secret.

`/public` still exists for removing the private flag completely.

## Who knows what

Open it from the wand menu, the timeline, or `/who-knows`. Each row is a secret and each column is a character:

- ● **Filled:** the character was there.
- ◌ **Dashed:** the character found out later. Click to undo.
- ○ **Empty:** the character doesn't know. Click it when they find out.

## Private Timeline (lorebook)

Open it from the wand menu, the scene bar, or `/private-timeline`. Everything is listed in story order.

- **Secrets.** When a private scene ends, it's summarized into an entry in the **chat's lorebook**. If the chat has none, one is created and linked automatically. The entry is wrapped in the private labels so the secret stays secret.
- **Story memory.** *Summarize story so far*, or `/memory-save`, turns the public parts of the story into entries too. Turn on *Automatically summarize the public story* to do this every N public messages, leaving the newest few alone. **Private messages are never put into story memory.**
- **Keywords.** The summarizer also picks 2 to 5 specific places, objects or events, such as `royal seal`, and adds them to character names as triggers.
- Each card can jump to the scene, re-summarize, edit the summary (keywords are on the last line), or remove the entry.

Turn on **Hide the original messages after saving** to keep the context small. The summaries then stand in for the hidden messages.

## Slash commands

| Command | What it does |
|---|---|
| `/private Ana, Kael` | Flags the last message. `at=12-18` flags a range |
| `/public at=12-18` | Removes the private flag |
| `/private-scene Ana, Kael` | Starts a scene. With no names, returns who is in it |
| `/private-end` | Ends the scene and saves it if auto-save is on |
| `/private-reveal Bob` | Bob finds out the latest secret. `at=14` picks the secret containing message 14 |
| `/private-save` | Summarizes the latest secret into the lorebook. `at=14` picks one |
| `/memory-save` | Summarizes the public story since the last memory. `at=0-40` sets the range |
| `/private-timeline` | Opens the timeline |
| `/who-knows` | Opens the who-knows-what grid |

## Settings

All of these are under Extensions → Private Scenes:

- **Leak checker:** on or off, and auto-regenerate.
- **Lorebook timeline:** auto-save secrets, keywords, hide after saving, always-include secret entries, and the summary instructions.
- **Story memory:** auto-summarize, every N messages, how many recent messages to leave alone, always-include, and the instructions.
- **Prompt:** the rules text, the active-scene note, the labels, and the rules depth.

## Limitations

- Private messages are **labelled, not removed**. One narrator plays everyone, so it has to remember the secret to write the characters who know it. Capable models handle this well, and the leak checker catches many slips, but nothing is airtight.
- The leak checker is itself a model call, so it can miss leaks or flag things that aren't leaks. Use *Looks fine* for the false alarms.
- Other extensions read the raw messages without the labels. Summaries made by the built-in Summarize, Memory Books, or vector storage won't know a message was private.
- Interceptors don't run during SillyTavern's dry runs (token counting and prompt inspection), so the labels don't show up there.

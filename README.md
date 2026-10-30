# Private Scenes

A SillyTavern extension for keeping secrets in a story, built for **one narrator card that plays every character**.

- **Private messages.** Mark messages as private between certain characters, so the narrator knows those events happened out of everyone else's sight.
- **Common knowledge.** Mark news articles, announcements, rumors or famous facts as things *every* character knows, NPCs included, even if they weren't there.
- **AI sidecar.** Run all the background work on a cheaper model while your roleplay keeps using your main one.
- **Leak checker.** Warns you when a reply lets a character know something they weren't told, and can regenerate the reply automatically.
- **Reveals.** Record when someone finds out a secret later. From then on, they're treated as knowing it.
- **Who knows what.** A grid of every secret and every character.
- **Private Timeline.** Saves private scenes, and optionally the public story, as summaries in the chat's lorebook, with keywords as triggers.
- **Inline tags.** Type `@private Ana, Kael:` in a message instead of clicking.
- **Story Memory.** One window with tabs for the timeline, character sheets and relationships, open threads, pinned facts, and secrets. It also tracks a story clock (time and place), merges old summaries into chapters, can hold summaries for your review, and notices when edits or deletions make a saved memory out of date.

Tested with SillyTavern 1.19.0 on desktop and on phone-sized touch screens. Every button is at least 40px tall on touch screens, nothing depends on hovering, and text boxes use 16px text so iPhones don't zoom in.

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

## AI sidecar: a cheaper model for background work

The extension makes some extra requests in the background: summaries and chapters, leak checks, character sheets, condensing world knowledge, and optionally the clock. You can send these to a cheaper model, while your roleplay keeps using Opus, Fable, or whatever you chat with.

1. In SillyTavern, open the plug icon, connect the cheaper model you want (for example Claude Haiku 5.5 or Sonnet 5.5), and save it under **Connection Profile**. This uses SillyTavern's built-in Connection Manager.
2. In Extensions → Private Scenes → **AI sidecar**, choose that profile. **Test** sends a tiny request and shows which model answered and how fast.
3. Under **Use it for**, untick anything you'd rather keep on your main model. Leak checks are the main candidate, since a stronger model notices subtler leaks.

Details:
- Sidecar requests skip your roleplay's preset, so your RP instructions and jailbreaks don't bleed into a summary request.
- If the sidecar fails, the main connection is used instead, with one warning. Turn this off if you'd rather it fail.
- With no sidecar chosen, everything uses your main connection, as before.

### Prompts written for smaller models

Every background task has its own instructions: a clear job, explicit rules, an exact answer format, and an example where the format matters. This keeps cheaper models on track. You can edit all of them under **AI prompts for background tasks**, and each has a reset button. Keep the answer format the same when you edit, because the extension reads those labels. If you never changed the old summary prompts, they were upgraded to the new versions automatically.

## Common knowledge: news, announcements, rumors

Every message has one of three levels of "who knows", set with the 🕵️ button in its `…` menu:

| Choice | Who knows | Looks like |
|---|---|---|
| **Everyone** | Every character in the world, NPCs included, even ones who weren't there | Sky-blue tint (rumors: pink) |
| **Who was there** | The characters present. This is the usual for any message | No tint |
| **Only…** | Just the characters you pick (private) | Violet tint |

When you choose **Everyone**, you also pick what kind it is: 🌍 Common knowledge, 📰 News, 📣 Announcement, or 💬 Rumor. A rumor means everyone has heard it, but it may not be true. This suits celebrity roleplays with generated news articles, public announcements, gossip, or anything famous in your world.

You can also start a message with **`@news:`**, **`@rumor:`**, **`@announcement:`** or **`@common:`**, or use `/common kind=news at=12`.

What happens next:
- The model sees the message wrapped in `[COMMON KNOWLEDGE (News) — every character knows this, including those who were not there]` (or a `[RUMOR …]` label), with a short rule saying anyone may mention it.
- The message is condensed into one or two sentences and added to an always-included **🌍 World knowledge** lorebook entry, so it's remembered after it scrolls out of the chat. Turning off *Condense* uses the message text instead.
- Story Memory → **Knowledge** lists them all. You can edit each line, update it when its message was edited, remove it, or add world knowledge by hand.
- Switching a message to *Who was there* or *Only…* takes it back out of World knowledge. A `@news:` message sent during a private scene stays common knowledge.

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

Open it from the wand menu, the timeline, or `/who-knows`. On a computer, each row is a secret and each column is a character. On a phone, each secret is a card with a chip per character:

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

## Story Memory

Open it from the wand menu (*Story memory*), the 📖 button on the scene bar, or `/memory`. The header shows the **story clock**, and the tabs are:

- **Timeline.** Secrets and story entries in story order.
  - **Chapters.** Once there are enough story entries, the oldest ones are merged into a **chapter**. By default that's 5 entries, keeping the newest 3 as they are. Old chapters are merged into an **arc**. This keeps long roleplays small in the prompt. *Split* undoes a merge. Secrets are never merged.
  - **Review queue.** With *Let me review summaries before they are saved* on, new summaries wait at the top with **Approve**, **Edit & approve** and **Discard**.
  - **Rewind-safe.** Every saved memory remembers which messages it came from. If you edit, delete or swipe them (or open a branch without them), the entry is marked **Out of date**, and you get one warning. You can **Re-summarize** it, **Keep as is**, or remove it.
- **Characters.** One sheet per character: their current condition, mood, goals and possessions, plus how they relate to each other character. Sheets update after each story summary and show how relationships changed ("suspicious of her, was: friendly acquaintance"). Each sheet is a lorebook entry triggered by the character's name. **Sheets only use public story memory, so they never give away a secret.**
- **Threads.** Promises, plans, debts and open questions. Summaries add new threads and mark finished ones resolved. You can also add, edit, tick off or reopen them yourself. Open threads are always given to the model. Threads that come from a private scene stay private, and they follow that scene's reveals.
- **Knowledge.** 🌍 *World knowledge*, the common knowledge described above, plus 📌 *Pinned facts*: small details the model must never forget. Pin one from any message with the 📌 in its `…` menu (it starts from the text you selected), or with `/pin`. Facts pinned from a private message stay private.
- **Secrets.** The who-knows-what grid.

**Story clock:** set it with `@time Day 4, dawn:` and `@place the stables:` at the start of a message (these combine with the other tags), with `/story-time` and `/story-place`, or with the ✏️ in the Story Memory header. It also updates from each story summary. An optional setting checks it after every reply. The model sees `[Story time: … Location: …]` with every reply.

## Slash commands

| Command | What it does |
|---|---|
| `/private Ana, Kael` | Flags the last message. `at=12-18` flags a range |
| `/public at=12-18` | Makes messages normal again: no longer private or common knowledge |
| `/private-scene Ana, Kael` | Starts a scene. With no names, returns who is in it |
| `/private-end` | Ends the scene and saves it if auto-save is on |
| `/private-reveal Bob` | Bob finds out the latest secret. `at=14` picks the secret containing message 14 |
| `/private-save` | Summarizes the latest secret into the lorebook. `at=14` picks one |
| `/memory-save` | Summarizes the public story since the last memory. `at=0-40` sets the range |
| `/memory` | Opens Story Memory. Add a tab name to open it there: `/memory threads` |
| `/who-knows` | Opens the Secrets tab |
| `/memory-merge` | Merges the oldest story entries into a chapter now |
| `/pin Ana is left-handed` | Pins a fact |
| `/common kind=news at=12` | Marks message 12 as common knowledge. Kinds: common, news, announcement, rumor |
| `/thread Kael owes Bob a favor` | Adds an open thread |
| `/story-time Day 4, dawn` · `/story-place the stables` | Sets the story clock. With no text, returns it |

## Settings

All of these are under Extensions → Private Scenes:

- **AI sidecar:** the connection profile for background tasks, which tasks use it, and the fallback.
- **AI prompts for background tasks:** every task's instructions, each with a reset button.
- **Common knowledge:** condense marked messages into a short line, or use their text as is.
- **Leak checker:** on or off, and auto-regenerate.
- **Lorebook timeline:** auto-save secrets, keywords, hide after saving, always-include secret entries, and the summary instructions.
- **Story memory:** auto-summarize, every N messages, how many recent messages to leave alone, always-include, the instructions, and chapter merging (entries per chapter, how many to keep detailed, chapter instructions).
- **Characters & threads:** keep sheets up to date, and track threads.
- **Story clock:** on or off, and the optional per-reply check.
- **Review:** *Let me review summaries before they are saved*.
- **Prompt:** the rules text, the active-scene note, the labels, and the rules depth.

## Limitations

- Private messages are **labelled, not removed**. One narrator plays everyone, so it has to remember the secret to write the characters who know it. Capable models handle this well, and the leak checker catches many slips, but nothing is airtight.
- The leak checker is itself a model call, so it can miss leaks or flag things that aren't leaks. Use *Looks fine* for the false alarms.
- Other extensions read the raw messages without the labels. Summaries made by the built-in Summarize, Memory Books, or vector storage won't know a message was private.
- Interceptors don't run during SillyTavern's dry runs (token counting and prompt inspection), so the labels don't show up there.

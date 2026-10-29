# Private Scenes

A SillyTavern extension that marks messages as **private between certain characters**, so the narrator knows those events happened out of everyone else's sight and doesn't make them public knowledge.

It's built for **one narrator card that plays every character**. Private messages stay in the prompt so the narrator remembers them. At generation time they get labels like these:

```
[PRIVATE — known only to: Ana and Kael]
...the private messages...
[END PRIVATE]
```

The extension also adds a short rules note telling the model that unlisted characters must not know, hint at, or act on anything inside those labels.

Your saved chat is never changed. The labels exist only in the prompt sent to the model.

## Install

SillyTavern → **Extensions** → **Install extension** → paste this repository's URL.

## Flagging messages as private

There are three ways:

- **Button on a message.** Open a message's `…` menu and click the 🕵️ icon. Tick who knows about it, or type new names. Untick everyone to make it public again.
- **Private scene.** Go to Extensions → **Private Scenes** → *Start / edit private scene…*, or run `/private-scene Ana, Kael`. Every new message is flagged until you end the scene. A bar above the chat input shows the scene is active and has an **End** button.
- **Slash commands:**

| Command | What it does |
|---|---|
| `/private Ana, Kael` | Flags the last message |
| `/private at=12-18 Ana, Kael` | Flags messages 12 to 18, which is handy for flagging a scene after it happened |
| `/public at=12-18` | Removes the flag, for when the secret comes out |
| `/private-scene Ana, Kael` | Starts a private scene |
| `/private-scene` | Returns who is in the current scene |
| `/private-end` | Ends the scene |

`{{user}}` works in names.

When a secret gets revealed in-story, you can leave the old messages flagged and let the story show the reveal. Or you can `/public` them, or add the new person to the list with the button.

## Settings

All of these are under Extensions → Private Scenes:

- The rules text, the active-scene note, and the start and end labels. All are editable, and `{{members}}` is replaced with the names.
- **Rules depth**: how close to the end of the prompt the rules note goes. 1 means just before the last message. Lower depths are followed more strongly.
- A "Private" badge on flagged messages, which you can turn off.

## Limitations

- Private messages are **labelled, not removed**. One narrator plays everyone, so it has to remember the secret to write the characters who know it. This works well with capable models, but no prompt is airtight. Weaker models may still let things slip.
- Other extensions read the raw messages without the labels. Summaries from the built-in Summarize, Memory Books, or vector storage won't know a message was private.
- Interceptors don't run during SillyTavern's dry runs (token counting and prompt inspection), so the labels don't show up there.

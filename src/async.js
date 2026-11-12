// Keep delayed work scoped to its originating chat and serialize shared writes.
export function chatGuard(context) {
    const { chatId, chatMetadata } = context();
    return () => {
        const current = context();
        if (current.chatId !== chatId || current.chatMetadata !== chatMetadata) {
            throw new Error('The chat changed while this task was running. Return to the original chat and retry.');
        }
    };
}

export function keyedQueue() {
    const pending = new Map();
    return (key, operation) => {
        const previous = pending.get(key) ?? Promise.resolve();
        const run = previous.catch(() => {}).then(operation);
        pending.set(key, run);
        const clean = () => { if (pending.get(key) === run) pending.delete(key); };
        run.then(clean, clean);
        return run;
    };
}

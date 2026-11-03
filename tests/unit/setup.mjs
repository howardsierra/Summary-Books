// Lets the extension's modules load in plain Node: stubs SillyTavern's own
// modules and a minimal SillyTavern.getContext(). Tests set `ctx.chat` etc.
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
    if (/\\/(world-info|script|extensions|utils)\\.js$/.test(specifier) && specifier.startsWith('../')) {
        return { url: 'data:text/javascript,export const createWorldInfoEntry=()=>({});', shortCircuit: true };
    }
    return next(specifier, context);
}`));

export const ctx = {
    chat: [],
    chatId: 'test-chat',
    substituteParams: (text) => text,
    name1: 'User',
    name2: 'Narrator',
    chatMetadata: {},
    extensionSettings: {},
    saveSettingsDebounced() {},
    saveMetadataDebounced() {},
    saveMetadata: async () => {},
    eventSource: { on() {}, emit: async () => {} },
    eventTypes: {},
};
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.toastr = { info() {}, warning() {}, success() {}, error() {}, clear() {} };

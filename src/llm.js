// Every background request (summaries, leak checks, character sheets, …) goes
// through here. It uses the "AI sidecar" — a SillyTavern connection profile,
// usually a cheaper model — when one is chosen for that task, and the main
// connection otherwise.

import { ctx, settings } from './core.js';

/** Background tasks, the setting that routes each one, and a sensible answer length. */
export const TASKS = Object.freeze({
    summary: { label: 'Summaries & chapters', maxTokens: 700 },
    leak: { label: 'Leak checks', maxTokens: 150 },
    sheets: { label: 'Character sheets', maxTokens: 900 },
    condense: { label: 'Condensing world knowledge', maxTokens: 250 },
    clock: { label: 'Clock tracking', maxTokens: 80 },
});

const SIDECAR_EXTENSION = 'connection-manager';

/** Connection profiles the sidecar can use, or null when the Connection Manager is off. */
export function sidecarProfiles() {
    try {
        return ctx().ConnectionManagerRequestService.getSupportedProfiles();
    } catch {
        return null;
    }
}

function sidecarProfileFor(task) {
    const s = settings();
    if (!s.sidecarProfile || s.sidecarTasks?.[task] === false) return null;
    if (ctx().extensionSettings.disabledExtensions?.includes(SIDECAR_EXTENSION)) return null;
    return sidecarProfiles()?.find(p => p.id === s.sidecarProfile) ?? null;
}

/** Text out of whatever shape a connection returns. */
function textOf(result) {
    if (typeof result === 'string') return result;
    return String(result?.content ?? result?.text ?? result?.message?.content ?? '');
}

let warnedFallback = false;

async function viaSidecar(profile, task, systemPrompt, prompt) {
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
    ];
    // No preset: the roleplay's own instructions would otherwise leak into a summary request.
    const result = await ctx().ConnectionManagerRequestService.sendRequest(profile.id, messages, TASKS[task].maxTokens,
        { stream: false, extractData: true, includePreset: false, includeInstruct: true });
    return textOf(result);
}

function viaMain(task, systemPrompt, prompt) {
    return ctx().generateRaw({ systemPrompt, prompt, responseLength: TASKS[task].maxTokens });
}

/**
 * Runs one background request.
 * @param {keyof TASKS} task
 * @param {{systemPrompt: string, prompt: string}} request
 * @returns {Promise<string>}
 */
export async function llm(task, { systemPrompt, prompt }) {
    const profile = sidecarProfileFor(task);
    if (!profile) return String(await viaMain(task, systemPrompt, prompt) ?? '');
    try {
        return await viaSidecar(profile, task, systemPrompt, prompt);
    } catch (error) {
        console.error(`[Private Scenes] Sidecar "${profile.name}" failed for ${task}`, error);
        if (!settings().sidecarFallback) throw new Error(`The AI sidecar (${profile.name}) failed: ${error?.cause?.message ?? error?.message ?? error}`);
        if (!warnedFallback) {
            warnedFallback = true;
            toastr.warning(`The AI sidecar (${profile.name}) failed, so the main connection was used instead. Check the profile in the Connection Manager.`, 'Private Scenes');
        }
        return String(await viaMain(task, systemPrompt, prompt) ?? '');
    }
}

/** Sends a tiny request through the chosen profile and reports the model and time. */
export async function testSidecar() {
    const s = settings();
    const profile = sidecarProfiles()?.find(p => p.id === s.sidecarProfile);
    if (!profile) {
        toastr.info('No sidecar is chosen, so background tasks use your main connection.', 'Private Scenes');
        return;
    }
    const started = performance.now();
    try {
        const answer = await viaSidecar(profile, 'clock', 'You are a connection test. Reply with exactly: OK', 'Reply with OK.');
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        toastr.success(`${profile.name}${profile.model ? ` (${profile.model})` : ''} answered “${answer.trim().slice(0, 40)}” in ${seconds}s.`, 'AI sidecar works');
    } catch (error) {
        toastr.error(String(error?.cause?.message ?? error?.message ?? error), `AI sidecar (${profile.name}) failed`);
    }
}

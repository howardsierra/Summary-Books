// Every background request (summaries, leak checks, character sheets, …) goes
// through here. It uses the "AI sidecar" when one is chosen for that task:
//  - 'model':   the current Chat Completion provider with a different model,
//  - 'profile': a SillyTavern connection profile (any provider, local models),
// and the main connection otherwise.

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

/** Which sidecar a task uses: { kind: 'model', model } | { kind: 'profile', profile } | null for the main connection. */
function sidecarFor(task, { ignoreTasks = false } = {}) {
    const s = settings();
    if (!ignoreTasks && s.sidecarTasks?.[task] === false) return null;
    if (s.sidecarMode === 'model') {
        const problem = modelSidecarProblem();
        if (problem) {
            warnOnce(`model:${problem}`, `${problem} Background tasks use your main connection until you fix it in the AI sidecar settings.`);
            return null;
        }
        return { kind: 'model', model: s.sidecarModel, name: s.sidecarModel };
    }
    if (s.sidecarMode === 'profile' && s.sidecarProfile) {
        if (ctx().extensionSettings.disabledExtensions?.includes(SIDECAR_EXTENSION)) return null;
        const profile = sidecarProfiles()?.find(p => p.id === s.sidecarProfile);
        return profile ? { kind: 'profile', profile, name: profile.name } : null;
    }
    return null;
}

// ─── Picking a model directly ────────────────────────────────────────

/** The main Chat Completion provider (e.g. "claude", "openrouter"), or null on Text Completion. */
export function currentSource() {
    const c = ctx();
    return c.mainApi === 'openai' ? c.chatCompletionSettings?.chat_completion_source ?? null : null;
}

/** The provider's display name, as SillyTavern's API panel shows it. */
export function sourceName(source = currentSource()) {
    const option = source ? $(`#chat_completion_source option[value="${CSS.escape(source)}"]`) : $();
    return option.length ? option.text().trim() : (source ?? '');
}

/**
 * The models SillyTavern lists for the current provider, read from its own
 * model dropdown in the API panel. [{ id, label, group }]
 */
export function providerModels(source = currentSource()) {
    if (!source) return [];
    const id = { makersuite: 'google' }[source] ?? source;
    const select = document.getElementById(`model_${id}_select`);
    if (!select) return [];
    return [...select.querySelectorAll('option')]
        .filter(option => option.value)
        .map(option => ({ id: option.value, label: option.textContent.trim() || option.value, group: option.parentElement?.label ?? '' }));
}

/** Why the "pick a model" sidecar can't run right now, or '' when it can. */
export function modelSidecarProblem() {
    const s = settings();
    if (!s.sidecarModel) return 'No sidecar model is chosen.';
    const source = currentSource();
    if (!source) return 'Picking a model needs a Chat Completion connection (your roleplay uses Text Completion). Use a connection profile instead.';
    if (s.sidecarSource && s.sidecarSource !== source) {
        return `The sidecar model was chosen for ${sourceName(s.sidecarSource) || s.sidecarSource}, but your connection is now ${sourceName(source)}.`;
    }
    return '';
}

/** Sends messages through the current provider with another model (no preset). */
async function viaModel(model, task, systemPrompt, prompt) {
    const c = ctx();
    const oai = c.chatCompletionSettings;
    const result = await c.ChatCompletionService.processRequest({
        stream: false,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
        max_tokens: TASKS[task].maxTokens,
        model,
        chat_completion_source: oai.chat_completion_source,
        custom_url: oai.custom_url,
        custom_include_headers: oai.custom_include_headers,
        reverse_proxy: oai.reverse_proxy,
        proxy_password: oai.proxy_password,
        vertexai_region: oai.vertexai_region,
        zai_endpoint: oai.zai_endpoint,
        siliconflow_endpoint: oai.siliconflow_endpoint,
        minimax_endpoint: oai.minimax_endpoint,
        pollinations_endpoint: oai.pollinations_endpoint,
        azure_base_url: oai.azure_base_url,
        azure_deployment_name: oai.azure_deployment_name,
        azure_api_version: oai.azure_api_version,
    }, {}, true, null);
    return textOf(result);
}

/** Text out of whatever shape a connection returns. */
function textOf(result) {
    if (typeof result === 'string') return result;
    return String(result?.content ?? result?.text ?? result?.message?.content ?? '');
}

const warned = new Set();
function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    toastr.warning(message, 'Private Scenes: AI sidecar');
}

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
    const sidecar = sidecarFor(task);
    if (!sidecar) return String(await viaMain(task, systemPrompt, prompt) ?? '');
    try {
        return sidecar.kind === 'model'
            ? await viaModel(sidecar.model, task, systemPrompt, prompt)
            : await viaSidecar(sidecar.profile, task, systemPrompt, prompt);
    } catch (error) {
        console.error(`[Private Scenes] Sidecar "${sidecar.name}" failed for ${task}`, error);
        const reason = error?.cause?.message ?? error?.message ?? error;
        if (!settings().sidecarFallback) throw new Error(`The AI sidecar (${sidecar.name}) failed: ${reason}`);
        warnOnce(`fail:${sidecar.name}`, `The AI sidecar (${sidecar.name}) failed, so the main connection was used instead. ${reason}`);
        return String(await viaMain(task, systemPrompt, prompt) ?? '');
    }
}

/** Sends a tiny request through the chosen sidecar and reports the model and time. */
export async function testSidecar() {
    const s = settings();
    if (s.sidecarMode === 'model' && modelSidecarProblem()) {
        toastr.warning(modelSidecarProblem(), 'AI sidecar');
        return;
    }
    const sidecar = sidecarFor('clock', { ignoreTasks: true });
    if (!sidecar) {
        toastr.info(s.sidecarMode === 'profile' ? 'Choose a connection profile first.' : 'No sidecar is chosen, so background tasks use your main connection.', 'AI sidecar');
        return;
    }
    const started = performance.now();
    const system = 'You are a connection test. Reply with exactly: OK';
    try {
        const answer = sidecar.kind === 'model'
            ? await viaModel(sidecar.model, 'clock', system, 'Reply with OK.')
            : await viaSidecar(sidecar.profile, 'clock', system, 'Reply with OK.');
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        const label = sidecar.kind === 'model' ? `${sidecar.model} via ${sourceName()}` : `${sidecar.name}${sidecar.profile.model ? ` (${sidecar.profile.model})` : ''}`;
        toastr.success(`${label} answered “${answer.trim().slice(0, 40)}” in ${seconds}s.`, 'AI sidecar works');
    } catch (error) {
        toastr.error(String(error?.cause?.message ?? error?.message ?? error), `AI sidecar (${sidecar.name}) failed`);
    }
}

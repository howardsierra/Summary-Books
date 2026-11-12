// Every background request (summaries, leak checks, character sheets, …) goes
// through here. It uses the "AI sidecar" when one is chosen for that task:
//  - 'model':   a model you pick, from your roleplay's provider or any other
//               Chat Completion provider you saved an API key for,
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

/** The provider the "pick a model" sidecar uses: the chosen one, else the roleplay's. */
export function sidecarProvider() {
    return settings().sidecarSource || currentSource();
}

/** Every Chat Completion provider SillyTavern supports: [{ id, label }]. */
export function allProviders() {
    return [...document.querySelectorAll('#chat_completion_source option')]
        .filter(option => option.value)
        .map(option => ({ id: option.value, label: option.textContent.trim() || option.value }));
}

/** Why the "pick a model" sidecar can't run right now, or '' when it can. */
export function modelSidecarProblem() {
    const s = settings();
    if (!s.sidecarModel) return 'No sidecar model is chosen.';
    if (!sidecarProvider()) return 'Your roleplay uses a Text Completion connection, so choose a provider for the sidecar.';
    if (sidecarProvider() === 'custom' && !customUrl()) return 'Enter the URL of your Custom (OpenAI-compatible) endpoint.';
    return '';
}

/** The Custom endpoint URL: the sidecar's own, else the roleplay's when that is Custom too. */
function customUrl() {
    const oai = ctx().chatCompletionSettings ?? {};
    return settings().sidecarCustomUrl || (currentSource() === 'custom' ? oai.custom_url : '') || '';
}

/**
 * Connection fields for a provider. The roleplay's own extras (reverse proxy,
 * regions, endpoints…) only apply when it is the same provider.
 */
function providerFields(source) {
    const oai = ctx().chatCompletionSettings ?? {};
    if (source !== currentSource()) return { chat_completion_source: source, custom_url: source === 'custom' ? customUrl() : undefined };
    return {
        chat_completion_source: source,
        custom_url: source === 'custom' ? customUrl() : oai.custom_url,
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
    };
}

/** Sends messages to the chosen provider and model (no preset). */
async function viaModel(model, task, systemPrompt, prompt) {
    const result = await ctx().ChatCompletionService.processRequest({
        stream: false,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
        max_tokens: TASKS[task].maxTokens,
        model,
        ...providerFields(sidecarProvider()),
    }, {}, true, null);
    return textOf(result);
}

/** Asks a provider for its model list with your saved key: [{ id, label, group }]. */
export async function fetchProviderModels(source = sidecarProvider()) {
    const response = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(providerFields(source)),
    });
    if (!response.ok) throw new Error(`${sourceName(source)} did not return a model list (${response.status}). Is an API key saved for it?`);
    const data = await response.json();
    if (data?.error) throw new Error(`${sourceName(source)} did not return a model list. Is an API key saved for it?`);
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
    return list.map(m => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(Boolean).sort()
        .map(id => ({ id, label: id, group: '' }));
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
        const label = sidecar.kind === 'model' ? `${sidecar.model} via ${sourceName(sidecarProvider())}` : `${sidecar.name}${sidecar.profile.model ? ` (${sidecar.profile.model})` : ''}`;
        toastr.success(`${label} answered “${answer.trim().slice(0, 40)}” in ${seconds}s.`, 'AI sidecar works');
    } catch (error) {
        toastr.error(String(error?.cause?.message ?? error?.message ?? error), `AI sidecar (${sidecar.name}) failed`);
    }
}

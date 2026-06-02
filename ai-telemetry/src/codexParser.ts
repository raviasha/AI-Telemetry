import { buildEvent } from './metadata';
import { enqueue } from './logWriter';
import { classifyTask } from './classifier';
import * as path from 'path';

const INGESTION_START_MS = Date.now();
const INTERACTION_FINALIZE_IDLE_MS = 6000;

interface ToolCallState {
    id: string;
    name: string;
    startedAt: number | null;
    completedAt: number | null;
    success: boolean | null;
    argumentCharLength: number;
}

interface InteractionState {
    interactionNumber: number;
    userMessageTimestampMs: number;
    userMessageTimestampIso: string;
    userMessageEventId: string | null;
    prompt: string;
    attachmentsCount: number;
    attachmentTypes: string[];
    firstTurnStartTimestampMs: number | null;
    lastEventTimestampMs: number;
    assistantTurnsCount: number;
    responseCharLength: number;
    hasReasoning: boolean;
    reasoningCharLength: number;
    reasoningMessageCount: number;
    filesRead: string[];
    toolCalls: Map<string, ToolCallState>;
    toolCallSequence: number;
    turnId: string | null;
    idleMsSincePrevInteraction: number | null;
}

interface SessionState {
    sessionId: string;
    cliVersion: string;
    originator: string;
    cwd: string;
    modelProvider: string;
    interactionCount: number;
    lastInteractionEndTimestamp: number | null;
    currentInteraction: InteractionState | null;
    finalizeTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, SessionState>();

export function processCodexLine(filePath: string, rawLine: string): void {
    const line = rawLine.trim();
    if (!line) {
        return;
    }

    let event: {
        timestamp: string;
        type: string;
        payload?: Record<string, unknown>;
    };

    try {
        event = JSON.parse(line) as typeof event;
    } catch {
        return;
    }

    const eventTs = parseTimestamp(event.timestamp);
    if (eventTs < INGESTION_START_MS) {
        return;
    }

    const payload = event.payload && typeof event.payload === 'object'
        ? event.payload
        : {};

    let state = sessions.get(filePath);

    if (event.type === 'session_meta') {
        if (state) {
            finalizeInteraction(filePath, state);
        }

        const sessionId = asString(payload.id) ?? path.basename(filePath, '.jsonl');
        state = {
            sessionId,
            cliVersion: asString(payload.cli_version) ?? 'unknown',
            originator: asString(payload.originator) ?? 'codex',
            cwd: asString(payload.cwd) ?? 'unknown',
            modelProvider: asString(payload.model_provider) ?? 'unknown',
            interactionCount: 0,
            lastInteractionEndTimestamp: null,
            currentInteraction: null,
            finalizeTimer: null,
        };
        sessions.set(filePath, state);
        return;
    }

    state = state ?? initSessionFromFilePath(filePath);

    if (event.type === 'event_msg') {
        handleEventMsg(filePath, state, payload, eventTs);
        return;
    }

    if (event.type === 'response_item') {
        handleResponseItem(filePath, state, payload, eventTs, event.timestamp);
    }
}

export function clearCodexSession(filePath: string): void {
    const state = sessions.get(filePath);
    if (state) {
        finalizeInteraction(filePath, state);
        clearFinalizeTimer(state);
    }
    sessions.delete(filePath);
}

function handleEventMsg(filePath: string, state: SessionState, payload: Record<string, unknown>, eventTs: number): void {
    const eventType = asString(payload.type);
    if (!eventType) {
        return;
    }

    if (eventType === 'task_started') {
        if (!state.currentInteraction) {
            return;
        }
        state.currentInteraction.assistantTurnsCount += 1;
        state.currentInteraction.lastEventTimestampMs = eventTs;

        const turnId = asString(payload.turn_id);
        if (turnId) {
            state.currentInteraction.turnId = turnId;
        }
        if (state.currentInteraction.firstTurnStartTimestampMs === null) {
            state.currentInteraction.firstTurnStartTimestampMs = eventTs;
        }
        scheduleFinalizeInteraction(filePath, state);
        return;
    }

    if (eventType === 'task_complete') {
        if (!state.currentInteraction) {
            return;
        }

        const turnId = asString(payload.turn_id);
        if (turnId) {
            state.currentInteraction.turnId = turnId;
        }

        const lastMessage = asString(payload.last_agent_message);
        if (lastMessage && state.currentInteraction.responseCharLength === 0) {
            state.currentInteraction.responseCharLength = lastMessage.length;
        }

        state.currentInteraction.lastEventTimestampMs = eventTs;
        finalizeInteraction(filePath, state);
    }
}

function handleResponseItem(
    filePath: string,
    state: SessionState,
    payload: Record<string, unknown>,
    eventTs: number,
    eventTimestampIso: string
): void {
    const payloadType = asString(payload.type);
    if (!payloadType) {
        return;
    }

    if (payloadType === 'user_message') {
        finalizeInteraction(filePath, state);

        const prompt = asString(payload.message) ?? '';
        const images = Array.isArray(payload.images) ? payload.images.length : 0;
        const localImages = Array.isArray(payload.local_images) ? payload.local_images.length : 0;
        const textElements = Array.isArray(payload.text_elements) ? payload.text_elements.length : 0;

        state.interactionCount += 1;
        state.currentInteraction = {
            interactionNumber: state.interactionCount,
            userMessageTimestampMs: eventTs,
            userMessageTimestampIso: eventTimestampIso,
            userMessageEventId: null,
            prompt,
            attachmentsCount: images + localImages + textElements,
            attachmentTypes: attachmentTypesFromPayload(payload),
            firstTurnStartTimestampMs: null,
            lastEventTimestampMs: eventTs,
            assistantTurnsCount: 0,
            responseCharLength: 0,
            hasReasoning: false,
            reasoningCharLength: 0,
            reasoningMessageCount: 0,
            filesRead: [],
            toolCalls: new Map<string, ToolCallState>(),
            toolCallSequence: 0,
            turnId: null,
            idleMsSincePrevInteraction: state.lastInteractionEndTimestamp === null
                ? null
                : Math.max(eventTs - state.lastInteractionEndTimestamp, 0),
        };

        clearFinalizeTimer(state);
        scheduleFinalizeInteraction(filePath, state);
        return;
    }

    const interaction = state.currentInteraction;
    if (!interaction) {
        return;
    }

    interaction.lastEventTimestampMs = eventTs;

    if (payloadType === 'message') {
        const role = asString(payload.role);
        if (role === 'assistant') {
            interaction.responseCharLength += extractTextLength(payload.content);
        }
        scheduleFinalizeInteraction(filePath, state);
        return;
    }

    if (payloadType === 'agent_message') {
        const msg = asString(payload.message) ?? '';
        interaction.responseCharLength += msg.length;
        scheduleFinalizeInteraction(filePath, state);
        return;
    }

    if (payloadType === 'reasoning') {
        interaction.hasReasoning = true;
        interaction.reasoningMessageCount += 1;
        interaction.reasoningCharLength += extractTextLength(payload.summary) + extractTextLength(payload.content);
        scheduleFinalizeInteraction(filePath, state);
        return;
    }

    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
        const callId = asString(payload.call_id) ?? `codex_tool_${interaction.toolCallSequence++}`;
        const name = asString(payload.name) ?? 'unknown_tool';
        const call = ensureToolCall(interaction.toolCalls, callId, name);
        call.startedAt = eventTs;

        const rawArgs = payloadType === 'function_call' ? payload.arguments : payload.input;
        call.argumentCharLength = Math.max(call.argumentCharLength, getArgumentCharLength(rawArgs));
        const args = parseToolArguments(rawArgs);
        if (args !== undefined) {
            interaction.filesRead.push(...extractFilePathsFromArgs(args));
        }

        const status = asString(payload.status);
        if (status === 'completed') {
            call.completedAt = eventTs;
            call.success = true;
        }

        scheduleFinalizeInteraction(filePath, state);
        return;
    }

    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
        const callId = asString(payload.call_id);
        if (!callId) {
            return;
        }

        const call = ensureToolCall(interaction.toolCalls, callId, 'unknown_tool');
        call.completedAt = eventTs;
        const out = payload.output;
        call.success = inferToolSuccess(out);
        if (typeof out === 'string') {
            interaction.filesRead.push(...extractFilePathsFromArgs(out));
        }

        scheduleFinalizeInteraction(filePath, state);
        return;
    }

    if (payloadType === 'token_count') {
        scheduleFinalizeInteraction(filePath, state);
    }
}

function finalizeInteraction(filePath: string, state: SessionState): void {
    clearFinalizeTimer(state);

    const interaction = state.currentInteraction;
    if (!interaction) {
        return;
    }

    if (interaction.prompt.length === 0 && interaction.assistantTurnsCount === 0) {
        state.currentInteraction = null;
        return;
    }

    const toolCalls = Array.from(interaction.toolCalls.values());
    const toolNamesAll = toolCalls.map(c => c.name).filter(Boolean);
    const toolNames = dedupeAndSort(toolNamesAll);
    const toolBreakdown = countBy(toolNamesAll);

    const toolSuccessCount = toolCalls.filter(c => c.success === true).length;
    const toolFailureCount = toolCalls.filter(c => c.success === false).length;

    const toolLatencies = toolCalls
        .filter(c => c.startedAt !== null && c.completedAt !== null)
        .map(c => Math.max((c.completedAt as number) - (c.startedAt as number), 0));
    const toolLatencyMsTotal = toolLatencies.reduce((sum, n) => sum + n, 0);
    const toolLatencyMsAvg = toolLatencies.length > 0
        ? Math.round(toolLatencyMsTotal / toolLatencies.length)
        : 0;

    const toolArgumentCharLengthTotal = toolCalls.reduce((sum, c) => sum + c.argumentCharLength, 0);

    const latencyMs = Math.max(interaction.lastEventTimestampMs - interaction.userMessageTimestampMs, 0);
    const interactionKey = buildInteractionKey(state.sessionId, interaction);

    enqueue(buildEvent({
        interactionKey,
        source: 'codex',
        assistantClient: 'codex',
        assistantName: 'codex',
        workspacePath: state.cwd,
        sessionId: state.sessionId,
        copilotVersion: state.cliVersion,
        vscodeVersion: 'unknown',
        sessionProducer: state.originator,
        sessionSchemaVersion: 1,
        interactionNumber: interaction.interactionNumber,
        assistantTurnsCount: interaction.assistantTurnsCount,
        userMessageEventId: interaction.userMessageEventId,
        userMessageTimestamp: interaction.userMessageTimestampIso,
        firstTurnStartTimestamp: interaction.firstTurnStartTimestampMs
            ? new Date(interaction.firstTurnStartTimestampMs).toISOString()
            : null,
        lastTurnEndTimestamp: new Date(interaction.lastEventTimestampMs).toISOString(),
        promptCharLength: interaction.prompt.length,
        responseCharLength: interaction.responseCharLength,
        contextFilesCount: interaction.attachmentsCount,
        attachmentTypes: interaction.attachmentTypes,
        toolCallsCount: toolCalls.length,
        toolNames,
        toolBreakdown,
        toolSuccessCount,
        toolFailureCount,
        toolLatencyMsTotal,
        toolLatencyMsAvg,
        toolArgumentCharLengthTotal,
        filesRead: dedupeAndSort(interaction.filesRead),
        taskType: classifyTask(interaction.prompt),
        latencyMs,
        idleMsSincePrevInteraction: interaction.idleMsSincePrevInteraction,
        hasReasoning: interaction.hasReasoning,
        reasoningCharLength: interaction.reasoningCharLength,
        reasoningMessageCount: interaction.reasoningMessageCount,
        timestamp: new Date(interaction.lastEventTimestampMs).toISOString(),
    }));

    state.lastInteractionEndTimestamp = interaction.lastEventTimestampMs;
    state.currentInteraction = null;
    sessions.set(filePath, state);
}

function scheduleFinalizeInteraction(filePath: string, state: SessionState): void {
    clearFinalizeTimer(state);
    state.finalizeTimer = setTimeout(() => {
        finalizeInteraction(filePath, state);
    }, INTERACTION_FINALIZE_IDLE_MS);
}

function clearFinalizeTimer(state: SessionState): void {
    if (state.finalizeTimer) {
        clearTimeout(state.finalizeTimer);
        state.finalizeTimer = null;
    }
}

function initSessionFromFilePath(filePath: string): SessionState {
    const state: SessionState = {
        sessionId: path.basename(filePath, '.jsonl'),
        cliVersion: 'unknown',
        originator: 'codex',
        cwd: 'unknown',
        modelProvider: 'unknown',
        interactionCount: 0,
        lastInteractionEndTimestamp: null,
        currentInteraction: null,
        finalizeTimer: null,
    };
    sessions.set(filePath, state);
    return state;
}

function ensureToolCall(map: Map<string, ToolCallState>, id: string, name: string): ToolCallState {
    const existing = map.get(id);
    if (existing) {
        if (existing.name === 'unknown_tool' && name) {
            existing.name = name;
        }
        return existing;
    }

    const created: ToolCallState = {
        id,
        name: name || 'unknown_tool',
        startedAt: null,
        completedAt: null,
        success: null,
        argumentCharLength: 0,
    };
    map.set(id, created);
    return created;
}

function parseTimestamp(value: string): number {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : Date.now();
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function extractTextLength(value: unknown): number {
    if (typeof value === 'string') {
        return value.length;
    }
    if (Array.isArray(value)) {
        return value.reduce((sum, item) => sum + extractTextLength(item), 0);
    }
    if (value && typeof value === 'object') {
        let total = 0;
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (k === 'text' || k === 'message' || k === 'content') {
                total += extractTextLength(v);
            }
        }
        return total;
    }
    return 0;
}

function parseToolArguments(raw: unknown): unknown {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    }
    return raw;
}

function getArgumentCharLength(raw: unknown): number {
    if (raw === undefined || raw === null) {
        return 0;
    }
    if (typeof raw === 'string') {
        return raw.length;
    }
    try {
        return JSON.stringify(raw).length;
    } catch {
        return 0;
    }
}

function inferToolSuccess(output: unknown): boolean | null {
    if (typeof output !== 'string') {
        return null;
    }

    try {
        const parsed = JSON.parse(output) as { metadata?: { exit_code?: number } };
        if (parsed.metadata && typeof parsed.metadata.exit_code === 'number') {
            return parsed.metadata.exit_code === 0;
        }
    } catch {
        // not json
    }

    if (output.toLowerCase().includes('error')) {
        return false;
    }
    if (output.toLowerCase().includes('success')) {
        return true;
    }
    return null;
}

function extractFilePathsFromArgs(args: unknown): string[] {
    const out: string[] = [];

    const visit = (value: unknown): void => {
        if (typeof value === 'string') {
            const direct = value.match(/\/[A-Za-z0-9._\-\/ ]+/g) ?? [];
            for (const entry of direct) {
                const trimmed = entry.trim();
                if (trimmed.length > 1 && trimmed.startsWith('/')) {
                    out.push(trimmed);
                }
            }
            const patch = value.match(/\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+([^\n]+)/g) ?? [];
            for (const line of patch) {
                const idx = line.indexOf('File:');
                if (idx >= 0) {
                    const fp = line.slice(idx + 5).trim();
                    if (fp.startsWith('/')) {
                        out.push(fp);
                    }
                }
            }
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item);
            }
            return;
        }

        if (value && typeof value === 'object') {
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                if ((k === 'filePath' || k === 'path' || k === 'uri' || k === 'workspaceFolder' || k === 'cwd') && typeof v === 'string') {
                    if (v.startsWith('/')) {
                        out.push(v);
                    }
                }
                visit(v);
            }
        }
    };

    visit(args);
    return dedupeAndSort(out);
}

function attachmentTypesFromPayload(payload: Record<string, unknown>): string[] {
    const types: string[] = [];
    if (Array.isArray(payload.images) && payload.images.length > 0) {
        types.push('images');
    }
    if (Array.isArray(payload.local_images) && payload.local_images.length > 0) {
        types.push('local_images');
    }
    if (Array.isArray(payload.text_elements) && payload.text_elements.length > 0) {
        types.push('text_elements');
    }
    return dedupeAndSort(types);
}

function dedupeAndSort(values: string[]): string[] {
    return Array.from(new Set(values.map(v => v.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function countBy(values: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const v of values) {
        counts[v] = (counts[v] ?? 0) + 1;
    }
    return counts;
}

function buildInteractionKey(sessionId: string, interaction: InteractionState): string {
    const userKey = interaction.userMessageEventId
        ?? interaction.turnId
        ?? `${interaction.userMessageTimestampIso}:${interaction.prompt.length}`;
    return `${sessionId}:${userKey}`;
}

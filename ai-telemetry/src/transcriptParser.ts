import { buildEvent } from './metadata';
import { enqueue } from './logWriter';
import { classifyTask } from './classifier';
import * as path from 'path';

export type AssistantClient = 'vscode' | 'cursor' | 'codex' | 'unknown';

// Only ingest events that happen after this extension instance starts.
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

interface TurnState {
    startTimestamp: number;
    lastActivityTimestamp: number;
    responseCharLength: number;
    toolCallSequence: number;
    toolCalls: Map<string, ToolCallState>;
    filesRead: string[];
    hasReasoning: boolean;
    reasoningCharLength: number;
    reasoningMessageCount: number;
}

interface InteractionState {
    interactionNumber: number;
    userMessageEventId: string | null;
    userMessageTimestampMs: number;
    userMessageTimestampIso: string;
    idleMsSincePrevInteraction: number | null;
    prompt: string;
    attachments: unknown[];
    assistantTurnsCount: number;
    firstTurnStartTimestampMs: number | null;
    lastTurnEndTimestampMs: number | null;
    responseCharLength: number;
    filesRead: string[];
    toolCalls: Map<string, ToolCallState>;
    toolCallSequence: number;
    hasReasoning: boolean;
    reasoningCharLength: number;
    reasoningMessageCount: number;
}

interface SessionState {
    assistantClient: AssistantClient;
    sessionId: string;
    copilotVersion: string;
    vscodeVersion: string;
    producer: string;
    sessionSchemaVersion: number;
    interactionCount: number;
    lastInteractionEndTimestamp: number | null;
    currentTurn: TurnState | null;
    currentInteraction: InteractionState | null;
    finalizeTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, SessionState>();

export function processLine(filePath: string, rawLine: string, clientHint: AssistantClient = 'unknown'): void {
    const line = rawLine.trim();
    if (!line) {
        return;
    }

    let event: {
        type: string;
        data: Record<string, unknown>;
        timestamp: string;
        id?: string;
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

    let state = sessions.get(filePath);

    switch (event.type) {
        case 'session.start': {
            const d = event.data as {
                sessionId: string;
                copilotVersion?: string;
                vscodeVersion?: string;
                producer?: string;
                version?: number;
            };

            // Finalize any in-memory interaction before replacing state.
            if (state) {
                finalizeInteraction(filePath, state);
            }

            sessions.set(filePath, {
                assistantClient: normalizeAssistantClient(clientHint, d.producer),
                sessionId: d.sessionId ?? path.basename(filePath, '.jsonl'),
                copilotVersion: d.copilotVersion ?? 'unknown',
                vscodeVersion: d.vscodeVersion ?? 'unknown',
                producer: d.producer ?? 'unknown',
                sessionSchemaVersion: typeof d.version === 'number' ? d.version : 0,
                interactionCount: 0,
                lastInteractionEndTimestamp: null,
                currentTurn: null,
                currentInteraction: null,
                finalizeTimer: null,
            });
            break;
        }

        case 'user.message': {
            state = state ?? initSessionFromFilePath(filePath, clientHint);

            // New user message starts a new interaction; close prior interaction.
            finalizeInteraction(filePath, state);

            const d = event.data as { content?: string; attachments?: unknown[] };
            const attachments = Array.isArray(d.attachments) ? d.attachments : [];
            const prompt = typeof d.content === 'string' ? d.content : '';

            state.interactionCount += 1;
            state.currentInteraction = {
                interactionNumber: state.interactionCount,
                userMessageEventId: event.id ?? null,
                userMessageTimestampMs: eventTs,
                userMessageTimestampIso: event.timestamp,
                idleMsSincePrevInteraction: state.lastInteractionEndTimestamp === null
                    ? null
                    : Math.max(eventTs - state.lastInteractionEndTimestamp, 0),
                prompt,
                attachments,
                assistantTurnsCount: 0,
                firstTurnStartTimestampMs: null,
                lastTurnEndTimestampMs: null,
                responseCharLength: 0,
                filesRead: [],
                toolCalls: new Map<string, ToolCallState>(),
                toolCallSequence: 0,
                hasReasoning: false,
                reasoningCharLength: 0,
                reasoningMessageCount: 0,
            };
            state.currentTurn = null;
            clearFinalizeTimer(state);
            break;
        }

        case 'assistant.turn_start': {
            state = state ?? initSessionFromFilePath(filePath, clientHint);
            if (!state.currentInteraction) {
                // Ignore autonomous turns that are not linked to a user message.
                return;
            }

            state.currentTurn = {
                startTimestamp: eventTs,
                lastActivityTimestamp: eventTs,
                responseCharLength: 0,
                toolCallSequence: 0,
                toolCalls: new Map<string, ToolCallState>(),
                filesRead: [],
                hasReasoning: false,
                reasoningCharLength: 0,
                reasoningMessageCount: 0,
            };

            if (state.currentInteraction.firstTurnStartTimestampMs === null) {
                state.currentInteraction.firstTurnStartTimestampMs = eventTs;
            }

            clearFinalizeTimer(state);
            // Some providers may delay or omit further turn events.
            // Start an idle-based finalize timer immediately at turn start.
            scheduleFinalizeInteraction(filePath, state);
            break;
        }

        case 'assistant.message': {
            state = state ?? initSessionFromFilePath(filePath, clientHint);
            const turn = state.currentTurn;
            if (!turn || !state.currentInteraction) {
                return;
            }

            const d = event.data as {
                content?: string;
                toolRequests?: Array<{ toolCallId?: string; name: string; arguments?: unknown }>;
                reasoningText?: string;
            };

            if (typeof d.content === 'string') {
                turn.responseCharLength += d.content.length;
            }
            turn.lastActivityTimestamp = eventTs;

            if (typeof d.reasoningText === 'string' && d.reasoningText.length > 0) {
                turn.hasReasoning = true;
                turn.reasoningCharLength += d.reasoningText.length;
                turn.reasoningMessageCount += 1;
            }

            if (Array.isArray(d.toolRequests)) {
                for (const req of d.toolRequests) {
                    const id = req.toolCallId ?? `assistant_tool_${turn.toolCallSequence++}`;
                    const call = ensureToolCall(turn.toolCalls, id, req.name);
                    const args = parseToolArguments(req.arguments);
                    call.argumentCharLength = Math.max(call.argumentCharLength, getArgumentCharLength(req.arguments));
                    if (args !== undefined) {
                        turn.filesRead.push(...extractFilePathsFromArgs(args));
                    }
                }
            }

            // Some transcript streams omit assistant.turn_end; finalize on idle.
            scheduleFinalizeInteraction(filePath, state);
            break;
        }

        case 'tool.execution_start': {
            state = state ?? initSessionFromFilePath(filePath, clientHint);
            const turn = state.currentTurn;
            if (!turn || !state.currentInteraction) {
                return;
            }

            const d = event.data as { toolCallId?: string; toolName?: string; arguments?: unknown };
            const id = d.toolCallId ?? `execution_tool_${turn.toolCallSequence++}`;
            const name = d.toolName ?? 'unknown_tool';
            const call = ensureToolCall(turn.toolCalls, id, name);
            call.startedAt = eventTs;
            turn.lastActivityTimestamp = eventTs;
            call.argumentCharLength = Math.max(call.argumentCharLength, getArgumentCharLength(d.arguments));

            const args = parseToolArguments(d.arguments);
            if (args !== undefined) {
                turn.filesRead.push(...extractFilePathsFromArgs(args));
            }
            break;
        }

        case 'tool.execution_complete': {
            state = state ?? initSessionFromFilePath(filePath, clientHint);
            const turn = state.currentTurn;
            if (!turn || !state.currentInteraction) {
                return;
            }

            const d = event.data as { toolCallId?: string; success?: boolean };
            if (!d.toolCallId) {
                return;
            }
            const call = ensureToolCall(turn.toolCalls, d.toolCallId, 'unknown_tool');
            call.completedAt = eventTs;
            turn.lastActivityTimestamp = eventTs;
            if (typeof d.success === 'boolean') {
                call.success = d.success;
            }
            break;
        }

        case 'assistant.turn_end': {
            state = state ?? initSessionFromFilePath(filePath, clientHint);
            if (!state.currentInteraction || !state.currentTurn) {
                return;
            }

            mergeTurnIntoInteraction(state.currentInteraction, state.currentTurn, eventTs);
            state.currentTurn = null;
            scheduleFinalizeInteraction(filePath, state);
            break;
        }
    }
}

export function clearSession(filePath: string): void {
    const state = sessions.get(filePath);
    if (state) {
        finalizeInteraction(filePath, state);
        clearFinalizeTimer(state);
    }
    sessions.delete(filePath);
}

function initSessionFromFilePath(filePath: string, clientHint: AssistantClient = 'unknown'): SessionState {
    const state: SessionState = {
        assistantClient: clientHint,
        sessionId: path.basename(filePath, '.jsonl'),
        copilotVersion: 'unknown',
        vscodeVersion: 'unknown',
        producer: 'unknown',
        sessionSchemaVersion: 0,
        interactionCount: 0,
        lastInteractionEndTimestamp: null,
        currentTurn: null,
        currentInteraction: null,
        finalizeTimer: null,
    };
    sessions.set(filePath, state);
    return state;
}

function mergeTurnIntoInteraction(interaction: InteractionState, turn: TurnState, turnEndTs: number): void {
    interaction.assistantTurnsCount += 1;
    interaction.responseCharLength += turn.responseCharLength;
    interaction.filesRead.push(...turn.filesRead);
    interaction.hasReasoning = interaction.hasReasoning || turn.hasReasoning;
    interaction.reasoningCharLength += turn.reasoningCharLength;
    interaction.reasoningMessageCount += turn.reasoningMessageCount;
    interaction.lastTurnEndTimestampMs = turnEndTs;

    for (const [id, call] of turn.toolCalls.entries()) {
        const existing = interaction.toolCalls.get(id);
        if (!existing) {
            interaction.toolCalls.set(id, { ...call });
            continue;
        }

        existing.name = existing.name === 'unknown_tool' ? call.name : existing.name;
        existing.startedAt = pickMin(existing.startedAt, call.startedAt);
        existing.completedAt = pickMax(existing.completedAt, call.completedAt);
        existing.success = call.success !== null ? call.success : existing.success;
        existing.argumentCharLength = Math.max(existing.argumentCharLength, call.argumentCharLength);
    }
}

function finalizeInteraction(filePath: string, state: SessionState): void {
    clearFinalizeTimer(state);

    const interaction = state.currentInteraction;
    if (!interaction) {
        return;
    }

    // Fallback path: if turn_end never arrives, merge in-flight turn on idle.
    if (state.currentTurn) {
        mergeTurnIntoInteraction(interaction, state.currentTurn, state.currentTurn.lastActivityTimestamp);
        state.currentTurn = null;
    }

    // Drop interactions that have no user prompt and no assistant turns.
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

    const lastTurnEnd = interaction.lastTurnEndTimestampMs ?? interaction.userMessageTimestampMs;
    const latencyMs = Math.max(lastTurnEnd - interaction.userMessageTimestampMs, 0);

    enqueue(buildEvent({
        interactionKey: buildInteractionKey(state.sessionId, interaction),
        source: 'copilot',
        assistantClient: state.assistantClient,
        assistantName: inferAssistantName(state.producer),
        sessionId: state.sessionId,
        copilotVersion: state.copilotVersion,
        vscodeVersion: state.vscodeVersion,
        sessionProducer: state.producer,
        sessionSchemaVersion: state.sessionSchemaVersion,
        interactionNumber: interaction.interactionNumber,
        assistantTurnsCount: interaction.assistantTurnsCount,
        userMessageEventId: interaction.userMessageEventId,
        userMessageTimestamp: interaction.userMessageTimestampIso,
        firstTurnStartTimestamp: interaction.firstTurnStartTimestampMs
            ? new Date(interaction.firstTurnStartTimestampMs).toISOString()
            : null,
        lastTurnEndTimestamp: new Date(lastTurnEnd).toISOString(),
        promptCharLength: interaction.prompt.length,
        responseCharLength: interaction.responseCharLength,
        contextFilesCount: interaction.attachments.length,
        attachmentTypes: summarizeAttachmentTypes(interaction.attachments),
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
        timestamp: new Date(lastTurnEnd).toISOString(),
    }));

    state.lastInteractionEndTimestamp = lastTurnEnd;
    state.currentInteraction = null;

    // Preserve current session state in map.
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
                if ((k === 'filePath' || k === 'path' || k === 'uri' || k === 'workspaceFolder') && typeof v === 'string') {
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

function summarizeAttachmentTypes(attachments: unknown[]): string[] {
    const types: string[] = [];
    for (const item of attachments) {
        if (item === null || item === undefined) {
            continue;
        }
        if (typeof item !== 'object') {
            types.push(typeof item);
            continue;
        }
        const obj = item as Record<string, unknown>;
        if (typeof obj.type === 'string' && obj.type.trim()) {
            types.push(obj.type.trim());
        } else if (typeof obj.kind === 'string' && obj.kind.trim()) {
            types.push(obj.kind.trim());
        } else if (typeof obj.variableName === 'string' && obj.variableName.trim()) {
            types.push('variable');
        } else if (typeof obj.uri === 'string' && obj.uri.trim()) {
            types.push('uri');
        } else {
            types.push('object');
        }
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

function pickMin(a: number | null, b: number | null): number | null {
    if (a === null) {
        return b;
    }
    if (b === null) {
        return a;
    }
    return Math.min(a, b);
}

function pickMax(a: number | null, b: number | null): number | null {
    if (a === null) {
        return b;
    }
    if (b === null) {
        return a;
    }
    return Math.max(a, b);
}

function buildInteractionKey(sessionId: string, interaction: InteractionState): string {
    const userKey = interaction.userMessageEventId
        ?? `${interaction.userMessageTimestampIso}:${interaction.prompt.length}`;
    return `${sessionId}:${userKey}`;
}

function normalizeAssistantClient(clientHint: AssistantClient, producer?: string): AssistantClient {
    if (clientHint !== 'unknown') {
        return clientHint;
    }
    const p = (producer ?? '').toLowerCase();
    if (p.includes('cursor')) {
        return 'cursor';
    }
    if (p.includes('vscode') || p.includes('code') || p.includes('copilot')) {
        return 'vscode';
    }
    return 'unknown';
}

function inferAssistantName(producer: string): string {
    const p = producer.toLowerCase();
    if (p && p !== 'unknown') {
        return p;
    }
    return 'github_copilot_chat';
}

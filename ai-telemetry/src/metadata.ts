import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface TelemetryEvent {
    schema_version: string;
    event_id: string;
    interaction_key: string;
    source: 'copilot' | 'codex';
    assistant_client: 'vscode' | 'cursor' | 'codex' | 'unknown';
    assistant_name: string;
    timestamp: string;
    session_id: string;
    workspace_id: string;
    workspace_path: string;
    copilot_version: string;
    vscode_version: string;
    session_producer: string;
    session_schema_version: number;
    interaction_number: number;
    assistant_turns_count: number;
    user_message_event_id: string | null;
    user_message_timestamp: string;
    first_turn_start_timestamp: string | null;
    last_turn_end_timestamp: string;
    prompt_char_length: number;
    estimated_input_tokens: number;
    response_char_length: number;
    estimated_output_tokens: number;
    context_files_count: number;
    attachment_types: string[];
    tool_calls_count: number;
    tool_names: string[];
    tool_breakdown: Record<string, number>;
    tool_success_count: number;
    tool_failure_count: number;
    tool_latency_ms_total: number;
    tool_latency_ms_avg: number;
    tool_argument_char_length_total: number;
    files_read: string[];
    task_type: string;
    latency_ms: number;
    idle_ms_since_prev_interaction: number | null;
    has_reasoning: boolean;
    reasoning_char_length: number;
    reasoning_message_count: number;
}

export interface BuildEventParams {
    interactionKey: string;
    source: 'copilot' | 'codex';
    assistantClient: 'vscode' | 'cursor' | 'codex' | 'unknown';
    assistantName: string;
    workspacePath?: string;
    sessionId: string;
    copilotVersion: string;
    vscodeVersion: string;
    sessionProducer: string;
    sessionSchemaVersion: number;
    interactionNumber: number;
    assistantTurnsCount: number;
    userMessageEventId: string | null;
    userMessageTimestamp: string;
    firstTurnStartTimestamp: string | null;
    lastTurnEndTimestamp: string;
    promptCharLength: number;
    responseCharLength: number;
    contextFilesCount: number;
    attachmentTypes: string[];
    toolCallsCount: number;
    toolNames: string[];
    toolBreakdown: Record<string, number>;
    toolSuccessCount: number;
    toolFailureCount: number;
    toolLatencyMsTotal: number;
    toolLatencyMsAvg: number;
    toolArgumentCharLengthTotal: number;
    filesRead: string[];
    taskType: string;
    latencyMs: number;
    idleMsSincePrevInteraction: number | null;
    hasReasoning: boolean;
    reasoningCharLength: number;
    reasoningMessageCount: number;
    timestamp: string;
}

export function buildEvent(params: BuildEventParams): TelemetryEvent {
    const workspacePath = params.workspacePath ?? getWorkspacePath();

    return {
        schema_version: '4.0',
        event_id: crypto.randomUUID(),
        interaction_key: params.interactionKey,
        source: params.source,
        assistant_client: params.assistantClient,
        assistant_name: params.assistantName,
        timestamp: params.timestamp,
        session_id: params.sessionId,
        workspace_id: getWorkspaceId(workspacePath),
        workspace_path: workspacePath,
        copilot_version: params.copilotVersion,
        vscode_version: params.vscodeVersion,
        session_producer: params.sessionProducer,
        session_schema_version: params.sessionSchemaVersion,
        interaction_number: params.interactionNumber,
        assistant_turns_count: params.assistantTurnsCount,
        user_message_event_id: params.userMessageEventId,
        user_message_timestamp: params.userMessageTimestamp,
        first_turn_start_timestamp: params.firstTurnStartTimestamp,
        last_turn_end_timestamp: params.lastTurnEndTimestamp,
        prompt_char_length: params.promptCharLength,
        estimated_input_tokens: Math.ceil(params.promptCharLength / 4),
        response_char_length: params.responseCharLength,
        estimated_output_tokens: Math.ceil(params.responseCharLength / 4),
        context_files_count: params.contextFilesCount,
        attachment_types: params.attachmentTypes,
        tool_calls_count: params.toolCallsCount,
        tool_names: params.toolNames,
        tool_breakdown: params.toolBreakdown,
        tool_success_count: params.toolSuccessCount,
        tool_failure_count: params.toolFailureCount,
        tool_latency_ms_total: params.toolLatencyMsTotal,
        tool_latency_ms_avg: params.toolLatencyMsAvg,
        tool_argument_char_length_total: params.toolArgumentCharLengthTotal,
        files_read: params.filesRead,
        task_type: params.taskType,
        latency_ms: params.latencyMs,
        idle_ms_since_prev_interaction: params.idleMsSincePrevInteraction,
        has_reasoning: params.hasReasoning,
        reasoning_char_length: params.reasoningCharLength,
        reasoning_message_count: params.reasoningMessageCount,
    };
}

function getWorkspacePath(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : 'unknown';
}

function getWorkspaceId(workspacePath: string): string {
    if (workspacePath === 'unknown' || !workspacePath) {
        return 'no-workspace';
    }
    return crypto
        .createHash('sha256')
        .update(workspacePath)
        .digest('hex')
        .slice(0, 12);
}

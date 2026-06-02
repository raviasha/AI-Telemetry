import * as crypto from 'crypto';
import { BuildEventParams, TelemetryEvent } from './types';

export function buildEvent(params: BuildEventParams): TelemetryEvent {
    const workspacePath = params.workspacePath ?? 'unknown';

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

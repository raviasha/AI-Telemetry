import * as fs from 'fs';
import * as path from 'path';

interface TelemetryEvent {
    source?: string;
    assistant_client?: string;
    assistant_name?: string;
    task_type?: string;
    schema_version?: string;
    timestamp?: string;
    latency_ms?: number;
    tool_success_count?: number;
    tool_failure_count?: number;
    estimated_input_tokens?: number;
    estimated_output_tokens?: number;
}

interface InsightsStats {
    filesScanned: number;
    totalEvents: number;
    malformedLines: number;
    recent24h: number;
    lastTimestamp: string;
    latencyCount: number;
    latencyTotalMs: number;
    inputTokensTotal: number;
    outputTokensTotal: number;
    toolSuccessTotal: number;
    toolFailureTotal: number;
    bySource: Record<string, number>;
    byAssistantClient: Record<string, number>;
    byTaskType: Record<string, number>;
    bySchema: Record<string, number>;
}

const DEFAULT_MAX_FILES = 14;

export async function buildInsightsMarkdown(logRoot: string, maxFiles = DEFAULT_MAX_FILES): Promise<string> {
    const files = await listLogFiles(logRoot, maxFiles);
    const stats = await buildStats(files);

    const lines: string[] = [];
    lines.push('# AI Telemetry Insights');
    lines.push('');
    lines.push(`- Generated at: ${new Date().toISOString()}`);
    lines.push(`- Log root: ${logRoot}`);
    lines.push(`- Files scanned: ${stats.filesScanned}`);
    lines.push(`- Total events: ${stats.totalEvents}`);
    lines.push(`- Recent events (24h): ${stats.recent24h}`);
    lines.push(`- Last event timestamp: ${stats.lastTimestamp || 'n/a'}`);
    lines.push(`- Malformed lines: ${stats.malformedLines}`);
    lines.push('');

    lines.push('## Core Metrics');
    lines.push('');
    lines.push(`- Avg latency (ms): ${formatNumber(avg(stats.latencyTotalMs, stats.latencyCount))}`);
    lines.push(`- Tool success total: ${stats.toolSuccessTotal}`);
    lines.push(`- Tool failure total: ${stats.toolFailureTotal}`);
    lines.push(`- Estimated input tokens total: ${stats.inputTokensTotal}`);
    lines.push(`- Estimated output tokens total: ${stats.outputTokensTotal}`);
    lines.push('');

    lines.push('## Events by Source');
    lines.push('');
    lines.push(...toBulletLines(stats.bySource));
    lines.push('');

    lines.push('## Events by Assistant Client');
    lines.push('');
    lines.push(...toBulletLines(stats.byAssistantClient));
    lines.push('');

    lines.push('## Events by Task Type');
    lines.push('');
    lines.push(...toBulletLines(stats.byTaskType));
    lines.push('');

    lines.push('## Events by Schema');
    lines.push('');
    lines.push(...toBulletLines(stats.bySchema));

    return lines.join('\n');
}

async function listLogFiles(logRoot: string, maxFiles: number): Promise<string[]> {
    const out: string[] = [];

    const walk = async (dir: string): Promise<void> => {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        await Promise.all(entries.map(async (entry) => {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                return;
            }
            if (entry.isFile() && /^ai-telemetry-v4-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) {
                out.push(fullPath);
            }
        }));
    };

    await walk(logRoot);
    out.sort((a, b) => a.localeCompare(b));
    return out.slice(-Math.max(1, maxFiles));
}

async function buildStats(files: string[]): Promise<InsightsStats> {
    const stats: InsightsStats = {
        filesScanned: files.length,
        totalEvents: 0,
        malformedLines: 0,
        recent24h: 0,
        lastTimestamp: '',
        latencyCount: 0,
        latencyTotalMs: 0,
        inputTokensTotal: 0,
        outputTokensTotal: 0,
        toolSuccessTotal: 0,
        toolFailureTotal: 0,
        bySource: {},
        byAssistantClient: {},
        byTaskType: {},
        bySchema: {}
    };

    const now = Date.now();
    const last24hMs = 24 * 60 * 60 * 1000;

    for (const filePath of files) {
        let raw = '';
        try {
            raw = await fs.promises.readFile(filePath, 'utf8');
        } catch {
            continue;
        }

        for (const line of raw.split('\n')) {
            if (!line.trim()) {
                continue;
            }

            let event: TelemetryEvent;
            try {
                event = JSON.parse(line) as TelemetryEvent;
            } catch {
                stats.malformedLines += 1;
                continue;
            }

            stats.totalEvents += 1;

            increment(stats.bySource, event.source ?? 'unknown');
            increment(stats.byAssistantClient, event.assistant_client ?? 'unknown');
            increment(stats.byTaskType, event.task_type ?? 'unknown');
            increment(stats.bySchema, event.schema_version ?? 'missing');

            if (typeof event.latency_ms === 'number' && Number.isFinite(event.latency_ms)) {
                stats.latencyCount += 1;
                stats.latencyTotalMs += event.latency_ms;
            }

            if (typeof event.tool_success_count === 'number') {
                stats.toolSuccessTotal += event.tool_success_count;
            }
            if (typeof event.tool_failure_count === 'number') {
                stats.toolFailureTotal += event.tool_failure_count;
            }
            if (typeof event.estimated_input_tokens === 'number') {
                stats.inputTokensTotal += event.estimated_input_tokens;
            }
            if (typeof event.estimated_output_tokens === 'number') {
                stats.outputTokensTotal += event.estimated_output_tokens;
            }

            if (typeof event.timestamp === 'string') {
                const ts = Date.parse(event.timestamp);
                if (Number.isFinite(ts)) {
                    const iso = new Date(ts).toISOString();
                    if (!stats.lastTimestamp || iso > stats.lastTimestamp) {
                        stats.lastTimestamp = iso;
                    }
                    if ((now - ts) <= last24hMs) {
                        stats.recent24h += 1;
                    }
                }
            }
        }
    }

    return stats;
}

function increment(bucket: Record<string, number>, key: string): void {
    bucket[key] = (bucket[key] ?? 0) + 1;
}

function toBulletLines(map: Record<string, number>): string[] {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (entries.length === 0) {
        return ['- none'];
    }
    return entries.map(([key, value]) => `- ${key}: ${value}`);
}

function avg(total: number, count: number): number {
    if (count <= 0) {
        return 0;
    }
    return total / count;
}

function formatNumber(value: number): string {
    if (!Number.isFinite(value)) {
        return '0';
    }
    return value.toFixed(1);
}
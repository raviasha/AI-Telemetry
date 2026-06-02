import * as fs from 'fs';
import * as path from 'path';
import { getLogPath } from './config';
import { TelemetryEvent } from './metadata';

const queue: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const FLUSH_INTERVAL_MS = 5_000;
const BATCH_SIZE = 50;
const TARGET_SCHEMA_VERSION = '4.0';

export function enqueue(event: TelemetryEvent): void {
    // Protect downstream consumers from mixed-schema output.
    if (event.schema_version !== TARGET_SCHEMA_VERSION) {
        return;
    }

    queue.push(event);
    if (queue.length >= BATCH_SIZE) {
        scheduleFlush(0);
    } else {
        scheduleFlush(FLUSH_INTERVAL_MS);
    }
}

export async function flush(): Promise<void> {
    if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (queue.length === 0) {
        return;
    }

    const batch = queue.splice(0, queue.length);
    const logDir = getLogPath();

    try {
        await fs.promises.mkdir(logDir, { recursive: true });
        const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const filePath = path.join(logDir, `ai-telemetry-v4-${date}.jsonl`);

        const existingKeys = await loadExistingInteractionKeys(filePath);
        const deduped = batch.filter(event => !existingKeys.has(toDedupKey(event.source, event.interaction_key)));

        if (deduped.length === 0) {
            return;
        }

        const lines = deduped.map(event => JSON.stringify(event)).join('\n') + '\n';
        await fs.promises.appendFile(filePath, lines, 'utf8');
    } catch {
        // Logging failures must never surface to the user or crash the extension.
        // Events are already drained from the queue; they are silently discarded.
    }
}

async function loadExistingInteractionKeys(filePath: string): Promise<Set<string>> {
    const keys = new Set<string>();
    try {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const lines = raw.split('\n');
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            try {
                const parsed = JSON.parse(line) as Partial<TelemetryEvent>;
                if (typeof parsed.interaction_key === 'string' && parsed.interaction_key.length > 0) {
                    const source = typeof parsed.source === 'string' ? parsed.source : 'unknown';
                    keys.add(toDedupKey(source, parsed.interaction_key));
                }
            } catch {
                // Ignore malformed lines.
            }
        }
    } catch {
        // File does not exist yet.
    }
    return keys;
}

function scheduleFlush(delayMs: number): void {
    if (flushTimer !== null) {
        clearTimeout(flushTimer);
    }
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
    }, delayMs);
}

function toDedupKey(source: string, interactionKey: string): string {
    return `${source}:${interactionKey}`;
}

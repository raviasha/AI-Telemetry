import * as os from 'os';
import * as path from 'path';

export type LogMode = 'shared' | 'separate';

export function getLogMode(): LogMode {
    const raw = (process.env.AI_TELEMETRY_LOG_MODE ?? '').trim().toLowerCase();
    return raw === 'separate' ? 'separate' : 'shared';
}

export function getLogPathBase(): string {
    const configured = (process.env.AI_TELEMETRY_LOG_PATH ?? '').trim();
    if (configured) {
        return configured;
    }
    return path.join(os.homedir(), '.ai-telemetry', 'logs');
}

export function getLogPathForSource(source: 'copilot' | 'codex'): string {
    const base = getLogPathBase();
    if (getLogMode() === 'separate') {
        return path.join(base, source);
    }
    return base;
}

export function getPollIntervalMs(): number {
    const raw = Number.parseInt(process.env.CODEX_TELEMETRY_POLL_MS ?? '', 10);
    if (Number.isFinite(raw) && raw >= 500) {
        return raw;
    }
    return 2000;
}

export function getCodexSessionRoot(): string {
    const configured = (process.env.CODEX_SESSION_ROOT ?? '').trim();
    if (configured) {
        return configured;
    }
    return path.join(os.homedir(), '.codex', 'sessions');
}

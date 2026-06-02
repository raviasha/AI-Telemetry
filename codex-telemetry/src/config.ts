import * as fs from 'fs';
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

    const roots = getDefaultCodexSessionRootCandidates();
    for (const candidate of roots) {
        try {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        } catch {
            // Ignore invalid/inaccessible paths.
        }
    }

    // Keep legacy default behavior if no candidate path exists yet.
    return roots[0];
}

export function getCodexSessionRoots(): string[] {
    const configured = (process.env.CODEX_SESSION_ROOT ?? '').trim();
    if (configured) {
        return [configured];
    }

    const unique = new Set<string>();
    for (const candidate of getDefaultCodexSessionRootCandidates()) {
        unique.add(candidate);
    }

    return Array.from(unique);
}

function getDefaultCodexSessionRootCandidates(): string[] {
    const home = os.homedir();
    const xdgDataHome = (process.env.XDG_DATA_HOME ?? '').trim();

    const candidates = [
        path.join(home, '.codex', 'sessions'),
        path.join(home, 'Library', 'Application Support', 'Codex', 'sessions'),
        path.join(home, 'Library', 'Application Support', 'com.openai.codex', 'sessions'),
        path.join(home, 'Library', 'Application Support', 'com.openai.codex-desktop', 'sessions')
    ];

    if (xdgDataHome) {
        candidates.push(path.join(xdgDataHome, 'codex', 'sessions'));
    }

    return candidates;
}

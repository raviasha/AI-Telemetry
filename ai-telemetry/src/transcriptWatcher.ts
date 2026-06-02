import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { processLine, clearSession, type AssistantClient } from './transcriptParser';
import { processCodexLine, clearCodexSession } from './codexParser';

// Tracks how many bytes of each transcript file we have already processed.
const fileOffsets = new Map<string, number>();

let pollTimer: ReturnType<typeof setInterval> | undefined;

const POLL_INTERVAL_MS = 2000;

function getCodexSessionRoots(): string[] {
    const configured = (process.env.CODEX_SESSION_ROOT ?? '').trim();
    if (configured) {
        return [configured];
    }

    const home = os.homedir();
    const xdgDataHome = (process.env.XDG_DATA_HOME ?? '').trim();
    const roots = [
        path.join(home, '.codex', 'sessions'),
        path.join(home, 'Library', 'Application Support', 'Codex', 'sessions'),
        path.join(home, 'Library', 'Application Support', 'com.openai.codex', 'sessions'),
        path.join(home, 'Library', 'Application Support', 'com.openai.codex-desktop', 'sessions')
    ];

    if (xdgDataHome) {
        roots.push(path.join(xdgDataHome, 'codex', 'sessions'));
    }

    return Array.from(new Set(roots));
}

// Discover known workspaceStorage roots for supported editors.
function getWorkspaceStorageBases(): string[] {
    const home = os.homedir();
    const platform = process.platform;

    if (platform === 'darwin') {
        return [
            path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
            path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage'),
        ];
    }

    if (platform === 'win32') {
        const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
        return [
            path.join(appData, 'Code', 'User', 'workspaceStorage'),
            path.join(appData, 'Cursor', 'User', 'workspaceStorage'),
        ];
    }

    // Linux
    return [
        path.join(home, '.config', 'Code', 'User', 'workspaceStorage'),
        path.join(home, '.config', 'Cursor', 'User', 'workspaceStorage'),
    ];
}

export async function startWatching(context: vscode.ExtensionContext): Promise<void> {
    const knownFiles = await listSourceFiles();
    const newest = await getNewestFile(knownFiles);
    if (newest) {
        fileOffsets.set(newest.filePath, newest.size);
    }

    // Polling is more reliable than FS watchers for external directories.
    pollTimer = setInterval(() => {
        void pollTranscripts();
    }, POLL_INTERVAL_MS);

    // Ensure timer is cleaned up with extension lifecycle.
    context.subscriptions.push({ dispose: () => stopWatching() });
}

export function stopWatching(): void {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
    }
    fileOffsets.clear();
}

async function pollTranscripts(): Promise<void> {
    const currentFiles = await listSourceFiles();
    const currentSet = new Set(currentFiles);

    // Clean up deleted files.
    for (const trackedPath of Array.from(fileOffsets.keys())) {
        if (!currentSet.has(trackedPath)) {
            fileOffsets.delete(trackedPath);
            clearSession(trackedPath);
            clearCodexSession(trackedPath);
        }
    }

    // Tail all known files, including newly created ones.
    await Promise.all(currentFiles.map(filePath => tailFile(filePath)));
}

async function listSourceFiles(): Promise<string[]> {
    const all: string[] = [];

    for (const base of getWorkspaceStorageBases()) {
        try {
            const entries = await fs.promises.readdir(base);
            await Promise.all(entries.map(async entry => {
                const transcriptDir = path.join(base, entry, 'GitHub.copilot-chat', 'transcripts');
                try {
                    const files = await fs.promises.readdir(transcriptDir);
                    for (const file of files) {
                        if (file.endsWith('.jsonl')) {
                            all.push(path.join(transcriptDir, file));
                        }
                    }
                } catch {
                    // Workspace may not have Copilot transcripts yet.
                }
            }));
        } catch {
            // Editor storage root may not exist on this machine.
        }
    }

    const codexRoots = getCodexSessionRoots();
    const codexFilesByRoot = await Promise.all(codexRoots.map(async root => listJsonlRecursively(root)));
    for (const files of codexFilesByRoot) {
        all.push(...files);
    }

    return Array.from(new Set(all));
}

async function listJsonlRecursively(root: string): Promise<string[]> {
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
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                out.push(fullPath);
            }
        }));
    };

    await walk(root);
    return out;
}

async function getNewestFile(filePaths: string[]): Promise<{ filePath: string; size: number } | null> {
    let newest: { filePath: string; mtimeMs: number; size: number } | null = null;
    for (const filePath of filePaths) {
        try {
            const st = await fs.promises.stat(filePath);
            if (!newest || st.mtimeMs > newest.mtimeMs) {
                newest = { filePath, mtimeMs: st.mtimeMs, size: st.size };
            }
        } catch {
            // File may disappear while scanning.
        }
    }
    return newest ? { filePath: newest.filePath, size: newest.size } : null;
}

async function tailFile(filePath: string): Promise<void> {
    try {
        const stat = await fs.promises.stat(filePath);
        const offset = fileOffsets.get(filePath) ?? 0;

        if (stat.size <= offset) {
            return;
        }

        const length = stat.size - offset;
        const buffer = Buffer.allocUnsafe(length);
        const fh = await fs.promises.open(filePath, 'r');
        try {
            await fh.read(buffer, 0, length, offset);
        } finally {
            await fh.close();
        }

        const newContent = buffer.toString('utf8');
        for (const line of newContent.split('\n')) {
            if (isCodexSessionFile(filePath)) {
                processCodexLine(filePath, line);
            } else {
                processLine(filePath, line, detectAssistantClient(filePath));
            }
        }

        fileOffsets.set(filePath, stat.size);
    } catch { /* file deleted mid-read — ignore */ }
}

function isCodexSessionFile(filePath: string): boolean {
    const normalizedFilePath = path.resolve(filePath);
    return getCodexSessionRoots().some((root) => {
        const normalizedRoot = path.resolve(root);
        return normalizedFilePath === normalizedRoot || normalizedFilePath.startsWith(`${normalizedRoot}${path.sep}`);
    });
}

function detectAssistantClient(filePath: string): AssistantClient {
    if (filePath.includes(`${path.sep}Cursor${path.sep}`) || filePath.includes(`${path.sep}.config${path.sep}Cursor${path.sep}`)) {
        return 'cursor';
    }
    if (filePath.includes(`${path.sep}Code${path.sep}`) || filePath.includes(`${path.sep}.config${path.sep}Code${path.sep}`)) {
        return 'vscode';
    }
    return 'unknown';
}

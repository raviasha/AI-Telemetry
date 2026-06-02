import * as fs from 'fs';
import * as path from 'path';
import { getCodexSessionRoots, getPollIntervalMs } from './config';
import { clearCodexSession, processCodexLine } from './codexParser';

const fileOffsets = new Map<string, number>();
let pollTimer: ReturnType<typeof setInterval> | undefined;

export async function startWatching(): Promise<void> {
    const knownFiles = await listCodexFiles();
    const newest = await getNewestFile(knownFiles);
    if (newest) {
        fileOffsets.set(newest.filePath, newest.size);
    }

    pollTimer = setInterval(() => {
        void pollCodexSessions();
    }, getPollIntervalMs());
}

export function stopWatching(): void {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
    }
    fileOffsets.clear();
}

async function pollCodexSessions(): Promise<void> {
    const currentFiles = await listCodexFiles();
    const currentSet = new Set(currentFiles);

    for (const trackedPath of Array.from(fileOffsets.keys())) {
        if (!currentSet.has(trackedPath)) {
            fileOffsets.delete(trackedPath);
            clearCodexSession(trackedPath);
        }
    }

    await Promise.all(currentFiles.map(filePath => tailFile(filePath)));
}

async function listCodexFiles(): Promise<string[]> {
    const out = new Set<string>();
    const roots = getCodexSessionRoots();

    const byRoot = await Promise.all(roots.map(async root => listJsonlRecursively(root)));
    for (const paths of byRoot) {
        for (const filePath of paths) {
            out.add(filePath);
        }
    }

    return Array.from(out);
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
            // The file may disappear during scan.
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
            processCodexLine(filePath, line);
        }

        fileOffsets.set(filePath, stat.size);
    } catch {
        // Ignore deleted/locked files and continue polling.
    }
}

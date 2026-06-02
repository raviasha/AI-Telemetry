import * as vscode from 'vscode';
import { startWatching, stopWatching } from './transcriptWatcher';
import { flush } from './logWriter';
import { getLogPath } from './config';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    await startWatching(context);

    const openLogsCmd = vscode.commands.registerCommand('aiTelemetry.openLogs', async () => {
        const logPath = getLogPath();
        const fs = await import('fs');
        await fs.promises.mkdir(logPath, { recursive: true });
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logPath));
    });

    context.subscriptions.push(openLogsCmd);
}

export async function deactivate(): Promise<void> {
    stopWatching();
    await flush();
}

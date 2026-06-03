import * as vscode from 'vscode';
import { startWatching, stopWatching } from './transcriptWatcher';
import { flush } from './logWriter';
import { getLogPath } from './config';
import { buildInsightsMarkdown } from './insights';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    await startWatching(context);

    const openLogsCmd = vscode.commands.registerCommand('aiTelemetry.openLogs', async () => {
        const logPath = getLogPath();
        const fs = await import('fs');
        await fs.promises.mkdir(logPath, { recursive: true });
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logPath));
    });

    const showInsightsCmd = vscode.commands.registerCommand('aiTelemetry.showInsights', async () => {
        try {
            // Flush in-memory events first so insights include very recent activity.
            await flush();

            const logPath = getLogPath();
            const markdown = await buildInsightsMarkdown(logPath);
            const doc = await vscode.workspace.openTextDocument({
                language: 'markdown',
                content: markdown
            });

            await vscode.window.showTextDocument(doc, {
                preview: false,
                viewColumn: vscode.ViewColumn.Beside
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            void vscode.window.showErrorMessage(`AI Telemetry: failed to generate insights (${message})`);
        }
    });

    context.subscriptions.push(openLogsCmd, showInsightsCmd);
}

export async function deactivate(): Promise<void> {
    stopWatching();
    await flush();
}

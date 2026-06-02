import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

export function isEnabled(): boolean {
    return vscode.workspace.getConfiguration('aiTelemetry').get<boolean>('enabled', true);
}

export function getLogPath(): string {
    const configured = vscode.workspace.getConfiguration('aiTelemetry').get<string>('logPath', '');
    if (configured && configured.trim()) {
        return configured.trim();
    }
    return path.join(os.homedir(), '.ai-telemetry', 'logs');
}

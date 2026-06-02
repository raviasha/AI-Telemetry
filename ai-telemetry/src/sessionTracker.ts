import * as crypto from 'crypto';

let currentSessionId: string | null = null;

/**
 * Returns the current session ID. Generates a new one when
 * historyLength is 0 (i.e. a fresh chat thread has started).
 */
export function getOrCreateSessionId(historyLength: number): string {
    if (historyLength === 0 || currentSessionId === null) {
        currentSessionId = crypto.randomUUID();
    }
    return currentSessionId;
}

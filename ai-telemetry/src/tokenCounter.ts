import * as vscode from 'vscode';

/**
 * Counts tokens for an array of messages using the model's local tokenizer.
 * countTokens accepts one message at a time — we sum across all messages.
 * This is a local operation — no API call, no token cost.
 * Falls back to a character-count estimate (chars / 4) if the API throws.
 */
export async function countTokens(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    token: vscode.CancellationToken
): Promise<number> {
    try {
        let total = 0;
        for (const msg of messages) {
            total += await model.countTokens(msg, token);
        }
        return total;
    } catch {
        return estimateFromChars(messages);
    }
}

/**
 * Counts tokens for a single string (used for output text).
 */
export async function countTextTokens(
    model: vscode.LanguageModelChat,
    text: string,
    token: vscode.CancellationToken
): Promise<number> {
    try {
        return await model.countTokens(vscode.LanguageModelChatMessage.Assistant(text), token);
    } catch {
        return Math.ceil(text.length / 4);
    }
}

function estimateFromChars(messages: vscode.LanguageModelChatMessage[]): number {
    let chars = 0;
    for (const msg of messages) {
        for (const part of msg.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                chars += part.value.length;
            }
        }
    }
    return Math.ceil(chars / 4);
}

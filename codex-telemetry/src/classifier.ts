const TASK_PATTERNS: Array<[RegExp, string]> = [
    [/\b(fix|bug|error|issue|broken|failing|crash|exception|wrong|incorrect|doesn'?t work|not working)\b/i, 'fix'],
    [/\b(test|spec|unit test|integration test|jest|mocha|vitest|pytest|coverage)\b/i, 'test'],
    [/\b(refactor|improve|clean up|optimize|simplify|reorganize|restructure|performance)\b/i, 'refactor'],
    [/\b(explain|what is|what does|why|how does|describe|understand|tell me|walk me through)\b/i, 'explain'],
    [/\b(write|create|implement|add|build|generate|make|new|scaffold)\b/i, 'write'],
];

export function classifyTask(prompt: string): string {
    for (const [pattern, label] of TASK_PATTERNS) {
        if (pattern.test(prompt)) {
            return label;
        }
    }
    return 'other';
}

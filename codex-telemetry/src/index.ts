import { flush } from './logWriter';
import { startWatching, stopWatching } from './watcher';

async function main(): Promise<void> {
    await startWatching();

    const shutdown = async (): Promise<void> => {
        stopWatching();
        await flush();
        process.exit(0);
    };

    process.on('SIGINT', () => {
        void shutdown();
    });

    process.on('SIGTERM', () => {
        void shutdown();
    });
}

void main();

/**
 * Return exec arguments that are valid when a worker loads a file.
 *
 * Node inherits the parent's `process.execArgv` for worker threads. The
 * `--input-type` flag is only valid for `--eval`, `--print`, or stdin, so a
 * worker loading a JavaScript file exits immediately when the parent was
 * started with `node --input-type=module -e ...`.
 */
export function getWorkerExecArgv(): string[] {
    const args: string[] = [];
    for (let index = 0; index < process.execArgv.length; index += 1) {
        const argument = process.execArgv[index];
        if (argument === '--input-type') {
            index += 1;
            continue;
        }
        if (argument.startsWith('--input-type=')) continue;
        args.push(argument);
    }
    return args;
}

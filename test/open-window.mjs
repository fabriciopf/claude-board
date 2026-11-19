// Runs a window opener the way relaunch does: spawns it and waits for it to exit.
// The test starts this file detached and with no console, which is how relaunch itself runs.
// node open-window.mjs <base64 of JSON { command, args, options }>
import { spawn } from 'node:child_process';

const { command, args, options } = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const child = spawn(command, args, options);
child.on('error', () => process.exit(1));
child.on('exit', (code) => process.exit(code ?? 1));

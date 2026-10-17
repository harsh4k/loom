import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  finish(code, output = '') {
    this.stdout.end(output);
    this.stderr.end();
    setImmediate(() => this.emit('close', code, null));
  }
}

export function fakeSpawn({ output = '', exitCode = 0, hang = false, killExitCode = 0, closeOnKill = true } = {}) {
  const calls = [];
  let commandChild;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (command.toLowerCase().includes('taskkill')) {
      const killer = new FakeChild(undefined);
      setImmediate(() => {
        killer.finish(killExitCode);
        if (closeOnKill) commandChild?.finish(1);
      });
      return killer;
    }
    commandChild = new FakeChild(4321);
    setImmediate(() => {
      commandChild.emit('spawn');
      if (!hang) commandChild.finish(exitCode, output);
    });
    return commandChild;
  };
  return { spawn, calls, getChild: () => commandChild };
}

import { type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { dumpStreamFromProcess } from './backup-service.js';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function fakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  const process = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill,
  }) as unknown as ChildProcess;
  return { process, stdout, stderr, kill };
}

describe('dumpStreamFromProcess', () => {
  it('rejects when stdout ends before pg_dump later exits non-zero', async () => {
    const child = fakeChild();
    let settled = false;
    const result = readAll(dumpStreamFromProcess(child.process)).finally(() => {
      settled = true;
    });
    const stdoutEnded = once(child.stdout, 'end');

    child.stdout.end(Buffer.from('partial'));
    await stdoutEnded;
    await nextEventLoopTurn();
    expect(settled).toBe(false);

    child.stderr.end(Buffer.from('fatal dump error'));
    await once(child.stderr, 'end');
    const rejection = expect(result).rejects.toThrow(/pg_dump exited 2.*fatal dump error/i);
    child.process.emit('close', 2);
    await rejection;
  });

  it('does not emit EOF before pg_dump closes successfully', async () => {
    const child = fakeChild();
    const output = dumpStreamFromProcess(child.process);
    let outputEnded = false;
    let settled = false;
    output.once('end', () => {
      outputEnded = true;
    });
    const result = readAll(output).finally(() => {
      settled = true;
    });
    const stdoutEnded = once(child.stdout, 'end');

    child.stdout.end(Buffer.from('complete'));
    await stdoutEnded;
    await nextEventLoopTurn();
    expect(outputEnded).toBe(false);
    expect(settled).toBe(false);

    child.process.emit('close', 0);
    await expect(result).resolves.toEqual(Buffer.from('complete'));
  });

  it('bounds stderr retained for the failure message', async () => {
    const child = fakeChild();
    const result = readAll(dumpStreamFromProcess(child.process));
    child.stderr.write(Buffer.alloc(8 * 1024, 0x61));
    child.stdout.end();
    child.process.emit('close', 1);
    await expect(result).rejects.toThrow(/^pg_dump exited 1: a{4096}$/);
  });

  it('cancels pg_dump exactly once when the returned stream is destroyed', async () => {
    const child = fakeChild();
    const output = dumpStreamFromProcess(child.process);
    const closed = once(output, 'close');

    output.destroy();
    output.destroy();
    await closed;
    output.destroy();
    await nextEventLoopTurn();

    expect(child.stdout.destroyed).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

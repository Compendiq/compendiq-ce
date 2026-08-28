import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { dumpStreamFromProcess } from './backup-service.js';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function fakeChild(): {
  process: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const process = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
  return { process, stdout, stderr };
}

describe('dumpStreamFromProcess', () => {
  it('rejects when stdout ends before pg_dump later exits non-zero', async () => {
    const child = fakeChild();
    const result = readAll(dumpStreamFromProcess(child.process));
    child.stdout.end(Buffer.from('partial'));
    child.process.emit('close', 2);
    child.stderr.end(Buffer.from('fatal dump error'));
    await expect(result).rejects.toThrow(/pg_dump exited 2.*fatal dump error/i);
  });

  it('does not emit EOF before pg_dump closes successfully', async () => {
    const child = fakeChild();
    let settled = false;
    const result = readAll(dumpStreamFromProcess(child.process)).finally(() => {
      settled = true;
    });
    child.stdout.end(Buffer.from('complete'));
    await Promise.resolve();
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
});

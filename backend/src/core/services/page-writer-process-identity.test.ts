import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  capturePageWriterDeploymentIdentity,
  verifyLocalPageWriterTermination,
  type PageWriterDeploymentIdentity,
} from './page-writer-process-identity.js';

describe('server-observed local writer termination', () => {
  it('never identifies the live owner or an old record without OS identity as terminated', async () => {
    const identity = await capturePageWriterDeploymentIdentity();
    expect(await verifyLocalPageWriterTermination(identity)).toBe(false);
    expect(await verifyLocalPageWriterTermination({
      host: identity.host, pid: identity.pid, startedAt: identity.startedAt,
    })).toBe(false);
  });

  it('proves an actual child exit only within its original boot and PID scope', async () => {
    const moduleUrl = new URL('./page-writer-process-identity.ts', import.meta.url).href;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { capturePageWriterDeploymentIdentity } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify(await capturePageWriterDeploymentIdentity()));
      process.stdin.resume();
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let diagnostics = '';
    child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString(); });
    const reported = new Promise<PageWriterDeploymentIdentity>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const newline = output.indexOf('\n');
        if (newline !== -1) {
          try { resolve(JSON.parse(output.slice(0, newline)) as PageWriterDeploymentIdentity); }
          catch (error) { reject(error); }
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => { reject(new Error(`Identity child exited ${code}: ${diagnostics}`)); });
    });
    try {
      const identity = await reported;
      if (process.platform !== 'linux' && process.platform !== 'darwin') {
        expect(identity.processProof).toBeNull();
        expect(await verifyLocalPageWriterTermination(identity)).toBe(false);
        return;
      }
      expect(identity.processProof, 'Supported host must expose a usable OS process identity').not.toBeNull();
      expect(await verifyLocalPageWriterTermination(identity)).toBe(false);
      child.kill('SIGTERM');
      await exited;
      expect(await verifyLocalPageWriterTermination(identity)).toBe(true);
      expect(await verifyLocalPageWriterTermination({ ...identity, processProof: null })).toBe(false);
      expect(await verifyLocalPageWriterTermination({
        ...identity, processProof: { ...identity.processProof, bootId: '00000000-0000-4000-8000-000000000001' },
      })).toBe(false);
      expect(await verifyLocalPageWriterTermination({
        ...identity, processProof: { ...identity.processProof, pidNamespace: 'a-different-pid-namespace' },
      })).toBe(false);
      expect(await verifyLocalPageWriterTermination({ ...identity, host: `${identity.host}-other-host` })).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }, 20000);
});

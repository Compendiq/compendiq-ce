import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const ProcessProofSchema = z.object({
  platform: z.enum(['linux', 'darwin']),
  bootId: z.string().uuid(),
  pidNamespace: z.string().min(1).max(100),
  startIdentity: z.string().min(1).max(100),
});
const DeploymentIdentitySchema = z.object({
  host: z.string().min(1).max(255),
  pid: z.number().int().positive().max(2_147_483_647),
  startedAt: z.string().datetime(),
  processProof: ProcessProofSchema.nullable(),
});
export type PageWriterDeploymentIdentity = z.infer<typeof DeploymentIdentitySchema>;
type ProcessProof = z.infer<typeof ProcessProofSchema>;
let ownIdentity: Promise<PageWriterDeploymentIdentity> | undefined;

/** These identifiers describe the local kernel's PID scope, not a hostname claim. */
async function localProcessScope(): Promise<Omit<ProcessProof, 'startIdentity'> | null> {
  if (process.platform === 'linux') {
    const [bootId, pidNamespace] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readlink('/proc/self/ns/pid'),
    ]);
    if (!/^pid:\[\d+\]$/.test(pidNamespace)) return null;
    return { platform: 'linux', bootId: bootId.trim().toLowerCase(), pidNamespace };
  }
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      timeout: 5000, maxBuffer: 4096, env: { LC_ALL: 'C', TZ: 'UTC' },
    });
    return { platform: 'darwin', bootId: stdout.trim().toLowerCase(), pidNamespace: 'darwin-host-pid-space' };
  }
  return null;
}

async function processStartIdentity(pid: number, platform: ProcessProof['platform']): Promise<string | null> {
  if (platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    if (Number(stat.slice(0, stat.indexOf(' '))) !== pid) return null;
    // comm may contain spaces and closing parentheses. Fields after its final ')'
    // start at field 3; starttime is field 22 (index 19 in the remaining fields).
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const start = stat.slice(end + 2).trim().split(/\s+/)[19];
    return start && /^\d+$/.test(start) ? start : null;
  }
  const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    timeout: 5000, maxBuffer: 4096, env: { LC_ALL: 'C', TZ: 'UTC' },
  });
  const start = stdout.trim();
  return start && !start.includes('\n') ? start : null;
}

/** Persist this server-observed identity when allocating a writer epoch. */
export function capturePageWriterDeploymentIdentity(): Promise<PageWriterDeploymentIdentity> {
  ownIdentity ??= (async () => {
    const identity: PageWriterDeploymentIdentity = {
      host: hostname(),
      pid: process.pid,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      processProof: null,
    };
    try {
      const scope = await localProcessScope();
      if (scope) {
        const startIdentity = await processStartIdentity(process.pid, scope.platform);
        const proof = ProcessProofSchema.safeParse({ ...scope, startIdentity });
        if (proof.success) identity.processProof = proof.data;
      }
    } catch {
      // Unsupported/hardened hosts retain owner-quiescence recovery. An unreadable
      // process identity is never evidence that another writer has terminated.
    }
    return identity;
  })();
  return ownIdentity;
}

/**
 * Accept only a deployment_identity loaded from the durable runtime row, never
 * HTTP-supplied proof. Different hosts/boots/PID namespaces and missing metadata
 * cannot establish local termination. In particular, /proc ENOENT alone is not
 * proof: hidepid can hide a live process, whereas signal 0 returns EPERM for it.
 * This proves process death, NOT termination of an already-dispatched remote
 * request; every started effect still requires its own terminal reconciliation.
 */
export async function verifyLocalPageWriterTermination(identity: unknown): Promise<boolean> {
  const parsed = DeploymentIdentitySchema.safeParse(identity);
  if (!parsed.success || !parsed.data.processProof) return false;
  const expected = parsed.data.processProof;
  try {
    const scope = await localProcessScope();
    if (!scope || scope.platform !== expected.platform || scope.bootId !== expected.bootId
      || scope.pidNamespace !== expected.pidNamespace || parsed.data.host !== hostname()) return false;
    try {
      process.kill(parsed.data.pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    const currentStart = await processStartIdentity(parsed.data.pid, scope.platform);
    // A reused PID is a different process. Coarse Darwin lstart can fail to
    // distinguish a reuse within one second, which safely leaves recovery busy.
    return currentStart !== null && currentStart !== expected.startIdentity;
  } catch {
    return false;
  }
}

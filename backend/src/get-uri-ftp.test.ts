import { afterEach, describe, expect, it } from 'vitest';
import { getUri } from 'get-uri';
import type { Readable } from 'node:stream';
import { FIXTURE_MODIFIED, mlsdFileLine, startFtpFixture, type FtpFixture, type FtpFixtureOptions } from './test-ftp-fixture.js';

/**
 * Drives the installed `get-uri` FTP path — what `@lhci/cli` → `proxy-agent` →
 * `pac-proxy-agent` calls to fetch a `pac+ftp://` PAC file — against a loopback
 * fixture. get-uri 6 pins `basic-ftp ^5`; the root `overrides` entry
 * `get-uri → basic-ftp 6.2.6` (GHSA-5pm8-86m8-9m6r) makes it run on 6.x.
 * Bounded timeouts, loopback only, no external network.
 */
const BODY = 'function FindProxyForURL() { return "DIRECT"; }\n';
const URL_PATH = '/dir/proxy.pac';

let fixture: FtpFixture | undefined;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

async function serve(options: Partial<FtpFixtureOptions>): Promise<string> {
  fixture = await startFtpFixture({ files: { [URL_PATH]: BODY }, ...options });
  return `ftp://127.0.0.1:${fixture.port}${URL_PATH}`;
}

async function read(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Give a stray rejection time to surface before afterEach asserts none. A real
 * delay is needed: Node reports unhandled rejections from a later tick, and
 * there is no promise to await for a rejection nobody is handling.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('get-uri FTP path on the overridden basic-ftp', () => {
  process.on('unhandledRejection', onUnhandled);

  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
    expect(unhandled).toEqual([]);
    unhandled.length = 0;
  });

  it('downloads a file when MDTM reports a modification time', async () => {
    const url = await serve({ mdtm: FIXTURE_MODIFIED });
    const stream = await getUri(url);
    expect(await read(stream)).toBe(BODY);
    expect(stream.lastModified).toEqual(new Date(Date.UTC(2024, 0, 2, 3, 4, 5)));
    expect(fixture!.commands.some((c) => c.startsWith('MLSD'))).toBe(false);
  }, 10_000);

  it('falls back to listing when MDTM gives no modification time', async () => {
    const url = await serve({ mlsd: [mlsdFileLine('proxy.pac', BODY.length)] });
    const stream = await getUri(url);
    expect(await read(stream)).toBe(BODY);
    expect(stream.lastModified).toEqual(new Date(Date.UTC(2024, 0, 2, 3, 4, 5)));
    expect(fixture!.commands.filter((c) => c.startsWith('MDTM'))).toHaveLength(1);
    expect(fixture!.commands).toContain('MLSD /dir');
  }, 10_000);

  it('ignores a __proto__ MLSD fact instead of failing the listing (GHSA-5pm8-86m8-9m6r)', async () => {
    // basic-ftp ≤ 6.2.3 threw "factHandler is not a function" for this line.
    const url = await serve({ mlsd: [mlsdFileLine('proxy.pac', BODY.length, '__proto__=x;')] });
    const stream = await getUri(url);
    expect(await read(stream)).toBe(BODY);
  }, 10_000);

  it('surfaces a malformed MLSD modify fact as a catchable rejection, not a crash', async () => {
    const url = await serve({ mlsd: [`type=file;size=5;modify=not-a-date; proxy.pac`] });
    await expect(getUri(url)).rejects.toBeInstanceOf(Error);
    await settle();
  }, 10_000);

  it('refuses a passive-mode reply that points the data connection at another host', async () => {
    // 192.0.2.1 is TEST-NET-1: the default basic-ftp 6 client rejects before
    // connecting; allowSeparateTransferHost is deliberately never set.
    const url = await serve({ pasvHost: '192.0.2.1', mlsd: [mlsdFileLine('proxy.pac', BODY.length)] });
    await expect(getUri(url)).rejects.toThrow(/another host \(192\.0\.2\.1\)/);
    await settle();
  }, 10_000);
});

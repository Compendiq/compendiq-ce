/**
 * A stand-in for the vision-language endpoint, for the image axis's own tests
 * (#1115 P5b).
 *
 * A helper module in `src/` rather than a copy inside each test file, the same
 * shape and for the same reason as `src/test-db-helper.ts`: two suites need it
 * (the seeder's and the runner's), and a duplicated stub is how the two start
 * disagreeing about what the endpoint answers.
 *
 * It is a real `node:http` server, so every request goes through
 * `vl-embedding-client.ts` for real — the queue, the per-provider breaker, the
 * `messages` body, the unit-norm check. Mocking `embedImagesVl` instead would
 * skip precisely the layer the intake depends on, which is the "mock at the
 * boundary (HTTP), never at the service-function layer" rule from CLAUDE.md.
 *
 * The vectors are deterministic and semantic-ish: each request is hashed to an
 * axis so that the same bytes always embed to the same place and two different
 * inputs land apart. Nothing here is a quality fixture — it exists so the
 * PLUMBING can be asserted without a VL model, exactly as the runner's topic
 * vectors do for the text leg.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface VlStubRequest {
  /** The parsed request body, so a test can assert the shape that was sent. */
  body: Record<string, unknown>;
  /** True when the user turn carried an `image_url` part. */
  isImage: boolean;
  /** The user turn's text, when it carried one. */
  text: string | null;
  /** The `data:` URI of the image part, so a test can steer one image's axis. */
  imageDataUrl: string | null;
}

export interface VlStubServer {
  /** Spelled with the `/v1`, exactly as a provider row is. */
  baseUrl: string;
  /** Every request this server answered, in order. */
  requests: VlStubRequest[];
  /** Requests that carried an image part. */
  imageRequests: () => VlStubRequest[];
  /** Requests that carried text only — the query embeds. */
  textRequests: () => VlStubRequest[];
  /** Width of the vectors it answers with. */
  dimensions: number;
  /**
   * Steer the next N answers. `failWith` makes the server answer that HTTP
   * status instead of a vector; `axisFor` overrides the hashing so a test can
   * put a specific query next to a specific image.
   */
  failWith: (status: number | null) => void;
  axisFor: (fn: ((req: VlStubRequest) => number) | null) => void;
  /**
   * Empty the request log and leave the steering alone.
   *
   * Separate from {@link VlStubServer.reset} because the two are wanted at
   * different moments: a suite that steers one image's axis has to arm the
   * steering BEFORE seeding and then forget the seed's requests, and a `reset`
   * there silently un-steered the run — every vector fell back to the default
   * hash and the "best image" assertion failed for a reason that looked like a
   * ranking bug.
   */
  clearRequests: () => void;
  reset: () => void;
  close: () => Promise<void>;
}

/** Deterministic unit vector: one axis lit, so two different axes are orthogonal. */
function unitVector(axis: number, dimensions: number): number[] {
  const v = Array.from({ length: dimensions }, () => 0);
  v[((axis % dimensions) + dimensions) % dimensions] = 1;
  return v;
}

function hashAxis(seed: string): number {
  return parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
}

function describe(body: Record<string, unknown>): VlStubRequest {
  const messages = (body.messages ?? []) as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const user = messages.find((m) => m.role === 'user');
  const parts = user?.content ?? [];
  const image = parts.find((p) => p.type === 'image_url');
  const text = parts.find((p) => p.type === 'text');
  const url = (image?.image_url as { url?: string } | undefined)?.url ?? null;
  return {
    body,
    isImage: image !== undefined,
    text: image ? null : ((text?.text as string | undefined) ?? null),
    imageDataUrl: url,
  };
}

/** Start a stub on an ephemeral loopback port. Always `await server.close()`. */
export async function startVlStubServer(opts: { dimensions?: number } = {}): Promise<VlStubServer> {
  const dimensions = opts.dimensions ?? 64;
  const requests: VlStubRequest[] = [];
  let failStatus: number | null = null;
  let axisOverride: ((req: VlStubRequest) => number) | null = null;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unparseable body' }));
        return;
      }
      const described = describe(parsed);
      requests.push(described);

      if (failStatus !== null) {
        res.writeHead(failStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub failure' }));
        return;
      }

      // The MRL parameter is honoured, because the probe refuses a server that
      // ignores it (`dimensions_ignored`) and the eval runs through that probe.
      const requested = typeof parsed.dimensions === 'number' ? parsed.dimensions : dimensions;
      const axis = axisOverride
        ? axisOverride(described)
        : hashAxis(described.isImage
          ? JSON.stringify(described.body.messages).slice(0, 4096)
          : (described.text ?? ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: unitVector(axis, requested) }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    dimensions,
    imageRequests: () => requests.filter((r) => r.isImage),
    textRequests: () => requests.filter((r) => !r.isImage),
    failWith: (status) => { failStatus = status; },
    axisFor: (fn) => { axisOverride = fn; },
    clearRequests: () => { requests.length = 0; },
    reset: () => { requests.length = 0; failStatus = null; axisOverride = null; },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

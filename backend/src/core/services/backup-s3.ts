/**
 * S3 / S3-compatible uploader for encrypted backups (#1420).
 *
 * Uses undici + SigV4 so the runtime image does not have to hoist the AWS SDK
 * tree. Parts are bounded (8 MiB) to stay inside the 1024m mem_limit.
 */

import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { request } from 'undici';
import {
  assertNonSsrfUrl,
  SsrfError,
  validateUrlSyntaxAndProtocol,
} from '../utils/ssrf-guard.js';

const PART_SIZE = 8 * 1024 * 1024;
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export class BackupS3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupS3Error';
  }
}

export interface S3Target {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  prefix: string;
  forcePathStyle: boolean;
}

export async function assertSafeS3Endpoint(endpoint: string): Promise<URL> {
  const url = validateUrlSyntaxAndProtocol(endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (METADATA_HOSTS.has(host) || host.startsWith('169.254.')) {
    throw new SsrfError('S3 endpoint points at a cloud metadata address');
  }
  await assertNonSsrfUrl(url.toString());
  return url;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function amzDate(now: Date): { amz: string; date: string } {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return { amz: iso, date: iso.slice(0, 8) };
}

function encodePath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => encodeURIComponent(seg).replaceAll("'", '%27'))
    .join('/');
}

function canonicalQuery(params: URLSearchParams): string {
  const items: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) {
    items.push([encodeURIComponent(k), encodeURIComponent(v)]);
  }
  items.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return items.map(([k, v]) => `${k}=${v}`).join('&');
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer | string;
}

function buildUrl(target: S3Target, key: string, query?: URLSearchParams): { url: URL; host: string; path: string } {
  const endpoint = new URL(target.endpoint);
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  if (target.forcePathStyle) {
    const path = `/${target.bucket}/${encodedKey}`.replace(/\/+$/, encodedKey ? `/${encodedKey}` : `/${target.bucket}`);
    const url = new URL(path.replace(/\/{2,}/g, '/'), endpoint);
    if (query) url.search = query.toString();
    return { url, host: endpoint.host, path: url.pathname };
  }
  const host = `${target.bucket}.${endpoint.host}`;
  const url = new URL(`/${encodedKey}`, `${endpoint.protocol}//${host}`);
  if (query) url.search = query.toString();
  return { url, host, path: url.pathname };
}

function sign(target: S3Target, method: string, host: string, path: string, query: URLSearchParams, body: Buffer | string | undefined, now = new Date()): Record<string, string> {
  const { amz, date } = amzDate(now);
  const payloadHash = body === undefined ? 'UNSIGNED-PAYLOAD' : sha256Hex(body);
  const headers: Record<string, string> = {
    host,
    'x-amz-date': amz,
    'x-amz-content-sha256': payloadHash,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    encodePath(path) || '/',
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${target.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amz,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const sig = createHmac('sha256', signingKey(target.secretKey, date, target.region))
    .update(stringToSign, 'utf8')
    .digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${target.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return headers;
}

async function s3Request(
  target: S3Target,
  method: string,
  key: string,
  query: URLSearchParams,
  body?: Buffer | string,
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const { url, host, path } = buildUrl(target, key, query);
  const headers = sign(target, method, host, path, query, body);
  if (body !== undefined) {
    headers['content-length'] = String(Buffer.byteLength(body));
    if (typeof body === 'string') headers['content-type'] = 'application/xml';
  }
  const res = await request(url.toString(), { method, headers, body });
  const text = await res.body.text();
  const hdrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (typeof v === 'string') hdrs[k.toLowerCase()] = v;
  }
  return { status: res.statusCode, headers: hdrs, text };
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function xmlText(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return match?.[1] ?? null;
}

function xmlAll(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]!);
}

export async function testS3Connection(target: S3Target): Promise<void> {
  await assertSafeS3Endpoint(target.endpoint);
  const query = new URLSearchParams({ 'list-type': '2', 'max-keys': '1' });
  const res = await s3Request(target, 'GET', '', query);
  if (res.status >= 400) {
    throw new BackupS3Error(`S3 test failed (${res.status}): ${res.text.slice(0, 300)}`);
  }
}

export interface UploadedObject {
  key: string;
  bytes: number;
}

export async function uploadBackupObject(
  target: S3Target,
  objectKey: string,
  body: Readable,
): Promise<UploadedObject> {
  await assertSafeS3Endpoint(target.endpoint);
  const create = await s3Request(
    target,
    'POST',
    objectKey,
    new URLSearchParams({ uploads: '' }),
    '',
  );
  const uploadId = xmlText(create.text, 'UploadId');
  if (create.status >= 400 || !uploadId) {
    throw new BackupS3Error(`CreateMultipartUpload failed (${create.status}): ${create.text.slice(0, 300)}`);
  }
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let partNumber = 1;
  let pending = Buffer.alloc(0);
  let bytes = 0;
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = Buffer.concat([pending, buf]);
      while (pending.length >= PART_SIZE) {
        const part = pending.subarray(0, PART_SIZE);
        pending = pending.subarray(PART_SIZE);
        await uploadPart(target, objectKey, uploadId, partNumber, part, parts);
        bytes += part.length;
        partNumber += 1;
      }
    }
    if (pending.length > 0 || parts.length === 0) {
      await uploadPart(target, objectKey, uploadId, partNumber, pending, parts);
      bytes += pending.length;
    }
    const completeXml =
      `<CompleteMultipartUpload>` +
      parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
        .join('') +
      `</CompleteMultipartUpload>`;
    const done = await s3Request(
      target,
      'POST',
      objectKey,
      new URLSearchParams({ uploadId }),
      completeXml,
    );
    if (done.status >= 400) {
      throw new BackupS3Error(`CompleteMultipartUpload failed (${done.status}): ${done.text.slice(0, 300)}`);
    }
    return { key: objectKey, bytes };
  } catch (err) {
    await s3Request(target, 'DELETE', objectKey, new URLSearchParams({ uploadId })).catch(() => undefined);
    throw err;
  }
}

async function uploadPart(
  target: S3Target,
  objectKey: string,
  uploadId: string,
  partNumber: number,
  part: Buffer,
  parts: Array<{ partNumber: number; etag: string }>,
): Promise<void> {
  const res = await s3Request(
    target,
    'PUT',
    objectKey,
    new URLSearchParams({ partNumber: String(partNumber), uploadId }),
    part,
  );
  const etag = res.headers.etag;
  if (res.status >= 400 || !etag) {
    throw new BackupS3Error(`UploadPart ${partNumber} failed (${res.status}): ${res.text.slice(0, 300)}`);
  }
  parts.push({ partNumber, etag });
}

export interface ListedObject {
  key: string;
  lastModified: Date;
  size: number;
}

export async function listBackupObjects(target: S3Target): Promise<ListedObject[]> {
  await assertSafeS3Endpoint(target.endpoint);
  const out: ListedObject[] = [];
  let token: string | undefined;
  do {
    const query = new URLSearchParams({ 'list-type': '2', prefix: target.prefix });
    if (token) query.set('continuation-token', token);
    const res = await s3Request(target, 'GET', '', query);
    if (res.status >= 400) {
      throw new BackupS3Error(`ListObjects failed (${res.status}): ${res.text.slice(0, 300)}`);
    }
    const keys = xmlAll(res.text, 'Key');
    const modified = xmlAll(res.text, 'LastModified');
    const sizes = xmlAll(res.text, 'Size');
    for (let i = 0; i < keys.length; i += 1) {
      out.push({
        key: keys[i]!,
        lastModified: new Date(modified[i] ?? 0),
        size: Number(sizes[i] ?? 0),
      });
    }
    const truncated = xmlText(res.text, 'IsTruncated') === 'true';
    token = truncated ? (xmlText(res.text, 'NextContinuationToken') ?? undefined) : undefined;
  } while (token);
  return out;
}

export async function deleteBackupObjects(target: S3Target, keys: string[]): Promise<void> {
  await assertSafeS3Endpoint(target.endpoint);
  if (keys.length === 0) return;
  const xml =
    `<Delete>` +
    keys.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('') +
    `</Delete>`;
  const res = await s3Request(target, 'POST', '', new URLSearchParams({ delete: '' }), xml);
  if (res.status >= 400) {
    throw new BackupS3Error(`DeleteObjects failed (${res.status}): ${res.text.slice(0, 300)}`);
  }
}

export async function pruneBackupObjects(
  target: S3Target,
  retentionCount: number,
  retentionDays: number,
  now = new Date(),
): Promise<string[]> {
  const objects = (await listBackupObjects(target))
    .filter((o) => o.key.endsWith('.enc'))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const stale = objects.filter((o, i) => i >= retentionCount || o.lastModified.getTime() < cutoff);
  await deleteBackupObjects(target, stale.map((o) => o.key));
  return stale.map((o) => o.key);
}

export function objectKeyFor(prefix: string, date = new Date()): string {
  const stamp = date.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const base = prefix.endsWith('/') || prefix === '' ? prefix : `${prefix}/`;
  return `${base}compendiq-backup-${stamp}.enc`;
}

export type { SignedRequest };

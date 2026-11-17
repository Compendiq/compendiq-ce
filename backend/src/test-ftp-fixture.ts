import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * Minimal in-process FTP server on loopback, built on plain `node:net` (no
 * dependency). It speaks just enough of RFC 959 / 2428 / 3659 for basic-ftp's
 * `Client.access()`, `lastMod()`, `list()` and `downloadTo()`, which is the path
 * `get-uri` (Lighthouse CI's `proxy-agent` stack) takes for an `ftp:` URL.
 * Used by `get-uri-ftp.test.ts`; behaviour is chosen per server via options.
 */
export interface FtpFixtureOptions {
  /** Control port; defaults to an ephemeral loopback port. */
  port?: number;
  /** Files served by RETR, keyed by absolute path. */
  files: Record<string, string>;
  /** Answer MDTM with this 14-digit timestamp; `undefined` answers 500 (unsupported). */
  mdtm?: string;
  /** Raw MLSD lines (without CRLF) returned for any MLSD request. */
  mlsd?: string[];
  /** IPv4 address advertised in the PASV reply; defaults to the loopback data server. */
  pasvHost?: string;
}

export interface FtpFixture {
  port: number;
  /** Every control-connection line the server received, in order. */
  commands: string[];
  close(): Promise<void>;
}

const MODIFIED = '20240102030405';

export async function startFtpFixture(options: FtpFixtureOptions): Promise<FtpFixture> {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const dataServers = new Set<Server>();

  const server = createServer((control) => {
    sockets.add(control);
    control.on('close', () => sockets.delete(control));
    control.on('error', () => control.destroy());

    let pendingData: Promise<Socket> | undefined;
    const reply = (line: string) => control.write(`${line}\r\n`);

    const openPassive = (): Promise<number> =>
      new Promise((resolve) => {
        const dataServer = createServer();
        dataServers.add(dataServer);
        pendingData = new Promise<Socket>((resolveSocket) => {
          dataServer.once('connection', (socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            socket.on('error', () => socket.destroy());
            resolveSocket(socket);
            dataServer.close();
          });
        });
        dataServer.listen(0, '127.0.0.1', () => resolve((dataServer.address() as AddressInfo).port));
      });

    const sendOverData = async (payload: string) => {
      reply('150 Opening data connection');
      const data = await pendingData!;
      pendingData = undefined;
      data.end(payload, () => reply('226 Transfer complete'));
    };

    const handle = async (line: string) => {
      const [verb = '', ...rest] = line.split(' ');
      const arg = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'USER':
          return reply('331 Password required');
        case 'PASS':
          return reply('230 Logged in');
        case 'FEAT':
          // MLST advertised so basic-ftp prefers MLSD for listings.
          return control.write('211-Features:\r\n MLST type*;size*;modify*;\r\n211 End\r\n');
        case 'OPTS':
        case 'TYPE':
          return reply('200 OK');
        case 'PWD':
          return reply('257 "/" is the current directory');
        case 'MDTM':
          if (options.mdtm === undefined) return reply('500 MDTM not supported');
          return reply(`213 ${options.mdtm}`);
        case 'EPSV':
          return reply('500 EPSV not supported');
        case 'PASV': {
          const port = await openPassive();
          const host = (options.pasvHost ?? '127.0.0.1').replaceAll('.', ',');
          return reply(`227 Entering Passive Mode (${host},${port >> 8},${port & 255})`);
        }
        case 'MLSD':
          return sendOverData((options.mlsd ?? []).map((l) => `${l}\r\n`).join(''));
        case 'LIST':
          return reply('500 LIST not supported');
        case 'RETR': {
          const body = options.files[arg];
          if (body === undefined) return reply('550 No such file');
          return sendOverData(body);
        }
        case 'QUIT':
          reply('221 Bye');
          return control.end();
        default:
          return reply('502 Command not implemented');
      }
    };

    let buffer = '';
    control.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let eol: number;
      while ((eol = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        commands.push(line);
        void handle(line).catch(() => control.destroy());
      }
    });
    reply('220 fixture ready');
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        for (const dataServer of dataServers) dataServer.close();
        server.close(() => resolve());
      }),
  };
}

/** MLSD line for a regular file, modified at the fixture's fixed timestamp. */
export function mlsdFileLine(name: string, size: number, extraFacts = ''): string {
  return `${extraFacts}type=file;size=${size};modify=${MODIFIED}; ${name}`;
}

export const FIXTURE_MODIFIED = MODIFIED;

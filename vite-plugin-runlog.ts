// A tiny middleware plugin that lets the browser persist run logs to a local `logs/` folder
// by riding the Vite dev/preview server that already exists — no new process, no database,
// no config. Identical handler under `npm run dev` and `npm run preview`. If this plugin
// isn't loaded (someone serves the prebuilt dist/ from a plain static server), the client's
// health probe fails and it falls back to the manual JSON download; nothing here is required.

import type { Plugin, Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

const LOGS_DIR = path.resolve(process.cwd(), 'logs');
const INDEX_FILE = path.join(LOGS_DIR, 'index.jsonl');
const MAX_BODY = 8 * 1024 * 1024; // 8 MB cap; a 60 s run is ~40 KB

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(text);
}

function slugify(s: string): string {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'anon';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Atomic write: temp file then rename, so a partial write never leaves a corrupt log.
function writeAtomic(file: string, text: string): void {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

interface RunLogShape {
  meta?: { runId?: string; startedAt?: string; mode?: string; machine?: { installId?: string; label?: string }; config?: unknown };
  summary?: unknown;
}

function handlePost(req: IncomingMessage, res: ServerResponse): void {
  readBody(req)
    .then((raw) => {
      let log: RunLogShape;
      try {
        log = JSON.parse(raw) as RunLogShape;
      } catch {
        return json(res, 400, { ok: false, reason: 'invalid JSON' });
      }
      const runId = log.meta?.runId;
      if (!runId || typeof runId !== 'string') {
        return json(res, 400, { ok: false, reason: 'missing meta.runId' });
      }
      fs.mkdirSync(LOGS_DIR, { recursive: true });

      const startedAt = log.meta?.startedAt ?? new Date().toISOString();
      const stamp = startedAt.replace(/:/g, '-').replace(/\..+$/, '');
      const label = slugify(log.meta?.machine?.label ?? '');
      const filename = `${stamp}_${label}_${runId.slice(0, 4)}.json`;
      const filepath = path.join(LOGS_DIR, filename);

      writeAtomic(filepath, raw);

      const indexRow = {
        runId,
        startedAt,
        mode: log.meta?.mode ?? 'scored',
        installId: log.meta?.machine?.installId ?? '',
        label: log.meta?.machine?.label ?? '',
        config: log.meta?.config ?? null,
        summary: log.summary ?? null,
        file: filename,
      };
      fs.appendFileSync(INDEX_FILE, JSON.stringify(indexRow) + '\n');

      return json(res, 200, { ok: true, path: `logs/${filename}` });
    })
    .catch((e: unknown) => json(res, 500, { ok: false, reason: e instanceof Error ? e.message : 'write failed' }));
}

function handleIndex(req: IncomingMessage, res: ServerResponse): void {
  let installId = '';
  try {
    const u = new URL(req.url ?? '', 'http://localhost');
    installId = u.searchParams.get('installId') ?? '';
  } catch {
    /* ignore */
  }
  const rows: Array<Record<string, unknown>> = [];
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const lines = fs.readFileSync(INDEX_FILE, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (!installId || row.installId === installId) rows.push(row);
        } catch {
          /* skip malformed line */
        }
      }
    }
  } catch {
    return json(res, 200, []);
  }
  json(res, 200, rows.slice(-50));
}

function attach(middlewares: Connect.Server): void {
  middlewares.use((req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.startsWith('/api/log/health')) return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.startsWith('/api/log/index')) return handleIndex(req, res);
    if (req.method === 'POST' && url.startsWith('/api/log')) return handlePost(req, res);
    next();
  });
}

export function runLogPlugin(): Plugin {
  return {
    name: 'brm-runlog',
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}

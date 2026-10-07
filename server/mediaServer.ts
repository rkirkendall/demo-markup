// Vite plugin: serves videos from a local folder and saves the edit spec next to them.
// Everything stays on this machine. Nothing is sent to a remote service.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};
export const SPEC_FILE = 'demo-markup.json';

function mediaDir() {
  return path.resolve(process.env.DEMO_MARKUP_DIR ?? path.join(process.cwd(), 'media'));
}

// Resolve a bare file name inside the media folder. Rejects anything that escapes it.
function safeFile(name: string) {
  const base = path.basename(name);
  if (!base || base !== name) return null;
  return path.join(mediaDir(), base);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function listMedia() {
  const dir = mediaDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()) && !f.startsWith('.'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, path: path.join(dir, f), size: st.size, modified: st.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function streamVideo(req: IncomingMessage, res: ServerResponse, file: string) {
  if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (m && !m[1] && m[2]) {
      start = size - parseInt(m[2], 10);
      end = size - 1;
    }
    if (start >= size || end >= size || start > end) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.statusCode = 200;
    res.setHeader('Content-Length', size);
    fs.createReadStream(file).pipe(res);
  }
}

export function mediaServer(): Plugin {
  return {
    name: 'demo-markup-media',
    configureServer(server) {
      // Tell the editor when something else (like an AI agent) changes the project file.
      let lastSeen = '';
      const specPathNow = () => path.join(mediaDir(), SPEC_FILE);
      const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
      let watchedPath = specPathNow();
      lastSeen = read(watchedPath);
      const timer = setInterval(() => {
        const p = specPathNow();
        const now = read(p);
        if (p !== watchedPath) {
          watchedPath = p;
          lastSeen = now;
          return;
        }
        if (now === lastSeen) return;
        lastSeen = now;
        try {
          JSON.parse(now);
        } catch {
          return; // mid-write; check again next tick
        }
        server.ws.send('demo-markup:project-changed', {});
      }, 700);
      server.httpServer?.on('close', () => clearInterval(timer));

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://local');
        try {
          if (url.pathname === '/api/info') {
            return json(res, 200, {
              dir: mediaDir(),
              specPath: path.join(mediaDir(), SPEC_FILE),
              appDir: server.config.root,
            });
          }
          if (url.pathname === '/api/media' && req.method === 'GET') {
            return json(res, 200, listMedia());
          }
          if (url.pathname.startsWith('/media/')) {
            const file = safeFile(decodeURIComponent(url.pathname.slice('/media/'.length)));
            if (!file) return json(res, 400, { error: 'bad name' });
            return streamVideo(req, res, file);
          }
          // Copy a video the user dropped into the browser into the media folder,
          // so the edit spec can point the agent at a real file path.
          if (url.pathname === '/api/import' && req.method === 'POST') {
            const name = url.searchParams.get('name') ?? '';
            const file = safeFile(name);
            if (!file || !VIDEO_EXT.has(path.extname(file).toLowerCase())) {
              return json(res, 400, { error: 'unsupported file' });
            }
            const size = Number(req.headers['content-length'] ?? -1);
            if (fs.existsSync(file) && fs.statSync(file).size === size) {
              req.resume();
              return json(res, 200, { name, path: file, existed: true });
            }
            const tmp = file + '.part';
            const out = fs.createWriteStream(tmp);
            req.pipe(out);
            out.on('finish', () => {
              fs.renameSync(tmp, file);
              json(res, 200, { name, path: file, existed: false });
            });
            out.on('error', (e) => json(res, 500, { error: String(e) }));
            return;
          }
          // Open a saved project: switch to the video folder it points at and make it the current project there.
          if (url.pathname === '/api/open' && req.method === 'POST') {
            const spec = JSON.parse(await readBody(req));
            const dir = typeof spec?.mediaDir === 'string' ? path.resolve(spec.mediaDir) : '';
            if (!spec?.editor?.clips || !dir) return json(res, 400, { error: 'Not a Demo Markup project file.' });
            if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
              return json(res, 404, { error: `Video folder not found: ${dir}` });
            }
            const specPath = path.join(dir, SPEC_FILE);
            const body = JSON.stringify(spec, null, 2);
            // Keep whatever was there before if its edits differ, in case the file being opened is older.
            if (fs.existsSync(specPath)) {
              const prev = fs.readFileSync(specPath, 'utf8');
              let same = false;
              try {
                same = JSON.stringify(JSON.parse(prev).editor) === JSON.stringify(spec.editor);
              } catch {}
              if (!same) fs.copyFileSync(specPath, path.join(dir, 'demo-markup.previous.json'));
            }
            fs.writeFileSync(specPath, body);
            process.env.DEMO_MARKUP_DIR = dir;
            watchedPath = specPath;
            lastSeen = body;
            const missing = [...new Set<string>(spec.editor.clips.map((c: { file: string }) => c.file))].filter(
              (f) => !fs.existsSync(path.join(dir, f)),
            );
            return json(res, 200, { dir, missing });
          }
          if (url.pathname === '/api/project') {
            const specPath = path.join(mediaDir(), SPEC_FILE);
            if (req.method === 'GET') {
              if (!fs.existsSync(specPath)) return json(res, 404, { error: 'none' });
              res.setHeader('Content-Type', 'application/json');
              return res.end(fs.readFileSync(specPath, 'utf8'));
            }
            if (req.method === 'PUT') {
              const body = await readBody(req);
              JSON.parse(body); // validate
              fs.writeFileSync(specPath, body);
              if (specPath === watchedPath) lastSeen = body;
              return json(res, 200, { ok: true, path: specPath });
            }
          }
        } catch (e) {
          return json(res, 500, { error: String(e) });
        }
        next();
      });
    },
  };
}

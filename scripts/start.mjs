#!/usr/bin/env node
// Usage: demo-markup [folder-with-videos] [--port 5173]
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const args = process.argv.slice(2);
let port = 5173;
let dir;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else dir = args[i];
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mediaDir = path.resolve(process.cwd(), dir ?? path.join(root, 'media'));
fs.mkdirSync(mediaDir, { recursive: true });
process.env.DEMO_MARKUP_DIR = mediaDir;

const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), server: { port } });
await server.listen();
console.log(`\n  Demo Markup is running.`);
console.log(`  Video folder: ${mediaDir}`);
server.printUrls();

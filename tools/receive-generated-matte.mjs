import http from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

const [, , outputArgument, portArgument = '4178'] = process.argv;

if (!outputArgument) {
  throw new Error('Usage: node receive-generated-matte.mjs <output> [port]');
}

const outputPath = path.resolve(outputArgument);
const port = Number(portArgument);

const server = http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }

  if (request.method !== 'POST' || request.url !== '/save') {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', async () => {
    try {
      const payload = Buffer.concat(chunks);
      const isWebm =
        payload.length > 100_000 &&
        payload[0] === 0x1a &&
        payload[1] === 0x45 &&
        payload[2] === 0xdf &&
        payload[3] === 0xa3;
      if (!isWebm) {
        throw new Error('Generated payload is not a valid WebM asset');
      }
      await writeFile(outputPath, payload);
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ outputPath, size: payload.length }));
      server.close();
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
});

server.listen(port, '127.0.0.1');

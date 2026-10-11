import net from 'node:net';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/** Reject even swallowed network attempts; installed only in the isolated test worker. */
export function forbidNetwork() {
  const fetchBefore = globalThis.fetch;
  const connectBefore = net.Socket.prototype.connect;
  const attempts: string[] = [];
  const reject = (kind: string): never => { attempts.push(kind); throw new Error(`产品回放禁止网络：${kind}`); };
  globalThis.fetch = async () => reject('fetch');
  net.Socket.prototype.connect = function () { return reject('socket'); } as typeof connectBefore;
  return {
    attempts,
    restore() { globalThis.fetch = fetchBefore; net.Socket.prototype.connect = connectBefore; },
  };
}

/** Decode PNG scanlines at the image-library boundary; production uses Electron nativeImage. */
export function pngSize(path: string) {
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  let width = 0, height = 0, channels = 0;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) return null;
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('回放 PNG 必须为非交错 8 位图像');
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[data[9]] ?? 0;
    }
    if (kind === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  if (!channels || !width || !height || !chunks.length) return null;
  const decoded = inflateSync(Buffer.concat(chunks));
  const stride = width * channels + 1;
  if (decoded.length !== stride * height) return null;
  for (let row = 0; row < height; row++) if (decoded[row * stride] > 4) return null;
  return { width, height };
}

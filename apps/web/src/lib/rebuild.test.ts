// @vitest-environment node
/// <reference types="node" />
import fs from 'node:fs';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import { prepareZXingModule } from 'zxing-wasm/reader';
import { beforeAll, describe, expect, it } from 'vitest';
import { crispCopy, enhanceVerified, type Decoder, type RawImage } from './enhance';
import { decodeIndependently, decodeQrCodes, locateIndependently } from './qr-decoder';
import { rebuildExact, type EcLevel, type ModuleGrid } from './rebuild';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs') as { PNG: { sync: { read(file: Buffer): { data: Buffer; width: number; height: number } } } };
const errorCorrectionCode = require('qrcode/lib/core/error-correction-code') as {
  getBlocksCount(version: number, level: unknown): number;
  getTotalCodewordsCount(version: number, level: unknown): number;
};
const errorCorrectionLevel = require('qrcode/lib/core/error-correction-level') as Record<EcLevel, unknown>;

class TestImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

beforeAll(() => {
  (globalThis as unknown as { ImageData: unknown }).ImageData = TestImageData;
  prepareZXingModule({
    overrides: { wasmBinary: fs.readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')).buffer as ArrayBuffer },
  });
});

function fixture(name: string): RawImage {
  const png = PNG.sync.read(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

type Matrix = { size: number; get(row: number, col: number): number | boolean };

function gridFrom(matrix: Matrix, extra: Partial<ModuleGrid> = {}): ModuleGrid {
  const dark = new Uint8Array(matrix.size * matrix.size);
  for (let row = 0; row < matrix.size; row++) for (let col = 0; col < matrix.size; col++) dark[row * matrix.size + col] = matrix.get(row, col) ? 1 : 0;
  return { size: matrix.size, dark, ...extra };
}

function sameSquares(a: Matrix, b: Matrix): boolean {
  if (a.size !== b.size) return false;
  for (let row = 0; row < a.size; row++) for (let col = 0; col < a.size; col++) if (!!a.get(row, col) !== !!b.get(row, col)) return false;
  return true;
}

/** Data squares away from the finder, timing and format areas, so flips land in codewords. */
function flip(grid: ModuleGrid, positions: [number, number][]): ModuleGrid {
  const dark = grid.dark.slice();
  for (const [row, col] of positions) dark[row * grid.size + col] ^= 1;
  return { ...grid, dark };
}

function isPureBlackAndWhite(image: RawImage): boolean {
  for (let at = 0; at < image.data.length; at += 4) if (image.data[at] !== 0 && image.data[at] !== 255) return false;
  return true;
}

const TEXT = 'https://example.com/attendance?session=2026-11-16&room=B204&t=1731736800';

describe('rebuilding a code exactly', () => {
  it('uses the error correction tables of the QR standard', () => {
    // rebuild.ts carries its own copy of these tables; they must match the encoder's.
    const source = fs.readFileSync(new URL('./rebuild.ts', import.meta.url), 'utf8');
    const table = (name: string): Record<string, number[]> => {
      const block = source.split(`const ${name}`)[1].split('};')[0];
      return Object.fromEntries([...block.matchAll(/([LMQH]): \[([^\]]+)\]/g)].map((match) => [match[1], match[2].split(',').map(Number)]));
    };
    const perBlock = table('EC_PER_BLOCK');
    const blocks = table('BLOCKS');
    for (const level of ['L', 'M', 'Q', 'H'] as EcLevel[]) {
      for (let version = 1; version <= 40; version++) {
        const count = errorCorrectionCode.getBlocksCount(version, errorCorrectionLevel[level]);
        expect(blocks[level][version]).toBe(count);
        expect(perBlock[level][version]).toBe(errorCorrectionCode.getTotalCodewordsCount(version, errorCorrectionLevel[level]) / count);
      }
    }
  });

  it('gives back the same code from a clean reading', () => {
    const code = QRCode.create(TEXT, { errorCorrectionLevel: 'Q' }).modules;
    const rebuilt = rebuildExact(gridFrom(code), TEXT);
    expect(rebuilt && sameSquares(rebuilt, code)).toBe(true);
  });

  it('finds the level and mask itself when the reader does not say', () => {
    for (const maskPattern of [0, 5]) {
      const code = QRCode.create(TEXT, { errorCorrectionLevel: 'H', maskPattern } as QRCode.QRCodeOptions).modules;
      const rebuilt = rebuildExact(gridFrom(code), TEXT);
      expect(rebuilt && sameSquares(rebuilt, code)).toBe(true);
    }
  });

  it('accepts a few misread squares, and still gives the original', () => {
    const code = QRCode.create(TEXT, { errorCorrectionLevel: 'M' }).modules;
    const misread = flip(gridFrom(code), [[20, 20], [21, 22], [25, 30], [30, 25]]);
    const rebuilt = rebuildExact(misread, TEXT);
    expect(rebuilt && sameSquares(rebuilt, code)).toBe(true);
  });

  it('refuses a reading with more damage than the error correction covers', () => {
    const code = QRCode.create(TEXT, { errorCorrectionLevel: 'L' }).modules;
    const positions: [number, number][] = [];
    for (let row = 10; row < code.size - 10; row++) for (let col = 10; col < code.size - 10; col++) if ((row + col) % 2 === 0) positions.push([row, col]);
    expect(rebuildExact(flip(gridFrom(code), positions), TEXT)).toBeNull();
  });

  it('refuses when the text does not match the squares', () => {
    const code = QRCode.create(TEXT, { errorCorrectionLevel: 'M' }).modules;
    expect(rebuildExact(gridFrom(code), `${TEXT}x`)).toBeNull();
    expect(rebuildExact(gridFrom(code), TEXT.replace('B204', 'B205'))).toBeNull();
  });

  it('refuses a grid that is not a QR code size', () => {
    expect(rebuildExact({ size: 22, dark: new Uint8Array(22 * 22) }, TEXT)).toBeNull();
  });
});

describe('crisp copies of real scans', () => {
  const FAR_TEXT = 'http://itunes.apple.com/us/app/encyclopaedia-britannica/id447919187?mt=8';
  const RAISED_TEXT = "'Twas brillig";

  it('rebuilds the far-away TV scan exactly, in pure black and white', async () => {
    const result = await enhanceVerified(fixture('far-tv-scan.png'), FAR_TEXT, decodeQrCodes, decodeIndependently, { locate: locateIndependently });
    expect(result?.method).toBe('rebuilt square for square from the scanned code');
    expect(isPureBlackAndWhite(result!.image)).toBe(true);
    // The very code that was on the screen: version 6, level Q, mask 1, as the reader found.
    const original = QRCode.create(FAR_TEXT, { version: 6, errorCorrectionLevel: 'Q', maskPattern: 1 } as QRCode.QRCodeOptions).modules;
    const [read] = await decodeQrCodes(result!.image, false);
    expect(read.grid && sameSquares({ size: read.grid.size, get: (r, c) => read.grid!.dark[r * read.grid!.size + c] === 1 }, original)).toBe(true);
  });

  it('rebuilds a code with raised, shadowed squares, which the old clean-up smeared', async () => {
    const result = await enhanceVerified(fixture('raised-squares-scan.png'), RAISED_TEXT, decodeQrCodes, decodeIndependently, { locate: locateIndependently });
    expect(result?.method).toBe('rebuilt square for square from the scanned code');
    expect(isPureBlackAndWhite(result!.image)).toBe(true);
  });

  it('rebuilds from the straightened photo when the reader gives no grid', async () => {
    const withoutGrid: Decoder = async (image, thorough) => (await decodeQrCodes(image, thorough)).map(({ grid: _grid, ...rest }) => rest);
    const result = await enhanceVerified(fixture('far-tv-scan.png'), FAR_TEXT, withoutGrid, decodeIndependently, { locate: locateIndependently });
    expect(result?.method).toBe('rebuilt square for square from the scanned code');
  });

  it('makes the copy straight from a live reading in well under the time a code stays on screen', async () => {
    const [live] = await decodeQrCodes(fixture('raised-squares-scan.png'), false);
    expect(live.grid).toBeDefined();
    const started = performance.now();
    const result = await crispCopy(live.grid!, RAISED_TEXT, live.bytes, decodeQrCodes, decodeIndependently);
    expect(result?.method).toBe('rebuilt square for square from the scanned code');
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('never makes a copy for text the squares do not hold', async () => {
    const [live] = await decodeQrCodes(fixture('raised-squares-scan.png'), false);
    expect(await crispCopy(live.grid!, "'Twas brilliG", live.bytes, decodeQrCodes, decodeIndependently)).toBeNull();
  });
});

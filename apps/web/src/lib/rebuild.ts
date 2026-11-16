import QRCode from 'qrcode';
import type { RawImage } from './enhance';

/**
 * Rebuilds a scanned QR code square for square, so it can be shown perfectly sharp.
 *
 * A decoder reads a grid of dark and light squares from the photo. A few may be misread when the photo
 * is blurred; the code's error correction is what lets it still be read. Here the code is encoded again
 * from its text, with the same version, error correction level and mask, and compared with that grid.
 * It is accepted only when every difference is within what the error correction could have caused,
 * and Reed-Solomon codes guarantee only one valid code is that close. So the result is the original
 * code itself, not merely one that reads the same.
 */

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

/** The squares a decoder saw, row by row, top left first. */
export interface ModuleGrid {
  size: number;
  /** 1 for a dark square. */
  dark: Uint8Array;
  ecLevel?: EcLevel;
  /** The data mask, 0 to 7, as the QR standard numbers them. */
  mask?: number;
}

interface Matrix {
  size: number;
  get(row: number, col: number): number | boolean;
  isReserved(row: number, col: number): number | boolean;
}

/** QRCode.create accepts these; the published typings leave some out. */
type Segment = { data: string | Uint8Array; mode: 'byte' | 'alphanumeric' | 'numeric' };
const createCode = QRCode.create as unknown as (
  input: string | Segment[],
  options: { version: number; errorCorrectionLevel: EcLevel; maskPattern: number },
) => { modules: Matrix };

const EC_LEVELS: EcLevel[] = ['L', 'M', 'Q', 'H'];
/** At most this many of the 15 format bits may differ; valid format patterns differ in at least 7. */
const MAX_FORMAT_ERRORS = 3;
/** Rendered size of one square, at least, and the target width of the whole image. */
const MIN_PIXELS_PER_MODULE = 8;
const TARGET_WIDTH = 600;
const QUIET_MODULES = 4;

/** Error correction codewords per block and blocks, by version (index 1 to 40) and level, from the QR standard. */
const EC_PER_BLOCK: Record<EcLevel, number[]> = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const BLOCKS: Record<EcLevel, number[]> = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

function versionOf(size: number): number | null {
  const version = (size - 17) / 4;
  return Number.isInteger(version) && version >= 1 && version <= 40 ? version : null;
}

/** Positions of the two copies of the 15 format bits. */
function formatCopies(size: number): [number, number][][] {
  const first: [number, number][] = [];
  for (let col = 0; col <= 8; col++) if (col !== 6) first.push([8, col]);
  for (let row = 7; row >= 0; row--) if (row !== 6) first.push([row, 8]);
  const second: [number, number][] = [];
  for (let row = size - 1; row >= size - 7; row--) second.push([row, 8]);
  for (let col = size - 8; col < size; col++) second.push([8, col]);
  return [first, second];
}

/** The data squares in the order the standard fills them, two columns at a time from the bottom right. */
function placementOrder(matrix: Matrix): number[] {
  const { size } = matrix;
  const order: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) if (!matrix.isReserved(row, col)) order.push(row * size + col);
    }
    upward = !upward;
  }
  return order;
}

/** Which error correction block each codeword belongs to, after the standard's interleaving. */
function blockOfCodeword(version: number, level: EcLevel, totalCodewords: number): { blockOf: number[]; ecPerBlock: number } {
  const blocks = BLOCKS[level][version];
  const ecPerBlock = EC_PER_BLOCK[level][version];
  const dataTotal = totalCodewords - blocks * ecPerBlock;
  const shortLength = Math.floor(dataTotal / blocks);
  const shortBlocks = blocks - (dataTotal % blocks);
  const blockOf: number[] = [];
  for (let i = 0; i <= shortLength; i++) {
    for (let block = 0; block < blocks; block++) if (i < shortLength || block >= shortBlocks) blockOf.push(block);
  }
  for (let i = 0; i < ecPerBlock; i++) for (let block = 0; block < blocks; block++) blockOf.push(block);
  return { blockOf, ecPerBlock };
}

/** True when the grid can only be a misread of this exact code. */
function provenSame(matrix: Matrix, grid: ModuleGrid, version: number, level: EcLevel): boolean {
  const { size } = grid;
  const differs = (row: number, col: number) => (matrix.get(row, col) ? 1 : 0) !== grid.dark[row * size + col];
  if (Math.min(...formatCopies(size).map((copy) => copy.filter(([row, col]) => differs(row, col)).length)) > MAX_FORMAT_ERRORS) return false;

  const order = placementOrder(matrix);
  const totalCodewords = Math.floor(order.length / 8);
  const { blockOf, ecPerBlock } = blockOfCodeword(version, level, totalCodewords);
  if (blockOf.length !== totalCodewords) return false;
  const wrongCodewords = new Set<number>();
  for (let bit = 0; bit < totalCodewords * 8; bit++) {
    const at = order[bit];
    if (differs(Math.floor(at / size), at % size)) wrongCodewords.add(bit >> 3);
  }
  const wrongPerBlock = new Map<number, number>();
  for (const codeword of wrongCodewords) wrongPerBlock.set(blockOf[codeword], (wrongPerBlock.get(blockOf[codeword]) ?? 0) + 1);
  // Two valid codes differ in more than ecPerBlock codewords of some block, so within half of that only one fits.
  return [...wrongPerBlock.values()].every((wrong) => wrong <= Math.floor(ecPerBlock / 2));
}

/** The ways an encoder may have split the text; most use one mode for all of it. */
function segmentations(text: string, bytes?: Uint8Array): (string | Segment[])[] {
  const ways: (string | Segment[])[] = [text, [{ data: bytes ?? new TextEncoder().encode(text), mode: 'byte' }]];
  if (/^[0-9A-Z $%*+\-./:]+$/.test(text)) ways.push([{ data: text, mode: 'alphanumeric' }]);
  if (/^\d+$/.test(text)) ways.push([{ data: text, mode: 'numeric' }]);
  return ways;
}

/** The exact code the grid is a reading of, or null when that can't be proven. */
export function rebuildExact(grid: ModuleGrid, text: string, bytes?: Uint8Array): Matrix | null {
  const version = versionOf(grid.size);
  if (!version || grid.dark.length !== grid.size * grid.size) return null;
  const levels = grid.ecLevel ? [grid.ecLevel] : EC_LEVELS;
  const masks = grid.mask !== undefined ? [grid.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const input of segmentations(text, bytes)) {
    for (const level of levels) {
      for (const mask of masks) {
        let matrix: Matrix;
        try {
          matrix = createCode(input, { version, errorCorrectionLevel: level, maskPattern: mask }).modules;
        } catch {
          continue; // too much text for this version and level
        }
        if (matrix.size === grid.size && provenSame(matrix, grid, version, level)) return matrix;
      }
    }
  }
  return null;
}

/** Draws squares as pure black and white, with the clear margin scanners need. */
export function renderModules(size: number, isDark: (row: number, col: number) => boolean): RawImage {
  const total = size + 2 * QUIET_MODULES;
  const scale = Math.max(MIN_PIXELS_PER_MODULE, Math.ceil(TARGET_WIDTH / total));
  const width = total * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!isDark(row, col)) continue;
      for (let y = (row + QUIET_MODULES) * scale; y < (row + QUIET_MODULES + 1) * scale; y++) {
        const line = y * width;
        for (let x = (col + QUIET_MODULES) * scale; x < (col + QUIET_MODULES + 1) * scale; x++) {
          const at = (line + x) * 4;
          data[at] = data[at + 1] = data[at + 2] = 0;
        }
      }
    }
  }
  return { data, width, height: width };
}

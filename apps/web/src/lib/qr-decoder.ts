import jsQR from 'jsqr';
import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';
import type { Detection, RawImage } from './enhance';
import type { EcLevel, ModuleGrid } from './rebuild';

const MAX_CODES_PER_IMAGE = 12;

const BASE_OPTIONS: ReaderOptions = {
  formats: ['QRCode'],
  tryHarder: true,
  tryInvert: true,
  tryRotate: true,
  maxNumberOfSymbols: MAX_CODES_PER_IMAGE,
};

/** A second, unrelated decoder used to double-check enhanced images. */
export function decodeIndependently(image: RawImage): string | null {
  return jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}

/** The second decoder's reading, with the code's location. It copes better with very small codes. */
export function locateIndependently(image: RawImage): Detection | null {
  const found = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
  if (!found?.data) return null;
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = found.location;
  return {
    text: found.data,
    corners: [topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner],
    inverted: false,
    modules: 17 + 4 * found.version,
  };
}

/** The grid of squares zxing read, with the level and mask it found. Its symbol image has 0 for dark. */
function gridOf(result: { symbol?: { data: Uint8ClampedArray; width: number; height: number }; extra?: string }): ModuleGrid | undefined {
  const symbol = result.symbol;
  if (!symbol || symbol.width < 21 || symbol.width !== symbol.height || symbol.data.length !== symbol.width * symbol.height) return undefined;
  let extra: { ECLevel?: string; DataMask?: number } = {};
  try {
    extra = JSON.parse(result.extra || '{}') as typeof extra;
  } catch {
    // only the grid itself is needed
  }
  const ecLevel = ['L', 'M', 'Q', 'H'].includes(extra.ECLevel ?? '') ? (extra.ECLevel as EcLevel) : undefined;
  const mask = Number.isInteger(extra.DataMask) && extra.DataMask! >= 0 && extra.DataMask! <= 7 ? extra.DataMask : undefined;
  return { size: symbol.width, dark: Uint8Array.from(symbol.data, (value) => (value === 0 ? 1 : 0)), ecLevel, mask };
}

/** Reads every QR code in an image. `thorough` is slower but finds damaged and noisy ones. */
export async function decodeQrCodes(image: RawImage, thorough = false): Promise<Detection[]> {
  const imageData = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  const results = await readBarcodes(imageData, { ...BASE_OPTIONS, tryDownscale: thorough, tryDenoise: thorough });
  return results
    .filter((result) => result.isValid && result.text)
    .map((result) => {
      const { topLeft, topRight, bottomRight, bottomLeft } = result.position;
      const version = Number.parseInt(result.version, 10);
      return {
        text: result.text,
        corners: [topLeft, topRight, bottomRight, bottomLeft],
        inverted: result.isInverted,
        modules: version > 0 ? 17 + 4 * version : undefined,
        grid: gridOf(result),
        bytes: result.bytes?.length ? new Uint8Array(result.bytes) : undefined,
      };
    });
}

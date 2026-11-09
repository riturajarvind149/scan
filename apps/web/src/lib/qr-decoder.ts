import jsQR from 'jsqr';
import { readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';
import type { Detection, RawImage } from './enhance';

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
      };
    });
}

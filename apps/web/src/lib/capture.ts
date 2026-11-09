import { MAX_IMAGE_BASE64_LENGTH, type ImageMimeType } from '@qr2win/shared-types';
import type { RawImage } from './enhance';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EncodedImage {
  base64: string;
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

/** Big enough to read any code, small enough to arrive quickly over a phone connection. */
const QUICK_MAX_SIZE = 1000;
const QUICK_QUALITY = 0.92;

/** A QR code needs a clear margin to stay scannable, so the crop keeps some of its surroundings. */
const QUIET_ZONE_RATIO = 0.14;

/** The crop around a detected code, including its margin and clamped to the frame. */
export function cropRegion(corners: Point[], frameWidth: number, frameHeight: number): Rect {
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const margin = Math.max(maxX - minX, maxY - minY) * QUIET_ZONE_RATIO;
  const x = Math.max(0, Math.floor(minX - margin));
  const y = Math.max(0, Math.floor(minY - margin));
  return {
    x,
    y,
    width: Math.min(frameWidth, Math.ceil(maxX + margin)) - x,
    height: Math.min(frameHeight, Math.ceil(maxY + margin)) - y,
  };
}

function encode(canvas: HTMLCanvasElement, mimeType: ImageMimeType, quality?: number): string {
  return canvas.toDataURL(mimeType, quality).split(',')[1] ?? '';
}

/**
 * Encodes a canvas without touching its pixels. PNG preserves them exactly; JPEG and then
 * downscaling are fallbacks for images over the size limit.
 */
export function encodeCanvas(source: HTMLCanvasElement): EncodedImage | null {
  let canvas = source;
  for (let attempt = 0; attempt < 5; attempt++) {
    const png = encode(canvas, 'image/png');
    if (png && png.length <= MAX_IMAGE_BASE64_LENGTH) {
      return { base64: png, mimeType: 'image/png', width: canvas.width, height: canvas.height };
    }
    const jpeg = encode(canvas, 'image/jpeg', 0.92);
    if (jpeg && jpeg.length <= MAX_IMAGE_BASE64_LENGTH) {
      return { base64: jpeg, mimeType: 'image/jpeg', width: canvas.width, height: canvas.height };
    }
    const smaller = document.createElement('canvas');
    smaller.width = Math.max(1, Math.round(canvas.width / 2));
    smaller.height = Math.max(1, Math.round(canvas.height / 2));
    smaller.getContext('2d')?.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    canvas = smaller;
  }
  return null;
}

/** Encodes the photo sent the moment a code is seen. Speed matters here; the clearer copy follows. */
export function encodeQuickly(source: HTMLCanvasElement): EncodedImage | null {
  const scale = Math.min(1, QUICK_MAX_SIZE / Math.max(source.width, source.height));
  let canvas = source;
  if (scale < 1) {
    canvas = document.createElement('canvas');
    canvas.width = Math.round(source.width * scale);
    canvas.height = Math.round(source.height * scale);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
  }
  const base64 = encode(canvas, 'image/jpeg', QUICK_QUALITY);
  return base64 && base64.length <= MAX_IMAGE_BASE64_LENGTH
    ? { base64, mimeType: 'image/jpeg', width: canvas.width, height: canvas.height }
    : encodeCanvas(canvas);
}

export function encodeRawImage(image: RawImage): EncodedImage | null {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  return encodeCanvas(canvas);
}

/** Copies a region of the camera frame, unchanged, to its own canvas. */
export function copyRegion(frame: HTMLCanvasElement, region: Rect): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = region.width;
  canvas.height = region.height;
  canvas.getContext('2d', { willReadFrequently: true })?.drawImage(frame, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  return canvas;
}

export function readPixels(canvas: HTMLCanvasElement): RawImage {
  const context = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width, height };
}

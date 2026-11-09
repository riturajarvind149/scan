import { MAX_IMAGE_BASE64_LENGTH, type ImageMimeType } from '@qr2win/shared-types';

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

export interface CapturedImage {
  base64: string;
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

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
 * Copies the code out of the current camera frame: the original pixels, not a regenerated code.
 * PNG preserves them exactly; JPEG and then downscaling are fallbacks for images over the size limit.
 */
export function captureFromVideo(video: HTMLVideoElement, corners: Point[]): CapturedImage | null {
  if (!video.videoWidth || !video.videoHeight || corners.length < 3) return null;
  const region = cropRegion(corners, video.videoWidth, video.videoHeight);
  if (region.width < 1 || region.height < 1) return null;

  const canvas = document.createElement('canvas');
  let scale = 1;
  for (let attempt = 0; attempt < 5; attempt++) {
    canvas.width = Math.max(1, Math.round(region.width * scale));
    canvas.height = Math.max(1, Math.round(region.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);

    const png = encode(canvas, 'image/png');
    if (png && png.length <= MAX_IMAGE_BASE64_LENGTH) {
      return { base64: png, mimeType: 'image/png', width: canvas.width, height: canvas.height };
    }
    const jpeg = encode(canvas, 'image/jpeg', 0.92);
    if (jpeg && jpeg.length <= MAX_IMAGE_BASE64_LENGTH) {
      return { base64: jpeg, mimeType: 'image/jpeg', width: canvas.width, height: canvas.height };
    }
    scale /= 2;
  }
  return null;
}

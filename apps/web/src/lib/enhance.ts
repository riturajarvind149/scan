import type { Point } from './capture';

/** Pixels, as in ImageData but usable anywhere. */
export interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Detection {
  text: string;
  /** Top left, top right, bottom right, bottom left of the code. */
  corners: Point[];
  inverted: boolean;
  /** Modules across the code, when known. */
  modules?: number;
}

/** `thorough` is slower and reads damaged images; a clean result must not need it. */
export type Decoder = (image: RawImage, thorough: boolean) => Promise<Detection[]>;

/** A second decoder sharing no code with the first, so both failing the same way is very unlikely. */
export type IndependentDecoder = (image: RawImage) => string | null;

/** The second decoder again, also saying where the code is. */
export type IndependentLocator = (image: RawImage) => Detection | null;

/** What else may help find the code when the main decoder cannot read the capture. */
export interface LocateHelp {
  locate?: IndependentLocator;
  /** Where the live scan saw the code in this capture, which may have been the phone's own detector. */
  corners?: Point[];
}

export interface EnhancedResult {
  image: RawImage;
  method: string;
}

const PIXELS_PER_MODULE = 12;
const FALLBACK_OUTPUT = 512;
const MAX_OUTPUT = 1024;
/** Samples per output pixel, per axis. Averaging them removes screen stripes and camera noise. */
const SUPERSAMPLE = 3;
/** The clear margin added around the code. */
const QUIET_ZONE = 0.09;
/** A little of the real surroundings is kept, in case the located corners are slightly off. */
const CORNER_SLACK = 0.03;
const SHADING_GRID = 24;
const LEVELS_CLIP = 0.01;
const SHARPEN_AMOUNT = 0.6;
/** Below this difference between dark and light modules, a colour channel holds mostly noise. */
const MIN_CHANNEL_RANGE = 12;
/** Channels separating the modules this similarly mean a black and white code under coloured light. */
const MONOCHROME_RATIO = 0.65;
const NEUTRAL_DARK = 16;
const NEUTRAL_LIGHT = 245;
const ENLARGE_FACTOR = 3;
const MAX_ENLARGED_CAPTURE = 700;

function blank(width: number, height: number): RawImage {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

function luminance(data: Uint8ClampedArray, at: number): number {
  return 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
}

/** Makes a small capture bigger, because decoders struggle when modules are only a few pixels wide. */
function enlarge(source: RawImage, factor: number): RawImage {
  const { data, width, height } = source;
  const out = blank(width * factor, height * factor);
  for (let y = 0; y < out.height; y++) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) / factor - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < out.width; x++) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) / factor - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const at = (y * out.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const top = data[(y0 * width + x0) * 4 + channel] * (1 - fx) + data[(y0 * width + x1) * 4 + channel] * fx;
        const bottom = data[(y1 * width + x0) * 4 + channel] * (1 - fx) + data[(y1 * width + x1) * 4 + channel] * fx;
        out.data[at + channel] = top * (1 - fy) + bottom * fy;
      }
      out.data[at + 3] = 255;
    }
  }
  return out;
}

/** Finds the code in a capture, trying each way in turn. Only the location is used from this. */
async function locateCode(crop: RawImage, expectedText: string, decode: Decoder, help: LocateHelp): Promise<Detection | null> {
  const direct = (await decode(crop, true)).find((detection) => detection.text === expectedText);
  if (direct) return direct;
  if (Math.max(crop.width, crop.height) <= MAX_ENLARGED_CAPTURE) {
    const enlarged = (await decode(enlarge(crop, ENLARGE_FACTOR), true)).find((detection) => detection.text === expectedText);
    if (enlarged) {
      return { ...enlarged, corners: enlarged.corners.map((point) => ({ x: point.x / ENLARGE_FACTOR, y: point.y / ENLARGE_FACTOR })) };
    }
  }
  const located = help.locate?.(crop);
  if (located?.text === expectedText) return located;
  return help.corners?.length === 4 ? { text: expectedText, corners: help.corners, inverted: false } : null;
}

/** Solves the perspective transform taking the unit square to the given corners. */
function unitSquareTo(c: Point[]): number[] {
  const [p0, p1, p2, p3] = c;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h];
}

/**
 * Squares up a tilted code, moving existing pixels but inventing none, and puts a clear margin
 * around it so scanners can find it. Only the area outside the code gets new pixels.
 */
export function rectify(source: RawImage, corners: Point[], inverted: boolean, modules?: number): RawImage {
  const size = Math.min(MAX_OUTPUT, modules ? Math.round((modules * PIXELS_PER_MODULE) / (1 - 2 * QUIET_ZONE)) : FALLBACK_OUTPUT);
  const [a, b, c, d, e, f, g, h] = unitSquareTo(corners);
  const out = blank(size, size);
  const inner = 1 - 2 * QUIET_ZONE;
  const margin = inverted ? 0 : 255;
  const { data, width, height } = source;

  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const total = [0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      out.data[at + 3] = 255;
      total[0] = total[1] = total[2] = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        const v = ((y + (sy + 0.5) / SUPERSAMPLE) / size - QUIET_ZONE) / inner;
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const u = ((x + (sx + 0.5) / SUPERSAMPLE) / size - QUIET_ZONE) / inner;
          const outside = u < -CORNER_SLACK || u > 1 + CORNER_SLACK || v < -CORNER_SLACK || v > 1 + CORNER_SLACK;
          const w = g * u + h * v + 1;
          const px = (a * u + b * v + c) / w - 0.5;
          const py = (d * u + e * v + f) / w - 0.5;
          if (outside || px < 0 || py < 0 || px >= width - 1 || py >= height - 1) {
            total[0] += margin;
            total[1] += margin;
            total[2] += margin;
            continue;
          }
          const x0 = Math.floor(px);
          const y0 = Math.floor(py);
          const fx = px - x0;
          const fy = py - y0;
          const i00 = (y0 * width + x0) * 4;
          const i10 = i00 + 4;
          const i01 = i00 + width * 4;
          const i11 = i01 + 4;
          for (let channel = 0; channel < 3; channel++) {
            const top = data[i00 + channel] * (1 - fx) + data[i10 + channel] * fx;
            const bottom = data[i01 + channel] * (1 - fx) + data[i11 + channel] * fx;
            total[channel] += top * (1 - fy) + bottom * fy;
          }
        }
      }
      out.data[at] = total[0] / samples;
      out.data[at + 1] = total[1] / samples;
      out.data[at + 2] = total[2] / samples;
    }
  }
  return out;
}

/**
 * Removes a colour cast, such as the blue of a photographed screen. Each channel is rescaled evenly,
 * so within a channel dark stays darker than light and no module can flip. A black and white code
 * comes out truly neutral, while a code that is really coloured only has its white corrected.
 */
export function removeColourCast(source: RawImage): RawImage {
  const { data, width, height } = source;
  // Measured on the code alone: the added margin is pure white and would hide the cast.
  const inset = Math.floor(Math.min(width, height) * QUIET_ZONE);
  const histogram = new Uint32Array(256);
  let measured = 0;
  for (let y = inset; y < height - inset; y++) {
    for (let x = inset; x < width - inset; x++) {
      histogram[Math.round(luminance(data, (y * width + x) * 4))]++;
      measured++;
    }
  }
  let low = 0;
  let high = 255;
  for (let seen = 0; low < 255 && seen + histogram[low] <= measured * 0.05; low++) seen += histogram[low];
  for (let seen = 0; high > 0 && seen + histogram[high] <= measured * 0.05; high--) seen += histogram[high];
  const middle = (low + high) / 2;

  const dark = [0, 0, 0];
  const light = [0, 0, 0];
  let darkCount = 0;
  let lightCount = 0;
  for (let y = inset; y < height - inset; y++) {
    for (let x = inset; x < width - inset; x++) {
      const at = (y * width + x) * 4;
      const isLight = luminance(data, at) >= middle;
      const totals = isLight ? light : dark;
      for (let channel = 0; channel < 3; channel++) totals[channel] += data[at + channel];
      if (isLight) lightCount++;
      else darkCount++;
    }
  }
  if (darkCount === 0 || lightCount === 0) return source;
  for (let channel = 0; channel < 3; channel++) {
    dark[channel] /= darkCount;
    light[channel] /= lightCount;
  }
  const ranges = light.map((value, channel) => value - dark[channel]);
  if (Math.min(...ranges) < MIN_CHANNEL_RANGE) {
    // One channel barely separates the modules, as with a yellow code. Rescaling it would only amplify noise.
    return Math.max(...ranges) < MIN_CHANNEL_RANGE ? source : balanceWhite(source, light);
  }
  if (Math.min(...ranges) / Math.max(...ranges) < MONOCHROME_RATIO) return balanceWhite(source, light);

  const span = NEUTRAL_LIGHT - NEUTRAL_DARK;
  const out = blank(width, height);
  for (let at = 0; at < data.length; at += 4) {
    let level = 0;
    for (let channel = 0; channel < 3; channel++) level += (data[at + channel] - dark[channel]) / ranges[channel];
    const shade = NEUTRAL_DARK + (level / 3) * span;
    out.data[at] = out.data[at + 1] = out.data[at + 2] = shade;
    out.data[at + 3] = 255;
  }
  return out;
}

function balanceWhite(source: RawImage, white: number[]): RawImage {
  const { data, width, height } = source;
  const out = blank(width, height);
  const gains = white.map((value) => NEUTRAL_LIGHT / Math.max(1, value));
  for (let at = 0; at < data.length; at += 4) {
    for (let channel = 0; channel < 3; channel++) out.data[at + channel] = data[at + channel] * gains[channel];
    out.data[at + 3] = 255;
  }
  return out;
}

/** Evens out glare and shadow across the image, by dividing by the local brightness of its light areas. */
export function flattenShading(source: RawImage): RawImage {
  const { data, width, height } = source;
  const grid = new Float32Array((SHADING_GRID + 1) * (SHADING_GRID + 1)).fill(1);
  for (let gy = 0; gy <= SHADING_GRID; gy++) {
    for (let gx = 0; gx <= SHADING_GRID; gx++) {
      // Each grid point looks at a window large enough to always include some light modules.
      const cx = (gx / SHADING_GRID) * width;
      const cy = (gy / SHADING_GRID) * height;
      const radius = (width / SHADING_GRID) * 2;
      let brightest = 1;
      const stride = Math.max(1, Math.floor(radius / 6));
      for (let y = Math.max(0, Math.floor(cy - radius)); y < Math.min(height, cy + radius); y += stride) {
        for (let x = Math.max(0, Math.floor(cx - radius)); x < Math.min(width, cx + radius); x += stride) {
          brightest = Math.max(brightest, luminance(data, (y * width + x) * 4));
        }
      }
      grid[gy * (SHADING_GRID + 1) + gx] = brightest;
    }
  }
  const out = blank(width, height);
  for (let y = 0; y < height; y++) {
    const gyf = (y / height) * SHADING_GRID;
    const gy = Math.min(SHADING_GRID - 1, Math.floor(gyf));
    const ty = gyf - gy;
    for (let x = 0; x < width; x++) {
      const gxf = (x / width) * SHADING_GRID;
      const gx = Math.min(SHADING_GRID - 1, Math.floor(gxf));
      const tx = gxf - gx;
      const row = gy * (SHADING_GRID + 1);
      const next = row + SHADING_GRID + 1;
      const local =
        (grid[row + gx] * (1 - tx) + grid[row + gx + 1] * tx) * (1 - ty) + (grid[next + gx] * (1 - tx) + grid[next + gx + 1] * tx) * ty;
      const gain = 255 / local;
      const at = (y * width + x) * 4;
      out.data[at] = data[at] * gain;
      out.data[at + 1] = data[at + 1] * gain;
      out.data[at + 2] = data[at + 2] * gain;
      out.data[at + 3] = 255;
    }
  }
  return out;
}

/** Stretches contrast evenly over the whole image. Dark stays darker than light, so no module can flip. */
export function stretchLevels(source: RawImage): RawImage {
  const { data, width, height } = source;
  const histogram = new Uint32Array(256);
  for (let at = 0; at < data.length; at += 4) histogram[Math.round(luminance(data, at))]++;
  const total = width * height;
  const clip = total * LEVELS_CLIP;
  let low = 0;
  let high = 255;
  for (let seen = 0; low < 255 && seen + histogram[low] <= clip; low++) seen += histogram[low];
  for (let seen = 0; high > 0 && seen + histogram[high] <= clip; high--) seen += histogram[high];
  const out = blank(width, height);
  const range = Math.max(1, high - low);
  for (let at = 0; at < data.length; at += 4) {
    out.data[at] = ((data[at] - low) * 255) / range;
    out.data[at + 1] = ((data[at + 1] - low) * 255) / range;
    out.data[at + 2] = ((data[at + 2] - low) * 255) / range;
    out.data[at + 3] = 255;
  }
  return out;
}

/** A mild unsharp mask, to crisp up the edges between modules. */
export function sharpen(source: RawImage): RawImage {
  const { data, width, height } = source;
  const out = blank(width, height);
  out.data.set(data);
  const line = width * 4;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const i = at + channel;
        const blur = (data[i - 4] + data[i + 4] + data[i - line] + data[i + line]) / 4;
        out.data[i] = data[i] + (data[i] - blur) * SHARPEN_AMOUNT;
      }
    }
  }
  return out;
}

/** How sharp an image is, for picking the best of several frames: the variance of its edges. */
export function sharpnessScore(image: RawImage): number {
  const { data, width, height } = image;
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 256));
  const line = width * 4;
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let y = stride; y < height - stride; y += stride) {
    for (let x = stride; x < width - stride; x += stride) {
      const at = (y * width + x) * 4;
      const edge = 4 * data[at + 1] - data[at + 1 - 4 * stride] - data[at + 1 + 4 * stride] - data[at + 1 - line * stride] - data[at + 1 + line * stride];
      sum += edge;
      squares += edge * edge;
      count++;
    }
  }
  return count === 0 ? 0 : squares / count - (sum / count) ** 2;
}

/**
 * Tries to produce a clearer image of the code. A result is returned only if two independent
 * decoders both read it, in their normal mode, as exactly the text of the original capture. So an
 * enhancement can never leave a different or broken code. Returns null when nothing passes, and the
 * untouched capture is then all that gets shown.
 */
export async function enhanceVerified(
  crop: RawImage,
  expectedText: string,
  decode: Decoder,
  independent: IndependentDecoder,
  help: LocateHelp = {},
): Promise<EnhancedResult | null> {
  const found = await locateCode(crop, expectedText, decode, help);
  if (!found) return null;

  const rectified = rectify(crop, found.corners, found.inverted, found.modules);
  const neutral = removeColourCast(rectified);
  const evened = found.inverted ? neutral : flattenShading(neutral);
  const candidates: [string, () => RawImage][] = [
    ['squared up, colour and lighting corrected, sharpened', () => sharpen(stretchLevels(evened))],
    ['squared up, colour and lighting corrected', () => stretchLevels(evened)],
    ['squared up, colour corrected', () => stretchLevels(neutral)],
    ['squared up', () => rectified],
  ];
  for (const [method, build] of candidates) {
    const image = build();
    const results = await decode(image, false);
    if (results.length === 1 && results[0].text === expectedText && independent(image) === expectedText) {
      return { image, method };
    }
  }
  return null;
}

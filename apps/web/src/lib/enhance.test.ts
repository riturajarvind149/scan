// @vitest-environment node
/// <reference types="node" />
import fs from 'node:fs';
import { createRequire } from 'node:module';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { prepareZXingModule } from 'zxing-wasm/reader';
import { beforeAll, describe, expect, it } from 'vitest';
import { enhanceVerified, flattenShading, rectify, removeColourCast, sharpen, sharpnessScore, stretchLevels, type RawImage } from './enhance';
import { decodeIndependently, decodeQrCodes } from './qr-decoder';

const require = createRequire(import.meta.url);

class TestImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

interface Scene {
  frameWidth: number;
  frameHeight: number;
  /** Where the code sits in the frame: top left, top right, bottom right, bottom left. */
  quad: [number, number][];
  dark?: number;
  light?: number;
  background?: number;
  blur?: number;
  /** Bright patch over the frame, like a projector's hotspot. */
  glare?: number;
  /** Fine stripes, like photographing a screen. */
  moire?: number;
  noise?: number;
}

/** Draws a real QR code the way a camera would see it. Deterministic, so results are repeatable. */
function renderScene(text: string, scene: Scene): RawImage {
  const { frameWidth: width, frameHeight: height, quad } = scene;
  const { dark = 20, light = 235, background = 120, blur = 0, glare = 0, moire = 0, noise = 0 } = scene;
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const [p0, p1, p2, p3] = quad.map(([x, y]) => ({ x, y }));
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x, c = p0.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y, f = p0.y;
  const A = e - f * h, B = c * h - b, C = b * f - c * e;
  const D = f * g - d, E = a - c * g, F = c * d - a * f;
  const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;

  const luma = new Float32Array(width * height);
  const margin = 4 / modules.size; // the code's own quiet zone
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let total = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3;
          const py = y + (sy + 0.5) / 3;
          const w = G * px + H * py + I;
          const u = (A * px + B * py + C) / w;
          const v = (D * px + E * py + F) / w;
          if (u < -margin || u > 1 + margin || v < -margin || v > 1 + margin) total += background;
          else if (u < 0 || u >= 1 || v < 0 || v >= 1) total += light;
          else total += modules.get(Math.floor(v * modules.size), Math.floor(u * modules.size)) ? dark : light;
        }
      }
      luma[y * width + x] = total / 9;
    }
  }

  let blurred = luma;
  for (let pass = 0; pass < blur; pass++) {
    const next = new Float32Array(blurred);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        next[i] = (blurred[i] * 2 + blurred[i - 1] + blurred[i + 1] + blurred[i - width] + blurred[i + width]) / 6;
      }
    }
    blurred = next;
  }

  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 12345;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = blurred[y * width + x];
      if (moire) value += Math.sin(x * 2.1 + y * 0.35) * moire;
      if (glare) value += glare * Math.exp(-(((x - width * 0.45) ** 2 + (y - height * 0.45) ** 2) / (2 * (width * 0.28) ** 2)));
      if (noise) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        value += (seed / 2 ** 32 - 0.5) * noise;
      }
      const at = (y * width + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  return { data, width, height };
}

const TEXT = 'https://example.com/attendance?session=2026-11-09&room=B204';

/** The problems reported: distance on a weak camera, a tilted laptop screen, and a washed-out projector. */
const HARD_SCENES: Record<string, Scene> = {
  'small and far away': { frameWidth: 1280, frameHeight: 720, quad: [[580, 300], [700, 300], [700, 420], [580, 420]], blur: 1 },
  'tilted, photographed off a screen': {
    frameWidth: 1280,
    frameHeight: 720,
    quad: [[470, 180], [770, 150], [800, 500], [450, 520]],
    moire: 22,
    blur: 1,
    noise: 12,
  },
  'projector, washed out': {
    frameWidth: 1280,
    frameHeight: 720,
    quad: [[400, 120], [860, 120], [860, 580], [400, 580]],
    dark: 175,
    light: 245,
    background: 210,
    noise: 6,
  },
  'projector with a bright hotspot': {
    frameWidth: 1280,
    frameHeight: 720,
    quad: [[400, 120], [860, 120], [860, 580], [400, 580]],
    dark: 110,
    light: 195,
    background: 130,
    glare: 55,
    noise: 6,
  },
  'weak camera, blurred and noisy': { frameWidth: 640, frameHeight: 480, quad: [[210, 130], [430, 135], [425, 350], [205, 345]], blur: 2, noise: 20 },
};

function shrinkTo400(image: RawImage): RawImage {
  // What the previous scanner did: a centre square, shrunk to 400 pixels.
  const side = Math.round((2 / 3) * Math.min(image.width, image.height));
  const left = Math.round((image.width - side) / 2);
  const top = Math.round((image.height - side) / 2);
  const data = new Uint8ClampedArray(400 * 400 * 4);
  for (let y = 0; y < 400; y++) {
    for (let x = 0; x < 400; x++) {
      const from = (Math.floor(top + (y / 400) * side) * image.width + Math.floor(left + (x / 400) * side)) * 4;
      const to = (y * 400 + x) * 4;
      data[to] = data[to + 1] = data[to + 2] = image.data[from];
      data[to + 3] = 255;
    }
  }
  return { data, width: 400, height: 400 };
}

function cloneAll<T extends RawImage>(image: T): RawImage {
  return { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
}

beforeAll(() => {
  (globalThis as unknown as { ImageData: unknown }).ImageData = TestImageData;
  prepareZXingModule({
    overrides: { wasmBinary: fs.readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')).buffer as ArrayBuffer },
  });
});

describe('detection on hard images', () => {
  it.each(Object.entries(HARD_SCENES))('reads a code that is %s', async (_name, scene) => {
    const results = await decodeQrCodes(renderScene(TEXT, scene), true);
    expect(results.map((result) => result.text)).toEqual([TEXT]);
  });

  it('beats the previous approach across these scenes', async () => {
    let previous = 0;
    let current = 0;
    for (const scene of Object.values(HARD_SCENES)) {
      const image = renderScene(TEXT, scene);
      const small = shrinkTo400(image);
      if (jsQR(small.data, small.width, small.height)?.data === TEXT) previous++;
      if ((await decodeQrCodes(image, true)).some((result) => result.text === TEXT)) current++;
    }
    console.log(`Hard scenes read: previous approach ${previous}/5, new scanner ${current}/5`);
    expect(current).toBe(Object.keys(HARD_SCENES).length);
    expect(current).toBeGreaterThan(previous);
  });

  it('finds every code when several are in view', async () => {
    const width = 1280;
    const height = 720;
    const texts = ['https://one.example/a', 'https://two.example/b', 'https://three.example/c'];
    const data = new Uint8ClampedArray(width * height * 4).fill(150);
    for (let at = 3; at < data.length; at += 4) data[at] = 255;
    texts.forEach((text, index) => {
      const left = 40 + index * 420;
      const part = renderScene(text, { frameWidth: 400, frameHeight: 400, quad: [[50, 50], [350, 50], [350, 350], [50, 350]], background: 150 });
      for (let y = 0; y < 400; y++) {
        for (let x = 0; x < 400; x++) {
          const from = (y * 400 + x) * 4;
          const to = ((y + 160) * width + x + left) * 4;
          data[to] = data[to + 1] = data[to + 2] = part.data[from];
        }
      }
    });
    const found = await decodeQrCodes({ data, width, height });
    expect(found.map((result) => result.text).sort()).toEqual([...texts].sort());
  });
});

describe('enhancement never changes the code', () => {

  it.each(Object.entries(HARD_SCENES))('keeps the same content for a code that is %s', async (_name, scene) => {
    const image = renderScene(TEXT, scene);
    const enhanced = await enhanceVerified(cloneAll(image), TEXT, decodeQrCodes, decodeIndependently);
    expect(enhanced).not.toBeNull();
    const reread = await decodeQrCodes(enhanced!.image);
    expect(reread.map((result) => result.text)).toEqual([TEXT]);
  });

  it.each(Object.entries(HARD_SCENES))('makes the image easier for other scanners when it is %s', async (name, scene) => {
    const image = renderScene(TEXT, scene);
    const enhanced = await enhanceVerified(cloneAll(image), TEXT, decodeQrCodes, decodeIndependently);
    // Another decoder again, in plain default mode, standing in for an app scanning the laptop's screen.
    const independent = jsQR(enhanced!.image.data, enhanced!.image.width, enhanced!.image.height);
    expect(independent?.data, name).toBe(TEXT);
  });

  it('discards an enhancement that decodes to different text', async () => {
    const image = renderScene(TEXT, HARD_SCENES['small and far away']);
    let calls = 0;
    const lyingDecoder = async (candidate: RawImage, thorough: boolean) => {
      const results = await decodeQrCodes(candidate, thorough);
      calls++;
      return calls === 1 ? results : results.map((result) => ({ ...result, text: 'https://evil.example/' }));
    };
    expect(await enhanceVerified(image, TEXT, lyingDecoder, decodeIndependently)).toBeNull();
    expect(calls).toBe(5); // the original, then all four enhancement attempts
  });

  it('discards an enhancement that no longer decodes', async () => {
    const image = renderScene(TEXT, HARD_SCENES['small and far away']);
    let calls = 0;
    const failingDecoder = async (candidate: RawImage, thorough: boolean) => {
      const results = await decodeQrCodes(candidate, thorough);
      return calls++ === 0 ? results : [];
    };
    expect(await enhanceVerified(image, TEXT, failingDecoder, decodeIndependently)).toBeNull();
  });

  it('discards an enhancement the second decoder reads differently', async () => {
    const image = renderScene(TEXT, HARD_SCENES['small and far away']);
    expect(await enhanceVerified(image, TEXT, decodeQrCodes, () => 'https://evil.example/')).toBeNull();
  });

  it('discards an enhancement the second decoder cannot read', async () => {
    const image = renderScene(TEXT, HARD_SCENES['small and far away']);
    expect(await enhanceVerified(image, TEXT, decodeQrCodes, () => null)).toBeNull();
  });

  it('refuses to enhance when the frame shows a different code than expected', async () => {
    const image = renderScene('https://something-else.example/', HARD_SCENES['small and far away']);
    expect(await enhanceVerified(image, TEXT, decodeQrCodes, decodeIndependently)).toBeNull();
  });

  it('does not turn a code into pure black and white, keeping its real shades', async () => {
    const image = renderScene(TEXT, HARD_SCENES['projector, washed out']);
    const enhanced = await enhanceVerified(cloneAll(image), TEXT, decodeQrCodes, decodeIndependently);
    const shades = new Set<number>();
    for (let at = 0; at < enhanced!.image.data.length; at += 4) shades.add(enhanced!.image.data[at]);
    expect(shades.size).toBeGreaterThan(20);
  });

  it('leaves the original pixels untouched', () => {
    const image = renderScene(TEXT, HARD_SCENES['projector, washed out']);
    const before = new Uint8ClampedArray(image.data);
    stretchLevels(image);
    removeColourCast(image);
    flattenShading(image);
    sharpen(image);
    rectify(image, [{ x: 400, y: 120 }, { x: 860, y: 120 }, { x: 860, y: 580 }, { x: 400, y: 580 }], false);
    expect(image.data).toEqual(before);
  });
});

describe('a code photographed off a tinted screen', () => {
  const TILTED = HARD_SCENES['tilted, photographed off a screen'];

  /** Recolours a grey scene, the way a blue screen and a phone's camera tint a photo. */
  function tinted(image: RawImage, multiply: [number, number, number], add: [number, number, number] = [0, 0, 0]): RawImage {
    const data = new Uint8ClampedArray(image.data);
    for (let at = 0; at < data.length; at += 4) {
      for (let channel = 0; channel < 3; channel++) data[at + channel] = image.data[at + channel] * multiply[channel] + add[channel];
    }
    return { data, width: image.width, height: image.height };
  }

  /** The average difference between a pixel's strongest and weakest colour channels. */
  function colourfulness(image: RawImage): number {
    let total = 0;
    for (let at = 0; at < image.data.length; at += 4) {
      const pixel = [image.data[at], image.data[at + 1], image.data[at + 2]];
      total += Math.max(...pixel) - Math.min(...pixel);
    }
    return total / (image.width * image.height);
  }

  it('comes out straight, square, neutral and reading the same', async () => {
    const photo = tinted(renderScene(TEXT, TILTED), [0.72, 0.85, 1], [10, 25, 45]);
    expect(colourfulness(photo)).toBeGreaterThan(30);
    const enhanced = await enhanceVerified(cloneAll(photo), TEXT, decodeQrCodes, decodeIndependently);
    expect(enhanced).not.toBeNull();
    expect(enhanced!.image.width).toBe(enhanced!.image.height);
    expect(colourfulness(enhanced!.image)).toBeLessThan(2);
    expect((await decodeQrCodes(enhanced!.image)).map((result) => result.text)).toEqual([TEXT]);
  });

  it('crops away the surroundings, down to the code and its margin', async () => {
    // The background here is mid grey. After cropping, none of it should be left in the corners.
    const photo = renderScene(TEXT, { ...TILTED, moire: 0, noise: 0, blur: 0 });
    const { image } = (await enhanceVerified(cloneAll(photo), TEXT, decodeQrCodes, decodeIndependently))!;
    for (const [x, y] of [[2, 2], [image.width - 3, 2], [2, image.height - 3], [image.width - 3, image.height - 3]]) {
      expect(image.data[(y * image.width + x) * 4]).toBe(255);
    }
  });

  it('keeps a code that is really coloured from turning grey', () => {
    const size = 200;
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const at = (y * size + x) * 4;
        const module = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 === 0;
        data.set(module ? [30, 40, 200, 255] : [235, 235, 235, 255], at);
      }
    }
    const result = removeColourCast({ data, width: size, height: size });
    expect(colourfulness(result)).toBeGreaterThan(30);
  });

  it('never lets a dark module become lighter than a light one', () => {
    const photo = tinted(renderScene(TEXT, HARD_SCENES['projector, washed out']), [0.8, 0.9, 1]);
    const lum = (image: RawImage, at: number) => 0.299 * image.data[at] + 0.587 * image.data[at + 1] + 0.114 * image.data[at + 2];
    const result = removeColourCast(photo);
    const order: number[] = [];
    for (let at = 0; at < photo.data.length; at += 4) order.push(at);
    order.sort((a, b) => lum(photo, a) - lum(photo, b));
    const quarter = Math.floor(order.length / 4);
    const average = (part: number[]) => part.reduce((sum, at) => sum + lum(result, at), 0) / part.length;
    expect(average(order.slice(0, quarter))).toBeLessThan(average(order.slice(-quarter)));
  });
});

describe('sharpnessScore', () => {
  it('prefers the sharper of two frames', () => {
    const scene = HARD_SCENES['small and far away'];
    const sharp = renderScene(TEXT, { ...scene, blur: 0 });
    const blurry = renderScene(TEXT, { ...scene, blur: 4 });
    expect(sharpnessScore(sharp)).toBeGreaterThan(sharpnessScore(blurry));
  });
});

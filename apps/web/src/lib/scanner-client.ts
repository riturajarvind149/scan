import type { Point } from './capture';
import type { Detection, EnhancedResult, RawImage } from './enhance';

/** Runs decoding and enhancement off the main thread, so the camera preview never stutters. */
export class ScannerClient {
  private worker = new Worker(new URL('./scanner.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private waiting = new Map<number, { resolve: (value: never) => void; reject: (reason: Error) => void }>();

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const entry = this.waiting.get(data.id);
      if (!entry) return;
      this.waiting.delete(data.id);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data.result as never);
    };
    this.worker.onerror = (event) => {
      for (const entry of this.waiting.values()) entry.reject(new Error(event.message));
      this.waiting.clear();
    };
  }

  detect(image: RawImage, thorough: boolean, stretch: boolean): Promise<Detection[]> {
    return this.call({ kind: 'detect', image, thorough, stretch }, image);
  }

  /** `corners` are where the live scan saw the code in this image. */
  enhance(image: RawImage, text: string, corners: Point[]): Promise<EnhancedResult | null> {
    return this.call({ kind: 'enhance', image, text, corners }, image);
  }

  terminate(): void {
    this.worker.terminate();
  }

  private call<T>(request: object, image: RawImage): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: never) => void, reject });
      this.worker.postMessage({ id, ...request }, [image.data.buffer]);
    });
  }
}

/// <reference lib="webworker" />
import { prepareZXingModule } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
import { enhanceVerified, stretchLevels, type RawImage } from './enhance';
import { decodeIndependently, decodeQrCodes } from './qr-decoder';

// Served from this relay rather than the library's default CDN, so same-Wi-Fi mode needs no internet.
prepareZXingModule({
  overrides: {
    locateFile: (file: string, prefix: string) => (file.endsWith('.wasm') ? wasmUrl : prefix + file),
  },
});

export type ScannerRequest =
  | { id: number; kind: 'detect'; image: RawImage; thorough: boolean; stretch: boolean }
  | { id: number; kind: 'enhance'; image: RawImage; text: string };

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = async ({ data: request }: MessageEvent<ScannerRequest>) => {
  try {
    if (request.kind === 'detect') {
      // Stretching here only helps find a code in a washed-out frame. This copy is never sent.
      const image = request.stretch ? stretchLevels(request.image) : request.image;
      worker.postMessage({ id: request.id, result: await decodeQrCodes(image, request.thorough) });
    } else {
      const enhanced = await enhanceVerified(request.image, request.text, decodeQrCodes, decodeIndependently);
      worker.postMessage({ id: request.id, result: enhanced }, enhanced ? [enhanced.image.data.buffer] : []);
    }
  } catch (err) {
    worker.postMessage({ id: request.id, error: (err as Error).message });
  }
};

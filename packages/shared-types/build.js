import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const cjsContent = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PAIRING_CODE_LENGTH = 6;
exports.PAIRING_CODE_EXPIRY_MS = 5 * 60 * 1000;
exports.MAX_IMAGE_PAYLOAD_BYTES = 5 * 1024 * 1024;
exports.MAX_IMAGE_DIMENSION = 4096;
exports.ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
exports.WS_HEARTBEAT_INTERVAL_MS = 30000;
exports.TOKEN_LENGTH = 64;
exports.RATE_LIMIT_SCANS_PER_MINUTE = 30;
`;

fs.writeFileSync(path.join(distDir, 'index.cjs'), cjsContent, 'utf-8');
console.log('[shared-types] Generated dist/index.cjs (CommonJS)');


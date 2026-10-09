import { crc32, deflateSync } from "node:zlib";
import qrcode from "qrcode-generator";

/**
 * The QR as the bank would hand it out: black on white, quiet zone of four modules and the
 * "$" badge of the Bolivian QR Simple in the centre.
 *
 * Error correction is H (30 %): the badge hides about 3 % of the symbol and whoever restyles
 * the code can cover the centre with a logo of its own and still read the same content.
 */
export const QR_SCALE = 6;
export const QR_QUIET_MODULES = 4;
/** Radius of the central badge, as a fraction of the symbol's side. */
const BADGE_RATIO = 0.1;

export interface QrMatrix {
  size: number;
  dark(row: number, col: number): boolean;
}

export function qrMatrix(payload: string): QrMatrix {
  const qr = qrcode(0, "H");
  qr.addData(payload, "Byte");
  qr.make();
  return { size: qr.getModuleCount(), dark: (row, col) => qr.isDark(row, col) };
}

/** 8-bit grayscale PNG of the QR with its badge. */
export function renderQrPng(matrix: QrMatrix, scale = QR_SCALE): Buffer {
  const side = (matrix.size + QR_QUIET_MODULES * 2) * scale;
  const pixels = Buffer.alloc(side * side, 255);
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (!matrix.dark(row, col)) continue;
      const x0 = (col + QR_QUIET_MODULES) * scale;
      const y0 = (row + QR_QUIET_MODULES) * scale;
      for (let y = y0; y < y0 + scale; y++) pixels.fill(0, y * side + x0, y * side + x0 + scale);
    }
  }
  drawBadge(pixels, side, matrix.size * scale * BADGE_RATIO);
  return encodeGrayPng(side, side, pixels);
}

/** White disc with a "$": two arcs and a bar, anti-aliased by sampling each pixel 4 × 4. */
function drawBadge(pixels: Buffer, side: number, radius: number): void {
  const c = side / 2;
  const r = radius * 0.3; // radius of each arc of the S
  const w = radius * 0.1; // half the stroke
  const DEG = Math.PI / 180;
  const cap1 = { x: r * Math.cos(-30 * DEG), y: -r + r * Math.sin(-30 * DEG) };
  const cap2 = { x: r * Math.cos(150 * DEG), y: r + r * Math.sin(150 * DEG) };
  const ink = (x: number, y: number): boolean => {
    // The bar that crosses the S.
    if (Math.abs(x) <= w * 0.55 && Math.abs(y) <= radius * 0.78) return true;
    if (Math.hypot(x - cap1.x, y - cap1.y) <= w || Math.hypot(x - cap2.x, y - cap2.y) <= w) return true;
    // Upper arc: from the top-right tail, over the top and down the left side to the middle.
    const a1 = Math.atan2(y + r, x) / DEG;
    if (Math.abs(Math.hypot(x, y + r) - r) <= w && (a1 <= -30 || a1 >= 90)) return true;
    // Lower arc: from the middle, down the right side and around to the bottom-left tail.
    const a2 = Math.atan2(y - r, x) / DEG;
    return Math.abs(Math.hypot(x, y - r) - r) <= w && a2 >= -90 && a2 <= 150;
  };
  const from = Math.floor(c - radius - 1);
  const to = Math.ceil(c + radius + 1);
  const N = 4;
  for (let py = from; py < to; py++) {
    for (let px = from; px < to; px++) {
      let disc = 0;
      let dark = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const x = px + (sx + 0.5) / N - c;
          const y = py + (sy + 0.5) / N - c;
          if (Math.hypot(x, y) > radius) continue;
          disc++;
          if (ink(x, y)) dark++;
        }
      }
      if (disc === 0) continue;
      const i = py * side + px;
      const total = N * N;
      // Outside the disc the module underneath shows through; inside it is white or ink.
      pixels[i] = Math.round((pixels[i]! * (total - disc) + 255 * (disc - dark)) / total);
    }
  }
}

function encodeGrayPng(width: number, height: number, gray: Buffer): Buffer {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) gray.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(0, 9); // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

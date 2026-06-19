import type { RawGifMeta, RawFrame } from "../types";
import { lzwDecode } from "./lzw";

export function parseGif(buf: Uint8Array): RawGifMeta {
  let pos = 0;

  function readByte() { return buf[pos++]!; }
  function readWord() { const val = buf[pos]! | (buf[pos + 1]! << 8); pos += 2; return val; }
  function readBytes(n: number) { const res = buf.subarray(pos, pos + n); pos += n; return res; }

  // Header
  const sig = String.fromCharCode(...readBytes(6));
  if (sig !== "GIF87a" && sig !== "GIF89a") {
    throw new Error("Invalid GIF signature: " + sig);
  }

  // Logical Screen Descriptor
  const width = readWord();
  const height = readWord();
  const packed = readByte();
  const bgColorIndex = readByte();
  readByte(); // pixelAspectRatio (unused)

  const globalColorTableFlag = (packed & 0x80) !== 0;
  const gctSize = 1 << ((packed & 0x07) + 1);

  let globalColorTable: Uint8Array | undefined;
  if (globalColorTableFlag) {
    globalColorTable = readBytes(gctSize * 3);
  }

  let loopCount = 0; // Default to 0 (infinite) if not specified
  const frames: RawFrame[] = [];

  // State for current frame
  let currentDelay = 0;
  let currentTransparentIndex: number | undefined = undefined;
  let currentDisposalMethod = 0;

  while (pos < buf.length) {
    const blockType = readByte();

    if (blockType === 0x3B) { // Trailer
      break;
    } else if (blockType === 0x21) { // Extension
      const extLabel = readByte();
      if (extLabel === 0xF9) { // Graphic Control Extension
        readByte(); // blockSize (always 4)
        const gcePacked = readByte();
        currentDisposalMethod = (gcePacked & 0x1C) >> 2;
        const transparentColorFlag = (gcePacked & 0x01) !== 0;
        currentDelay = readWord() * 10; // Convert to ms
        const transIndex = readByte();
        if (transparentColorFlag) {
          currentTransparentIndex = transIndex;
        } else {
          currentTransparentIndex = undefined;
        }
        readByte(); // Block terminator (0x00)
      } else if (extLabel === 0xFF) { // Application Extension
        const blockSize = readByte();
        if (blockSize === 11) {
          const app = String.fromCharCode(...readBytes(11));
          if (app === "NETSCAPE2.0" || app === "ANIMEXTS1.0") {
            const subBlockSize = readByte();
            if (subBlockSize === 3) {
              readByte(); // 0x01
              loopCount = readWord();
              readByte(); // Block terminator
            } else {
              // Read remaining sub-blocks
              pos += subBlockSize;
              while (pos < buf.length && buf[pos]! !== 0) {
                pos += buf[pos]! + 1;
              }
              pos++;
            }
          } else {
            // Read remaining sub-blocks
            while (pos < buf.length && buf[pos]! !== 0) {
              pos += buf[pos]! + 1;
            }
            pos++;
          }
        } else {
          // Read remaining sub-blocks
          pos += blockSize;
          while (pos < buf.length && buf[pos]! !== 0) {
            pos += buf[pos]! + 1;
          }
          pos++;
        }
      } else {
        // Skip extension
        while (pos < buf.length && buf[pos]! !== 0) {
          pos += buf[pos]! + 1;
        }
        pos++;
      }
    } else if (blockType === 0x2C) { // Image Descriptor
      const left = readWord();
      const top = readWord();
      const imgWidth = readWord();
      const imgHeight = readWord();
      const imgPacked = readByte();

      const lctFlag = (imgPacked & 0x80) !== 0;
      const lctSize = 1 << ((imgPacked & 0x07) + 1);

      let localColorTable: Uint8Array | undefined;
      if (lctFlag) {
        localColorTable = readBytes(lctSize * 3);
      }

      const minCodeSize = readByte();
      
      // Read image data blocks
      const dataBlocks: Uint8Array[] = [];
      let totalLength = 0;
      while (pos < buf.length) {
        const blockSize = readByte();
        if (blockSize === 0) break;
        dataBlocks.push(buf.subarray(pos, pos + blockSize));
        totalLength += blockSize;
        pos += blockSize;
      }

      const compressedData = new Uint8Array(totalLength);
      let offset = 0;
      for (const block of dataBlocks) {
        compressedData.set(block, offset);
        offset += block.length;
      }

      const pixelCount = imgWidth * imgHeight;
      const pixels = lzwDecode(minCodeSize, compressedData, pixelCount);

      frames.push({
        left,
        top,
        width: imgWidth,
        height: imgHeight,
        pixels,
        localColorTable,
        transparentIndex: currentTransparentIndex,
        delayMs: currentDelay,
        disposalMethod: currentDisposalMethod,
      });

      // Reset GCE state
      currentDelay = 0;
      currentTransparentIndex = undefined;
      currentDisposalMethod = 0;
    }
  }

  return {
    width,
    height,
    globalColorTable,
    bgColorIndex,
    frames,
    loopCount
  };
}

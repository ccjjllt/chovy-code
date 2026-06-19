export function lzwDecode(minCodeSize: number, data: Uint8Array, pixelCount: number): Uint8Array {
  const MAX_DICT_SIZE = 4096;
  const nullCode = -1;
  const clearCode = 1 << minCodeSize;
  const eofCode = clearCode + 1;

  const dict = new Int32Array(MAX_DICT_SIZE); // prefix code
  const dictSuffix = new Uint8Array(MAX_DICT_SIZE); // appended byte
  const dictLength = new Uint16Array(MAX_DICT_SIZE); // length of sequence

  for (let i = 0; i < clearCode; i++) {
    dict[i] = nullCode;
    dictSuffix[i] = i;
    dictLength[i] = 1;
  }

  let availableCode = clearCode + 2;
  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;

  const pixels = new Uint8Array(pixelCount);
  let pixelIndex = 0;

  // Bit reader
  let byteIndex = 0;
  let bitIndex = 0; // bit offset in the current byte

  function readBits(bits: number): number {
    let result = 0;
    let bitsRead = 0;
    while (bitsRead < bits) {
      if (byteIndex >= data.length) return -1;
      const bitsToRead = Math.min(bits - bitsRead, 8 - bitIndex);
      const mask = (1 << bitsToRead) - 1;
      result |= ((data[byteIndex]! >> bitIndex) & mask) << bitsRead;
      bitsRead += bitsToRead;
      bitIndex += bitsToRead;
      if (bitIndex === 8) {
        bitIndex = 0;
        byteIndex++;
      }
    }
    return result;
  }

  let oldCode = nullCode;
  let firstChar = 0;

  while (pixelIndex < pixelCount) {
    let code = readBits(codeSize);
    if (code === -1 || code === eofCode) break;

    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      codeMask = (1 << codeSize) - 1;
      availableCode = clearCode + 2;
      oldCode = nullCode;
      continue;
    }

    if (oldCode === nullCode) {
      pixels[pixelIndex++] = dictSuffix[code]!;
      oldCode = code;
      firstChar = dictSuffix[code]!;
      continue;
    }

    let inCode = code;
    if (code >= availableCode) {
      code = oldCode;
    }

    // Trace back the dictionary sequence
    let c = code;
    const len = inCode >= availableCode ? dictLength[oldCode]! + 1 : dictLength[c]!;
    
    // Bounds check
    if (pixelIndex + len > pixelCount) {
        break; // Malformed or truncated
    }

    let t = pixelIndex + len - 1;

    if (inCode >= availableCode) {
      pixels[t--] = firstChar;
      c = oldCode;
    }

    while (c !== nullCode && t >= pixelIndex) {
      pixels[t--] = dictSuffix[c]!;
      c = dict[c]!;
    }

    firstChar = pixels[pixelIndex]!;
    pixelIndex += len;

    // Add new code to dictionary
    if (availableCode < MAX_DICT_SIZE) {
      dict[availableCode] = oldCode;
      dictSuffix[availableCode] = firstChar;
      dictLength[availableCode] = dictLength[oldCode]! + 1;
      availableCode++;

      if ((availableCode & codeMask) === 0 && availableCode < MAX_DICT_SIZE) {
        codeSize++;
        codeMask = (1 << codeSize) - 1;
      }
    }

    oldCode = inCode;
  }

  return pixels;
}

import type { RawFrame } from "../types";

export class FrameRenderer {
  public displayCanvas: Uint8Array;
  private disposeCanvas: Uint8Array;
  private screenWidth: number;
  private screenHeight: number;
  private bgColor: [number, number, number, number];

  constructor(width: number, height: number, bgColor: [number, number, number, number] = [0, 0, 0, 0]) {
    this.screenWidth = width;
    this.screenHeight = height;
    this.displayCanvas = new Uint8Array(width * height * 4);
    this.disposeCanvas = new Uint8Array(width * height * 4);
    this.bgColor = bgColor;
    
    // Initialize disposeCanvas with background color
    for (let i = 0; i < this.disposeCanvas.length; i += 4) {
      this.disposeCanvas[i] = bgColor[0];
      this.disposeCanvas[i+1] = bgColor[1];
      this.disposeCanvas[i+2] = bgColor[2];
      this.disposeCanvas[i+3] = bgColor[3];
    }
  }

  public renderFrame(rawFrame: RawFrame, globalColorTable?: Uint8Array): Uint8Array {
    const colorTable = rawFrame.localColorTable || globalColorTable;
    if (!colorTable) {
      throw new Error("No color table available for frame");
    }

    // Start with the disposed state from the previous frame
    this.displayCanvas.set(this.disposeCanvas);

    // Draw the current frame onto displayCanvas
    for (let y = 0; y < rawFrame.height; y++) {
      for (let x = 0; x < rawFrame.width; x++) {
        const dx = rawFrame.left + x;
        const dy = rawFrame.top + y;

        if (dx >= 0 && dx < this.screenWidth && dy >= 0 && dy < this.screenHeight) {
          const pixelIndex = y * rawFrame.width + x;
          const colorIndex = rawFrame.pixels[pixelIndex]!;

          if (colorIndex !== rawFrame.transparentIndex) {
            const destIndex = (dy * this.screenWidth + dx) * 4;
            const srcIndex = colorIndex * 3;
            
            if (srcIndex + 2 < colorTable.length) {
              this.displayCanvas[destIndex] = colorTable[srcIndex]!;         // R
              this.displayCanvas[destIndex + 1] = colorTable[srcIndex + 1]!; // G
              this.displayCanvas[destIndex + 2] = colorTable[srcIndex + 2]!; // B
              this.displayCanvas[destIndex + 3] = 255;                      // A
            }
          }
        }
      }
    }

    // Now prepare disposeCanvas for the NEXT frame
    if (rawFrame.disposalMethod === 0 || rawFrame.disposalMethod === 1) {
      // Keep: NEXT frame starts with CURRENT display canvas
      this.disposeCanvas.set(this.displayCanvas);
    } else if (rawFrame.disposalMethod === 2) {
      // Restore Background: NEXT frame starts with CURRENT display canvas, but with the current frame's area cleared
      this.disposeCanvas.set(this.displayCanvas);
      for (let y = 0; y < rawFrame.height; y++) {
        for (let x = 0; x < rawFrame.width; x++) {
          const dx = rawFrame.left + x;
          const dy = rawFrame.top + y;
          if (dx >= 0 && dx < this.screenWidth && dy >= 0 && dy < this.screenHeight) {
            const destIndex = (dy * this.screenWidth + dx) * 4;
            this.disposeCanvas[destIndex] = this.bgColor[0];
            this.disposeCanvas[destIndex + 1] = this.bgColor[1];
            this.disposeCanvas[destIndex + 2] = this.bgColor[2];
            this.disposeCanvas[destIndex + 3] = this.bgColor[3];
          }
        }
      }
    } else if (rawFrame.disposalMethod === 3) {
      // Restore Previous: disposeCanvas remains unchanged (it still has the state from before the CURRENT frame was drawn)
    }

    // Return a copy of the displayed canvas
    return new Uint8Array(this.displayCanvas);
  }
}

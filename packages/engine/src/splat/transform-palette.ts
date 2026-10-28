import type { GraphicsDevice } from 'playcanvas';
import {
  ADDRESS_CLAMP_TO_EDGE,
  FILTER_NEAREST,
  Mat4,
  PIXELFORMAT_RGBA32F,
  Texture,
} from 'playcanvas';

const idx = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14];
const width = 512 * 3;

class TransformPalette {
  getTransform: (index: number, transform: Mat4) => void;
  setTransform: (index: number, transform: Mat4) => void;
  upload: () => boolean;
  alloc: (num?: number) => number;
  free: (num?: number) => void;
  texture!: Texture; // assigned via defineProperty in constructor

  constructor(device: GraphicsDevice, initialSize = 4096) {
    let texture: Texture;
    let data: Float32Array;
    let dirty = false;

    const realloc = (width: number, height: number) => {
      const newTexture = new Texture(device, {
        name: 'transformPalette',
        width,
        height,
        format: PIXELFORMAT_RGBA32F,
        mipmaps: false,
        minFilter: FILTER_NEAREST,
        magFilter: FILTER_NEAREST,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE,
      });

      const newData = newTexture.lock() as Float32Array;
      newTexture.unlock();

      if (texture) {
        newData.set(data);
        texture.destroy();
      }

      texture = newTexture;
      data = newData;
      dirty = true;
    };

    this.getTransform = (index: number, transform: Mat4) => {
      const dst = transform.data;
      for (let i = 0; i < 12; ++i) {
        dst[idx[i]] = data[index * 12 + i];
      }
    };

    this.setTransform = (index: number, transform: Mat4) => {
      const src = transform.data;
      const base = index * 12;
      let changed = false;
      for (let i = 0; i < 12; ++i) {
        const v = src[idx[i]];
        if (data[base + i] !== v) {
          data[base + i] = v;
          changed = true;
        }
      }
      if (changed) dirty = true;
    };

    this.upload = () => {
      if (!dirty) return false;
      dirty = false;
      texture.upload();
      return true;
    };

    let nextIdx = 1;

    this.alloc = (num = 1) => {
      const result = nextIdx;

      while (nextIdx + num > data.length / 12) {
        realloc(width, texture.height * 2);
      }

      nextIdx += num;

      return result;
    };

    this.free = (num = 1) => {
      nextIdx -= num;
    };

    Object.defineProperty(this, 'texture', {
      get() {
        return texture;
      },
    });

    realloc(width, Math.ceil(initialSize / (width / 3)));

    this.setTransform(0, Mat4.IDENTITY);
    this.upload();
  }
}

export { TransformPalette };

import type { Base64Image, ImageInput } from './types.js';
import { checkUrl, invalid } from './validate.js';

/** The image types the API takes. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DATA_URL = /^data:([^;,]+)(?:;[^;,]*)*;base64,(.*)$/s;

/**
 * An image as the request carries it: a URL the API downloads (checked), or
 * the bytes as a Blob. A data URL and a `Base64Image` become a Blob here, so
 * the rest of the client only knows the two.
 */
export function toImage(input: ImageInput, field: string): string | Blob {
  if (typeof Blob !== 'undefined' && input instanceof Blob) return input;
  if (typeof input === 'string') {
    const m = DATA_URL.exec(input);
    if (!m) {
      checkUrl(input, field);
      return input;
    }
    return fromBase64(m[2]!, m[1]!.toLowerCase(), void 0, field);
  }
  if (input && typeof (input as Base64Image).base64 === 'string') {
    const b = input as Base64Image;
    return fromBase64(b.base64, b.mimeType, b.name, field);
  }
  throw invalid(`${field} must be a URL, a data URL, a Base64Image or a Blob`);
}

function fromBase64(base64: string, type: string, name: string | undefined, field: string): Blob {
  if (!IMAGE_TYPES.includes(type)) throw invalid(`${field} must be a JPEG, PNG or WebP image`);
  let bin: string;
  try {
    bin = atob(base64.replace(/\s+/g, ''));
  } catch {
    throw invalid(`${field} is not valid base64`);
  }
  if (!bin.length) throw invalid(`${field} is empty`);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // `File` carries the name; Node 18 has only `Blob`, and a default name is made at upload.
  return name && typeof File !== 'undefined' ? new File([bytes], name, { type }) : new Blob([bytes], { type });
}

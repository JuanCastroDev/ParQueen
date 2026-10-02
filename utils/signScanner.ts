/** Previewable image + raw base64 for `analyzeParkingSign()`. */
export interface SignImage {
  previewUrl: string;
  imageData: string;
}

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/s;

export const signImageFromDataUrl = (dataUrl: string): SignImage | null => {
  const match = DATA_URL_RE.exec((dataUrl || '').trim());
  if (!match || !match[2]) return null;
  return { previewUrl: `data:${match[1]};base64,${match[2]}`, imageData: match[2] };
};

export const signImageFromBase64 = (base64: string, mime = 'image/jpeg'): SignImage | null => {
  const imageData = (base64 || '').trim();
  if (!imageData) return null;
  if (imageData.startsWith('data:')) return signImageFromDataUrl(imageData);
  const safeMime = mime && mime.startsWith('image/') ? mime : 'image/jpeg';
  return { previewUrl: `data:${safeMime};base64,${imageData}`, imageData };
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

/** Converts a camera-capture File into the preview / analyze contract. */
export const fileToSignImage = async (file: Blob | null | undefined): Promise<SignImage | null> => {
  if (!file || file.size === 0) return null;
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength === 0) return null;
  const imageData = bytesToBase64(new Uint8Array(buffer));
  if (!imageData) return null;
  const mime = file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg';
  return { previewUrl: `data:${mime};base64,${imageData}`, imageData };
};

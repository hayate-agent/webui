import sharp from 'sharp';
// Generated locally, not an opaque embedded credential-like base64 literal.
export const validPng = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'red' } }).png().toBuffer();

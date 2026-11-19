import sharp from 'sharp';
import { inspectImage } from './media.mjs';

export async function verifyDecodedImage(image) {
 const bytes = Buffer.from(image.data, 'base64');
 inspectImage(bytes, image.mimeType);
 const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: 16000000, animated: false });
 const metadata = await decoder.metadata();
 if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw Error('Animated images are not supported');
 // Decode actual pixels: metadata alone accepts some truncated raster files.
 await decoder.raw().toBuffer();
 return image;
}

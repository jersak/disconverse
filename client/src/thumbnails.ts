// Small preview images, made in the browser: at upload time, and by the admin panel's backfill.
// They're what the admin media browser (and video posters in chat) load instead of the originals.

const THUMB_SIZE = 320; // longest side, in pixels

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  // WebP is smallest; browsers that can't encode it return PNG instead (or null).
  return encode("image/webp", 0.75).then((b) => (b && b.type === "image/webp" ? b : encode("image/jpeg", 0.8)));
}

function draw(source: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  const scale = Math.min(1, THUMB_SIZE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return toBlob(canvas);
}

/** Thumbnail of an image (first frame for GIFs). */
export async function imageThumbnail(image: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(image);
    const thumb = await draw(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    return thumb;
  } catch {
    return null; // a format this browser can't decode
  }
}

/**
 * A frame from near the start of a video. `src` can be a local object URL or a same-origin URL
 * (only the needed part is downloaded). Null if the browser can't decode the video.
 */
export function videoThumbnail(src: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let done = false;
    const finish = (result: Blob | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 10_000);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onloadedmetadata = () => {
      // A moment in, to skip a black first frame.
      video.currentTime = Math.min(1, (video.duration || 0) / 4);
    };
    video.onseeked = () => {
      if (!video.videoWidth) return finish(null);
      void draw(video, video.videoWidth, video.videoHeight).then(finish, () => finish(null));
    };
    video.onerror = () => finish(null);
    video.src = src;
  });
}

/** Thumbnail for an attached file, or null for formats the browser can't read. */
export async function fileThumbnail(file: File): Promise<Blob | null> {
  if (file.type.startsWith("image/")) return imageThumbnail(file);
  if (file.type.startsWith("video/")) {
    const url = URL.createObjectURL(file);
    try {
      return await videoThumbnail(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return null;
}

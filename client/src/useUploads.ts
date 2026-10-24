import { useCallback, useEffect, useRef, useState } from "react";
import { api, uploadFile, type Attachment } from "./api.ts";
import { fileThumbnail } from "./thumbnails.ts";

export const MAX_ATTACHMENTS = 10;

export type PendingUpload = {
  key: number;
  file: File;
  /** Local object URL for the thumbnail. */
  preview: string;
  progress: number;
  attachment?: Attachment;
  error?: string;
  abort?: () => void;
};

/** Width/height of an image or video, so chat can reserve space before it loads. */
async function measure(file: File): Promise<{ width?: number; height?: number }> {
  try {
    if (file.type.startsWith("image/")) {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    }
    if (file.type.startsWith("video/")) {
      return await new Promise((resolve) => {
        const video = document.createElement("video");
        const url = URL.createObjectURL(file);
        const done = (size: { width?: number; height?: number }) => {
          URL.revokeObjectURL(url);
          resolve(size);
        };
        video.preload = "metadata";
        video.onloadedmetadata = () => done({ width: video.videoWidth || undefined, height: video.videoHeight || undefined });
        video.onerror = () => done({});
        setTimeout(() => done({}), 5000);
        video.src = url;
      });
    }
  } catch {
    // Unknown size: the message just won't reserve space.
  }
  return {};
}

let nextKey = 1;

// Fetched once; the server enforces the limits regardless, this just fails oversized files instantly.
let limitsMb: Promise<{ image: number; video: number } | null> | undefined;
const getLimits = () =>
  (limitsMb ??= api.uploadLimits().then(
    (r) => r.limitsMb,
    () => null,
  ));

function precheck(file: File, limits: { image: number; video: number } | null): string | undefined {
  const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : null;
  if (!kind) return "Only images and videos can be attached";
  const max = limits?.[kind];
  if (max && file.size > max * 1024 * 1024) return `${kind === "image" ? "Images" : "Videos"} can be up to ${max} MB`;
}

/** Files attached to the message being written; each starts uploading as soon as it's added. */
export function useUploads() {
  const [items, setItems] = useState<PendingUpload[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const update = (key: number, patch: Partial<PendingUpload>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const add = useCallback(async (files: File[]) => {
    const limits = await getLimits();
    const room = MAX_ATTACHMENTS - itemsRef.current.length;
    const added: PendingUpload[] = files.slice(0, Math.max(0, room)).map((file) => ({
      key: nextKey++,
      file,
      preview: URL.createObjectURL(file),
      progress: 0,
      error: precheck(file, limits),
    }));
    setItems((list) => [...list, ...added]);

    for (const item of added) {
      if (item.error) continue;
      void (async () => {
        const [size, thumbnail] = await Promise.all([measure(item.file), fileThumbnail(item.file)]);
        const upload = uploadFile(item.file, size, thumbnail, (progress) => update(item.key, { progress }));
        update(item.key, { abort: upload.abort });
        try {
          update(item.key, { attachment: await upload.promise, progress: 1 });
        } catch (err) {
          update(item.key, { error: err instanceof Error ? err.message : "Upload failed" });
        }
      })();
    }
  }, []);

  const remove = useCallback((key: number) => {
    const item = itemsRef.current.find((i) => i.key === key);
    if (!item) return;
    item.abort?.();
    URL.revokeObjectURL(item.preview);
    setItems((list) => list.filter((i) => i.key !== key));
  }, []);

  const clear = useCallback(() => {
    for (const i of itemsRef.current) URL.revokeObjectURL(i.preview);
    setItems([]);
  }, []);

  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview)), []);

  return {
    items,
    add,
    remove,
    clear,
    uploading: items.some((i) => !i.attachment && !i.error),
    readyIds: items.flatMap((i) => (i.attachment ? [i.attachment.id] : [])),
  };
}

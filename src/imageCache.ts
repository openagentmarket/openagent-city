const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadCachedImage(src: string) {
  const cached = imageCache.get(src);

  if (cached) {
    return cached;
  }

  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = (event) => {
      imageCache.delete(src);
      reject(event);
    };
    image.src = src;
  });

  imageCache.set(src, promise);
  return promise;
}

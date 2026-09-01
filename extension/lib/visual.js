/**
 * Compact screenshot baselines.
 *
 * Storing a full screenshot in every test makes recordings huge. A 32x32
 * luminance fingerprint is 1KB, survives harmless encoding differences, and
 * still detects layout/content changes across the viewport.
 */

export async function visualFingerprint(dataBase64, mime = 'image/png') {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('This Chromium build does not expose OffscreenCanvas/createImageBitmap to extension workers.');
  }
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  const size = 32;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, size, size);
  bitmap.close?.();
  const rgba = context.getImageData(0, 0, size, size).data;
  const values = [];
  for (let i = 0; i < rgba.length; i += 4) {
    values.push(Math.round((rgba[i] * 0.2126) + (rgba[i + 1] * 0.7152) + (rgba[i + 2] * 0.0722)));
  }
  return { algorithm: 'luma-32x32-v1', width: size, height: size, values };
}

export function visualDifference(a, b) {
  if (!a || !b || a.algorithm !== b.algorithm || a.values?.length !== b.values?.length) {
    throw new Error('Visual baseline format does not match the current screenshot fingerprint.');
  }
  let total = 0;
  let changed = 0;
  for (let i = 0; i < a.values.length; i++) {
    const delta = Math.abs(a.values[i] - b.values[i]) / 255;
    total += delta;
    if (delta > 0.12) changed += 1;
  }
  return {
    difference: total / a.values.length,
    changedRatio: changed / a.values.length,
  };
}

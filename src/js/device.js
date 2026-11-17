// Camera (photo compression) and location helpers.
import { fitWithin } from './merge.js';

export const PHOTO_MAX_SIDE = 1280;
export const PHOTO_QUALITY = 0.7;

// Shrink a photo on the device before it is saved: longest side 1280 px, JPEG ~70 %.
export async function compressPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, PHOTO_MAX_SIDE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY); });
  if (!blob) throw new Error('This photo could not be read');
  return { blob, width, height };
}

function toPoint(pos) {
  return {
    lat: Number(pos.coords.latitude.toFixed(6)),
    lng: Number(pos.coords.longitude.toFixed(6)),
    acc: Math.round(pos.coords.accuracy ?? 0),
    t: new Date(pos.timestamp || Date.now()).toISOString(),
  };
}

export function getPoint() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(Object.assign(new Error('No location support'), { denied: true }));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(toPoint(pos)),
      (err) => reject(Object.assign(new Error(err.message || 'Location failed'), { denied: err.code === 1 })),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}

export function watchPoints(onPoint, onError) {
  const id = navigator.geolocation.watchPosition(
    (pos) => onPoint(toPoint(pos)),
    (err) => onError?.(Object.assign(new Error(err.message || 'Location failed'), { denied: err.code === 1 })),
    { enableHighAccuracy: true, maximumAge: 0 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

export async function permissionState(name) {
  try {
    return (await navigator.permissions.query({ name })).state; // granted | prompt | denied
  } catch {
    return 'prompt';
  }
}

// Calls back with the permission state now and whenever it changes. Returns a stop function.
export function watchPermission(name, cb) {
  let status = null;
  let stopped = false;
  const onChange = () => cb(status.state);
  if (!navigator.permissions?.query) { cb('prompt'); return () => {}; }
  navigator.permissions.query({ name }).then((s) => {
    if (stopped) return;
    status = s;
    cb(s.state);
    s.addEventListener('change', onChange);
  }).catch(() => cb('prompt'));
  return () => { stopped = true; status?.removeEventListener('change', onChange); };
}

export function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// Files in Google Drive through the free Apps Script service (tools/password-service: fileUp / fileGet).
// Chat files, voice notes, task attachments and payroll receipts used to be stored as base64 chunks in Firestore,
// which used up Firebase's free daily reads and storage. When the service is not set up (or not updated yet),
// callers fall back to the old Firestore chunks so sending never stops; old files keep opening from Firestore.
import { callService, publicConfig } from './authsvc.js';

let off = false;   // the service answered "unknown action" (old version) → don't try again this session

/** Can files go to Drive right now? */
export async function driveReady() {
  if (off) return false;
  try { return !!(await publicConfig()).authServiceUrl; } catch { return false; }
}

/**
 * Upload base64 data. kind = 'chat' | 'task' | 'payroll', ref = chatId / taskId / payroll item id.
 * Returns the Drive id, or '' when Drive can't be used (the caller then stores the file in Firestore).
 */
export async function driveUpload(kind, ref, { b64, name, mime }) {
  if (!(await driveReady())) return '';
  try {
    const r = await callService('fileUp', { kind, ref, name, mime, data: b64 });
    return r.driveId || '';
  } catch (e) {
    if (e && (e.code === 'unknown-action' || e.code === 'not-configured')) off = true;
    if (e && (e.code === 'forbidden' || e.code === 'too-large')) throw e;   // the same limits apply in Firestore
    console.warn('[drive] upload failed, using Firestore', e && (e.code || e.message));
    return '';
  }
}

/** The file as an object URL (kind + the id of its chat_files / task_files / payroll_proofs document) */
export async function driveDownload(kind, id, fallbackMime = '') {
  const r = await callService('fileGet', { kind, id });
  const bin = atob(r.data || ''); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: r.mime || fallbackMime || 'application/octet-stream' }));
}

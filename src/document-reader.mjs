import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';

export const DOCUMENT_EXTENSIONS = new Set([
  '.doc', '.docx', '.docm', '.ppt', '.pps', '.pot', '.pptx', '.pptm', '.ppsx', '.ppsm',
  '.xls', '.xlsx', '.xlsm', '.xlsb', '.odt', '.ods', '.odp', '.rtf', '.epub', '.csv', '.pdf',
]);
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;

function inside(root, target) {
  return target === root || target.startsWith(root + sep);
}

function truncate(text) {
  const lines = text.split('\n');
  let value = lines.slice(0, MAX_OUTPUT_LINES).join('\n');
  if (Buffer.byteLength(value) > MAX_OUTPUT_BYTES) value = Buffer.from(value).subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
  const truncated = lines.length > MAX_OUTPUT_LINES || Buffer.byteLength(text) > MAX_OUTPUT_BYTES;
  return truncated ? `${value}\n\n[文档内容已截断，仅返回前 ${MAX_OUTPUT_LINES} 行或 50 KiB]` : value;
}

export function safeDocumentName(value) {
  const cleaned = basename(String(value || 'document')).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 160);
  return cleaned && !['.', '..'].includes(cleaned) ? cleaned : 'document';
}

export function documentReader(workspace, converter) {
  const root = realpathSync(workspace);
  return {
    async read(input, signal) {
      if (typeof input !== 'string' || !input.trim() || input.length > 1000) throw new Error('invalid_document_path');
      const requested = resolve(root, input);
      let actual;
      try { actual = realpathSync(requested); } catch { throw new Error('document_not_found'); }
      if (!inside(root, actual)) throw new Error('document_outside_tenant');
      const info = lstatSync(actual);
      if (!info.isFile() || statSync(actual).size > MAX_DOCUMENT_BYTES) throw new Error('document_invalid_or_too_large');
      const extension = extname(actual).toLowerCase();
      if (!DOCUMENT_EXTENSIONS.has(extension)) throw new Error('unsupported_document_type');
      signal?.throwIfAborted();
      try {
        const markdown = await converter(actual);
        signal?.throwIfAborted();
        return { file: basename(actual), content: truncate(String(markdown)), ocr: false };
      } catch (error) {
        if (error?.code === 'needsOcr') throw new Error('document_needs_ocr');
        throw new Error('document_read_failed');
      }
    },
  };
}

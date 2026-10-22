// Copyright (C) 2026 FubukiHanasaki. AGPL-3.0-or-later.
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { Uint8ArrayReader, ZipReader, type Entry, type FileEntry } from '@zip.js/zip.js';
import { parse } from 'csv-parse/sync';
import { ImportError, LIMITS, type InputRow } from './types';
const bad = (message: string): never => { throw new ImportError(400, message); };
export function safePath(value: string, directory = false): string {
  if (typeof value !== 'string' || value.length > 240 || !value || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value !== value.normalize('NFC')) bad('压缩包包含不安全的文件路径');
  const name = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  if (name.split('/').some(p => !p || p === '.' || p === '..' || p.trim() !== p || p.endsWith('.'))) bad('压缩包包含不安全的文件路径');
  return name;
}
function text(bytes: Uint8Array, name: string): string {
  let result: string;
  try { result = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return bad(`${name} 必须使用 UTF-8 编码`); }
  if (result.includes('\0')) bad(`${name} 包含二进制内容`);
  return result;
}
export async function readArchive(bytes: Uint8Array): Promise<InputRow[]> {
  if (!bytes.length || bytes.length > LIMITS.zip) bad('ZIP 必须为 1 字节至 10 MB');
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let expanded = 0;
  try {
    const files = new Map<string, FileEntry>();
    const names = new Set<string>();
    let count = 0, declared = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      if (++count > LIMITS.entries) bad('ZIP 条目过多');
      const name = safePath(entry.filename, entry.directory);
      const key = name.toLocaleLowerCase('en-US');
      if (names.has(key)) bad('ZIP 存在重复路径或大小写冲突');
      names.add(key);
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (mode && mode !== 0x8000 && mode !== 0x4000) bad('ZIP 不允许链接或特殊文件');
      if (entry.encrypted) bad('不支持加密 ZIP');
      if (entry.directory) continue;
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) bad('ZIP 文件大小无效');
      const limit = name === 'submissions.csv' ? LIMITS.manifest : LIMITS.code;
      if (entry.uncompressedSize > limit) bad(`${name} 超出大小限制`);
      if (![0, 8].includes(entry.compressionMethod)) bad('仅支持普通存储或 Deflate ZIP');
      if ((declared += entry.uncompressedSize) > LIMITS.expanded) bad('ZIP 解压总大小超过 20 MB');
      files.set(name, entry);
    }
    async function read(entry: Entry, limit: number): Promise<Uint8Array> {
      if (entry.directory) return bad('不能读取目录');
      const chunks: Uint8Array[] = [];
      let length = 0;
      await entry.getData(new WritableStream<Uint8Array>({
        write(chunk) {
          length += chunk.byteLength; expanded += chunk.byteLength;
          if (length > limit || expanded > LIMITS.expanded) { controller.abort(); bad('实际解压大小超过限制'); }
          chunks.push(chunk.slice());
        },
      }), { checkSignature: true, signal: controller.signal, useWebWorkers: false });
      if (length !== entry.uncompressedSize) bad('ZIP 文件大小与声明不一致');
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      return result;
    }
    const manifest = files.get('submissions.csv');
    if (!manifest) bad('ZIP 根目录缺少 submissions.csv');
    const csv = text(await read(manifest!, LIMITS.manifest), 'submissions.csv');
    let records: string[][];
    try { records = parse(csv, { bom: true, skip_empty_lines: true, max_record_size: 4096, relax_column_count: false }); }
    catch { return bad('submissions.csv 格式错误'); }
    if (records.length < 2 || records.length > LIMITS.rows + 1) bad('每批需要 1–500 条提交');
    if (records[0].join(',') !== 'uid,problem,file,language') bad('表头必须为 uid,problem,file,language');
    const rows: InputRow[] = [], used = new Set<string>();
    for (const [index, cells] of records.slice(1).entries()) {
      const [uidText, problem, filename, language] = cells;
      if (!/^[1-9]\d{0,9}$/.test(uidText) || !Number.isSafeInteger(+uidText)) bad(`第 ${index + 2} 行 UID 无效`);
      if (!problem && !filename && !language) {
        rows.push({ line: index + 2, uid: +uidText, problem: '', file: '', language: '', code: '', hash: '' });
        continue;
      }
      if (!/^(?:[A-Z]{1,3}|[1-9]\d{0,9})$/.test(problem)) bad(`第 ${index + 2} 行题号无效`);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,63}$/.test(language)) bad(`第 ${index + 2} 行语言无效`);
      safePath(filename);
      if (filename === 'submissions.csv' || used.has(filename)) bad('每个代码文件只能引用一次');
      const entry = files.get(filename);
      if (!entry) bad(`第 ${index + 2} 行对应代码文件不存在`);
      const code = text(await read(entry!, LIMITS.code), filename);
      if (!code.trim()) bad(`第 ${index + 2} 行代码为空`);
      used.add(filename);
      rows.push({ line: index + 2, uid: +uidText, problem, file: filename, language, code, hash: createHash('sha256').update(code).digest('hex') });
    }
    if (files.size !== used.size + 1) bad('ZIP 含清单未引用的文件，请移除后再上传');
    return rows;
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError(400, 'ZIP 无法读取、校验失败或处理超时');
  } finally { clearTimeout(timer); await reader.close().catch(() => {}); }
}

import JSZip from 'jszip';
import type { BundleFile } from './generator.js';

/**
 * PER_TABLE ZIP 패키징(설계서 §6.10): `{BIZ_CD}/{NN}_{TABLE}.sql` + `_warnings.txt`, UTF-8(BOM 없음), DEFLATE.
 * 파일 시각은 생성 일시로 고정한다(같은 입력이면 같은 목록·내용).
 */
export async function zipFiles(files: readonly BundleFile[], date: Date): Promise<Buffer> {
  const zip = new JSZip();
  for (const f of files) zip.file(f.name, f.content, { date, createFolders: false });
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });
}

/** 테스트·검증용: ZIP → {경로: 내용}. */
export async function unzipText(buf: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, string> = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) out[name] = await entry.async('string');
  }
  return out;
}

import type JSZip from 'jszip';
import { api } from '../lib/api';
import type { Document } from '../types/document';
import { saveBlob, toFileName } from '../utils/download';

/**
 * Exportação de projetos LaTeX. O ZIP tem os caminhos relativos originais e
 * tudo o que é preciso para recompilar (não inclui o PDF: PDF é resultado, não
 * código-fonte).
 */

/** Põe todos os arquivos do projeto dentro de `zip` (ou de uma subpasta dele). */
export async function addProjectToZip(zip: JSZip, docId: string): Promise<void> {
  const { files } = await api.latex.listFiles(docId);
  for (const file of files) {
    if (file.kind === 'text') zip.file(file.path, file.content ?? '');
    else zip.file(file.path, await api.latex.readFile(docId, file.path));
  }
}

export async function downloadProjectZip(doc: Document): Promise<void> {
  const { default: JSZipCtor } = await import('jszip');
  const zip = new JSZipCtor();
  await addProjectToZip(zip, doc.id);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  saveBlob(blob, toFileName(doc.title, '.zip'));
}

/** Um arquivo de texto do projeto (ex.: o .tex aberto no editor). */
export function downloadTextFile(path: string, content: string): void {
  const name = path.slice(path.lastIndexOf('/') + 1);
  saveBlob(new Blob([content], { type: 'text/x-tex;charset=utf-8' }), name);
}

export function downloadPdf(title: string, pdf: Uint8Array): void {
  saveBlob(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), toFileName(title, '.pdf'));
}

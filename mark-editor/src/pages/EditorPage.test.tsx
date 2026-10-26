// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Document } from '../types/document';

const state = vi.hoisted(() => ({
  documents: [] as Document[],
  selectedDocument: null as Document | null,
  isLoading: true,
}));

vi.mock('../context/DocumentsContext', () => ({
  useDocuments: () => ({
    ...state,
    folders: [],
    selectDocument: vi.fn(),
    updateDocument: vi.fn(),
  }),
}));
for (const component of [
  '../components/DocumentList/DocumentList',
  '../components/Toolbar/Toolbar',
  '../components/Editor/Editor',
  '../components/Preview/Preview',
  '../components/ThemeToggle/ThemeToggle',
  '../components/SaveIndicator/SaveIndicator',
  '../components/MobileMenu/MobileMenu',
  '../components/UserMenu/UserMenu',
]) {
  vi.doMock(component, () => ({ default: () => null }));
}
vi.mock('../components/FullScreenLoader/FullScreenLoader', () => ({ default: () => <p>carregando</p> }));

const { default: EditorPage } = await import('./EditorPage');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOC: Document = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Fictício', content: '', folderId: null, updatedAt: '2026-10-26T00:00:00.000Z' };

let container: HTMLDivElement;
let root: Root;

const render = async () => {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/doc/${DOC.id}`]}>
        <Routes>
          <Route path="/" element={<p>página inicial</p>} />
          <Route path="/doc/:id" element={<EditorPage />} />
        </Routes>
      </MemoryRouter>
    );
  });
};

beforeEach(() => {
  state.documents = [];
  state.selectedDocument = null;
  state.isLoading = true;
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('abrir /doc/:id direto (link ou recarregar a página)', () => {
  it('a carga termina antes de a seleção ser aplicada: continua no documento', async () => {
    await render();
    expect(container.textContent).toBe('carregando');

    // Render em que a carga terminou e o documento está na lista, mas a
    // seleção ainda não chegou: antes, este estado mandava para a página inicial.
    state.documents = [DOC];
    state.isLoading = false;
    await render();
    expect(container.textContent).not.toBe('página inicial');

    state.selectedDocument = DOC;
    await render();
    expect(container.textContent).not.toBe('página inicial');
  });

  it('documento que não existe (ou não é do usuário): volta para a página inicial', async () => {
    await render();
    state.documents = [];
    state.isLoading = false;
    await render();
    expect(container.textContent).toBe('página inicial');
  });
});

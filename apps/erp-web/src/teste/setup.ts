import '@testing-library/jest-dom/vitest';
import { configurarZodPtBr } from '@genesis/shared';
import { notifications } from '@mantine/notifications';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

configurarZodPtBr();

// APIs do navegador que o Mantine usa e o jsdom não tem.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

class ResizeObserverFalso {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverFalso as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = () => {};
// `<Textarea autosize>` ouve `document.fonts` (FontFaceSet), que o jsdom não implementa.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', {
    value: { addEventListener: () => {}, removeEventListener: () => {}, ready: Promise.resolve() },
  });
}

afterEach(() => {
  // O store de notificações do Mantine é global: um aviso de um teste não pode vazar para o próximo.
  notifications.clean();
  notifications.cleanQueue();
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

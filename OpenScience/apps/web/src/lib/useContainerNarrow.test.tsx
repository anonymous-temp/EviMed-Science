import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { expect, it, vi } from 'vitest';
import { useContainerNarrow } from './useContainerNarrow';
function Probe() { const ref = useRef<HTMLDivElement>(null); const narrow = useContainerNarrow(ref, 640); return <div ref={ref}>{narrow ? 'narrow' : 'wide'}</div>; }
it('measures window resizes without ResizeObserver and cleans the listener', () => {
  vi.stubGlobal('ResizeObserver', undefined);
  let width = 1000;
  const geometry = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  const remove = vi.spyOn(window, 'removeEventListener');
  try {
    const { unmount } = render(<Probe />);
    expect(screen.getByText('wide')).toBeVisible();
    width = 500;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.getByText('narrow')).toBeVisible();
    unmount();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  } finally { geometry.mockRestore(); remove.mockRestore(); vi.unstubAllGlobals(); }
});

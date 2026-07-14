/**
 * SplitView — recursive renderer for a SplitTree with draggable dividers.
 * (Ported from avocado/apps/ghostty.)
 */

import { useRef, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { SplitTree } from '../split-tree.js';

export interface SplitViewProps {
  tree: SplitTree;
  renderPane: (paneId: string) => ReactNode;
  onRatioChange: (splitId: string, ratio: number) => void;
}

export function SplitView({ tree, renderPane, onRatioChange }: SplitViewProps): JSX.Element {
  if (tree.type === 'leaf') {
    return <>{renderPane(tree.paneId)}</>;
  }
  return <SplitContainer node={tree} renderPane={renderPane} onRatioChange={onRatioChange} />;
}

function SplitContainer({
  node,
  renderPane,
  onRatioChange,
}: {
  node: Extract<SplitTree, { type: 'split' }>;
  renderPane: (paneId: string) => ReactNode;
  onRatioChange: (splitId: string, ratio: number) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  const onDividerPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const divider = event.currentTarget;
    const pointerId = event.pointerId;
    divider.setPointerCapture?.(pointerId);

    const move = (moveEvent: PointerEvent): void => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const fraction =
        node.dir === 'row'
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height;
      onRatioChange(node.id, Math.min(0.9, Math.max(0.1, fraction)));
    };
    const up = (): void => {
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', up);
      divider.removeEventListener('pointercancel', up);
      if (divider.hasPointerCapture?.(pointerId)) {
        divider.releasePointerCapture(pointerId);
      }
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up);
    divider.addEventListener('pointercancel', up);
  };

  return (
    <div ref={containerRef} className="split" style={{ flexDirection: node.dir }}>
      <div className="split-cell" style={{ flexGrow: node.ratio }}>
        <SplitView tree={node.a} renderPane={renderPane} onRatioChange={onRatioChange} />
      </div>
      <div
        className={`divider ${node.dir}`}
        onPointerDown={onDividerPointerDown}
        role="separator"
        aria-orientation={node.dir === 'row' ? 'vertical' : 'horizontal'}
      />
      <div className="split-cell" style={{ flexGrow: 1 - node.ratio }}>
        <SplitView tree={node.b} renderPane={renderPane} onRatioChange={onRatioChange} />
      </div>
    </div>
  );
}

export default SplitView;

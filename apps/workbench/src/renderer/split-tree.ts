/**
 * Split tree — pure model for Ghostty-style pane splits.
 *
 * A tab's layout is a binary tree: leaves are panes, internal nodes are
 * splits with a direction and ratio. All operations return new trees.
 * (Ported from avocado/apps/ghostty.)
 */

export type SplitDirection = 'row' | 'column';

export type SplitTree =
  | { type: 'leaf'; paneId: string }
  | {
      type: 'split';
      id: string;
      dir: SplitDirection;
      /** Fraction of space given to `a` (0..1). */
      ratio: number;
      a: SplitTree;
      b: SplitTree;
    };

export function leaf(paneId: string): SplitTree {
  return { type: 'leaf', paneId };
}

/**
 * Replace the `targetPaneId` leaf with a split holding the existing pane
 * in `a` and the new pane in `b` (Ghostty: new split goes right/down).
 */
export function splitPane(
  tree: SplitTree,
  targetPaneId: string,
  newPaneId: string,
  dir: SplitDirection,
  splitId: string,
): SplitTree {
  if (tree.type === 'leaf') {
    if (tree.paneId !== targetPaneId) return tree;
    return { type: 'split', id: splitId, dir, ratio: 0.5, a: tree, b: leaf(newPaneId) };
  }
  return {
    ...tree,
    a: splitPane(tree.a, targetPaneId, newPaneId, dir, splitId),
    b: splitPane(tree.b, targetPaneId, newPaneId, dir, splitId),
  };
}

/** Remove a pane; collapses its parent split. Returns null if the tree empties. */
export function removePane(tree: SplitTree, paneId: string): SplitTree | null {
  if (tree.type === 'leaf') {
    return tree.paneId === paneId ? null : tree;
  }
  const a = removePane(tree.a, paneId);
  const b = removePane(tree.b, paneId);
  if (a && b) return { ...tree, a, b };
  return a ?? b;
}

/** Pane ids in visual (in-order) traversal. */
export function panesOf(tree: SplitTree): string[] {
  if (tree.type === 'leaf') return [tree.paneId];
  return [...panesOf(tree.a), ...panesOf(tree.b)];
}

export function setSplitRatio(tree: SplitTree, splitId: string, ratio: number): SplitTree {
  if (tree.type === 'leaf') return tree;
  if (tree.id === splitId) return { ...tree, ratio };
  return {
    ...tree,
    a: setSplitRatio(tree.a, splitId, ratio),
    b: setSplitRatio(tree.b, splitId, ratio),
  };
}

/** Cyclic next (+1) / previous (-1) pane relative to `paneId`. */
export function neighborPane(tree: SplitTree, paneId: string, offset: 1 | -1): string | null {
  const panes = panesOf(tree);
  const index = panes.indexOf(paneId);
  if (index === -1 || panes.length === 0) return null;
  return panes[(index + offset + panes.length) % panes.length] ?? null;
}

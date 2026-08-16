// Message threading + branch linearization (Part F).
//
// The DB stores messages as a flat list, but each carries a parentMessageId,
// so the conversation is really a tree. A node's children are the alternative
// replies to it — e.g. the user edits their question, or the assistant is
// regenerated. Editing and regenerating never mutate an existing message;
// they append a *new* sibling under the same parent (see firestore-db.ts
// saveMessage, which computes siblingIndex by counting existing children).
//
// What the UI needs is a single visible path: for each node, pick its
// "active" child branch and walk it down to a leaf. That walk is
// linearizeForest below. The active child defaults to the last sibling
// (newest edit/regenerate wins), and the branch switcher flips it.

export interface TreeMessage {
  id: string;
  role: 'user' | 'assistant';
  parentMessageId?: string | null;
  siblingIndex?: number;
  [key: string]: any;
}

// A node in the assembled forest: the message payload plus its tree state.
// Using a concrete (non-generic) node type keeps the recursive child typing
// honest — the self-referential generic tore up the type checker without
// buying anything, since `children` is treated structurally everywhere.
export interface TreeNode extends TreeMessage {
  children: TreeNode[];
  activeChildIndex: number;
}

/**
 * Assemble a flat message list into a forest. Returns the root nodes, each
 * carrying a `children` array (its branches) and an `activeChildIndex`
 * pointing at whichever child is currently the visible branch.
 *
 * Roots are the messages with no parentMessageId (null/undefined). For old
 * conversations imported before threading existed, every message is a root —
 * which yields a forest of single-node trees that linearizes back into the
 * original flat order, so legacy history is untouched.
 *
 * Robustness: if a parent id points at a node that isn't in this batch (a
 * message we failed to read, or — in pathological cases — a cycle), the
 * orphaned node is promoted to a root rather than dropped. We never lose a
 * message and never infinite-loop.
 */
export function buildMessageForest(flat: TreeMessage[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  const nodes: TreeNode[] = flat.map((m) => ({
    ...m,
    children: [],
    activeChildIndex: 0,
  }));
  for (const n of nodes) byId.set(n.id, n);

  const roots: TreeNode[] = [];
  for (const n of nodes) {
    const parentId = n.parentMessageId ?? null;
    if (parentId && byId.has(parentId)) {
      const parent = byId.get(parentId)!;
      // Guard against a cycle: adding the edge parent→n closes a loop iff n is
      // already an ancestor of parent (walking parent's parentMessageId chain
      // reaches n). If so, promote n to a root rather than wiring the cycle.
      // (Created ids are random UUIDs so a genuine cycle is near-impossible,
      // but defending it costs nothing and the DB is not trusted input.)
      if (!isAncestor(n.id, parentId, byId)) {
        parent.children.push(n);
        continue;
      }
    }
    // No resolvable parent → root. This covers legacy null-parent messages
    // *and* orphaned ids *and* cycles.
    roots.push(n);
  }

  // Sort each node's children by siblingIndex (then by creation time as a
  // stable tiebreak once createdAt is attached by the caller), and default the
  // active child to the newest sibling — latest edit/regenerate wins, which is
  // what a user expects when they reopen a branched conversation.
  for (const n of nodes) {
    n.children.sort(
      (a, b) =>
        ((a.siblingIndex ?? 0) - (b.siblingIndex ?? 0)) ||
        nodeTime(a) - nodeTime(b)
    );
    if (n.children.length > 0) {
      n.activeChildIndex = n.children.length - 1;
    }
  }

  return roots;
}

// createdAt comparison helper for the sibling tiebreak. Falls back to 0 for
// nodes that don't carry a createdAt (e.g. brand-new UI placeholders), so the
// sort stays total and stable.
function nodeTime(n: TreeMessage): number {
  const c = n.createdAt;
  if (typeof c === 'string') {
    const t = Date.parse(c);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

/**
 * Walk the active branch of each root down to its leaf and return the
 * resulting ordered list. Side effects: this leaves `activeChildIndex` on
 * the visible nodes as-is and produces a flat array the message list can
 * render directly.
 *
 * Each emitted node is annotated with `__branchIndex` and `__branchCount`
 * describing its position among its siblings — so a message that is one of
 * three regenerations of the previous turn reports branchCount 3. The branch
 * switcher UI reads those two fields. Roots (no parent) report count 1 /
 * index 1, so the switcher is hidden unless a node genuinely has siblings.
 */
export function linearizeForest(forest: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (node: TreeNode, branchIndex: number, branchCount: number) => {
    (node as any).__branchIndex = branchIndex;
    (node as any).__branchCount = branchCount;
    out.push(node);
    const kids = node.children ?? [];
    if (kids.length === 0) return;
    const idx = Math.min(node.activeChildIndex ?? kids.length - 1, kids.length - 1);
    if (idx < 0) return;
    // The active child is one of `kids.length` siblings; its branch index
    // within that group is idx+1 (1-based for display).
    visit(kids[idx], idx + 1, kids.length);
  };
  for (const root of forest) visit(root, 1, 1);
  return out;
}

/**
 * Switch the active child of a specific node and re-linearize. Returns a new
 * flat list. Mutates the forest's `activeChildIndex` on the target parent in
 * place (the caller owns the forest), then re-derives the rendered list.
 */
export function switchBranch(
  forest: TreeNode[],
  parentId: string,
  direction: 'prev' | 'next'
): TreeNode[] {
  const walk = (node: TreeNode) => {
    if (node.id === parentId && node.children.length > 0) {
      const cur = node.activeChildIndex ?? node.children.length - 1;
      const next = direction === 'next'
        ? Math.min(cur + 1, node.children.length - 1)
        : Math.max(cur - 1, 0);
      node.activeChildIndex = next;
      return;
    }
    const cur = node.activeChildIndex ?? (node.children.length ? node.children.length - 1 : 0);
    const kids = node.children ?? [];
    if (kids.length === 0) return;
    walk(kids[Math.min(cur, kids.length - 1)]);
  };
  forest.forEach(walk);
  // Always re-linearize so the visible path reflects the (possibly) new branch.
  return linearizeForest(forest);
}

function isAncestor(
  candidateAncestorId: string,
  descendantId: string,
  byId: Map<string, TreeNode>
): boolean {
  // Walk up from `descendantId`; if we ever reach `candidateAncestorId`, the
  // edge candidateAncestor→descendant would close a cycle.
  let cur: string | undefined = descendantId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur === candidateAncestorId) return true;
    cur = byId.get(cur)?.parentMessageId ?? undefined;
  }
  return false;
}

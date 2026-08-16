import { describe, it, expect } from 'vitest';
import { buildMessageForest, linearizeForest, switchBranch, type TreeMessage } from '@/lib/message-tree';

// Helpers build minimal tree messages. createdAt is a parseable ISO string so
// the sibling tiebreak has something deterministic to order on.
let clock = 0;
const msg = (
  id: string,
  role: 'user' | 'assistant',
  parent: string | null = null,
  siblingIndex = 0,
  content = ''
): TreeMessage => ({
  id,
  role,
  parentMessageId: parent,
  siblingIndex,
  content,
  createdAt: new Date(clock++ * 1000).toISOString(),
});

describe('message-tree', () => {
  it('linearizes a legacy flat list (all roots) in createdAt order', () => {
    clock = 0;
    const flat = [
      msg('u1', 'user'),
      msg('a1', 'assistant'),
      msg('u2', 'user'),
      msg('a2', 'assistant'),
    ];
    const forest = buildMessageForest(flat);
    // No parentMessageId on any of them → four single-node roots.
    expect(forest).toHaveLength(4);
    const out = linearizeForest(forest);
    expect(out.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    // All roots report branch 1/1 → no switcher anywhere.
    expect(out.every((m) => (m as any).__branchCount === 1)).toBe(true);
  });

  it('walks a threaded chain down to the leaf', () => {
    clock = 0;
    const flat = [
      msg('u1', 'user'),
      { ...msg('a1', 'assistant', 'u1'), id: 'a1' },
      { ...msg('u2', 'user', 'a1'), id: 'u2' },
      { ...msg('a2', 'assistant', 'u2'), id: 'a2' },
    ] as TreeMessage[];
    const out = linearizeForest(buildMessageForest(flat));
    expect(out.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    // One root only.
    expect(out.filter((m) => (m as any).__branchCount === 1)).toHaveLength(4);
  });

  it('treats a regenerated reply as a sibling under the same parent', () => {
    clock = 0;
    // u1 → a1 (first try), u1 → a2 (regenerate). Two children of u1.
    const flat = [
      { ...msg('u1', 'user'), id: 'u1' },
      { ...msg('a1', 'assistant', 'u1', 0), id: 'a1' },
      { ...msg('a2', 'assistant', 'u1', 1), id: 'a2' },
    ] as TreeMessage[];
    const forest = buildMessageForest(flat);
    const u1 = forest.find((n) => n.id === 'u1')!;
    expect(u1.children.map((c) => c.id)).toEqual(['a1', 'a2']);
    // Newest sibling (a2) is the visible one by default.
    expect(u1.activeChildIndex).toBe(1);
    const out = linearizeForest(forest);
    expect(out.map((m) => m.id)).toEqual(['u1', 'a2']);
    // u1 is a sole root (1/1), a2 reports it's branch 2 of 2.
    const a2 = out.find((m) => m.id === 'a2')!;
    expect((a2 as any).__branchIndex).toBe(2);
    expect((a2 as any).__branchCount).toBe(2);
  });

  it('switchBranch flips the visible sibling and re-linearizes without rereading', () => {
    clock = 0;
    const flat = [
      { ...msg('u1', 'user'), id: 'u1' },
      { ...msg('a1', 'assistant', 'u1', 0), id: 'a1' },
      { ...msg('a2', 'assistant', 'u1', 1), id: 'a2' },
    ] as TreeMessage[];
    const forest = buildMessageForest(flat);
    // Start on the newest branch (a2).
    expect(linearizeForest(forest).map((m) => m.id)).toEqual(['u1', 'a2']);
    // Switch back to the older branch.
    const prev = switchBranch(forest, 'u1', 'prev');
    expect(prev.map((m) => m.id)).toEqual(['u1', 'a1']);
    // The older branch reports index 1 of 2.
    expect((prev[1] as any).__branchIndex).toBe(1);
    expect((prev[1] as any).__branchCount).toBe(2);
    // Switch next again returns to a2.
    const next = switchBranch(forest, 'u1', 'next');
    expect(next.map((m) => m.id)).toEqual(['u1', 'a2']);
  });

  it('clamps the switcher at the ends (prev past oldest stays, next past newest stays)', () => {
    clock = 0;
    const flat = [
      { ...msg('u1', 'user'), id: 'u1' },
      { ...msg('a1', 'assistant', 'u1', 0), id: 'a1' },
      { ...msg('a2', 'assistant', 'u1', 1), id: 'a2' },
    ] as TreeMessage[];
    const forest = buildMessageForest(flat);
    // Already on newest (a2); next is a no-op.
    expect(switchBranch(forest, 'u1', 'next').map((m) => m.id)).toEqual(['u1', 'a2']);
    // Jump to oldest then prev again — no-op.
    switchBranch(forest, 'u1', 'prev');
    expect(switchBranch(forest, 'u1', 'prev').map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('edit-as-sibling: editing u1 produces a new child of u1s parent (its grandparent), i.e. a sibling of u1', () => {
    clock = 0;
    // Chain: u1 (root) -> a1 -> u2 (reply to a1). Then u2 is edited: new u2-new is a
    // sibling of u2 under a1.
    const flat = [
      { ...msg('u1', 'user', null, 0), id: 'u1' },
      { ...msg('a1', 'assistant', 'u1', 0), id: 'a1' },
      { ...msg('u2old', 'user', 'a1', 0), id: 'u2old' },
      { ...msg('u2new', 'user', 'a1', 1), id: 'u2new' }, // the edit
    ] as TreeMessage[];
    const forest = buildMessageForest(flat);
    // a1 is a child of u1, so it isn't one of the roots; find it by id.
    const findNode = (nodes: any[], id: string): any => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const r = findNode(n.children ?? [], id);
        if (r) return r;
      }
      return undefined;
    };
    const a1 = findNode(forest, 'a1')!;
    expect(a1.children.map((c) => c.id)).toEqual(['u2old', 'u2new']);
    // Newest edit wins on load.
    expect(linearizeForest(forest).map((m) => m.id)).toEqual(['u1', 'a1', 'u2new']);
    // Switch back to the original wording.
    expect(switchBranch(forest, 'a1', 'prev').map((m) => m.id)).toEqual(['u1', 'a1', 'u2old']);
  });

  it('promotes an orphaned parentMessageId to a root rather than dropping the message', () => {
    clock = 0;
    // a1 claims a parent "ghost" that is not in the batch.
    const flat = [
      { ...msg('u1', 'user', null, 0), id: 'u1' },
      { ...msg('a1', 'assistant', 'ghost', 0), id: 'a1' },
    ] as TreeMessage[];
    const forest = buildMessageForest(flat);
    // a1 becomes its own root; nothing is lost.
    expect(forest.map((n) => n.id).sort()).toEqual(['a1', 'u1']);
  });

  it('breaks a pathological self-cycle by promoting the cyclic node to root', () => {
    clock = 0;
    // a1 points at a2, a2 points at a1. Both must not be each other's children.
    const flat = [
      { ...msg('a1', 'assistant', 'a2', 0), id: 'a1' },
      { ...msg('a2', 'assistant', 'a1', 0), id: 'a2' },
    ] as TreeMessage[];
    const forest = buildMessageForest(flat);
    // Two roots, no infinite loop, no children linking back.
    expect(forest).toHaveLength(2);
    expect(forest.every((n) => n.children.length === 0)).toBe(true);
  });

  it('sorts siblings by siblingIndex when createdAt ties', () => {
    clock = 0;
    const t = new Date(1000).toISOString();
    const flat = [
      { ...msg('u1', 'user', null, 0), id: 'u1', createdAt: t },
      { ...msg('a2', 'assistant', 'u1', 2), id: 'a2', createdAt: t },
      { ...msg('a1', 'assistant', 'u1', 1), id: 'a1', createdAt: t },
      { ...msg('a0', 'assistant', 'u1', 0), id: 'a0', createdAt: t },
    ] as TreeMessage[];
    const forest = buildMessageForest(flat);
    const u1 = forest.find((n) => n.id === 'u1')!;
    expect(u1.children.map((c) => c.id)).toEqual(['a0', 'a1', 'a2']);
    // Newest (highest index) wins on load.
    expect(linearizeForest(forest).map((m) => m.id)).toEqual(['u1', 'a2']);
  });
});

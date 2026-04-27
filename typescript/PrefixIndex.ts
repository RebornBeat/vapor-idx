// =============================================================================
// vapor-idx — indexes/PrefixIndex.ts
// Trie-based prefix index: field → trie → Set<recordId> per prefix
// Supports: startsWith
// =============================================================================

interface TrieNode {
  ids:      Set<string>;
  children: Map<string, TrieNode>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export class PrefixIndex {
  // field → trie root
  private readonly roots: Map<string, TrieNode> = new Map();
  // id → [(field, normalisedValue)] for O(len) removal
  private readonly recordPaths: Map<string, [string, string][]> = new Map();

  // ── Mutation ───────────────────────────────────────────────────────────────

  add(field: string, value: unknown, id: string): void {
    if (value === null || value === undefined) return;

    const rawValues = Array.isArray(value) ? value : [value];

    for (const raw of rawValues) {
      const normalised = String(raw).toLowerCase();
      if (normalised.length === 0) continue;

      this.insertIntoTrie(field, normalised, id);

      let paths = this.recordPaths.get(id);
      if (paths === undefined) {
        paths = [];
        this.recordPaths.set(id, paths);
      }
      paths.push([field, normalised]);
    }
  }

  private insertIntoTrie(field: string, value: string, id: string): void {
    let root = this.roots.get(field);
    if (root === undefined) {
      root = makeNode();
      this.roots.set(field, root);
    }

    let node = root;
    // Insert id at every prefix length so startsWith('par') hits 'parser'
    for (let i = 0; i < value.length; i++) {
      const char  = value[i];
      let   child = node.children.get(char);
      if (child === undefined) {
        child = makeNode();
        node.children.set(char, child);
      }
      child.ids.add(id);
      node = child;
    }
  }

  remove(field: string, value: unknown, id: string): void {
    if (value === null || value === undefined) return;

    const rawValues = Array.isArray(value) ? value : [value];

    for (const raw of rawValues) {
      const normalised = String(raw).toLowerCase();
      this.removeFromTrie(field, normalised, id);
    }

    this.recordPaths.delete(id);
  }

  private removeFromTrie(field: string, value: string, id: string): void {
    const root = this.roots.get(field);
    if (root === undefined) return;

    let node = root;
    for (const char of value) {
      const child = node.children.get(char);
      if (child === undefined) return;
      child.ids.delete(id);
      node = child;
    }
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  startsWith(field: string, prefix: string): Set<string> {
    const normalised = prefix.toLowerCase();
    const root       = this.roots.get(field);
    if (root === undefined) return EMPTY_SET as Set<string>;

    let node = root;
    for (const char of normalised) {
      const child = node.children.get(char);
      if (child === undefined) return EMPTY_SET as Set<string>;
      node = child;
    }

    // node.ids contains all record IDs that have a value with this prefix
    return new Set(node.ids);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  clear(): void {
    this.roots.clear();
    this.recordPaths.clear();
  }

  get nodeCount(): number {
    let count = 0;
    for (const root of this.roots.values()) {
      count += countNodes(root);
    }
    return count;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(): TrieNode {
  return { ids: new Set(), children: new Map() };
}

function countNodes(node: TrieNode): number {
  let n = 1;
  for (const child of node.children.values()) n += countNodes(child);
  return n;
}

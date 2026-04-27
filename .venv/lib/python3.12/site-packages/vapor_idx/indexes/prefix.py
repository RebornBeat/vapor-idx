# =============================================================================
# vapor-idx — indexes/prefix.py
# Trie-based prefix index.
# Supports: startsWith
# =============================================================================

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any


@dataclass
class _TrieNode:
    ids:      set[str]          = field(default_factory=set)
    children: dict[str, "_TrieNode"] = field(default_factory=dict)


class PrefixIndex:
    def __init__(self) -> None:
        # field → trie root
        self._roots: dict[str, _TrieNode] = {}

    # ── Mutation ───────────────────────────────────────────────────────────────

    def add(self, field: str, value: Any, record_id: str) -> None:
        if value is None:
            return
        raw_values = value if isinstance(value, list) else [value]
        for raw in raw_values:
            normalised = str(raw).lower()
            if not normalised:
                continue
            if field not in self._roots:
                self._roots[field] = _TrieNode()
            node = self._roots[field]
            for char in normalised:
                if char not in node.children:
                    node.children[char] = _TrieNode()
                node = node.children[char]
                node.ids.add(record_id)

    def remove(self, field: str, value: Any, record_id: str) -> None:
        if value is None:
            return
        raw_values = value if isinstance(value, list) else [value]
        root = self._roots.get(field)
        if not root:
            return
        for raw in raw_values:
            normalised = str(raw).lower()
            node = root
            for char in normalised:
                child = node.children.get(char)
                if not child:
                    break
                child.ids.discard(record_id)
                node = child

    # ── Lookup ─────────────────────────────────────────────────────────────────

    def starts_with(self, field: str, prefix: str) -> set[str]:
        normalised = prefix.lower()
        root = self._roots.get(field)
        if not root:
            return set()
        node = root
        for char in normalised:
            child = node.children.get(char)
            if not child:
                return set()
            node = child
        return set(node.ids)

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def clear(self) -> None:
        self._roots.clear()

    @property
    def node_count(self) -> int:
        return sum(_count_nodes(root) for root in self._roots.values())


def _count_nodes(node: _TrieNode) -> int:
    return 1 + sum(_count_nodes(c) for c in node.children.values())

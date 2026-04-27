// =============================================================================
// vapor-idx — indexes/prefix.rs
// Trie-based prefix index.
// Supports: starts_with
// =============================================================================

use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
struct TrieNode {
    ids:      HashSet<String>,
    children: HashMap<char, TrieNode>,
}

#[derive(Debug, Default)]
pub struct PrefixIndex {
    roots: HashMap<String, TrieNode>,
}

impl PrefixIndex {
    pub fn new() -> Self { Self::default() }

    pub fn add(&mut self, field: &str, value: &serde_json::Value, id: &str) {
        let texts: Vec<String> = match value {
            serde_json::Value::String(s) => vec![s.clone()],
            serde_json::Value::Array(arr) => arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
            _ => return,
        };

        let root = self.roots.entry(field.to_owned()).or_default();
        for text in texts {
            let normalised = text.to_lowercase();
            let mut node = root as *mut TrieNode;
            for ch in normalised.chars() {
                // SAFETY: single-threaded, no aliasing
                let n = unsafe { &mut *node };
                node = n.children.entry(ch).or_default() as *mut TrieNode;
                unsafe { (*node).ids.insert(id.to_owned()) };
            }
        }
    }

    pub fn remove(&mut self, field: &str, value: &serde_json::Value, id: &str) {
        let texts: Vec<String> = match value {
            serde_json::Value::String(s) => vec![s.clone()],
            serde_json::Value::Array(arr) => arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
            _ => return,
        };
        let Some(root) = self.roots.get_mut(field) else { return };
        for text in texts {
            let normalised = text.to_lowercase();
            let mut node = root as *mut TrieNode;
            for ch in normalised.chars() {
                let n = unsafe { &mut *node };
                let Some(child) = n.children.get_mut(&ch) else { break };
                child.ids.remove(id);
                node = child as *mut TrieNode;
            }
        }
    }

    pub fn starts_with(&self, field: &str, prefix: &str) -> HashSet<String> {
        let normalised = prefix.to_lowercase();
        let Some(root) = self.roots.get(field) else { return HashSet::new() };
        let mut node = root;
        for ch in normalised.chars() {
            let Some(child) = node.children.get(&ch) else { return HashSet::new() };
            node = child;
        }
        node.ids.clone()
    }

    pub fn clear(&mut self) { self.roots.clear(); }

    pub fn node_count(&self) -> usize {
        self.roots.values().map(count_nodes).sum()
    }
}

fn count_nodes(node: &TrieNode) -> usize {
    1 + node.children.values().map(count_nodes).sum::<usize>()
}

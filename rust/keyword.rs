// =============================================================================
// vapor-idx — indexes/keyword.rs
// Tokenised inverted index.
// =============================================================================

use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
pub struct KeywordIndex {
    // "field:token" → set<id>
    index:       HashMap<String, HashSet<String>>,
    // id → set<"field:token"> for O(degree) removal
    record_keys: HashMap<String, HashSet<String>>,
}

impl KeywordIndex {
    pub fn new() -> Self { Self::default() }

    pub fn add(&mut self, field: &str, value: &serde_json::Value, id: &str) {
        let texts: Vec<String> = match value {
            serde_json::Value::String(s) => vec![s.clone()],
            serde_json::Value::Array(arr) => arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
            _ => return,
        };

        let tokens: Vec<String> = texts.iter().flat_map(|t| tokenise(t)).collect();
        if tokens.is_empty() { return; }

        let key_set = self.record_keys.entry(id.to_owned()).or_default();
        for token in tokens {
            let composite = format!("{field}:{token}");
            self.index.entry(composite.clone()).or_default().insert(id.to_owned());
            key_set.insert(composite);
        }
    }

    pub fn remove(&mut self, id: &str) {
        if let Some(keys) = self.record_keys.remove(id) {
            for key in keys {
                if let Some(id_set) = self.index.get_mut(&key) {
                    id_set.remove(id);
                    if id_set.is_empty() { self.index.remove(&key); }
                }
            }
        }
    }

    pub fn search(&self, query: &[String]) -> HashSet<String> {
        let tokens: Vec<String> = query.iter().flat_map(|q| tokenise(q)).collect();
        if tokens.is_empty() { return HashSet::new(); }

        let per_token: Vec<HashSet<String>> = tokens.iter().map(|token| {
            let mut merged = HashSet::new();
            for (key, ids) in &self.index {
                if key.ends_with(&format!(":{token}")) {
                    merged.extend(ids.iter().cloned());
                }
            }
            merged
        }).collect();

        intersect_all(per_token)
    }

    pub fn contains(&self, field: &str, query: &[String]) -> HashSet<String> {
        let tokens: Vec<String> = query.iter().flat_map(|q| tokenise(q)).collect();
        if tokens.is_empty() { return HashSet::new(); }

        let per_token: Vec<HashSet<String>> = tokens.iter().map(|token| {
            let key = format!("{field}:{token}");
            self.index.get(&key).cloned().unwrap_or_default()
        }).collect();

        intersect_all(per_token)
    }

    pub fn clear(&mut self) { self.index.clear(); self.record_keys.clear(); }
    pub fn token_count(&self) -> usize { self.index.len() }
}

pub fn tokenise(value: &str) -> Vec<String> {
    value.to_lowercase()
         .split(|c: char| !c.is_alphanumeric())
         .filter(|t| t.len() > 2)
         .map(String::from)
         .collect()
}

fn intersect_all(mut sets: Vec<HashSet<String>>) -> HashSet<String> {
    if sets.is_empty() { return HashSet::new(); }
    sets.sort_by_key(|s| s.len());
    let mut result = sets[0].clone();
    for s in &sets[1..] {
        result.retain(|id| s.contains(id));
        if result.is_empty() { break; }
    }
    result
}

// =============================================================================
// vapor-idx — indexes/exact.rs
// Equality index: field → normalised_value → HashSet<record_id>
// Supports: eq, neq, in, not_in
// =============================================================================

use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
pub struct ExactIndex {
    // field → normalised_value → set<id>
    index: HashMap<String, HashMap<String, HashSet<String>>>,
}

impl ExactIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, field: &str, value: &serde_json::Value, id: &str) {
        match value {
            serde_json::Value::Array(items) => {
                for item in items {
                    self.add_single(field, &normalise(item), id);
                }
            }
            v => {
                self.add_single(field, &normalise(v), id);
            }
        }
    }

    fn add_single(&mut self, field: &str, key: &str, id: &str) {
        self.index
            .entry(field.to_owned())
            .or_default()
            .entry(key.to_owned())
            .or_default()
            .insert(id.to_owned());
    }

    pub fn remove(&mut self, field: &str, value: &serde_json::Value, id: &str) {
        match value {
            serde_json::Value::Array(items) => {
                for item in items {
                    self.remove_single(field, &normalise(item), id);
                }
            }
            v => self.remove_single(field, &normalise(v), id),
        }
    }

    fn remove_single(&mut self, field: &str, key: &str, id: &str) {
        if let Some(field_map) = self.index.get_mut(field) {
            if let Some(id_set) = field_map.get_mut(key) {
                id_set.remove(id);
                if id_set.is_empty() {
                    field_map.remove(key);
                }
            }
            if field_map.is_empty() {
                self.index.remove(field);
            }
        }
    }

    pub fn eq(&self, field: &str, value: &serde_json::Value) -> HashSet<String> {
        let key = normalise(value);
        self.index
            .get(field)
            .and_then(|m| m.get(&key))
            .cloned()
            .unwrap_or_default()
    }

    pub fn neq(&self, field: &str, value: &serde_json::Value) -> HashSet<String> {
        let excluded = normalise(value);
        let mut result = HashSet::new();
        if let Some(field_map) = self.index.get(field) {
            for (k, ids) in field_map {
                if k != &excluded {
                    result.extend(ids.iter().cloned());
                }
            }
        }
        result
    }

    pub fn find_in(&self, field: &str, values: &[serde_json::Value]) -> HashSet<String> {
        let mut result = HashSet::new();
        for v in values {
            result.extend(self.eq(field, v));
        }
        result
    }

    pub fn not_in(&self, field: &str, values: &[serde_json::Value]) -> HashSet<String> {
        let excluded: HashSet<String> = values.iter().map(normalise).collect();
        let mut result = HashSet::new();
        if let Some(field_map) = self.index.get(field) {
            for (k, ids) in field_map {
                if !excluded.contains(k) {
                    result.extend(ids.iter().cloned());
                }
            }
        }
        result
    }

    pub fn clear(&mut self) {
        self.index.clear();
    }

    pub fn entry_count(&self) -> usize {
        self.index.values().map(|m| m.len()).sum()
    }
}

fn normalise(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.to_lowercase(),
        serde_json::Value::Bool(b)   => if *b { "true".into() } else { "false".into() },
        v                            => v.to_string(),
    }
}

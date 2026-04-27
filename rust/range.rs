// =============================================================================
// vapor-idx — indexes/range.rs
// Sorted numeric index using binary search.
// Supports: gt, lt, gte, lte
// =============================================================================

use std::collections::{HashMap, HashSet};

#[derive(Debug, Default)]
pub struct RangeIndex {
    // field → sorted Vec<(value_bits, id)>
    index: HashMap<String, Vec<(u64, String)>>,
}

impl RangeIndex {
    pub fn new() -> Self { Self::default() }

    pub fn add(&mut self, field: &str, value: &serde_json::Value, id: &str) {
        let numbers: Vec<f64> = match value {
            serde_json::Value::Number(n) => n.as_f64().into_iter().collect(),
            serde_json::Value::Array(arr) => arr.iter()
                .filter_map(|v| v.as_f64())
                .collect(),
            _ => return,
        };

        let entries = self.index.entry(field.to_owned()).or_default();
        for num in numbers {
            let bits = num.to_bits();
            let pos = entries.partition_point(|(b, i)| b < &bits || (b == &bits && i.as_str() < id));
            entries.insert(pos, (bits, id.to_owned()));
        }
    }

    pub fn remove(&mut self, field: &str, value: &serde_json::Value, id: &str) {
        let numbers: Vec<f64> = match value {
            serde_json::Value::Number(n) => n.as_f64().into_iter().collect(),
            serde_json::Value::Array(arr) => arr.iter().filter_map(|v| v.as_f64()).collect(),
            _ => return,
        };
        let Some(entries) = self.index.get_mut(field) else { return };
        for num in numbers {
            let bits = num.to_bits();
            if let Ok(pos) = entries.binary_search(&(bits, id.to_owned())) {
                entries.remove(pos);
            }
        }
        if entries.is_empty() { self.index.remove(field); }
    }

    pub fn gt(&self, field: &str, threshold: f64) -> HashSet<String> {
        let entries = self.index.get(field).map(|v| v.as_slice()).unwrap_or(&[]);
        let bits = threshold.to_bits();
        // First position where value > threshold
        let pos = entries.partition_point(|(b, _)| *b <= bits);
        entries[pos..].iter().map(|(_, id)| id.clone()).collect()
    }

    pub fn gte(&self, field: &str, threshold: f64) -> HashSet<String> {
        let entries = self.index.get(field).map(|v| v.as_slice()).unwrap_or(&[]);
        let bits = threshold.to_bits();
        let pos = entries.partition_point(|(b, _)| *b < bits);
        entries[pos..].iter().map(|(_, id)| id.clone()).collect()
    }

    pub fn lt(&self, field: &str, threshold: f64) -> HashSet<String> {
        let entries = self.index.get(field).map(|v| v.as_slice()).unwrap_or(&[]);
        let bits = threshold.to_bits();
        let pos = entries.partition_point(|(b, _)| *b < bits);
        entries[..pos].iter().map(|(_, id)| id.clone()).collect()
    }

    pub fn lte(&self, field: &str, threshold: f64) -> HashSet<String> {
        let entries = self.index.get(field).map(|v| v.as_slice()).unwrap_or(&[]);
        let bits = threshold.to_bits();
        let pos = entries.partition_point(|(b, _)| *b <= bits);
        entries[..pos].iter().map(|(_, id)| id.clone()).collect()
    }

    pub fn clear(&mut self) { self.index.clear(); }

    pub fn entry_count(&self) -> usize {
        self.index.values().map(|v| v.len()).sum()
    }
}

// =============================================================================
// vapor-idx — indexes/range.rs
// Sorted numeric index using binary search.
// FIX: f64::to_bits() does not preserve ordering for negative floats.
//      f64_to_ordered_u64() applies the IEEE 754 sign-correction so that
//      numeric order and u64 order are identical across the full real line.
// =============================================================================

use std::collections::{HashMap, HashSet};

/// Convert f64 to a u64 that sorts in the same order as the original float.
///
/// Positive floats: XOR with sign bit → all land in upper half [2^63, 2^64-1]
///                  in correct numeric order.
/// Negative floats: flip all bits → more-negative values become smaller u64
///                  values (correct numeric order).
/// NaN / infinity: callers exclude these via is_finite() before calling.
#[inline]
fn f64_to_ordered_u64(f: f64) -> u64 {
    let bits = f.to_bits();
    if f.is_sign_positive() {
        bits ^ (1u64 << 63)
    } else {
        !bits
    }
}

#[derive(Debug, Default)]
pub struct RangeIndex {
    index: HashMap<String, Vec<(u64, String)>>,
}

impl RangeIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, field: &str, value: &serde_json::Value, id: &str) {
        let numbers: Vec<f64> = match value {
            serde_json::Value::Number(n) => n.as_f64().into_iter().collect(),
            serde_json::Value::Array(arr) => arr.iter().filter_map(|v| v.as_f64()).collect(),
            _ => return,
        };
        let entries = self.index.entry(field.to_owned()).or_default();
        for num in numbers {
            if !num.is_finite() {
                continue;
            }
            let bits = f64_to_ordered_u64(num);
            let pos =
                entries.partition_point(|(b, i)| b < &bits || (b == &bits && i.as_str() < id));
            entries.insert(pos, (bits, id.to_owned()));
        }
    }

    pub fn remove(&mut self, field: &str, value: &serde_json::Value, id: &str) {
        let numbers: Vec<f64> = match value {
            serde_json::Value::Number(n) => n.as_f64().into_iter().collect(),
            serde_json::Value::Array(arr) => arr.iter().filter_map(|v| v.as_f64()).collect(),
            _ => return,
        };
        let Some(entries) = self.index.get_mut(field) else {
            return;
        };
        for num in numbers {
            if !num.is_finite() {
                continue;
            }
            let bits = f64_to_ordered_u64(num);
            if let Ok(pos) = entries.binary_search(&(bits, id.to_owned())) {
                entries.remove(pos);
            }
        }
        if entries.is_empty() {
            self.index.remove(field);
        }
    }

    pub fn gt(&self, field: &str, threshold: f64) -> HashSet<String> {
        if !threshold.is_finite() {
            return HashSet::new();
        }
        let entries = self.index.get(field).map(|v| v.as_slice()).unwrap_or(&[]);
        let bits = f64_to_ordered_u64(threshold);
        let pos = entries.partition_point(|(b, _)| *b <= bits);
        entries[pos..].iter().map(|(_, id)| id.clone()).collect()
    }

    pub fn gte(&self, field: &str, threshold: f64) -> HashSet<String> {
        if !threshold.is_finite() {
            return HashSet::new();
        }
        let entries = self.index.get(field).map(|v| v.as_slice()).unwrap_or(&[]);
        let bits = f64_to_ordered_u64(threshold);
        let pos = entries.partition_point(|(b, _)| *b < bits);
        entries[pos..].iter().map(|(_, id)| id.clone()).collect()
    }

    pub fn lt(&self, field: &str, threshold: f64) -> HashSet<String> {
        if !threshold.is_finite() {
            return HashSet::new();
        }
        let entries = self.index.get(field).map(|v| v.as_slice()).unwrap_or(&[]);
        let bits = f64_to_ordered_u64(threshold);
        let pos = entries.partition_point(|(b, _)| *b < bits);
        entries[..pos].iter().map(|(_, id)| id.clone()).collect()
    }

    pub fn lte(&self, field: &str, threshold: f64) -> HashSet<String> {
        if !threshold.is_finite() {
            return HashSet::new();
        }
        let entries = self.index.get(field).map(|v| v.as_slice()).unwrap_or(&[]);
        let bits = f64_to_ordered_u64(threshold);
        let pos = entries.partition_point(|(b, _)| *b <= bits);
        entries[..pos].iter().map(|(_, id)| id.clone()).collect()
    }

    pub fn clear(&mut self) {
        self.index.clear();
    }
    pub fn entry_count(&self) -> usize {
        self.index.values().map(|v| v.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_negative_float_ordering() {
        let vals: &[f64] = &[-100.0, -2.5, -1.0, -0.0, 0.0, 1.0, 2.5, 100.0];
        let bits: Vec<u64> = vals.iter().map(|&f| f64_to_ordered_u64(f)).collect();
        for i in 1..bits.len() {
            assert!(
                bits[i - 1] <= bits[i],
                "{} should sort before {}",
                vals[i - 1],
                vals[i]
            );
        }
    }

    #[test]
    fn test_gt_with_negatives() {
        let mut idx = RangeIndex::new();
        idx.add("x", &serde_json::json!(-5.0), "a");
        idx.add("x", &serde_json::json!(-1.0), "b");
        idx.add("x", &serde_json::json!(0.0), "c");
        idx.add("x", &serde_json::json!(3.0), "d");
        let r = idx.gt("x", -2.0);
        assert!(r.contains("b") && r.contains("c") && r.contains("d") && !r.contains("a"));
    }

    #[test]
    fn test_lte_with_negatives() {
        let mut idx = RangeIndex::new();
        idx.add("x", &serde_json::json!(-10.0), "a");
        idx.add("x", &serde_json::json!(-1.0), "b");
        idx.add("x", &serde_json::json!(5.0), "c");
        let r = idx.lte("x", -1.0);
        assert!(r.contains("a") && r.contains("b") && !r.contains("c"));
    }
}

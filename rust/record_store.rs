// =============================================================================
// vapor-idx — record_store.rs
// Primary record storage and per-type index routing.
// =============================================================================

use crate::types::*;
use crate::indexes::{exact::ExactIndex, keyword::KeywordIndex, prefix::PrefixIndex, range::RangeIndex};
use crate::schema::{validate_record_data};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

struct TypeIndexes {
    exact:      ExactIndex,
    keyword:    KeywordIndex,
    prefix:     PrefixIndex,
    range:      RangeIndex,
    strategies: HashMap<String, IndexStrategy>,
}

pub struct RecordStore {
    pub schema:   VaporSchema,
    records:      HashMap<String, VaporRecord>,
    by_type:      HashMap<String, HashSet<String>>,
    type_indexes: HashMap<String, TypeIndexes>,
    counter:      u64,
}

impl RecordStore {
    pub fn new(schema: VaporSchema) -> Self {
        let mut by_type      = HashMap::new();
        let mut type_indexes = HashMap::new();

        for (type_name, type_def) in &schema.types {
            let mut strategies = HashMap::new();
            for (field_name, field_def) in &type_def.fields {
                strategies.insert(field_name.clone(), field_def.index.clone());
            }
            type_indexes.insert(type_name.clone(), TypeIndexes {
                exact:    ExactIndex::new(),
                keyword:  KeywordIndex::new(),
                prefix:   PrefixIndex::new(),
                range:    RangeIndex::new(),
                strategies,
            });
            by_type.insert(type_name.clone(), HashSet::new());
        }

        Self { schema, records: HashMap::new(), by_type, type_indexes, counter: 0 }
    }

    pub fn store(&mut self, type_name: &str, data: serde_json::Value) -> VaporResult<String> {
        let type_def = self.schema.types.get(type_name)
            .ok_or_else(|| VaporError::NotFound(format!("Unknown type \"{type_name}\"")))?;

        validate_record_data(type_name, type_def, &data)?;

        let id  = self.next_id();
        let now = now_ms();

        let record = VaporRecord {
            id:          id.clone(),
            record_type: type_name.to_owned(),
            data:        data.clone(),
            created_at:  now,
            updated_at:  now,
        };

        self.records.insert(id.clone(), record);
        self.by_type.entry(type_name.to_owned()).or_default().insert(id.clone());
        self.index_record(type_name, &id, &data);

        Ok(id)
    }

    pub fn update(&mut self, record_id: &str, partial: serde_json::Value) -> VaporResult<()> {
        let record = self.records.get(record_id)
            .ok_or_else(|| VaporError::NotFound(format!("Record \"{record_id}\" not found")))?
            .clone();

        let type_name = record.record_type.clone();
        let type_def  = self.schema.types.get(&type_name).unwrap();

        // Merge and validate
        let mut merged = record.data.clone();
        if let (Some(merged_obj), Some(partial_obj)) = (merged.as_object_mut(), partial.as_object()) {
            for (k, v) in partial_obj {
                merged_obj.insert(k.clone(), v.clone());
            }
        }
        validate_record_data(&type_name, type_def, &merged)?;

        // Unindex old values for changed fields
        if let Some(partial_obj) = partial.as_object() {
            for field_name in partial_obj.keys() {
                if let Some(old_val) = record.data.get(field_name) {
                    self.unindex_field(&type_name, record_id, field_name, old_val);
                }
            }
            // Re-index new values
            for (field_name, new_val) in partial_obj {
                self.index_field(&type_name, record_id, field_name, new_val);
            }
        }

        let updated = VaporRecord {
            id:          record_id.to_owned(),
            record_type: type_name,
            data:        merged,
            created_at:  record.created_at,
            updated_at:  now_ms(),
        };
        self.records.insert(record_id.to_owned(), updated);
        Ok(())
    }

    pub fn delete(&mut self, record_id: &str) {
        if let Some(record) = self.records.remove(record_id) {
            self.unindex_record(&record.record_type, record_id, &record.data);
            if let Some(ids) = self.by_type.get_mut(&record.record_type) {
                ids.remove(record_id);
            }
        }
    }

    pub fn get(&self, record_id: &str) -> Option<&VaporRecord> {
        self.records.get(record_id)
    }

    pub fn has(&self, record_id: &str) -> bool {
        self.records.contains_key(record_id)
    }

    pub fn get_all(&self) -> Vec<VaporRecord> {
        self.records.values().cloned().collect()
    }

    pub fn get_type_id_set(&self, type_name: &str) -> HashSet<String> {
        self.by_type.get(type_name).cloned().unwrap_or_default()
    }

    pub fn get_types(&self) -> Vec<String> {
        self.by_type.keys().cloned().collect()
    }

    pub fn exact(&self, type_name: &str)   -> Option<&ExactIndex>   { self.type_indexes.get(type_name).map(|ti| &ti.exact) }
    pub fn keyword(&self, type_name: &str) -> Option<&KeywordIndex> { self.type_indexes.get(type_name).map(|ti| &ti.keyword) }
    pub fn prefix(&self, type_name: &str)  -> Option<&PrefixIndex>  { self.type_indexes.get(type_name).map(|ti| &ti.prefix) }
    pub fn range(&self, type_name: &str)   -> Option<&RangeIndex>   { self.type_indexes.get(type_name).map(|ti| &ti.range) }

    pub fn index_stats(&self) -> IndexStats {
        let mut exact_entries = 0;
        let mut keyword_tokens = 0;
        let mut prefix_nodes = 0;
        let mut range_entries = 0;
        for ti in self.type_indexes.values() {
            exact_entries  += ti.exact.entry_count();
            keyword_tokens += ti.keyword.token_count();
            prefix_nodes   += ti.prefix.node_count();
            range_entries  += ti.range.entry_count();
        }
        IndexStats { exact_entries, keyword_tokens, prefix_nodes, range_entries }
    }

    pub fn total_records(&self) -> usize { self.records.len() }

    pub fn records_by_type(&self) -> HashMap<String, usize> {
        self.by_type.iter().map(|(k, v)| (k.clone(), v.len())).collect()
    }

    pub fn clear(&mut self) {
        self.records.clear();
        for ids in self.by_type.values_mut() { ids.clear(); }
        for ti in self.type_indexes.values_mut() {
            ti.exact.clear(); ti.keyword.clear(); ti.prefix.clear(); ti.range.clear();
        }
    }

    // ── Private indexing ───────────────────────────────────────────────────────

    fn index_record(&mut self, type_name: &str, id: &str, data: &serde_json::Value) {
        if let Some(obj) = data.as_object() {
            let field_names: Vec<String> = obj.keys().cloned().collect();
            for field_name in field_names {
                if let Some(value) = data.get(&field_name) {
                    self.index_field(type_name, id, &field_name, value);
                }
            }
        }
    }

    fn index_field(&mut self, type_name: &str, id: &str, field_name: &str, value: &serde_json::Value) {
        let strategy = self.type_indexes.get(type_name)
            .and_then(|ti| ti.strategies.get(field_name))
            .cloned();

        if let Some(ti) = self.type_indexes.get_mut(type_name) {
            match strategy {
                Some(IndexStrategy::Exact)   => ti.exact.add(field_name, value, id),
                Some(IndexStrategy::Keyword) => ti.keyword.add(field_name, value, id),
                Some(IndexStrategy::Prefix)  => ti.prefix.add(field_name, value, id),
                Some(IndexStrategy::Range)   => ti.range.add(field_name, value, id),
                _ => {}
            }
        }
    }

    fn unindex_record(&mut self, type_name: &str, id: &str, data: &serde_json::Value) {
        if let Some(obj) = data.as_object() {
            let field_names: Vec<String> = obj.keys().cloned().collect();
            for field_name in field_names {
                if let Some(value) = data.get(&field_name) {
                    self.unindex_field(type_name, id, &field_name, value);
                }
            }
        }
    }

    fn unindex_field(&mut self, type_name: &str, id: &str, field_name: &str, value: &serde_json::Value) {
        let strategy = self.type_indexes.get(type_name)
            .and_then(|ti| ti.strategies.get(field_name))
            .cloned();

        if let Some(ti) = self.type_indexes.get_mut(type_name) {
            match strategy {
                Some(IndexStrategy::Exact)   => ti.exact.remove(field_name, value, id),
                Some(IndexStrategy::Keyword) => ti.keyword.remove(id),
                Some(IndexStrategy::Prefix)  => ti.prefix.remove(field_name, value, id),
                Some(IndexStrategy::Range)   => ti.range.remove(field_name, value, id),
                _ => {}
            }
        }
    }

    fn next_id(&mut self) -> String {
        self.counter += 1;
        let ms = now_ms();
        format!("vpr_{ms:x}_{:x}", self.counter)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

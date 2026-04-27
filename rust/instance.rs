// =============================================================================
// vapor-idx — instance.rs
// Main facade composing all engines.
// =============================================================================

use crate::types::*;
use crate::schema::{validate_schema, hash_schema, validate_record_data};
use crate::record_store::RecordStore;
use crate::relationship_store::RelationshipStore;
use crate::query_engine::QueryEngine;
use crate::traversal_engine::TraversalEngine;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct VaporInstance {
    schema:       VaporSchema,
    schema_hash:  String,
    records:      RecordStore,
    relationships: RelationshipStore,
    destroyed:    bool,
}

impl VaporInstance {
    pub fn new(schema: VaporSchema) -> VaporResult<Self> {
        validate_schema(&schema)?;
        let schema_hash    = hash_schema(&schema);
        let records        = RecordStore::new(schema.clone());
        let relationships  = RelationshipStore::new(schema.clone());
        Ok(Self { schema, schema_hash, records, relationships, destroyed: false })
    }

    // ── Record CRUD ────────────────────────────────────────────────────────────

    pub fn store(&mut self, type_name: &str, data: serde_json::Value) -> VaporResult<String> {
        self.assert_alive()?;
        self.records.store(type_name, data)
    }

    pub fn get(&self, record_id: &str) -> VaporResult<Option<VaporRecord>> {
        self.assert_alive()?;
        Ok(self.records.get(record_id).cloned())
    }

    pub fn update(&mut self, record_id: &str, partial: serde_json::Value) -> VaporResult<()> {
        self.assert_alive()?;
        self.records.update(record_id, partial)
    }

    pub fn delete(&mut self, record_id: &str) -> VaporResult<()> {
        self.assert_alive()?;
        self.relationships.remove_for_record(record_id);
        self.records.delete(record_id);
        Ok(())
    }

    // ── Relationships ──────────────────────────────────────────────────────────

    pub fn relate(
        &mut self,
        source_id:        &str,
        relationship_type: &str,
        target_id:        &str,
        metadata:         serde_json::Value,
    ) -> VaporResult<String> {
        self.assert_alive()?;
        let source = self.records.get(source_id)
            .ok_or_else(|| VaporError::NotFound(format!("Source \"{source_id}\" not found")))?
            .clone();
        let target = self.records.get(target_id)
            .ok_or_else(|| VaporError::NotFound(format!("Target \"{target_id}\" not found")))?
            .clone();
        self.relationships.relate(
            source_id, &source.record_type,
            relationship_type,
            target_id, &target.record_type,
            metadata,
        )
    }

    pub fn unrelate(&mut self, edge_id: &str) -> VaporResult<()> {
        self.assert_alive()?;
        self.relationships.unrelate(edge_id);
        Ok(())
    }

    pub fn get_relationships(
        &self,
        record_id:        &str,
        relationship_type: Option<&str>,
        direction:        Option<&str>,
    ) -> VaporResult<Vec<VaporRelationship>> {
        self.assert_alive()?;
        Ok(self.relationships.get_edges_for_record(
            record_id,
            relationship_type,
            direction.unwrap_or("both"),
        ))
    }

    // ── Query ──────────────────────────────────────────────────────────────────

    pub fn query(&self, options: &QueryOptions) -> VaporResult<QueryResult> {
        self.assert_alive()?;
        let engine = QueryEngine::new(&self.records);
        engine.query(options)
    }

    // ── Traversal ──────────────────────────────────────────────────────────────

    pub fn traverse(&self, options: &TraversalOptions) -> VaporResult<TraversalResult> {
        self.assert_alive()?;
        let qe       = QueryEngine::new(&self.records);
        let traversal = TraversalEngine::new(&self.records, &self.relationships, &qe);
        traversal.traverse(options)
    }

    pub fn find_path(&self, options: &PathOptions) -> VaporResult<Option<Vec<String>>> {
        self.assert_alive()?;
        let qe       = QueryEngine::new(&self.records);
        let traversal = TraversalEngine::new(&self.records, &self.relationships, &qe);
        traversal.find_path(options)
    }

    // ── Introspection ──────────────────────────────────────────────────────────

    pub fn stats(&self) -> VaporResult<VaporStats> {
        self.assert_alive()?;
        let is = self.records.index_stats();
        let mem = self.records.total_records() * 500
            + self.relationships.total_edges() * 200
            + is.exact_entries * 100
            + is.keyword_tokens * 80
            + is.prefix_nodes * 120
            + is.range_entries * 48;

        Ok(VaporStats {
            total_records:         self.records.total_records(),
            records_by_type:       self.records.records_by_type(),
            total_relationships:   self.relationships.total_edges(),
            relationships_by_type: self.relationships.edges_by_type(),
            index_stats:           is,
            memory_estimate_bytes: mem,
        })
    }

    // ── Snapshot / restore ─────────────────────────────────────────────────────

    pub fn snapshot(&self) -> VaporResult<VaporSnapshot> {
        self.assert_alive()?;
        Ok(VaporSnapshot {
            records:       self.records.get_all(),
            relationships: self.relationships.get_all(),
            schema:        self.schema.clone(),
            taken_at:      now_ms(),
            schema_hash:   self.schema_hash.clone(),
        })
    }

    pub fn restore(&self, snapshot: &VaporSnapshot) -> VaporResult<VaporInstance> {
        self.assert_alive()?;
        if snapshot.schema_hash != self.schema_hash {
            return Err(VaporError::Schema(
                "Cannot restore snapshot: schema hash mismatch.".into()
            ));
        }

        let mut fresh = VaporInstance::new(self.schema.clone())?;
        let mut id_map = std::collections::HashMap::new();

        let mut sorted = snapshot.records.clone();
        sorted.sort_by_key(|r| r.created_at);

        for record in &sorted {
            let new_id = fresh.records.store(&record.record_type, record.data.clone())?;
            id_map.insert(record.id.clone(), new_id);
        }

        for edge in &snapshot.relationships {
            let is_reverse = edge.metadata.get("_reverse").and_then(|v| v.as_bool()).unwrap_or(false);
            if is_reverse { continue; }

            let new_source = id_map.get(&edge.source_id);
            let new_target = id_map.get(&edge.target_id);

            if let (Some(ns), Some(nt)) = (new_source, new_target) {
                let mut clean_meta = edge.metadata.clone();
                if let Some(obj) = clean_meta.as_object_mut() { obj.remove("_reverse"); }
                fresh.relationships.relate(
                    ns, &fresh.records.get(ns).map(|r| r.record_type.clone()).unwrap_or_default(),
                    &edge.relationship_type,
                    nt, &fresh.records.get(nt).map(|r| r.record_type.clone()).unwrap_or_default(),
                    clean_meta,
                )?;
            }
        }

        Ok(fresh)
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    pub fn destroy(&mut self) {
        if self.destroyed { return; }
        self.records.clear();
        self.relationships.clear();
        self.destroyed = true;
    }

    pub fn is_destroyed(&self) -> bool { self.destroyed }

    fn assert_alive(&self) -> VaporResult<()> {
        if self.destroyed { Err(VaporError::Destroyed) } else { Ok(()) }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

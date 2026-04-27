// =============================================================================
// vapor-idx — relationship_store.rs
// First-class relationship edge storage with bidirectional adjacency.
// FIX: extract `directed` from rel_def BEFORE calling self.next_id() (mutable)
//      to avoid the Rust borrow checker rejecting simultaneous immutable +
//      mutable borrows of self.
// =============================================================================

use crate::types::*;
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct RelationshipStore {
    schema: VaporSchema,
    edges: HashMap<String, VaporRelationship>,
    outgoing: HashMap<String, HashMap<String, HashSet<String>>>,
    incoming: HashMap<String, HashMap<String, HashSet<String>>>,
    by_type: HashMap<String, HashSet<String>>,
    counter: u64,
}

impl RelationshipStore {
    pub fn new(schema: VaporSchema) -> Self {
        Self {
            schema,
            edges: HashMap::new(),
            outgoing: HashMap::new(),
            incoming: HashMap::new(),
            by_type: HashMap::new(),
            counter: 0,
        }
    }

    pub fn relate(
        &mut self,
        source_id: &str,
        source_type: &str,
        rel_type: &str,
        target_id: &str,
        target_type: &str,
        metadata: serde_json::Value,
    ) -> VaporResult<String> {
        let type_def = self
            .schema
            .types
            .get(source_type)
            .ok_or_else(|| VaporError::NotFound(format!("Type \"{source_type}\" not found")))?;

        let rel_def = type_def.relationships.get(rel_type).ok_or_else(|| {
            VaporError::Schema(format!(
                "Relationship \"{rel_type}\" not declared on type \"{source_type}\"."
            ))
        })?;

        if !rel_def
            .target_types
            .iter()
            .any(|t| t == "*" || t == target_type)
        {
            return Err(VaporError::Schema(format!(
                "Relationship \"{rel_type}\" from \"{source_type}\" does not allow \
                 target \"{target_type}\"."
            )));
        }

        self.enforce_cardinality(source_id, target_id, rel_type, &rel_def.cardinality)?;

        // Extract `directed` BEFORE any mutable borrow of self.
        // Rust cannot hold &self.schema (via rel_def) and call &mut self methods
        // simultaneously. Copying the bool here ends the immutable borrow.
        let directed = rel_def.directed;

        let edge_id = self.next_id();
        let now = now_ms();

        let edge = VaporRelationship {
            id: edge_id.clone(),
            relationship_type: rel_type.to_owned(),
            source_id: source_id.to_owned(),
            target_id: target_id.to_owned(),
            metadata: metadata.clone(),
            created_at: now,
        };

        self.edges.insert(edge_id.clone(), edge);
        self.add_adjacency(source_id, target_id, rel_type, &edge_id);
        self.by_type
            .entry(rel_type.to_owned())
            .or_default()
            .insert(edge_id.clone());

        if !directed {
            let rev_id = self.next_id();
            let rev_meta = {
                let mut m = metadata.as_object().cloned().unwrap_or_default();
                m.insert("_reverse".into(), serde_json::Value::Bool(true));
                serde_json::Value::Object(m)
            };
            let rev_edge = VaporRelationship {
                id: rev_id.clone(),
                relationship_type: rel_type.to_owned(),
                source_id: target_id.to_owned(),
                target_id: source_id.to_owned(),
                metadata: rev_meta,
                created_at: now,
            };
            self.edges.insert(rev_id.clone(), rev_edge);
            self.add_adjacency(target_id, source_id, rel_type, &rev_id);
            self.by_type
                .entry(rel_type.to_owned())
                .or_default()
                .insert(rev_id);
        }

        Ok(edge_id)
    }

    pub fn unrelate(&mut self, edge_id: &str) {
        if let Some(edge) = self.edges.remove(edge_id) {
            self.outgoing
                .get_mut(&edge.source_id)
                .and_then(|m| m.get_mut(&edge.relationship_type))
                .map(|s| s.remove(edge_id));
            self.incoming
                .get_mut(&edge.target_id)
                .and_then(|m| m.get_mut(&edge.relationship_type))
                .map(|s| s.remove(edge_id));
            self.by_type
                .get_mut(&edge.relationship_type)
                .map(|s| s.remove(edge_id));
        }
    }

    pub fn remove_for_record(&mut self, record_id: &str) {
        let mut to_remove: Vec<String> = Vec::new();
        if let Some(out_map) = self.outgoing.get(record_id) {
            for ids in out_map.values() {
                to_remove.extend(ids.iter().cloned());
            }
        }
        if let Some(in_map) = self.incoming.get(record_id) {
            for ids in in_map.values() {
                to_remove.extend(ids.iter().cloned());
            }
        }
        let unique: Vec<String> = to_remove
            .into_iter()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        for eid in unique {
            self.unrelate(&eid);
        }
    }

    pub fn get_edges_for_record(
        &self,
        record_id: &str,
        rel_type: Option<&str>,
        direction: &str,
    ) -> Vec<VaporRelationship> {
        let mut ids: HashSet<String> = HashSet::new();
        if direction == "outgoing" || direction == "both" {
            if let Some(out) = self.outgoing.get(record_id) {
                match rel_type {
                    Some(t) => {
                        out.get(t).map(|s| ids.extend(s.iter().cloned()));
                    }
                    None => {
                        for s in out.values() {
                            ids.extend(s.iter().cloned());
                        }
                    }
                }
            }
        }
        if direction == "incoming" || direction == "both" {
            if let Some(inc) = self.incoming.get(record_id) {
                match rel_type {
                    Some(t) => {
                        inc.get(t).map(|s| ids.extend(s.iter().cloned()));
                    }
                    None => {
                        for s in inc.values() {
                            ids.extend(s.iter().cloned());
                        }
                    }
                }
            }
        }
        ids.iter()
            .filter_map(|id| self.edges.get(id))
            .cloned()
            .collect()
    }

    pub fn get_neighbour_ids(
        &self,
        record_id: &str,
        rel_type: &str,
        direction: &str,
    ) -> Vec<String> {
        self.get_edges_for_record(record_id, Some(rel_type), direction)
            .into_iter()
            .map(|e| {
                if e.source_id == record_id {
                    e.target_id
                } else {
                    e.source_id
                }
            })
            .collect()
    }

    pub fn get_all(&self) -> Vec<VaporRelationship> {
        self.edges.values().cloned().collect()
    }

    pub fn total_edges(&self) -> usize {
        self.edges.len()
    }

    pub fn edges_by_type(&self) -> HashMap<String, usize> {
        self.by_type
            .iter()
            .map(|(k, v)| (k.clone(), v.len()))
            .collect()
    }

    pub fn clear(&mut self) {
        self.edges.clear();
        self.outgoing.clear();
        self.incoming.clear();
        self.by_type.clear();
    }

    fn enforce_cardinality(
        &self,
        source_id: &str,
        target_id: &str,
        rel_type: &str,
        cardinality: &Cardinality,
    ) -> VaporResult<()> {
        if *cardinality == Cardinality::ManyToMany {
            return Ok(());
        }
        let out_count = self
            .outgoing
            .get(source_id)
            .and_then(|m| m.get(rel_type))
            .map(|s| s.len())
            .unwrap_or(0);
        if *cardinality == Cardinality::OneToOne && out_count > 0 {
            return Err(VaporError::Cardinality(format!(
                "\"{rel_type}\" is one-to-one but source already has outgoing edge."
            )));
        }
        if *cardinality == Cardinality::OneToOne {
            let in_count = self
                .incoming
                .get(target_id)
                .and_then(|m| m.get(rel_type))
                .map(|s| s.len())
                .unwrap_or(0);
            if in_count > 0 {
                return Err(VaporError::Cardinality(format!(
                    "\"{rel_type}\" is one-to-one but target already has incoming edge."
                )));
            }
        }
        Ok(())
    }

    fn add_adjacency(&mut self, source: &str, target: &str, rel_type: &str, edge_id: &str) {
        self.outgoing
            .entry(source.to_owned())
            .or_default()
            .entry(rel_type.to_owned())
            .or_default()
            .insert(edge_id.to_owned());
        self.incoming
            .entry(target.to_owned())
            .or_default()
            .entry(rel_type.to_owned())
            .or_default()
            .insert(edge_id.to_owned());
    }

    fn next_id(&mut self) -> String {
        self.counter += 1;
        format!("vpe_{:x}_{:x}", now_ms(), self.counter)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

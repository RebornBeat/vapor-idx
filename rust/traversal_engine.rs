// =============================================================================
// vapor-idx — traversal_engine.rs
// BFS-based graph traversal with shortest-path support.
// =============================================================================

use crate::types::*;
use crate::record_store::RecordStore;
use crate::relationship_store::RelationshipStore;
use crate::query_engine::QueryEngine;
use std::collections::{HashSet, VecDeque};

pub struct TraversalEngine<'a> {
    records:       &'a RecordStore,
    relationships: &'a RelationshipStore,
    query:         &'a QueryEngine<'a>,
}

impl<'a> TraversalEngine<'a> {
    pub fn new(
        records:       &'a RecordStore,
        relationships: &'a RelationshipStore,
        query:         &'a QueryEngine<'a>,
    ) -> Self {
        Self { records, relationships, query }
    }

    pub fn traverse(&self, options: &TraversalOptions) -> VaporResult<TraversalResult> {
        if !self.records.has(&options.from) {
            return Err(VaporError::NotFound(format!("Start record \"{}\" not found.", options.from)));
        }

        let direction = match &options.direction {
            TraversalDirection::Outgoing => "outgoing",
            TraversalDirection::Incoming => "incoming",
            TraversalDirection::Both     => "both",
        };

        let mut visited:  HashSet<String>   = HashSet::from([options.from.clone()]);
        let mut entries:  Vec<TraversalEntry> = Vec::new();
        let mut records:  Vec<VaporRecord>    = Vec::new();

        // BFS queue: (current_id, depth, via_path)
        let mut queue: VecDeque<(String, usize, Vec<String>)> =
            VecDeque::from([(options.from.clone(), 0, vec![])]);

        while let Some((current_id, current_depth, via)) = queue.pop_front() {
            if current_depth >= options.depth { continue; }

            let neighbours = self.relationships.get_neighbour_ids(
                &current_id, &options.relationship, direction
            );

            for neighbour_id in neighbours {
                if visited.contains(&neighbour_id) { continue; }
                visited.insert(neighbour_id.clone());

                let Some(record) = self.records.get(&neighbour_id) else { continue };

                // Optional filter
                if let Some(filter) = &options.filter {
                    let result = self.query.query(filter)?;
                    if !result.records.iter().any(|r| r.id == neighbour_id) { continue; }
                }

                let mut new_via = via.clone();
                new_via.push(current_id.clone());

                entries.push(TraversalEntry {
                    record: record.clone(),
                    depth:  current_depth + 1,
                    via:    new_via.clone(),
                });
                records.push(record.clone());

                if current_depth + 1 < options.depth {
                    queue.push_back((neighbour_id, current_depth + 1, new_via));
                }
            }
        }

        Ok(TraversalResult { records, entries })
    }

    pub fn find_path(&self, options: &PathOptions) -> VaporResult<Option<Vec<String>>> {
        if !self.records.has(&options.from) {
            return Err(VaporError::NotFound(format!("Start \"{}\" not found.", options.from)));
        }
        if !self.records.has(&options.to) {
            return Err(VaporError::NotFound(format!("End \"{}\" not found.", options.to)));
        }
        if options.from == options.to {
            return Ok(Some(vec![options.from.clone()]));
        }

        let mut visited: HashSet<String> = HashSet::from([options.from.clone()]);
        let mut queue: VecDeque<Vec<String>> = VecDeque::from([vec![options.from.clone()]]);

        while let Some(path) = queue.pop_front() {
            if path.len() - 1 >= options.max_depth { continue; }

            let current_id = path.last().unwrap();
            let edges = self.relationships.get_edges_for_record(
                current_id,
                options.relationship.as_deref(),
                "both",
            );

            for edge in edges {
                let neighbour_id = if edge.source_id == *current_id {
                    &edge.target_id
                } else {
                    &edge.source_id
                };

                if visited.contains(neighbour_id) { continue; }
                visited.insert(neighbour_id.clone());

                let mut new_path = path.clone();
                new_path.push(neighbour_id.clone());

                if *neighbour_id == options.to {
                    return Ok(Some(new_path));
                }

                queue.push_back(new_path);
            }
        }

        Ok(None)
    }
}

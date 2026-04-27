// =============================================================================
// vapor-idx — query_engine.rs
// Imports validate_filter from schema.rs — no local re-definition.
// =============================================================================

use crate::record_store::RecordStore;
use crate::schema::validate_filter;
use crate::types::*;
use std::collections::HashSet;

pub struct QueryEngine<'a> {
    store: &'a RecordStore,
}

impl<'a> QueryEngine<'a> {
    pub fn new(store: &'a RecordStore) -> Self {
        Self { store }
    }

    pub fn query(&self, options: &QueryOptions) -> VaporResult<QueryResult> {
        let types = match &options.type_filter {
            Some(t) => t.clone(),
            None => self.store.get_types(),
        };
        let mut candidate_ids: Option<HashSet<String>> = None;

        for type_name in &types {
            let type_def = match self.store.schema.types.get(type_name) {
                Some(t) => t,
                None => continue,
            };
            let type_id_set = self.store.get_type_id_set(type_name);
            if type_id_set.is_empty() {
                continue;
            }

            for filter in &options.where_filters {
                validate_filter(filter, type_name, type_def)?;
            }

            let filtered = self.apply_filters(
                type_name,
                type_id_set,
                &options.where_filters,
                &options.logic,
            );
            let after_keywords = self.apply_keywords(type_name, filtered, &options.keywords);

            match &mut candidate_ids {
                None => {
                    candidate_ids = Some(after_keywords);
                }
                Some(ids) => {
                    ids.extend(after_keywords);
                }
            }
        }

        let ids = match candidate_ids {
            None => {
                return Ok(QueryResult {
                    records: vec![],
                    total: 0,
                })
            }
            Some(s) => s,
        };

        let mut records: Vec<VaporRecord> = ids
            .iter()
            .filter_map(|id| self.store.get(id))
            .cloned()
            .collect();

        if let Some((field, dir)) = &options.order_by {
            records.sort_by(|a, b| {
                let av = a.data.get(field);
                let bv = b.data.get(field);
                let cmp = compare_json(av, bv);
                if *dir == SortDirection::Desc {
                    cmp.reverse()
                } else {
                    cmp
                }
            });
        }

        let total = records.len();
        let offset = options.offset;
        let records = if let Some(limit) = options.limit {
            records.into_iter().skip(offset).take(limit).collect()
        } else {
            records.into_iter().skip(offset).collect()
        };

        Ok(QueryResult { records, total })
    }

    fn apply_filters(
        &self,
        type_name: &str,
        seed: HashSet<String>,
        filters: &[FieldFilter],
        logic: &QueryLogic,
    ) -> HashSet<String> {
        if filters.is_empty() {
            return seed;
        }
        match logic {
            QueryLogic::And => {
                let mut current = seed;
                for filter in filters {
                    let matched = self.apply_filter(type_name, filter);
                    current = current.intersection(&matched).cloned().collect();
                    if current.is_empty() {
                        break;
                    }
                }
                current
            }
            QueryLogic::Or => {
                let mut union_result = HashSet::new();
                for filter in filters {
                    let matched = self.apply_filter(type_name, filter);
                    let intersected: HashSet<String> =
                        matched.intersection(&seed).cloned().collect();
                    union_result.extend(intersected);
                }
                union_result
            }
        }
    }

    fn apply_filter(&self, type_name: &str, filter: &FieldFilter) -> HashSet<String> {
        let field = &filter.field;
        let value = &filter.value;
        match &filter.op {
            FilterOp::Eq => self
                .store
                .exact(type_name)
                .map(|i| i.eq(field, value))
                .unwrap_or_default(),
            FilterOp::Neq => self
                .store
                .exact(type_name)
                .map(|i| i.neq(field, value))
                .unwrap_or_default(),
            FilterOp::In => {
                let v = value.as_array().cloned().unwrap_or_default();
                self.store
                    .exact(type_name)
                    .map(|i| i.find_in(field, &v))
                    .unwrap_or_default()
            }
            FilterOp::NotIn => {
                let v = value.as_array().cloned().unwrap_or_default();
                self.store
                    .exact(type_name)
                    .map(|i| i.not_in(field, &v))
                    .unwrap_or_default()
            }
            FilterOp::Contains => {
                let q = value
                    .as_str()
                    .map(|s| vec![s.to_owned()])
                    .unwrap_or_default();
                self.store
                    .keyword(type_name)
                    .map(|i| i.contains(field, &q))
                    .unwrap_or_default()
            }
            FilterOp::StartsWith => {
                let p = value.as_str().unwrap_or("");
                self.store
                    .prefix(type_name)
                    .map(|i| i.starts_with(field, p))
                    .unwrap_or_default()
            }
            FilterOp::Gt => {
                let n = value.as_f64().unwrap_or(0.0);
                self.store
                    .range(type_name)
                    .map(|i| i.gt(field, n))
                    .unwrap_or_default()
            }
            FilterOp::Lt => {
                let n = value.as_f64().unwrap_or(0.0);
                self.store
                    .range(type_name)
                    .map(|i| i.lt(field, n))
                    .unwrap_or_default()
            }
            FilterOp::Gte => {
                let n = value.as_f64().unwrap_or(0.0);
                self.store
                    .range(type_name)
                    .map(|i| i.gte(field, n))
                    .unwrap_or_default()
            }
            FilterOp::Lte => {
                let n = value.as_f64().unwrap_or(0.0);
                self.store
                    .range(type_name)
                    .map(|i| i.lte(field, n))
                    .unwrap_or_default()
            }
        }
    }

    fn apply_keywords(
        &self,
        type_name: &str,
        seed: HashSet<String>,
        keywords: &Option<Vec<String>>,
    ) -> HashSet<String> {
        let Some(kws) = keywords else { return seed };
        if kws.is_empty() {
            return seed;
        }
        let matched = self
            .store
            .keyword(type_name)
            .map(|i| i.search(kws))
            .unwrap_or_default();
        seed.intersection(&matched).cloned().collect()
    }
}

fn compare_json(
    a: Option<&serde_json::Value>,
    b: Option<&serde_json::Value>,
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => {
            if let (Some(an), Some(bn)) = (a.as_f64(), b.as_f64()) {
                an.partial_cmp(&bn).unwrap_or(Ordering::Equal)
            } else {
                a.as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .cmp(&b.as_str().unwrap_or("").to_lowercase())
            }
        }
    }
}

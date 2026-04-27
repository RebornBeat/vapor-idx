// =============================================================================
// vapor-idx — types.rs
// All public types, schema declarations, query DSL, and errors.
// =============================================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Field primitives ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldType {
    String,
    Number,
    Boolean,
    #[serde(rename = "string[]")]
    StringArray,
    #[serde(rename = "number[]")]
    NumberArray,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexStrategy {
    None,
    Exact,
    Keyword,
    Prefix,
    Range,
}

// ── Schema declarations ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldDefinition {
    #[serde(rename = "type")]
    pub field_type: FieldType,
    pub index:      IndexStrategy,
    #[serde(default)]
    pub required:   bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cardinality {
    OneToOne,
    OneToMany,
    ManyToMany,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipDefinition {
    pub target_types: Vec<String>,
    pub directed:     bool,
    pub cardinality:  Cardinality,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeDefinition {
    pub fields:        HashMap<String, FieldDefinition>,
    #[serde(default)]
    pub relationships: HashMap<String, RelationshipDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaporSchema {
    pub types: HashMap<String, TypeDefinition>,
}

// ── Records ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaporRecord {
    pub id:          String,
    #[serde(rename = "type")]
    pub record_type: String,
    pub data:        serde_json::Value,
    pub created_at:  i64,
    pub updated_at:  i64,
}

// ── Relationships ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaporRelationship {
    pub id:                String,
    pub relationship_type: String,
    pub source_id:         String,
    pub target_id:         String,
    pub metadata:          serde_json::Value,
    pub created_at:        i64,
}

// ── Query DSL ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterOp {
    Eq, Neq, In, NotIn,
    Contains, StartsWith,
    Gt, Lt, Gte, Lte,
}

#[derive(Debug, Clone)]
pub struct FieldFilter {
    pub field: String,
    pub op:    FilterOp,
    pub value: serde_json::Value,
}

#[derive(Debug, Default, Clone)]
pub struct QueryOptions {
    pub type_filter:   Option<Vec<String>>,
    pub where_filters: Vec<FieldFilter>,
    pub keywords:      Option<Vec<String>>,
    pub logic:         QueryLogic,
    pub limit:         Option<usize>,
    pub offset:        usize,
    pub order_by:      Option<(String, SortDirection)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum QueryLogic {
    #[default]
    And,
    Or,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone)]
pub struct TraversalOptions {
    pub from:         String,
    pub relationship: String,
    pub direction:    TraversalDirection,
    pub depth:        usize,
    pub filter:       Option<QueryOptions>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum TraversalDirection {
    #[default]
    Outgoing,
    Incoming,
    Both,
}

#[derive(Debug, Clone)]
pub struct PathOptions {
    pub from:         String,
    pub to:           String,
    pub relationship: Option<String>,
    pub max_depth:    usize,
}

// ── Results ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct QueryResult {
    pub records: Vec<VaporRecord>,
    pub total:   usize,
}

#[derive(Debug, Clone)]
pub struct TraversalEntry {
    pub record: VaporRecord,
    pub depth:  usize,
    pub via:    Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TraversalResult {
    pub records: Vec<VaporRecord>,
    pub entries: Vec<TraversalEntry>,
}

// ── Stats & snapshots ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct IndexStats {
    pub exact_entries:  usize,
    pub keyword_tokens: usize,
    pub prefix_nodes:   usize,
    pub range_entries:  usize,
}

#[derive(Debug, Clone)]
pub struct VaporStats {
    pub total_records:          usize,
    pub records_by_type:        HashMap<String, usize>,
    pub total_relationships:    usize,
    pub relationships_by_type:  HashMap<String, usize>,
    pub index_stats:            IndexStats,
    pub memory_estimate_bytes:  usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaporSnapshot {
    pub records:       Vec<VaporRecord>,
    pub relationships: Vec<VaporRelationship>,
    pub schema:        VaporSchema,
    pub taken_at:      i64,
    pub schema_hash:   String,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaporError {
    Schema(String),
    Query(String),
    Destroyed,
    NotFound(String),
    Cardinality(String),
}

impl std::fmt::Display for VaporError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaporError::Schema(m)      => write!(f, "[vapor-idx] Schema error: {m}"),
            VaporError::Query(m)       => write!(f, "[vapor-idx] Query error: {m}"),
            VaporError::Destroyed      => write!(f, "[vapor-idx] Instance has been destroyed."),
            VaporError::NotFound(m)    => write!(f, "[vapor-idx] Not found: {m}"),
            VaporError::Cardinality(m) => write!(f, "[vapor-idx] Cardinality violation: {m}"),
        }
    }
}

impl std::error::Error for VaporError {}

pub type VaporResult<T> = Result<T, VaporError>;

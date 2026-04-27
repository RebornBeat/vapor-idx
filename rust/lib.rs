// =============================================================================
// vapor-idx — lib.rs
// Public API surface for the Rust crate.
// =============================================================================

mod indexes;
mod schema;
mod record_store;
mod relationship_store;
mod query_engine;
mod traversal_engine;
mod instance;

// ── Public re-exports ──────────────────────────────────────────────────────────

pub use types::*;
pub use instance::VaporInstance;

mod types;

// ── Factory function ──────────────────────────────────────────────────────────

/// Create a new Vapor index instance bound to the provided schema.
///
/// Every type, field, and relationship must be declared in the schema before
/// any records are stored. There are no defaults.
///
/// The instance lives entirely in RAM. It produces no files, no network
/// requests, and no cross-skill state. Call `vapor.destroy()` when done or
/// let it drop naturally.
///
/// # Example
///
/// ```rust
/// use vapor_idx::{create_vapor, VaporSchema, TypeDefinition, FieldDefinition,
///                 FieldType, IndexStrategy, QueryOptions};
/// use std::collections::HashMap;
///
/// let mut schema = VaporSchema { types: HashMap::new() };
/// schema.types.insert("Task".into(), TypeDefinition {
///     fields: HashMap::from([
///         ("title".into(), FieldDefinition {
///             field_type: FieldType::String,
///             index:      IndexStrategy::Keyword,
///             required:   true,
///         }),
///     ]),
///     relationships: HashMap::new(),
/// });
///
/// let mut vapor = create_vapor(schema).expect("valid schema");
/// let id = vapor.store("Task", serde_json::json!({"title": "Write tests"})).unwrap();
/// println!("Stored: {id}");
/// vapor.destroy();
/// ```
pub fn create_vapor(schema: VaporSchema) -> VaporResult<VaporInstance> {
    VaporInstance::new(schema)
}

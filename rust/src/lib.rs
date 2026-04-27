// =============================================================================
// vapor-idx — lib.rs
// mod declarations MUST come before pub use re-exports that reference them.
// =============================================================================

mod types;
mod indexes;
mod schema;
mod record_store;
mod relationship_store;
mod query_engine;
mod traversal_engine;
mod instance;

pub use types::*;
pub use instance::VaporInstance;

/// Create a new Vapor index instance bound to the provided schema.
///
/// Records live entirely in RAM. Nothing is written to disk.
/// Returns `VaporResult<VaporInstance>`.
///
/// # Example
///
/// ```rust
/// use vapor_idx::{create_vapor, VaporSchema, TypeDefinition, FieldDefinition,
///                 FieldType, IndexStrategy};
/// use std::collections::HashMap;
///
/// let schema = VaporSchema {
///     types: HashMap::from([
///         ("Task".to_string(), TypeDefinition {
///             fields: HashMap::from([
///                 ("title".to_string(), FieldDefinition {
///                     field_type: FieldType::String,
///                     index:      IndexStrategy::Keyword,
///                     required:   true,
///                 }),
///             ]),
///             relationships: HashMap::new(),
///         }),
///     ]),
/// };
/// let mut vapor = create_vapor(schema).expect("valid schema");
/// let id = vapor.store("Task", serde_json::json!({"title": "Write tests"})).unwrap();
/// vapor.destroy();
/// ```
pub fn create_vapor(schema: VaporSchema) -> VaporResult<VaporInstance> {
    VaporInstance::new(schema)

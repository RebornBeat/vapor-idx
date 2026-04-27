// =============================================================================
// vapor-idx — RelationshipStore.ts
// First-class relationship edge storage with bidirectional adjacency lists.
// =============================================================================

import {
  VaporRelationship,
  VaporSchema,
  RelationshipDefinition,
  VaporError,
  VaporSchemaError,
} from './types.js';

export class RelationshipStore {
  // edge id → VaporRelationship
  private readonly edges: Map<string, VaporRelationship> = new Map();

  // sourceId → relType → Set<edgeId>   (outgoing)
  private readonly outgoing: Map<string, Map<string, Set<string>>> = new Map();
  // targetId → relType → Set<edgeId>   (incoming)
  private readonly incoming: Map<string, Map<string, Set<string>>> = new Map();

  // relType → Set<edgeId>  (for stats / full scans by type)
  private readonly byType: Map<string, Set<string>> = new Map();

  private idCounter = 0;

  constructor(private readonly schema: VaporSchema) {}

  // ── Mutation ───────────────────────────────────────────────────────────────

  relate(
    sourceId:         string,
    sourceType:       string,
    relationshipType: string,
    targetId:         string,
    targetType:       string,
    metadata:         Record<string, unknown> = {}
  ): string {
    const relDef = this.resolveRelDef(sourceType, relationshipType);

    // Validate target type is permitted
    if (!relDef.targetTypes.includes('*') && !relDef.targetTypes.includes(targetType)) {
      throw new VaporSchemaError(
        `Relationship "${relationshipType}" from type "${sourceType}" ` +
        `does not allow target type "${targetType}". ` +
        `Allowed: ${relDef.targetTypes.join(', ')}.`
      );
    }

    // Enforce cardinality
    this.enforceCardinality(sourceId, targetId, relationshipType, relDef);

    const edgeId = this.nextEdgeId();
    const now    = Date.now();

    const edge: VaporRelationship = {
      id:               edgeId,
      relationshipType,
      sourceId,
      targetId,
      metadata:         Object.freeze({ ...metadata }),
      _createdAt:       now,
    };

    this.edges.set(edgeId, edge);
    this.addToAdjacency(sourceId, targetId, relationshipType, edgeId);
    this.addToTypeIndex(relationshipType, edgeId);

    // Bidirectional: create reverse edge
    if (!relDef.directed) {
      const reverseEdgeId = this.nextEdgeId();
      const reverseEdge: VaporRelationship = {
        id:               reverseEdgeId,
        relationshipType,
        sourceId:         targetId,
        targetId:         sourceId,
        metadata:         Object.freeze({ ...metadata, _reverse: true }),
        _createdAt:       now,
      };
      this.edges.set(reverseEdgeId, reverseEdge);
      this.addToAdjacency(targetId, sourceId, relationshipType, reverseEdgeId);
      this.addToTypeIndex(relationshipType, reverseEdgeId);
    }

    return edgeId;
  }

  unrelate(edgeId: string): void {
    const edge = this.edges.get(edgeId);
    if (edge === undefined) return;

    this.removeFromAdjacency(edge.sourceId, edge.targetId, edge.relationshipType, edgeId);
    this.removeFromTypeIndex(edge.relationshipType, edgeId);
    this.edges.delete(edgeId);
  }

  /** Remove all edges where sourceId or targetId matches the given record id. */
  removeForRecord(recordId: string): void {
    const toRemove: string[] = [];

    // Collect all outgoing edges
    const outMap = this.outgoing.get(recordId);
    if (outMap) {
      for (const edgeSet of outMap.values()) {
        for (const edgeId of edgeSet) toRemove.push(edgeId);
      }
    }

    // Collect all incoming edges
    const inMap = this.incoming.get(recordId);
    if (inMap) {
      for (const edgeSet of inMap.values()) {
        for (const edgeId of edgeSet) toRemove.push(edgeId);
      }
    }

    for (const edgeId of toRemove) this.unrelate(edgeId);
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  getEdge(edgeId: string): VaporRelationship | null {
    return this.edges.get(edgeId) ?? null;
  }

  getEdgesForRecord(
    recordId:        string,
    relationshipType?: string,
    direction:       'outgoing' | 'incoming' | 'both' = 'both'
  ): VaporRelationship[] {
    const edgeIds = new Set<string>();

    if (direction === 'outgoing' || direction === 'both') {
      const outMap = this.outgoing.get(recordId);
      if (outMap) {
        if (relationshipType) {
          outMap.get(relationshipType)?.forEach(id => edgeIds.add(id));
        } else {
          for (const edgeSet of outMap.values()) {
            for (const id of edgeSet) edgeIds.add(id);
          }
        }
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const inMap = this.incoming.get(recordId);
      if (inMap) {
        if (relationshipType) {
          inMap.get(relationshipType)?.forEach(id => edgeIds.add(id));
        } else {
          for (const edgeSet of inMap.values()) {
            for (const id of edgeSet) edgeIds.add(id);
          }
        }
      }
    }

    return [...edgeIds]
      .map(id => this.edges.get(id)!)
      .filter(Boolean);
  }

  getNeighbourIds(
    recordId:         string,
    relationshipType: string,
    direction:        'outgoing' | 'incoming' | 'both' = 'outgoing'
  ): string[] {
    const edges = this.getEdgesForRecord(recordId, relationshipType, direction);
    return edges.map(e => e.sourceId === recordId ? e.targetId : e.sourceId);
  }

  hasEdgeBetween(
    sourceId:         string,
    targetId:         string,
    relationshipType: string
  ): boolean {
    const outMap = this.outgoing.get(sourceId);
    if (!outMap) return false;

    const edgeSet = outMap.get(relationshipType);
    if (!edgeSet) return false;

    for (const edgeId of edgeSet) {
      const edge = this.edges.get(edgeId);
      if (edge?.targetId === targetId) return true;
    }
    return false;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  get totalEdges(): number {
    return this.edges.size;
  }

  get edgeCountsByType(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [type, edgeSet] of this.byType) result[type] = edgeSet.size;
    return result;
  }

  getAll(): VaporRelationship[] {
    return [...this.edges.values()];
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  clear(): void {
    this.edges.clear();
    this.outgoing.clear();
    this.incoming.clear();
    this.byType.clear();
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private resolveRelDef(sourceType: string, relationshipType: string): RelationshipDefinition {
    const typeDef = this.schema.types[sourceType];
    if (!typeDef) {
      throw new VaporError(`Unknown source type "${sourceType}".`);
    }
    const relDef = typeDef.relationships?.[relationshipType];
    if (!relDef) {
      throw new VaporSchemaError(
        `Relationship "${relationshipType}" is not declared on type "${sourceType}".`
      );
    }
    return relDef;
  }

  private enforceCardinality(
    sourceId:         string,
    targetId:         string,
    relationshipType: string,
    relDef:           RelationshipDefinition
  ): void {
    if (relDef.cardinality === 'many-to-many') return;

    const outMap    = this.outgoing.get(sourceId);
    const existingOut = outMap?.get(relationshipType)?.size ?? 0;

    if ((relDef.cardinality === 'one-to-one' || relDef.cardinality === 'one-to-many') && existingOut > 0) {
      if (relDef.cardinality === 'one-to-one') {
        throw new VaporError(
          `Cardinality violation: "${relationshipType}" is one-to-one ` +
          `but "${sourceId}" already has an outgoing edge of this type.`
        );
      }
    }

    if (relDef.cardinality === 'one-to-one') {
      const inMap       = this.incoming.get(targetId);
      const existingIn  = inMap?.get(relationshipType)?.size ?? 0;
      if (existingIn > 0) {
        throw new VaporError(
          `Cardinality violation: "${relationshipType}" is one-to-one ` +
          `but "${targetId}" already has an incoming edge of this type.`
        );
      }
    }
  }

  private addToAdjacency(
    sourceId:         string,
    targetId:         string,
    relationshipType: string,
    edgeId:           string
  ): void {
    // Outgoing
    let outMap = this.outgoing.get(sourceId);
    if (!outMap) { outMap = new Map(); this.outgoing.set(sourceId, outMap); }
    let outSet = outMap.get(relationshipType);
    if (!outSet) { outSet = new Set(); outMap.set(relationshipType, outSet); }
    outSet.add(edgeId);

    // Incoming
    let inMap = this.incoming.get(targetId);
    if (!inMap) { inMap = new Map(); this.incoming.set(targetId, inMap); }
    let inSet = inMap.get(relationshipType);
    if (!inSet) { inSet = new Set(); inMap.set(relationshipType, inSet); }
    inSet.add(edgeId);
  }

  private removeFromAdjacency(
    sourceId:         string,
    targetId:         string,
    relationshipType: string,
    edgeId:           string
  ): void {
    this.outgoing.get(sourceId)?.get(relationshipType)?.delete(edgeId);
    this.incoming.get(targetId)?.get(relationshipType)?.delete(edgeId);
  }

  private addToTypeIndex(relationshipType: string, edgeId: string): void {
    let set = this.byType.get(relationshipType);
    if (!set) { set = new Set(); this.byType.set(relationshipType, set); }
    set.add(edgeId);
  }

  private removeFromTypeIndex(relationshipType: string, edgeId: string): void {
    this.byType.get(relationshipType)?.delete(edgeId);
  }

  private nextEdgeId(): string {
    return `vpe_${Date.now().toString(36)}_${(++this.idCounter).toString(36)}`;
  }
}

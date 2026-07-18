import { embeddingService } from "./embedding.js";
import { shardManager } from "./sqlite/shard-manager.js";
import { vectorSearch } from "./sqlite/vector-search.js";
import { connectionManager } from "./sqlite/connection-manager.js";
import { CONFIG } from "../config.js";
import { log } from "./logger.js";
import type { MemoryType } from "../types/index.js";
import type { MemoryRecord } from "./sqlite/types.js";

export type MemoryScope = "project" | "all-projects";

function safeToISOString(timestamp: any): string {
  try {
    if (timestamp === null || timestamp === undefined) {
      return new Date().toISOString();
    }
    const numValue = typeof timestamp === "bigint" ? Number(timestamp) : Number(timestamp);

    if (isNaN(numValue) || numValue < 0) {
      return new Date().toISOString();
    }

    return new Date(numValue).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function safeJSONParse(jsonString: any): any {
  if (!jsonString || typeof jsonString !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(jsonString);
  } catch {
    return undefined;
  }
}

function toBlob(vector?: Float32Array): Uint8Array | null {
  return vector ? new Uint8Array(vector.buffer) : null;
}

function extractScopeFromContainerTag(containerTag: string): {
  scope: "user" | "project";
  hash: string;
} {
  const parts = containerTag.split("_");
  if (parts.length >= 3) {
    const scope = parts[1] as "user" | "project";
    const hash = parts.slice(2).join("_");
    return { scope, hash };
  }
  return { scope: "user", hash: containerTag };
}

function resolveScopeValue(
  scope: MemoryScope,
  containerTag: string
): { scope: "user" | "project"; hash: string } {
  if (scope === "all-projects") {
    return { scope: "project", hash: "" };
  }
  return extractScopeFromContainerTag(containerTag);
}

export class LocalMemoryClient {
  private initPromise: Promise<void> | null = null;
  private isInitialized: boolean = false;

  constructor() {}

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        this.isInitialized = true;
      } catch (error) {
        this.initPromise = null;
        log("SQLite initialization failed", { error: String(error) });
        throw error;
      }
    })();

    return this.initPromise;
  }

  async warmup(progressCallback?: (progress: any) => void): Promise<void> {
    await this.initialize();
    await embeddingService.warmup(progressCallback);
  }

  async isReady(): Promise<boolean> {
    return this.isInitialized && embeddingService.isWarmedUp;
  }

  getStatus(): {
    dbConnected: boolean;
    modelLoaded: boolean;
    ready: boolean;
  } {
    return {
      dbConnected: this.isInitialized,
      modelLoaded: embeddingService.isWarmedUp,
      ready: this.isInitialized && embeddingService.isWarmedUp,
    };
  }

  close(): void {
    connectionManager.closeAll();
  }

  async searchMemories(query: string, containerTag: string, scope: MemoryScope = "project") {
    try {
      await this.initialize();

      const queryVector = await embeddingService.embedWithTimeout(query);
      const resolved = resolveScopeValue(scope, containerTag);
      const shards = shardManager.getAllShards(resolved.scope, resolved.hash);

      if (shards.length === 0) {
        return { success: true as const, results: [], total: 0, timing: 0 };
      }

      const results = await vectorSearch.searchAcrossShards(
        shards,
        queryVector,
        scope === "all-projects" ? "" : containerTag,
        CONFIG.maxMemories,
        CONFIG.similarityThreshold,
        query
      );

      return { success: true as const, results, total: results.length, timing: 0 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemories: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }

  async combinedSearch(
    query: string,
    containerTag: string,
    limit: number = 10,
    scope: MemoryScope = "project"
  ) {
    try {
      await this.initialize();

      const keywords = query
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      if (keywords.length === 0) {
        return { success: true as const, results: [], count: 0 };
      }

      const resolved = resolveScopeValue(scope, containerTag);
      const shards = shardManager.getAllShards(resolved.scope, resolved.hash);
      if (shards.length === 0) {
        return { success: true as const, results: [], count: 0 };
      }

      const merged = new Map<string, { id: string; overview?: string; tags: string[]; similarity: number; source: string; createdAt: string }>();

      for (const kw of keywords) {
        const [semanticRes, keywordRes] = await Promise.all([
          this.searchMemories(kw, containerTag, scope),
          this.filterMemoriesByKeyword(containerTag, kw, scope),
        ]);

        if (semanticRes.success) {
          for (const r of (semanticRes as any).results || []) {
            const sim = r.similarity || 0;
            const existing = merged.get(r.id);
            if (!existing || sim > existing.similarity) {
              merged.set(r.id, {
                id: r.id,
                overview: r.overview,
                tags: r.tags || [],
                similarity: sim,
                source: "semantic",
                createdAt: r.createdAt || "",
              });
            } else if (sim > 0 && existing.source === "keyword") {
              existing.source = "both";
            }
          }
        }

        if (keywordRes.success) {
          for (const m of (keywordRes as any).memories || []) {
            const existing = merged.get(m.id);
            if (existing) {
              if (existing.source === "semantic") existing.source = "both";
              if (!existing.overview) existing.overview = m.overview;
              if (!existing.tags.length) existing.tags = m.tags;
              if (!existing.createdAt) existing.createdAt = m.createdAt;
            } else {
              merged.set(m.id, {
                id: m.id,
                overview: m.overview,
                tags: m.tags || [],
                similarity: 0,
                source: "keyword",
                createdAt: m.createdAt || "",
              });
            }
          }
        }
      }

      // Enrich semantic-only results with overview and createdAt from DB
      const enrichIds = Array.from(merged.entries())
        .filter(([, v]) => !v.overview || !v.createdAt)
        .map(([id]) => id);

      if (enrichIds.length > 0) {
        for (const shard of shards) {
          const db = connectionManager.getConnection(shard.dbPath);
          for (const eid of enrichIds) {
            const entry = merged.get(eid);
            if (!entry || (entry.overview && entry.createdAt)) continue;
            const row = vectorSearch.getMemoryById(db, eid);
            if (row) {
              if (!entry.overview) entry.overview = row.overview || undefined;
              if (!entry.createdAt) entry.createdAt = safeToISOString(row.created_at);
            }
          }
        }
      }

      const results = Array.from(merged.values())
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);

      return { success: true as const, results, count: results.length };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("combinedSearch: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [], count: 0 };
    }
  }

  private getNextNumericId(): string {
    let max = 0;
    const allShards = shardManager.getAllShards("project", "");
    for (const s of allShards) {
      const db = connectionManager.getConnection(s.dbPath);
      const row = db.prepare(
        "SELECT MAX(CAST(id AS INTEGER)) as mx FROM memories WHERE id GLOB '[0-9]*'"
      ).get() as any;
      if (row?.mx != null && row.mx > max) max = row.mx;
    }
    return String(max + 1);
  }

  async addMemory(
    content: string,
    containerTag: string,
    metadata?: {
      type?: MemoryType;
      source?: "manual" | "auto-capture" | "import" | "api";
      tags?: string[];
      tool?: string;
      sessionID?: string;
      reasoning?: string;
      captureTimestamp?: number;
      displayName?: string;
      overview?: string;
      userName?: string;
      userEmail?: string;
      projectPath?: string;
      projectName?: string;
      gitRepoUrl?: string;
      [key: string]: unknown;
    }
  ) {
    try {
      await this.initialize();

      const tags = metadata?.tags || [];
      const vector = await embeddingService.embedWithTimeout(content);
      let tagsVector: Float32Array | undefined = undefined;

      if (tags.length > 0) {
        // Wrap tags in a natural-language template before embedding. Bare comma
        // lists like "react, auth, bug-fix" sit outside the multilingual-e5
        // training distribution, so the resulting tagsVector drifts toward
        // unrelated chatter and weakens the 0.4-weight tag boost in
        // VectorSearch#searchInShard. The "Topics: ..." prefix is a sentence
        // form e5 was trained on and yields a more discriminative vector.
        tagsVector = await embeddingService.embedWithTimeout(`Topics: ${tags.join(", ")}`);
      }

      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shard = shardManager.getWriteShard(scope, hash);

      const id = this.getNextNumericId();
      const now = Date.now();

      const {
        displayName,
        overview,
        userName,
        userEmail,
        projectPath,
        projectName,
        gitRepoUrl,
        type,
        tags: _tags,
        ...dynamicMetadata
      } = metadata || {};

      const record: MemoryRecord = {
        id,
        content,
        vector,
        tagsVector,
        containerTag,
        tags: tags.length > 0 ? tags.join(",") : undefined,
        type,
        createdAt: now,
        updatedAt: now,
        displayName,
        overview,
        userName,
        userEmail,
        projectPath,
        projectName,
        gitRepoUrl,
        metadata:
          Object.keys(dynamicMetadata).length > 0 ? JSON.stringify(dynamicMetadata) : undefined,
      };

      const db = connectionManager.getConnection(shard.dbPath);

      // Use transaction for atomic SQLite insert
      const insertMemory = db.transaction(() => {
        const insertStmt = db.prepare(`
          INSERT INTO memories (
            id, content, vector, tags_vector, container_tag, tags, type, created_at, updated_at,
            metadata, display_name, overview, user_name, user_email, project_path, project_name, git_repo_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertStmt.run(
          record.id,
          record.content,
          toBlob(record.vector),
          toBlob(record.tagsVector),
          record.containerTag,
          record.tags || null,
          record.type || null,
          record.createdAt,
          record.updatedAt,
          record.metadata || null,
          record.displayName || null,
          record.overview || null,
          record.userName || null,
          record.userEmail || null,
          record.projectPath || null,
          record.projectName || null,
          record.gitRepoUrl || null
        );
      });
      insertMemory();

      // Vector index update (outside transaction — vector backend is async/in-memory)
      try {
        const backend = await (vectorSearch as any).getBackend();
        await backend.insert({ id: record.id, vector: record.vector, shard, kind: "content" });
        if (record.tagsVector) {
          await backend.insert({ id: record.id, vector: record.tagsVector, shard, kind: "tags" });
        }
      } catch (error) {
        // Rollback SQLite insert on vector backend failure
        db.prepare(`DELETE FROM memories WHERE id = ?`).run(record.id);
        throw error;
      }

      shardManager.incrementVectorCount(shard.id);

      return { success: true as const, id };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("addMemory: error", { error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async deleteMemory(memoryId: string) {
    try {
      await this.initialize();

      const userShards = shardManager.getAllShards("user", "");
      const projectShards = shardManager.getAllShards("project", "");
      const allShards = [...userShards, ...projectShards];

      for (const shard of allShards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memory = vectorSearch.getMemoryById(db, memoryId);

        if (memory) {
          await vectorSearch.deleteVector(db, memoryId, shard);
          shardManager.decrementVectorCount(shard.id);
          return { success: true };
        }
      }

      return { success: false, error: "Memory not found" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("deleteMemory: error", { memoryId, error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  async listMemories(containerTag: string, limit = 20, scope: MemoryScope = "project") {
    try {
      await this.initialize();

      const resolved = resolveScopeValue(scope, containerTag);
      const shards = shardManager.getAllShards(resolved.scope, resolved.hash);

      if (shards.length === 0) {
        return {
          success: true as const,
          memories: [],
          pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
        };
      }

      const allMemories: any[] = [];

      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.listMemories(
          db,
          scope === "all-projects" ? "" : containerTag,
          limit
        );
        allMemories.push(...memories);
      }

      allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));

      const memories = allMemories.slice(0, limit).map((r: any) => ({
        id: r.id,
        summary: r.content,
        createdAt: safeToISOString(r.created_at),
        metadata: safeJSONParse(r.metadata),
        displayName: r.display_name,
        userName: r.user_name,
        userEmail: r.user_email,
        projectPath: r.project_path,
        projectName: r.project_name,
        gitRepoUrl: r.git_repo_url,
      }));

      return {
        success: true as const,
        memories,
        pagination: { currentPage: 1, totalItems: memories.length, totalPages: 1 },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("listMemories: error", { error: errorMessage });
      return {
        success: false as const,
        error: errorMessage,
        memories: [],
        pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
      };
    }
  }

  async listMemoriesByTag(
    containerTag: string,
    tag: string,
    limit = 100,
    scope: MemoryScope = "project"
  ) {
    try {
      await this.initialize();

      const resolved = resolveScopeValue(scope, containerTag);
      const shards = shardManager.getAllShards(resolved.scope, resolved.hash);

      if (shards.length === 0) {
        return {
          success: true as const,
          memories: [],
          pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
        };
      }

      const allMemories: any[] = [];

      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.listByTag(
          db,
          scope === "all-projects" ? "" : containerTag,
          tag,
          limit
        );
        allMemories.push(...memories);
      }

      allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));

      const memories = allMemories.slice(0, limit).map((r: any) => ({
        id: r.id,
        displayName: r.display_name,
        overview: r.overview || undefined,
        tags: r.tags ? r.tags.split(",").map((t: string) => t.trim()) : [],
        createdAt: safeToISOString(r.created_at),
      }));

      return {
        success: true as const,
        memories,
        pagination: { currentPage: 1, totalItems: memories.length, totalPages: 1 },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("listMemoriesByTag: error", { tag, error: errorMessage });
      return {
        success: false as const,
        error: errorMessage,
        memories: [],
        pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
      };
    }
  }

  async listAllMemories(containerTag: string, scope: MemoryScope = "project") {
    try {
      await this.initialize();

      const resolved = resolveScopeValue(scope, containerTag);
      const shards = shardManager.getAllShards(resolved.scope, resolved.hash);

      if (shards.length === 0) {
        return {
          success: true as const,
          memories: [],
        };
      }

      const allMemories: any[] = [];

      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.listAll(
          db,
          scope === "all-projects" ? "" : containerTag
        );
        allMemories.push(...memories);
      }

      allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));

      const memories = allMemories.map((r: any) => ({
        id: r.id,
        displayName: r.display_name,
        overview: r.overview || undefined,
        tags: r.tags ? r.tags.split(",").map((t: string) => t.trim()) : [],
        createdAt: safeToISOString(r.created_at),
      }));

      return {
        success: true as const,
        count: memories.length,
        memories,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("listAllMemories: error", { error: errorMessage });
      return {
        success: false as const,
        error: errorMessage,
        memories: [],
      };
    }
  }

  async filterMemoriesByKeyword(
    containerTag: string,
    keyword: string,
    scope: MemoryScope = "project"
  ) {
    try {
      await this.initialize();

      const resolved = resolveScopeValue(scope, containerTag);
      const shards = shardManager.getAllShards(resolved.scope, resolved.hash);

      if (shards.length === 0) {
        return { success: true as const, memories: [], count: 0 };
      }

      const allMemories: any[] = [];
      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.filterByKeyword(
          db,
          scope === "all-projects" ? "" : containerTag,
          keyword
        );
        allMemories.push(...memories);
      }

      allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));

      const memories = allMemories.map((r: any) => ({
        id: r.id,
        displayName: r.display_name,
        overview: r.overview || undefined,
        tags: r.tags ? r.tags.split(",").map((t: string) => t.trim()) : [],
        createdAt: safeToISOString(r.created_at),
      }));

      return { success: true as const, count: memories.length, memories };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("filterMemoriesByKeyword: error", { keyword, error: errorMessage });
      return { success: false as const, error: errorMessage, memories: [] };
    }
  }

  async getMemoryContent(memoryId: string) {
    try {
      await this.initialize();

      const allShards = [
        ...shardManager.getAllShards("project", ""),
        ...shardManager.getAllShards("user", ""),
      ];

      for (const shard of allShards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const row = vectorSearch.getMemoryById(db, memoryId);
        if (row) {
          return {
            success: true as const,
            id: row.id,
            content: row.content,
            displayName: row.display_name,
            overview: row.overview || undefined,
            tags: row.tags ? row.tags.split(",").map((t: string) => t.trim()) : [],
            createdAt: safeToISOString(row.created_at),
          };
        }
      }

      return { success: false as const, error: "Memory not found" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("getMemoryContent: error", { memoryId, error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async searchMemoriesBySessionID(sessionID: string, containerTag: string, limit: number = 10) {
    try {
      await this.initialize();

      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shards = shardManager.getAllShards(scope, hash);

      if (shards.length === 0) {
        return { success: true as const, results: [], total: 0, timing: 0 };
      }

      const allMemories: any[] = [];

      for (const shard of shards) {
        const db = connectionManager.getConnection(shard.dbPath);
        const memories = vectorSearch.getMemoriesBySessionID(db, sessionID);
        allMemories.push(...memories);
      }

      allMemories.sort((a, b) => b.created_at - a.created_at);

      const results = allMemories.slice(0, limit).map((row: any) => ({
        id: row.id,
        memory: row.content,
        similarity: 1.0,
        tags: row.tags || [],
        metadata: row.metadata || {},
        containerTag: row.container_tag,
        displayName: row.display_name,
        userName: row.user_name,
        userEmail: row.user_email,
        projectPath: row.project_path,
        projectName: row.project_name,
        gitRepoUrl: row.git_repo_url,
        createdAt: row.created_at,
      }));

      return { success: true as const, results, total: results.length, timing: 0 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemoriesBySessionID: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [], total: 0, timing: 0 };
    }
  }
}

export const memoryClient = new LocalMemoryClient();

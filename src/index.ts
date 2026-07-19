import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import { tool } from "@opencode-ai/plugin";

import { memoryClient } from "./services/client.js";
import { formatContextForPrompt } from "./services/context.js";
import { getTags } from "./services/tags.js";
import { stripPrivateContent, isFullyPrivate } from "./services/privacy.js";
import { performAutoCapture } from "./services/auto-capture.js";
import { performUserProfileLearning } from "./services/user-memory-learning.js";
import { userPromptManager } from "./services/user-prompt/user-prompt-manager.js";
import { startWebServer, WebServer } from "./services/web-server.js";

import { isConfigured, CONFIG, initConfig } from "./config.js";
import { log } from "./services/logger.js";
import type { MemoryType } from "./types/index.js";
import { getLanguageName } from "./services/language-detector.js";
import type { MemoryScope } from "./services/client.js";
import { getHostClientConfig } from "./services/ai/opencode-host-config.js";
import { loadOpencodeProvider } from "./services/ai/opencode-provider-loader.js";
import { mkdirSync, writeFileSync } from "node:fs";

function generateDisplayName(content: string): string {
  const lines = content.split("\n").filter((l) => l.trim());
  for (const line of lines) {
    const cleaned = line.replace(/^#{1,6}\s*/, "").trim();
    if (cleaned) return cleaned.substring(0, 80);
  }
  return content.substring(0, 80);
}

function generateOverview(content: string): string {
  const lines = content.split("\n");
  const firstLine = lines[0]?.replace(/^#{1,6}\s*/, "").trim() || "";
  const rest = lines
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith("-") && !l.startsWith("*"))
    .join(" ");
  const overview = [firstLine, rest].filter(Boolean).join(": ");
  return overview.substring(0, 200) || content.substring(0, 200);
}

async function generateAIOverview(content: string): Promise<string | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          {
            role: "system",
            content:
              "你是一个技术文档摘要助手。用一句中文（不超过30字）简短概括以下内容的核心。只返回概述，不要加任何其他内容。",
          },
          { role: "user", content },
        ],
        max_tokens: 160,
        temperature: 0,
        stream: false,
        thinking: { type: "disabled" },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const text = json?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    return text.substring(0, 60);
  } catch {
    return null;
  }
}

function wrapLargeOutput(mode: string, obj: any): string {
  const json = JSON.stringify(obj);
  if (json.length <= 3000) return json;
  const ts = Date.now();
  const file = `/tmp/opencode/mem-${mode}-${ts}.json`;
  mkdirSync("/tmp/opencode", { recursive: true });
  writeFileSync(file, json);
  return JSON.stringify({
    success: obj.success,
    count: obj.count ?? (Array.isArray(obj.memories) ? obj.memories.length : undefined) ?? undefined,
    file,
    size: json.length,
  });
}

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

function loadStandardTags(): string[] {
  const paths = [
    resolve(dirname(new URL(import.meta.url).pathname), "../../standard-tags.json"),
    "/home/pomni/code/opencode-mem/standard-tags.json",
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8"));
    }
  }
  return ["rule", "resource", "operation-log", "information", "errors", "amend"];
}

const STANDARD_TAGS = loadStandardTags();

export function isStructuredSummaryPromptMessage(userMessage: string): boolean {
  // This is the plugin's own structured-summary request. OpenCode echoes it
  // through chat.message like a normal user message, but capturing it would
  // create self-referential memories about the memory prompt instead of the
  // user's conversation.
  return userMessage.includes("Analyze this conversation.") && userMessage.includes('type="skip"');
}

export async function configureOpencodeHostTransport(ctx: {
  readonly client: unknown;
  readonly serverUrl?: string | URL;
}): Promise<void> {
  const { createV2Client, resetHostFetch, setHostFetch, setV2Client } =
    await loadOpencodeProvider();
  resetHostFetch();
  const hostConfig = getHostClientConfig(ctx);
  if (hostConfig.fetch) {
    setHostFetch(hostConfig.fetch);
  } else {
    log("OpenCode host fetch unavailable; falling back to global fetch", {
      clientKeys: hostConfig.clientKeys,
      sdkConfigCount: hostConfig.sdkConfigCount,
    });
  }

  const serverUrl = hostConfig.baseUrl ?? ctx.serverUrl;
  if (serverUrl) {
    setV2Client(createV2Client(serverUrl));
  }
}

function logAutoCaptureProviderStatus(): void {
  if (!CONFIG.autoCaptureEnabled || CONFIG.autoCaptureProviderStatus.ready) return;

  log(
    `Auto-capture disabled by configuration. Issues: ${CONFIG.autoCaptureProviderStatus.issues.join("; ")}.`
  );
}

export const OpenCodeMemPlugin: Plugin = async (ctx: PluginInput) => {
  const { directory } = ctx;
  initConfig(directory);
  logAutoCaptureProviderStatus();
  const tags = getTags(directory);
  let webServer: WebServer | null = null;
  let idleTimeout: Timer | null = null;

  if (!isConfigured()) {
  }

  const GLOBAL_PLUGIN_WARMUP_KEY = Symbol.for("opencode-mem.plugin.warmedup");

  if (!(globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] && isConfigured()) {
    // Fire-and-forget: warmup is slow (embedding model load + index rebuild).
    // Awaiting it here serializes opencode's plugin loader and starves the TUI,
    // which gave the symptom "opencode hangs ~70s then disconnects on startup".
    (async () => {
      try {
        await memoryClient.warmup();
        (globalThis as any)[GLOBAL_PLUGIN_WARMUP_KEY] = true;
      } catch (error) {
        log("Plugin warmup failed", { error: String(error) });
      }
    })();
  }

  await configureOpencodeHostTransport(ctx);

  (async () => {
    try {
      const providerResult = await ctx.client.provider.list();
      if (providerResult.data?.connected) {
        const { setConnectedProviders } = await loadOpencodeProvider();
        setConnectedProviders(providerResult.data.connected);
        log("opencode providers connected", {
          list: providerResult.data.connected,
          configured: CONFIG.opencodeProvider || "(not set)",
        });
      } else {
        log("opencode provider list empty or failed", {
          data: JSON.stringify(providerResult.data).substring(0, 100),
        });
      }
    } catch (error) {
      log("Failed to initialize opencode provider state", { error: String(error) });
    }
  })();

  if (CONFIG.webServerEnabled) {
    startWebServer({
      port: CONFIG.webServerPort,
      host: CONFIG.webServerHost,
      enabled: CONFIG.webServerEnabled,
    })
      .then((server) => {
        webServer = server;
        const url = webServer.getUrl();

        webServer.setOnTakeoverCallback(async () => {
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Explorer",
                  message: "Took over web server ownership",
                  variant: "success",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }
        });

        if (webServer.isServerOwner()) {
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Explorer",
                  message: `Web UI started at ${url}`,
                  variant: "success",
                  duration: 5000,
                },
              })
              .catch(() => {});
          }
        } else {
          if (ctx.client?.tui) {
            ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Explorer",
                  message: `Web UI available at ${url}`,
                  variant: "info",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }
        }
      })
      .catch((error) => {
        log("Web server failed to start", { error: String(error) });

        if (ctx.client?.tui) {
          ctx.client.tui
            .showToast({
              body: {
                title: "Memory Explorer Error",
                message: `Failed to start: ${String(error)}`,
                variant: "error",
                duration: 5000,
              },
            })
            .catch(() => {});
        }
      });
  }

  const cleanupPlugin = async () => {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
      idleTimeout = null;
    }
    if (webServer) await webServer.stop();
    if (memoryClient) memoryClient.close();
  };

  const shutdownHandler = async () => {
    try {
      await cleanupPlugin();
    } catch (error) {
      log("Shutdown error", { error: String(error) });
      process.exitCode = 1;
    }
  };

  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);
  process.on("exit", () => {
    if (webServer) webServer.stop().catch(() => {});
    if (memoryClient) memoryClient.close();
  });

  return {
    "chat.message": async (input, output) => {
      if (!isConfigured() || !CONFIG.chatMessage.enabled) return;

      try {
        const textParts = output.parts.filter(
          (p): p is Part & { type: "text"; text: string } => p.type === "text"
        );

        if (textParts.length === 0) return;
        const userMessage = textParts.map((p) => p.text).join("\n");
        if (!userMessage.trim()) return;

        if (isStructuredSummaryPromptMessage(userMessage)) {
          return;
        }

        userPromptManager.savePrompt(input.sessionID, output.message.id, directory, userMessage);

        const messagesResponse = await ctx.client.session.messages({
          path: { id: input.sessionID },
        });
        const messages = messagesResponse.data || [];

        const hasNonSyntheticUserMessages = messages.some(
          (m) =>
            m.info.role === "user" &&
            !m.parts.every((p) => p.type !== "text" || p.synthetic === true)
        );

        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        const isAfterCompaction = lastMessage?.info?.summary === true;

        const shouldInject =
          CONFIG.chatMessage.injectOn === "always" ||
          !hasNonSyntheticUserMessages ||
          (isAfterCompaction &&
            messages.filter(
              (m) =>
                m.info.role === "user" &&
                !m.parts.every((p) => p.type !== "text" || p.synthetic === true)
            ).length === 1);

        if (!shouldInject) return;

        const listResult = await memoryClient.listMemories(
          tags.project.tag,
          CONFIG.chatMessage.maxMemories
        );

        let memories = listResult.success ? listResult.memories : [];

        if (CONFIG.chatMessage.excludeCurrentSession) {
          memories = memories.filter((m: any) => m.metadata?.sessionID !== input.sessionID);
        }

        if (CONFIG.chatMessage.maxAgeDays) {
          const cutoffDate = Date.now() - CONFIG.chatMessage.maxAgeDays * 86400000;
          memories = memories.filter((m: any) => new Date(m.createdAt).getTime() > cutoffDate);
        }

        if (memories.length === 0) return;

        const projectMemories = {
          results: memories.map((m: any) => ({
            similarity: 1.0,
            memory: m.summary,
          })),
          total: memories.length,
          timing: 0,
        };

        const userId = tags.user.userEmail || null;
        const memoryContext = formatContextForPrompt(userId, projectMemories);

        if (memoryContext) {
          const contextPart: Part = {
            id: `prt-memory-context-${Date.now()}`,
            sessionID: input.sessionID,
            messageID: output.message.id,
            type: "text",
            text: memoryContext,
            synthetic: true,
          } as any;
          output.parts.unshift(contextPart);
        }
      } catch (error) {
        log("chat.message: ERROR", { error: String(error) });
        if (ctx.client?.tui && CONFIG.showErrorToasts) {
          await ctx.client.tui
            .showToast({
              body: {
                title: "Memory System Error",
                message: String(error),
                variant: "error",
                duration: 5000,
              },
            })
            .catch(() => {});
        }
      }
    },

    "chat.params": async (input) => {
      if (!isConfigured() || CONFIG.opencodeModel !== "inherit") return;

      try {
        userPromptManager.setPromptModel(input.message.id, input.model.providerID, input.model.id);
      } catch (error) {
        log("chat.params: ERROR", { error: String(error) });
      }
    },

    tool: {
      memory: tool({
        description: `Manage and query project memory (MATCH USER LANGUAGE: ${getLanguageName(CONFIG.autoCaptureLanguage || "en")}). Use 'search' with technical keywords/tags, 'add' to store knowledge, 'profile' for preferences. Search/list scope: project or all-projects.`,
        args: {
          mode: tool.schema.enum(["add", "search", "profile", "list", "forget", "help", "filter_by_tag", "list_all", "filter_by_keyword", "pick"]).optional(),
          content: tool.schema.string().optional(),
          query: tool.schema.string().optional(),
          tags: tool.schema.string().optional(),
          agent: tool.schema.string(),
          type: tool.schema.string().optional(),
          memoryId: tool.schema.string().optional(),
          limit: tool.schema.number().optional(),
          scope: tool.schema.enum(["project", "all-projects"]).optional(),
        },
        async execute(args: {
          mode?: "add" | "search" | "profile" | "list" | "forget" | "help" | "filter_by_tag" | "list_all" | "filter_by_keyword" | "pick";
          content?: string;
          query?: string;
          tags?: string;
          agent: string;
          type?: MemoryType;
          memoryId?: string;
          limit?: number;
          scope?: MemoryScope;
        }) {
          if (!isConfigured()) {
            return JSON.stringify({
              success: false,
              error: "Memory system not configured properly.",
            });
          }

          const needsWarmup = !(await memoryClient.isReady());
          if (needsWarmup) {
            return JSON.stringify({ success: false, error: "Memory system is initializing." });
          }

          const mode = args.mode || "help";
          const langName = getLanguageName(CONFIG.autoCaptureLanguage || "en");

          try {
            switch (mode) {
              case "help":
                return JSON.stringify({
                  success: true,
                  message: "Memory System Usage Guide",
                  commands: [
                    {
                      command: "add",
                      description: `Store new memory (MATCH USER LANGUAGE: ${langName})`,
                      args: ["content", "type?", "tags?"],
                    },
                    {
                      command: "search",
                      description: `Search memories via keywords (MATCH USER LANGUAGE: ${langName})`,
                      args: ["query"],
                    },
                    {
                      command: "profile",
                      description:
                        "View user profile or save an explicit preference (provide content to write)",
                      args: ["content?"],
                    },
                    { command: "list", description: "List recent memories", args: ["limit?"] },
                    {
                      command: "filter_by_tag",
                      description: "List memories filtered by a specific tag",
                      args: ["tag", "limit?"],
                    },
                    {
                      command: "list_all",
                      description: "List all memories with id, name, overview and tags",
                      args: ["scope?"],
                    },
                    {
                      command: "filter_by_keyword",
                      description: "Filter memories whose content contains a keyword",
                      args: ["query", "scope?"],
                    },
                    {
                      command: "pick",
                      description: "Retrieve full content of a memory by id",
                      args: ["memoryId"],
                    },
                    { command: "forget", description: "Remove memory", args: ["memoryId"] },
                  ],
                  tagGuidance: "Use technical keywords for search. Tags rank highest.",
                });

              case "add":
                if (!args.content)
                  return JSON.stringify({ success: false, error: "content required" });
                if (!args.tags)
                  return JSON.stringify({
                    success: false,
                    error: "tags required — must include at least one standard tag: rule, resource, operation-log, information, errors, amend",
                  });
                const parsedTags = args.tags.split(",").map((t) => t.trim().toLowerCase());
                const stdCount = parsedTags.filter((t) => STANDARD_TAGS.includes(t)).length;
                if (stdCount < 1) {
                  return JSON.stringify({
                    success: false,
                    error: `at least one standard tag required (found ${stdCount}). Standard tags: ${STANDARD_TAGS.join(", ")}`,
                  });
                }
                const agentTag = `agent-${args.agent.toLowerCase().trim()}`;
                if (!parsedTags.includes(agentTag)) {
                  parsedTags.push(agentTag);
                }
                const sanitizedContent = stripPrivateContent(args.content);
                if (isFullyPrivate(args.content))
                  return JSON.stringify({ success: false, error: "Private content blocked" });
                const tagInfo = tags.project;
                const result = await memoryClient.addMemory(sanitizedContent, tagInfo.tag, {
                  type: args.type,
                  tags: parsedTags,
                  displayName: generateDisplayName(sanitizedContent),
                  overview: (await generateAIOverview(sanitizedContent)) || generateOverview(sanitizedContent),
                  userName: tagInfo.userName,
                  userEmail: tagInfo.userEmail,
                  projectPath: tagInfo.projectPath,
                  projectName: tagInfo.projectName,
                  gitRepoUrl: tagInfo.gitRepoUrl,
                });
                return JSON.stringify({
                  success: result.success,
                  message: `Memory added`,
                  id: result.id,
                  tags: parsedTags,
                });

              case "search":
                if (!args.query) return JSON.stringify({ success: false, error: "query required" });
                const combinedRes = await memoryClient.combinedSearch(
                  args.query,
                  tags.project.tag,
                  args.limit || 10,
                  args.scope ?? CONFIG.memory.defaultScope
                );
                if (!combinedRes.success)
                  return JSON.stringify({ success: false, error: combinedRes.error });
                return wrapLargeOutput("search", {
                  success: true,
                  query: args.query,
                  count: combinedRes.count,
                  results: combinedRes.results?.map((r: any) => ({
                    id: r.id,
                    overview: r.overview,
                    tags: r.tags,
                    similarity: Math.round(r.similarity * 100),
                    source: r.source,
                  })),
                });

              case "profile": {
                if (args.query) {
                  return JSON.stringify({
                    success: false,
                    error:
                      "query is not valid for profile mode. Use content to write a preference or omit all args to read.",
                  });
                }

                const { userProfileManager } =
                  await import("./services/user-profile/user-profile-manager.js");

                const userId = tags.user.userEmail || "unknown";

                // --- WRITE: explicit preference ---
                if (args.content !== undefined) {
                  const trimmed = args.content.trim();
                  if (!trimmed) {
                    return JSON.stringify({ success: false, error: "content must not be blank" });
                  }

                  if (!tags.user.userEmail) {
                    return JSON.stringify({
                      success: false,
                      error:
                        "Cannot save profile preference because no user email could be resolved. Configure userEmailOverride or git user.email.",
                    });
                  }

                  const sanitizedContent = stripPrivateContent(trimmed);
                  const hasNonPrivateContent =
                    sanitizedContent.replace(/\[REDACTED\]/g, "").trim().length > 0;

                  if (isFullyPrivate(trimmed) || !hasNonPrivateContent) {
                    return JSON.stringify({ success: false, error: "Private content blocked" });
                  }

                  const newPreference = {
                    category: "explicit",
                    description: sanitizedContent,
                    confidence: 1.0,
                    frequency: 1,
                    evidence: ["manual-write"],
                    lastSeen: Date.now(),
                  };

                  const existingProfile = userProfileManager.getActiveProfile(userId);

                  if (existingProfile) {
                    const existingData = JSON.parse(existingProfile.profileData);
                    const mergedData = await userProfileManager.mergeProfileData(
                      existingData,
                      {
                        preferences: [newPreference],
                      },
                      undefined,
                      existingProfile.id
                    );
                    userProfileManager.updateProfile(
                      existingProfile.id,
                      mergedData,
                      0,
                      `Explicit preference added: ${sanitizedContent.slice(0, 80)}`
                    );
                    return JSON.stringify({
                      success: true,
                      message: "Preference saved to profile",
                    });
                  } else {
                    userProfileManager.createProfile(
                      userId,
                      tags.user.displayName || userId,
                      tags.user.userName || userId,
                      tags.user.userEmail || userId,
                      { preferences: [newPreference], patterns: [], workflows: [] },
                      0
                    );
                    return JSON.stringify({
                      success: true,
                      message: "Profile created with preference",
                    });
                  }
                }

                // --- READ: no content provided ---
                const profile = userProfileManager.getActiveProfile(userId);
                if (!profile) return JSON.stringify({ success: true, profile: null });
                const pData = JSON.parse(profile.profileData);
                return JSON.stringify({
                  success: true,
                  profile: {
                    ...pData,
                    version: profile.version,
                    lastAnalyzed: profile.lastAnalyzedAt,
                  },
                });
              }

              case "list":
                const listRes = await memoryClient.listMemories(
                  tags.project.tag,
                  args.limit || 20,
                  args.scope ?? CONFIG.memory.defaultScope
                );
                if (!listRes.success)
                  return JSON.stringify({ success: false, error: listRes.error });
                return wrapLargeOutput("list", {
                  success: true,
                  count: listRes.memories?.length,
                  memories: listRes.memories?.map((m: any) => ({
                    id: m.id,
                    content: m.summary,
                  })),
                });

              case "filter_by_tag":
                if (!args.tags)
                  return JSON.stringify({ success: false, error: "tag required (use 'tags' parameter)" });
                const byTagRes = await memoryClient.listMemoriesByTag(
                  tags.project.tag,
                  args.tags.toLowerCase().trim(),
                  args.limit || 100,
                  args.scope ?? CONFIG.memory.defaultScope
                );
                if (!byTagRes.success)
                  return JSON.stringify({ success: false, error: byTagRes.error });
                return wrapLargeOutput("filter_by_tag", {
                  success: true,
                  count: byTagRes.memories?.length,
                  memories: byTagRes.memories?.map((m: any) => ({
                    id: m.id,
                    overview: m.overview,
                    tags: m.tags,
                  })),

                });

              case "list_all":
                const allRes = await memoryClient.listAllMemories(
                  tags.project.tag,
                  args.scope ?? CONFIG.memory.defaultScope
                );
                if (!allRes.success)
                  return JSON.stringify({ success: false, error: allRes.error });
                return wrapLargeOutput("list_all", {
                  success: true,
                  count: allRes.count,
                  memories: allRes.memories?.map((m: any) => ({
                    id: m.id,
                    overview: m.overview,
                    tags: m.tags,
                  })),
                });

              case "filter_by_keyword":
                if (!args.query)
                  return JSON.stringify({ success: false, error: "query required (keyword to filter)" });
                const kwRes = await memoryClient.filterMemoriesByKeyword(
                  tags.project.tag,
                  args.query,
                  args.scope ?? CONFIG.memory.defaultScope
                );
                if (!kwRes.success)
                  return JSON.stringify({ success: false, error: kwRes.error });
                return wrapLargeOutput("filter_by_keyword", {
                  success: true,
                  count: kwRes.count,
                  memories: kwRes.memories?.map((m: any) => ({
                    id: m.id,
                    overview: m.overview,
                    tags: m.tags,
                  })),
                });

              case "pick":
                if (!args.memoryId)
                  return JSON.stringify({ success: false, error: "memoryId required" });
                const pickRes = await memoryClient.getMemoryContent(args.memoryId);
                return wrapLargeOutput("pick", pickRes);

              case "forget":
                if (!args.memoryId)
                  return JSON.stringify({ success: false, error: "memoryId required" });
                const delRes = await memoryClient.deleteMemory(args.memoryId);
                return JSON.stringify({ success: delRes.success, message: `Memory removed` });

              default:
                return JSON.stringify({ success: false, error: `Unknown mode: ${mode}` });
            }
          } catch (error) {
            return JSON.stringify({ success: false, error: String(error) });
          }
        },
      }),
    },

    event: async (input: { event: { type: string; properties?: any } }) => {
      const event = input.event;
      if (event.type === "session.idle") {
        if (!isConfigured() || !CONFIG.autoCaptureEnabled) return;
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        if (idleTimeout) clearTimeout(idleTimeout);

        idleTimeout = setTimeout(async () => {
          try {
            await performAutoCapture(ctx, sessionID, directory);

            if (webServer?.isServerOwner()) {
              await performUserProfileLearning(ctx, directory);
              const { cleanupService } = await import("./services/cleanup-service.js");
              if (await cleanupService.shouldRunCleanup()) await cleanupService.runCleanup();
              const { connectionManager } = await import("./services/sqlite/connection-manager.js");
              connectionManager.checkpointAll();
            }
          } catch (error) {
            log("Idle processing error", { error: String(error) });
          } finally {
            idleTimeout = null;
          }
        }, 10000);
      }

      if (event.type === "session.compacted") {
        if (!isConfigured() || !CONFIG.compaction.enabled) return;

        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        try {
          const tags = getTags(directory);

          const memoriesResult = await memoryClient.searchMemoriesBySessionID(
            sessionID,
            tags.project.tag,
            CONFIG.compaction.memoryLimit
          );

          if (!memoriesResult.success || memoriesResult.results.length === 0) {
            return;
          }

          const memoryContext = formatMemoriesForCompaction(memoriesResult.results);

          await ctx.client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{ id: `prt-compaction-${Date.now()}`, type: "text", text: memoryContext }],
              noReply: true,
            },
          });

          if (ctx.client?.tui) {
            await ctx.client.tui
              .showToast({
                body: {
                  title: "Memory Restored",
                  message: `${memoriesResult.results.length} memories injected after compaction`,
                  variant: "success",
                  duration: 3000,
                },
              })
              .catch(() => {});
          }

          log("Compaction memory injected", {
            sessionID,
            count: memoriesResult.results.length,
          });
        } catch (error) {
          log("Compaction handler error", { error: String(error) });
        }
      }
    },
  };
};

function formatSearchResults(query: string, results: any, limit?: number): string {
  const memoryResults = results.results || [];
  return JSON.stringify({
    success: true,
    query,
    count: memoryResults.length,
    results: memoryResults.slice(0, limit || 10).map((r: any) => ({
      id: r.id,
      content: r.memory || r.chunk,
      similarity: Math.round(r.similarity * 100),
    })),
  });
}

function formatMemoriesForCompaction(memories: any[]): string {
  let output = `## Restored Session Memory\n\n`;

  memories.forEach((m, i) => {
    output += `### Memory ${i + 1}\n`;
    output += `${m.memory}\n\n`;
    if (m.tags && m.tags.length > 0) {
      output += `Tags: ${m.tags.join(", ")}\n\n`;
    }
  });

  return output;
}

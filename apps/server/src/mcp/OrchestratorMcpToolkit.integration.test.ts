import * as NodeURL from "node:url";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  isProviderNativeSubagentThread,
  MessageId,
  type ModelSelection,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadReadResult,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { McpSchema, McpServer } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../auth/McpOAuth.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "@t3tools/provider-testing/replayTranscript";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

/** A task delegated here always has a local child thread. */
const localChild = (childThreadId: ThreadId | null): ThreadId => {
  if (childThreadId === null) throw new Error("expected a local delegated child");
  return childThreadId;
};

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const codexInstanceId = ProviderInstanceId.make("codex");
const codexModel = "gpt-5.4";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const queuedFollowupPrompt = "Complete the queued follow-up and return the final result.";
const queuedFollowupResult = "Queued delegated follow-up completed.";
const decodeThreadRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const longFollowupResult = "Long delegated follow-up line. ".repeat(1_500);

const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const delegatedTaskStatusTranscriptFile = new URL(
  "../orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson",
  import.meta.url,
);

const readDelegatedTaskStatusTranscript = Effect.fn("readDelegatedTaskStatusTranscript")(
  function* (followupResult: string) {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(NodeURL.fileURLToPath(delegatedTaskStatusTranscriptFile));
    const transcript = yield* decodeProviderReplayNdjson(
      text.replaceAll(queuedFollowupResult, followupResult),
    );
    // The recording ends when the recorder closes the app-server while the parent
    // turn is still open. This test keeps acting as that parent afterwards, and
    // replaying the exit would kill the shared process and fail the parent run.
    return {
      ...transcript,
      entries: transcript.entries.filter((entry) => entry.type !== "runtime_exit"),
    };
  },
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

const layerUnusedScheduledTaskStub = Layer.succeed(
  ScheduledTaskService.ScheduledTaskService,
  ScheduledTaskService.ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    subscribeList: () => Stream.succeed({ tasks: [] }),
    upsert: () => Effect.die("ScheduledTaskService.upsert is unused in this test"),
    setEnabled: () => Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
    delete: () => Effect.die("ScheduledTaskService.delete is unused in this test"),
    deleteForThread: () => Effect.die("unused in this test"),
    moveThreadTasks: () => Effect.die("unused in this test"),
    runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
    rotateWebhookToken: () => Effect.die("unused in this test"),
    listWebhookDeliveries: () => Effect.die("unused in this test"),
    getWebhookDelivery: () => Effect.die("unused in this test"),
    triggerWebhook: () => Effect.die("unused in this test"),
  }),
);

const layerUnusedPeerServices = Layer.mergeAll(
  Layer.mock(PeerForwarding.PeerForwarding)({}),
  Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
  Layer.mock(PeerLinks.PeerLinks)({}),
  Layer.mock(RemoteDelegation.RemoteDelegation)({}),
);

const layerCodexProvider = ProviderRegistryMock.layer([
  makeProviderSnapshot({
    instanceId: codexInstanceId,
    driver: ProviderDriverKind.make("codex"),
    model: codexModel,
  }),
]);

const createReplayThread = Effect.fn("createReplayThread")(function* (
  threadId: ThreadId,
  title: string,
  cwd: string,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:${threadId}:create`),
    threadId,
    projectId,
    title,
    modelSelection: codexSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
  });
});

const startReplayParent = Orchestrator.OrchestratorV2.use((orchestrator) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:mcp-replay-parent:start"),
    threadId: parentThreadId,
    messageId: MessageId.make("message:mcp-replay-parent:start"),
    text: parentPrompt,
    attachments: [],
    modelSelection: codexSelection,
    dispatchMode: { type: "start_immediately" },
  }),
);

const awaitReplayParent = Effect.fn("awaitReplayParent")(function* (afterSequence: number) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const running = yield* orchestrator
    .streamStoredEventsFrom({ threadId: parentThreadId, afterSequence })
    .pipe(
      Stream.filter(
        ({ event }) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.runHead,
    );
  expect(Option.isSome(running)).toBe(true);
});

const protocol = "2025-06-18";

const connectHttpMcp = Effect.fn("connectHttpMcp")(function* (authorization: string) {
  const http = yield* HttpClient.HttpClient;
  const send = (method: string, params: object, sessionId?: string) =>
    http.post("/mcp", {
      headers: {
        accept: "application/json, text/event-stream",
        authorization,
        ...(sessionId === undefined
          ? {}
          : { "mcp-session-id": sessionId, "mcp-protocol-version": protocol }),
      },
      body: HttpBody.text(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        "application/json",
      ),
    });
  const initialized = yield* send("initialize", {
    protocolVersion: protocol,
    capabilities: {},
    clientInfo: { name: "thread-folders-integration", version: "1.0.0" },
  });
  expect(initialized.status).toBe(200);
  const sessionId = initialized.headers["mcp-session-id"];
  if (sessionId === undefined) throw new Error("MCP initialize did not return a session");
  const rpc = <A>(method: string, params: object) =>
    send(method, params, sessionId).pipe(
      Effect.flatMap((response) => {
        expect(response.status).toBe(200);
        return response.json;
      }),
      Effect.map((body) => (body as { result: A }).result),
    );
  const list = () =>
    rpc<{ tools: ReadonlyArray<{ name: string }> }>("tools/list", {}).pipe(
      Effect.map(({ tools }) => tools.map(({ name }) => name)),
    );
  const call = (name: string, args: object) =>
    rpc<{
      isError?: boolean;
      structuredContent?: unknown;
      content: ReadonlyArray<{ text: string }>;
    }>("tools/call", { name, arguments: args });
  const success = (name: string, args: object) =>
    call(name, args).pipe(
      Effect.map((result) => {
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        return result.structuredContent;
      }),
    );
  const failure = (name: string, args: object) =>
    call(name, args).pipe(
      Effect.map((result) => {
        expect(result.isError).toBe(true);
        return JSON.parse(result.content[0]!.text) as { code: string };
      }),
    );
  return { list, success, failure };
});

describe("orchestrator MCP toolkit", () => {
  it.live("manages folders and assigns new agent threads through authenticated MCP", () =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("thread-folders-mcp");
      const rawTranscript = yield* readDelegatedTaskStatusTranscript(queuedFollowupResult);
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(rawTranscript, cwd),
      );
      const database = SqlitePersistence.layerMemory;
      const adapters = CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript);
      const layerReplay = ProviderReplayHarness.layerWithRegistry(
        { name: "thread-folders-mcp/codex", runtimePolicyOverride: { cwd } },
        adapters,
        { databaseLayer: database, runEffectWorker: false },
      );
      const settings = ServerSettings.layerTest();
      const layerThreads = ThreadManagementService.layer.pipe(
        Layer.provideMerge(layerReplay),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
        Layer.provide(settings),
      );
      const layerAuth = Layer.mergeAll(EnvironmentAuth.layer, McpSessionRegistry.layer).pipe(
        Layer.provideMerge(ServerEnvironment.layerIdentity),
        Layer.provideMerge(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:mcp-folders")),
          }),
        ),
        Layer.provide(layerMemorySecretStore),
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(database),
        Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "t3-mcp-folders-auth-" })),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const project: Project = {
        id: projectId,
        title: "Folder MCP project",
        workspaceRoot: cwd,
        repositoryIdentity: null,
        faviconPath: null,
        defaultModelSelection: codexSelection,
        defaultThreadEnvMode: null,
        scripts: [],
        pinnedAt: null,
        archivedAt: null,
        createdAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        deletedAt: null,
      };
      const launchDependencies = Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => (id === projectId ? Effect.succeedSome(project) : Effect.succeedNone),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: cwd,
          folderForThread: () => Effect.succeedNone,
        }),
        Layer.mock(GitWorkflow.GitWorkflowService)({ currentBranch: () => Effect.succeed(null) }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(CheckpointStore.CheckpointStore)({}),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" }),
        }),
        Layer.mock(TerminalManager.TerminalManager)({}),
        Layer.mock(TextGeneration.TextGeneration)({}),
        WorktreeSetupTracker.layer,
        IdAllocator.layer,
        layerCodexProvider,
        settings,
      );
      const registrations = Layer.mergeAll(
        McpHttpServer.layerOrchestratorToolkit,
        McpHttpServer.layerThreadToolkit,
        McpHttpServer.layerProjectRegistration,
      ).pipe(
        Layer.provide(
          ThreadLaunchService.layer.pipe(
            Layer.provide(launchDependencies),
            Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
          ),
        ),
        Layer.provide(launchDependencies),
        Layer.provide(adapters.pipe(Layer.provide(McpProviderSessions.layer))),
        Layer.provide(layerUnusedScheduledTaskStub),
        Layer.provide(ThreadSearch.layer.pipe(Layer.provide(database))),
        Layer.provide(layerUnusedPeerServices),
        Layer.provide(Layer.mock(DocumentText.DocumentText)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(
          Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
        ),
        Layer.provide(
          SecretRequests.layer.pipe(
            Layer.provide(layerMemorySecretStore),
            Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
            Layer.provide(layerThreads),
          ),
        ),
      );
      const http = McpHttpServer.layerMcpTransport(registrations).pipe(
        Layer.provide(McpOAuth.layerMcpClientAuthenticator),
        Layer.provide(settings),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const otherThreadId = ThreadId.make("thread:mcp-folders-other");
        yield* createReplayThread(parentThreadId, "Folder MCP parent", cwd);
        yield* createReplayThread(otherThreadId, "Folder MCP other", cwd);
        const parentStart = yield* startReplayParent;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
        yield* awaitReplayParent(parentStart.sequence);

        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const provider = yield* registry.issue({
          threadId: parentThreadId,
          providerInstanceId: codexInstanceId,
        });
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const oauth = yield* auth.issueMcpClientSession({
          label: "Folders read-only",
          access: "read-only",
          peerLink: false,
          client: { deviceType: "bot" },
        });
        yield* HttpRouter.serve(http, { disableListenLog: true, disableLogger: true }).pipe(
          Layer.build,
        );

        const agent = yield* connectHttpMcp(provider.config.authorizationHeader);
        const reader = yield* connectHttpMcp(`Bearer ${oauth.token}`);
        const listTool = "t3_thread_folder_list";
        const readTool = "t3_thread_folder_read";
        const manageTool = "t3_thread_folder_manage";
        expect(yield* agent.list()).toEqual(
          expect.arrayContaining([listTool, readTool, manageTool]),
        );
        expect(yield* reader.list()).toEqual(expect.arrayContaining([listTool, readTool]));
        expect(
          yield* reader.failure(manageTool, { action: "create", name: "Denied" }),
        ).toMatchObject({
          code: "capability_denied",
        });

        const decodeFolderId = Schema.decodeUnknownEffect(
          Schema.Struct({ folderId: Schema.String }),
        );
        const inherited = yield* agent
          .success(manageTool, { action: "create", name: "Source" })
          .pipe(Effect.flatMap(decodeFolderId));
        const explicit = yield* agent
          .success(manageTool, { action: "create", name: "Target" })
          .pipe(Effect.flatMap(decodeFolderId));
        const source = { id: inherited.folderId, name: "Source" };
        const target = { id: explicit.folderId, name: "Target" };
        expect(yield* reader.success(listTool, {})).toEqual({ folders: [source, target] });
        yield* agent.success(manageTool, {
          action: "move",
          folderId: source.id,
          threadIds: [parentThreadId, otherThreadId],
        });
        expect(yield* agent.success(readTool, {})).toEqual({
          threadId: parentThreadId,
          folder: source,
        });
        expect(yield* reader.success(readTool, { folderId: source.id })).toEqual({
          folder: source,
          threads: expect.arrayContaining([
            { threadId: parentThreadId, projectId, title: "Folder MCP parent" },
            { threadId: otherThreadId, projectId, title: "Folder MCP other" },
          ]),
          nextCursor: null,
        });
        const folders = yield* orchestrator.threadFolders;
        const beforeInvalid = yield* folders.snapshot();
        for (const [folderId, threadIds, code] of [
          [target.id, [parentThreadId, "thread:mcp-folders-missing"], "thread_not_found"],
          ["missing-folder", [parentThreadId, otherThreadId], "invalid_request"],
        ] as const) {
          expect(
            yield* agent.failure(manageTool, { action: "move", folderId, threadIds }),
          ).toMatchObject({ code });
          expect(yield* folders.snapshot()).toEqual(beforeInvalid);
        }

        const created = yield* agent
          .success("create_threads", {
            clientRequestId: "folders-create",
            threads: [
              { title: "Inherited" },
              { title: "Explicit", folderId: target.id },
              { title: "Unassigned", folderId: null },
            ],
          })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(OrchestratorMcpCreateThreadsResult)));
        expect(created.threads).toHaveLength(3);
        for (const [index, folder] of [source, target, null].entries()) {
          const threadId = created.threads[index]!.threadId;
          expect(yield* agent.success(readTool, { threadId })).toEqual({ threadId, folder });
        }

        const decodeLaunched = Schema.decodeUnknownEffect(Schema.Struct({ threadId: ThreadId }));
        for (const [index, folder] of [source, target, null].entries()) {
          const folderChoice = index === 0 ? {} : { folderId: folder?.id ?? null };
          const child = yield* agent
            .success("delegate_task", {
              task: delegatedPrompt,
              mode: "async",
              clientRequestId: `folders-delegate-${index}`,
              ...folderChoice,
            })
            .pipe(Effect.flatMap(decodeDelegateTaskResult));
          const threadId = localChild(child.childThreadId);
          expect(yield* agent.success(readTool, { threadId })).toEqual({ threadId, folder });
          const launched = yield* agent
            .success("t3_thread_launch", {
              title: `Folder launch ${index}`,
              clientRequestId: `folders-launch-${index}`,
              ...folderChoice,
            })
            .pipe(Effect.flatMap(decodeLaunched));
          expect(yield* agent.success(readTool, launched)).toEqual({ ...launched, folder });
        }

        yield* agent.success(manageTool, {
          action: "rename",
          folderId: target.id,
          name: "Renamed",
        });
        yield* agent.success(manageTool, {
          action: "reorder",
          folderId: target.id,
          beforeFolderId: source.id,
        });
        expect(yield* reader.success(listTool, {})).toEqual({
          folders: [{ id: target.id, name: "Renamed" }, source],
        });
        const explicitThreadId = created.threads[1]!.threadId;
        yield* agent.success(manageTool, { action: "delete", folderId: target.id });
        expect(yield* reader.success(listTool, {})).toEqual({ folders: [source] });
        expect(yield* agent.success(readTool, { threadId: explicitThreadId })).toEqual({
          threadId: explicitThreadId,
          folder: null,
        });
      }).pipe(
        Effect.provide(
          Layer.merge(layerThreads, layerAuth).pipe(
            Layer.provideMerge(NodeHttpServer.layerTest),
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      );
    }),
  );

  it.live.each([
    { label: "distinct", result: queuedFollowupResult, latestSummary: queuedFollowupResult },
    { label: "identical", result: delegatedResult, latestSummary: null },
    { label: "emoji", result: "😀", latestSummary: "😀" },
    { label: "long", result: longFollowupResult, latestSummary: longFollowupResult },
  ])("reports $label child results", ({ result, latestSummary }) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("delegated-task-status");
      const rawTranscript = yield* readDelegatedTaskStatusTranscript(result);
      const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(rawTranscript, cwd),
      );
      const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
        {
          name: "delegated-task-status/codex",
          transcript,
          commands: [],
          runtimePolicyOverride: { cwd },
        },
        CodexOrchestratorReplayHarness,
      );
      // SQL spans carry no bound parameters, so this records which thread each tool read.
      const threadRecordReads: Array<{
        readonly threadId: ThreadId;
        readonly fields: ReadonlyArray<string>;
      }> = [];
      const layerOrchestration = Layer.merge(
        layerOrchestrator,
        Layer.effect(
          ThreadManagementService.ThreadManagementService,
          Effect.gen(function* () {
            const service = yield* ThreadManagementService.ThreadManagementService;
            return ThreadManagementService.ThreadManagementService.of({
              ...service,
              getThreadRecords: (threadId, fields, filter) =>
                Effect.sync(() => threadRecordReads.push({ threadId, fields })).pipe(
                  Effect.andThen(service.getThreadRecords(threadId, fields, filter)),
                ),
            });
          }),
        ).pipe(
          Layer.provide(
            ThreadManagementService.layer.pipe(
              Layer.provide(layerOrchestrator),
              Layer.provide(ServerSettings.layerTest()),
              Layer.provide(
                CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
              ),
            ),
          ),
        ),
      );
      const layerTest = layerOrchestratorToolkit.pipe(
        Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
        Layer.provideMerge(layerOrchestration),
        Layer.provide(
          CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript).pipe(
            Layer.provide(McpProviderSessions.layer),
          ),
        ),
        Layer.provide(layerCodexProvider),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerUnusedScheduledTaskStub),
        Layer.provide(layerUnusedPeerServices),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provideMerge(
          SecretRequests.layer.pipe(
            Layer.provide(layerMemorySecretStore),
            Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
            Layer.provide(layerOrchestration),
          ),
        ),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const server = yield* McpServer.McpServer;
        yield* createReplayThread(parentThreadId, "MCP replay parent", cwd);
        const parentStart = yield* startReplayParent;
        yield* awaitReplayParent(parentStart.sequence);

        const invocation: McpInvocationContext.McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-replay"),
          requestNamespace: "mcp-provider-session-replay-parent",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "mcp-provider-session-replay-parent",
            providerInstanceId: codexInstanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const invoke = (name: string, args: Record<string, unknown>, scope = invocation) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
              Effect.provideService(McpSchema.McpServerClient, client),
            );

        const delegationStartSequence = yield* orchestrator.getThreadEventSequence(parentThreadId);
        const delegatedCall = yield* invoke("delegate_task", {
          task: delegatedPrompt,
          target: {
            providerInstanceId: codexInstanceId,
            model: codexModel,
          },
          mode: "async",
          clientRequestId: "delegate-codex-replay-1",
        });
        const delegatedStart = yield* decodeDelegateTaskResult(
          delegatedCall.structuredContent,
        ).pipe(Effect.orDie);
        expect(delegatedStart.childRunId).not.toBeNull();
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: parentThreadId,
            afterSequence: delegationStartSequence,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "context-transfer.created" &&
                stored.event.payload.type === "subagent_result" &&
                stored.event.payload.sourceThreadId === delegatedStart.childThreadId &&
                stored.event.payload.sourcePoint.runId === delegatedStart.childRunId,
            ),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("Delegated result transfer was not created."),
                onSome: () => Effect.void,
              }),
            ),
          );
        const delegatedStatusCall = yield* invoke("task_status", {
          taskId: delegatedStart.taskId,
        });
        const delegated = yield* decodeDelegateTaskResult(
          delegatedStatusCall.structuredContent,
        ).pipe(Effect.orDie);
        expect(delegated).toMatchObject({
          status: "completed",
          summary: delegatedResult,
          providerInstanceId: codexInstanceId,
          hasPendingChildRuns: false,
          latestTerminalRunId: delegated.childRunId,
          latestTerminalStatus: "completed",
          latestTerminalSummary: null,
          latestTerminalResultContextTransferId: null,
        });
        expect(delegated.resultContextTransferId).not.toBeNull();

        const delegatedChild = yield* orchestrator.getThreadProjection(
          localChild(delegated.childThreadId),
        );
        expect(delegatedChild.thread.lineage.relationshipToParent).toBe("subagent");
        expect(isProviderNativeSubagentThread(delegatedChild.thread)).toBe(false);
        const followupStartSequence = yield* orchestrator.getThreadEventSequence(
          localChild(delegated.childThreadId),
        );
        const runningFollowupCall = yield* invoke("t3_thread_send", {
          threadId: localChild(delegated.childThreadId),
          message: cancellationPrompt,
          clientRequestId: "delegated-child-replay-running-1",
        });
        const runningFollowup = yield* decodeThreadSendResult(
          runningFollowupCall.structuredContent,
        ).pipe(Effect.orDie);
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: localChild(delegated.childThreadId),
            afterSequence: followupStartSequence,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "running",
            ),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("Follow-up provider turn did not start."),
                onSome: () => Effect.void,
              }),
            ),
          );

        const queuedFollowupCall = yield* invoke("t3_thread_send", {
          threadId: localChild(delegated.childThreadId),
          message: queuedFollowupPrompt,
          mode: "queue",
          clientRequestId: "delegated-child-replay-queued-1",
        });
        const queuedFollowup = yield* decodeThreadSendResult(
          queuedFollowupCall.structuredContent,
        ).pipe(Effect.orDie);
        expect(queuedFollowup).toMatchObject({
          status: "queued",
          delivery: "queued",
        });

        const pendingProjection = yield* orchestrator.getThreadProjection(
          localChild(delegated.childThreadId),
        );
        const followupTasks = (yield* orchestrator.getThreadProjection(
          parentThreadId,
        )).subagents.filter(
          (task) => task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
        );
        expect(followupTasks).toHaveLength(2);
        expect(followupTasks.every((task) => task.result === null)).toBe(true);
        expect(followupTasks.map((task) => task.id)).toEqual([
          runningFollowup.taskId,
          queuedFollowup.taskId,
        ]);
        expect(pendingProjection.runs.find((run) => run.id === delegated.childRunId)?.status).toBe(
          "completed",
        );
        expect(pendingProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
          "running",
        );
        expect(pendingProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
          "queued",
        );
        expect(
          (yield* orchestrator.getThreadProjection(parentThreadId)).runs.some(
            (run) => run.status === "running",
          ),
        ).toBe(true);

        const pendingStatusCall = yield* invoke("task_status", {
          taskId: delegated.taskId,
        });
        const pendingStatus = yield* decodeDelegateTaskResult(
          pendingStatusCall.structuredContent,
        ).pipe(Effect.orDie);
        expect(pendingStatus).toMatchObject({
          childRunId: delegated.childRunId,
          status: "completed",
          summary: delegatedResult,
          resultContextTransferId: delegated.resultContextTransferId,
          hasPendingChildRuns: true,
          latestTerminalRunId: delegated.childRunId,
          latestTerminalStatus: "completed",
          latestTerminalSummary: null,
          latestTerminalResultContextTransferId: null,
        });

        const finalSequence = yield* orchestrator.getThreadEventSequence(
          localChild(delegated.childThreadId),
        );
        const interruptCall = yield* invoke("t3_thread_interrupt", {
          threadId: localChild(delegated.childThreadId),
          runId: runningFollowup.runId,
          reason: "Allow the queued replay follow-up to run.",
          clientRequestId: "interrupt-delegated-child-replay-1",
        });
        const interrupt = yield* decodeThreadInterruptResult(interruptCall.structuredContent).pipe(
          Effect.orDie,
        );
        expect(interrupt).toMatchObject({
          runId: runningFollowup.runId,
          status: "interrupt_requested",
        });
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: localChild(delegated.childThreadId),
            afterSequence: finalSequence,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === queuedFollowup.runId &&
                stored.event.payload.status === "completed",
            ),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("Queued follow-up did not complete."),
                onSome: () => Effect.void,
              }),
            ),
          );

        const finalProjection = yield* orchestrator.getThreadProjection(
          localChild(delegated.childThreadId),
        );
        expect(finalProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
          "interrupted",
        );
        expect(finalProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
          "completed",
        );
        expect(
          finalProjection.turnItems.find(
            (item) => item.runId === runningFollowup.runId && item.type === "run_interrupt_result",
          ),
        ).toMatchObject({
          message: "Stopped by an agent: Allow the queued replay follow-up to run.",
        });
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: parentThreadId,
            afterSequence: finalSequence,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.id === followupTasks[1]!.id &&
                stored.event.payload.status === "completed",
            ),
            Stream.runHead,
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("Follow-up task did not settle."),
                onSome: () => Effect.void,
              }),
            ),
          );
        const finishedParent = yield* orchestrator.getThreadProjection(parentThreadId);
        expect(
          finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id)?.status,
        ).toBe("interrupted");
        expect(
          finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id),
        ).toMatchObject({
          status: "completed",
          result,
        });
        expect(
          finishedParent.contextTransfers.filter(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === delegated.childThreadId,
          ),
        ).toHaveLength(3);
        expect(
          finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id)
            ?.completionDelivery?.state,
        ).toBe("claimed");
        const finalStatusCall = yield* invoke("task_status", {
          taskId: delegated.taskId,
        });
        const finalStatus = yield* decodeDelegateTaskResult(finalStatusCall.structuredContent).pipe(
          Effect.orDie,
        );
        expect(finalStatus).toMatchObject({
          childRunId: delegated.childRunId,
          status: "completed",
          summary: delegatedResult,
          resultContextTransferId: delegated.resultContextTransferId,
          hasPendingChildRuns: false,
          latestTerminalRunId: queuedFollowup.runId,
          latestTerminalStatus: "completed",
          latestTerminalSummary: latestSummary,
        });
        const followupTransfer = finishedParent.contextTransfers.find(
          (transfer) =>
            transfer.type === "subagent_result" &&
            transfer.sourcePoint.runId === queuedFollowup.runId,
        );
        expect(followupTransfer).toBeDefined();
        expect(finalStatus.latestTerminalResultContextTransferId).toBe(followupTransfer?.id);
        expect(finalStatus.latestTerminalResultContextTransferId).not.toBe(
          delegated.resultContextTransferId,
        );
        const transferReads: Array<string> = [];
        const messageReads: Array<string> = [];
        const runReads: Array<string> = [];
        const projectionTableReads: Array<string> = [];
        const acknowledgementReads: Array<string> = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (endTime, exit) => {
              end(endTime, exit);
              const query = span.attributes.get("db.query.text");
              if (typeof query !== "string") return;
              let parent = Option.getOrUndefined(span.parent);
              while (parent?._tag === "Span") {
                if (
                  parent.name === "Orchestrator.dispatchDelegatedTaskCompletionDeliveryResolution"
                ) {
                  acknowledgementReads.push(query);
                  break;
                }
                parent = Option.getOrUndefined(parent.parent);
              }
              for (const [, table] of query.matchAll(/FROM orchestration_v2_projection_(\w+)/gi)) {
                projectionTableReads.push(table!);
              }
              if (/SELECT[\s\S]*FROM orchestration_v2_projection_context_transfers/i.test(query)) {
                transferReads.push(query);
              }
              if (/SELECT\s+payload_json\s+FROM orchestration_v2_projection_runs/i.test(query)) {
                runReads.push(query);
              }
              if (
                /SELECT\s+payload_json\s+FROM orchestration_v2_projection_messages/i.test(query)
              ) {
                messageReads.push(query);
              }
            };
            return span;
          },
        });
        const wait = yield* invoke(
          "t3_thread_wait",
          { threadId: delegated.childThreadId, runId: queuedFollowup.runId },
          { ...invocation, thread: undefined },
        ).pipe(Effect.withTracer(tracer));
        expect(wait.isError).not.toBe(true);
        const expectedWait = {
          threadId: delegated.childThreadId,
          runId: queuedFollowup.runId,
          status: "completed",
          timedOut: false,
        };
        expect(wait.structuredContent).toEqual(expectedWait);
        expect(messageReads).toEqual([]);
        expect(transferReads).toHaveLength(0);
        const settledWait = yield* invoke(
          "t3_thread_wait",
          {
            threadId: delegated.childThreadId,
            runId: queuedFollowup.runId,
            untilDelegatedWorkSettled: true,
          },
          { ...invocation, thread: undefined },
        ).pipe(Effect.withTracer(tracer));
        expect(settledWait.isError).not.toBe(true);
        expect(settledWait.structuredContent).toMatchObject({
          ...expectedWait,
          resultRun: { runId: queuedFollowup.runId, status: "completed" },
        });
        expect(messageReads.length).toBeGreaterThan(0);
        expect(
          messageReads.filter((query) => query.includes("$.notification.source.kind")),
        ).toHaveLength(1);
        // The orchestrator's restart-continuation guard still reads its own records.
        expect(
          messageReads.filter((query) => !query.includes("$.notification.source.kind")),
        ).toHaveLength(1);
        const parentlessRead = yield* invoke(
          "t3_thread_read",
          {
            threadId: delegated.childThreadId,
            limit: 100,
            maxCharsPerItem: result === "😀" ? 1 : 50_000,
          },
          { ...invocation, thread: undefined },
        ).pipe(Effect.withTracer(tracer));
        expect(parentlessRead.isError).not.toBe(true);
        expect(transferReads).toHaveLength(0);
        const afterParentlessRead = yield* orchestrator.getThreadProjection(parentThreadId);
        expect(
          afterParentlessRead.subagents.find((task) => task.id === queuedFollowup.taskId)
            ?.completionDelivery?.state,
        ).toBe("claimed");

        const read = yield* invoke("t3_thread_read", {
          threadId: delegated.childThreadId,
          limit: 100,
          ...(result === "😀" ? { maxCharsPerItem: 1 } : {}),
        }).pipe(Effect.withTracer(tracer));
        expect(read.isError).not.toBe(true);
        expect(transferReads.length).toBeGreaterThan(0);
        const firstPage = yield* decodeThreadRead(read.structuredContent);
        const finalItem = firstPage.items.find((item) => item.text === result.slice(0, 500));
        expect(finalItem).toBeDefined();
        if (result.length > 500) {
          yield* invoke("t3_thread_read", {
            threadId: delegated.childThreadId,
            itemId: finalItem!.itemId,
            textOffset: result.length,
          });
        } else {
          expect(read.structuredContent).toEqual(parentlessRead.structuredContent);
        }
        let text = finalItem!.text ?? "";
        let nextTextOffset = finalItem?.nextTextOffset ?? null;
        while (nextTextOffset !== null) {
          const beforeContinuation = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            beforeContinuation.subagents.find((task) => task.id === queuedFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("claimed");
          const continuation = yield* invoke("t3_thread_read", {
            threadId: delegated.childThreadId,
            itemId: finalItem!.itemId,
            textOffset: nextTextOffset,
            maxCharsPerItem: 50_000,
          }).pipe(Effect.withTracer(tracer));
          const nextPage = yield* decodeThreadRead(continuation.structuredContent);
          text += nextPage.items[0]?.text ?? "";
          nextTextOffset = nextPage.items[0]?.nextTextOffset ?? null;
        }
        expect(text).toBe(result);
        // The acknowledgement reads the task and its spawning run by id, not the parent's history.
        expect(acknowledgementReads.length).toBeGreaterThan(0);
        expect(
          acknowledgementReads.filter(
            (query) =>
              /FROM orchestration_v2_projection_(nodes|run_attempts)\b/.test(query) ||
              (/FROM orchestration_v2_projection_runs\b/.test(query) &&
                !query.includes("AND run_id IN")) ||
              (/FROM orchestration_v2_projection_subagents\b/.test(query) &&
                !query.includes("AND subagent_id IN")),
          ),
        ).toEqual([]);
        const afterRead = yield* orchestrator.getThreadProjection(parentThreadId);
        expect(
          afterRead.subagents.find((task) => task.id === queuedFollowup.taskId)?.completionDelivery
            ?.state,
        ).toBe("acknowledged");

        const messageReadsBeforeCapabilities = messageReads.length;
        const tableReadsBeforeCapabilities = projectionTableReads.length;
        const capabilities = yield* invoke("orchestrator_capabilities", {}).pipe(
          Effect.withTracer(tracer),
        );
        expect(capabilities.isError).not.toBe(true);
        expect(messageReads).toHaveLength(messageReadsBeforeCapabilities);
        // The caller check reads only the thread row, never its history.
        expect(new Set(projectionTableReads.slice(tableReadsBeforeCapabilities))).toEqual(
          new Set(["threads"]),
        );
        const runReadsBeforeStatus = runReads.length;
        const transferReadsBeforeStatus = transferReads.length;
        const threadRecordReadsBeforeStatus = threadRecordReads.length;
        const statusAgain = yield* invoke("task_status", { taskId: delegated.taskId }).pipe(
          Effect.withTracer(tracer),
        );
        expect(statusAgain.isError).not.toBe(true);
        // A task wait reads result transfers and runs from the child; the parent's stay unread.
        expect(runReads).toHaveLength(runReadsBeforeStatus + 1);
        expect(transferReads).toHaveLength(transferReadsBeforeStatus + 1);
        expect(
          threadRecordReads
            .slice(threadRecordReadsBeforeStatus)
            .filter(({ fields }) => fields.includes("runs") || fields.includes("contextTransfers"))
            .map(({ threadId }) => threadId),
        ).toEqual([delegated.childThreadId]);
      }).pipe(Effect.provide(layerTest));
    }),
  );
});

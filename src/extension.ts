import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

import { Lang, parseAsync } from "@ast-grep/napi";
import type { SgNode } from "@ast-grep/napi";
import * as vscode from "vscode";

type TestKind = "suite" | "test";

type DiscoveredTest = {
  id: string;
  label: string;
  kind: TestKind;
  namePattern: string;
  uri: vscode.Uri;
  canonicalFilePath: string;
  range: vscode.Range;
  startIndex: number;
  endIndex: number;
  item?: vscode.TestItem;
};

type TestData = {
  uri: vscode.Uri;
  namePattern?: string;
};

type RunPlan = {
  fileItem: vscode.TestItem;
  uri: vscode.Uri;
  items: vscode.TestItem[];
  includePatterns?: string[];
  skipPatterns: string[];
};

type NodeTestEvent = {
  type: string;
  data?: NodeTestEventData;
};

type NodeTestEventData = {
  file?: string;
  line?: number;
  column?: number;
  name?: string;
  message?: string;
  details?: NodeTestEventDetails;
};

type NodeTestEventDetails = {
  duration_ms?: number;
  error?: unknown;
};

type NodeTestEventCandidate = {
  type?: unknown;
  data?: unknown;
};

type NodeTestEventDataCandidate = {
  file?: unknown;
  line?: unknown;
  column?: unknown;
  name?: unknown;
  message?: unknown;
  details?: unknown;
};

type NodeTestEventDetailsCandidate = {
  duration_ms?: unknown;
  error?: unknown;
};

type LocatedNodeTestEventData = NodeTestEventData & {
  file: string;
  line: number;
  column: number;
};

type FailureDetails = {
  message: string;
  stack?: string | undefined;
};

type FailureProperties = {
  cause?: unknown;
  failureType?: unknown;
  inspect?: unknown;
  message?: unknown;
  stack?: unknown;
};

type FailureStringProperty = "failureType" | "inspect" | "message" | "stack";

type NamedFunction = {
  readonly name: string;
};

const UNTRUSTED_WORKSPACE_RUN_MESSAGE =
  "Running node:test requires trusting this workspace because it executes workspace code.";

function observeDiscovery(promise: Promise<void>): void {
  promise.catch((error: unknown) => {
    console.error("Unexpected node:test discovery failure.", error);
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = vscode.tests.createTestController("vscode-node-test-explorer", "node:test");
  const itemData = new Map<string, TestData>();
  const itemsById = new Map<string, vscode.TestItem>();
  const itemIdsByFile = new Map<string, Set<string>>();
  const locationKeysByFile = new Map<string, Set<string>>();
  const locationToItem = new Map<string, vscode.TestItem>();
  const discoveryTimers = new Map<string, NodeJS.Timeout>();
  const watchersByWorkspace = new Map<string, vscode.FileSystemWatcher>();

  async function discoverWorkspace(): Promise<void> {
    const uris = (
      await Promise.all(
        (vscode.workspace.workspaceFolders ?? []).map((workspaceFolder) =>
          vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceFolder, "**/*.{test,spec}.{js,mjs,ts,mts}"),
            "**/{node_modules,dist,out,coverage,.git}/**",
          ),
        ),
      )
    ).flat();

    for (let index = 0; index < uris.length; index += 4) {
      // oxlint-disable-next-line no-await-in-loop -- bounded parse concurrency protects the extension host.
      await Promise.all(uris.slice(index, index + 4).map((uri) => discoverUri(uri)));
    }
  }

  async function discoverUri(uri: vscode.Uri): Promise<void> {
    if (!languageForUri(uri)) {
      removeFile(uri);
      return;
    }

    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );

    if (openDocument) {
      await discoverText(uri, openDocument.getText());
      return;
    }

    try {
      await discoverText(
        uri,
        Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"),
      );
    } catch (error) {
      const fileItem = controller.items.get(uri.toString());
      if (fileItem) {
        fileItem.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async function discoverText(uri: vscode.Uri, source: string): Promise<void> {
    const language = languageForUri(uri);
    if (!language) {
      removeFile(uri);
      return;
    }

    let root: SgNode;
    try {
      root = (await parseAsync(language, source)).root();
    } catch (error) {
      let fileItem = controller.items.get(uri.toString());
      if (!fileItem) {
        fileItem = controller.createTestItem(uri.toString(), basename(uri.fsPath), uri);
        controller.items.add(fileItem);
        itemData.set(fileItem.id, { uri });
        itemsById.set(fileItem.id, fileItem);
      }
      fileItem.error = error instanceof Error ? error.message : String(error);
      return;
    }

    const canonicalFilePath = await realpath(uri.fsPath).catch(() => uri.fsPath);
    const directImports = new Map<string, TestKind>();
    const namespaceImports = new Set<string>();

    for (const statement of root.findAll({ rule: { kind: "import_statement" } })) {
      const sourceNode = statement.field("source");
      if (!sourceNode || staticString(sourceNode) !== "node:test") {
        continue;
      }

      const importClause = statement.children().find((child) => child.kind() === "import_clause");
      if (!importClause) {
        continue;
      }

      for (const child of importClause.children()) {
        if (child.kind() === "identifier") {
          directImports.set(child.text(), "test");
          continue;
        }

        if (child.kind() === "namespace_import") {
          const identifier = child.children().find((node) => node.kind() === "identifier");
          if (identifier) {
            namespaceImports.add(identifier.text());
          }
          continue;
        }

        if (child.kind() !== "named_imports") {
          continue;
        }

        for (const specifier of child.children()) {
          if (specifier.kind() !== "import_specifier") {
            continue;
          }

          const importedName = specifier.field("name")?.text();
          if (!importedName) {
            continue;
          }

          const kind = kindForNodeTestExport(importedName);
          if (kind) {
            directImports.set(specifier.field("alias")?.text() ?? importedName, kind);
          }
        }
      }
    }

    if (directImports.size === 0 && namespaceImports.size === 0) {
      removeFile(uri);
      return;
    }

    const discovered: DiscoveredTest[] = [];
    for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
      const callee = call.field("function");
      const args = call.field("arguments");
      if (!callee || !args) {
        continue;
      }

      const kind = kindForCallee(callee, directImports, namespaceImports);
      const label = firstStringArgument(args);
      if (!kind || !label) {
        continue;
      }

      const range = call.range();
      discovered.push({
        id: `${uri.toString()}#${range.start.line}:${range.start.column}`,
        label,
        kind,
        namePattern: `^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        uri,
        canonicalFilePath,
        range: new vscode.Range(
          range.start.line,
          range.start.column,
          range.end.line,
          range.end.column,
        ),
        startIndex: range.start.index,
        endIndex: range.end.index,
      });
    }

    if (discovered.length === 0) {
      removeFile(uri);
      return;
    }

    discovered.sort((left, right) => left.startIndex - right.startIndex);
    replaceFileTests(uri, discovered);
  }

  function replaceFileTests(uri: vscode.Uri, discovered: DiscoveredTest[]): void {
    const fileId = uri.toString();
    for (const id of itemIdsByFile.get(fileId) ?? []) {
      itemData.delete(id);
      itemsById.delete(id);
    }
    for (const key of locationKeysByFile.get(fileId) ?? []) {
      locationToItem.delete(key);
    }

    let fileItem = controller.items.get(fileId);
    if (!fileItem) {
      fileItem = controller.createTestItem(fileId, basename(uri.fsPath), uri);
      controller.items.add(fileItem);
    }

    fileItem.error = undefined;
    fileItem.children.replace([]);
    itemData.set(fileItem.id, { uri });
    itemsById.set(fileItem.id, fileItem);

    const itemIds = new Set<string>([fileItem.id]);
    const locationKeys = new Set<string>();
    const suiteStack: DiscoveredTest[] = [];

    for (const test of discovered) {
      while (true) {
        const currentSuite = suiteStack.at(-1);
        if (currentSuite === undefined || currentSuite.endIndex > test.startIndex) {
          break;
        }
        suiteStack.pop();
      }

      const item = controller.createTestItem(test.id, test.label, test.uri);
      item.range = test.range;
      if (test.kind === "suite") {
        item.description = "suite";
      }
      itemData.set(item.id, { uri: test.uri, namePattern: test.namePattern });
      itemsById.set(item.id, item);
      itemIds.add(item.id);

      const locationKey = `${test.canonicalFilePath}:${test.range.start.line}:${test.range.start.character}`;
      locationKeys.add(locationKey);
      locationToItem.set(locationKey, item);

      test.item = item;
      (suiteStack[suiteStack.length - 1]?.item ?? fileItem).children.add(item);

      if (test.kind === "suite") {
        suiteStack.push(test);
      }
    }

    itemIdsByFile.set(fileId, itemIds);
    locationKeysByFile.set(fileId, locationKeys);
  }

  function removeFile(uri: vscode.Uri): void {
    const fileId = uri.toString();
    controller.items.delete(fileId);
    for (const id of itemIdsByFile.get(fileId) ?? []) {
      itemData.delete(id);
      itemsById.delete(id);
    }
    for (const key of locationKeysByFile.get(fileId) ?? []) {
      locationToItem.delete(key);
    }
    const timer = discoveryTimers.get(fileId);
    if (timer) {
      clearTimeout(timer);
      discoveryTimers.delete(fileId);
    }
    itemIdsByFile.delete(fileId);
    locationKeysByFile.delete(fileId);
  }

  async function saveDirtyTestDocuments(
    included: readonly vscode.TestItem[] | undefined,
  ): Promise<void> {
    const includedUris = included
      ? new Set(included.flatMap((item) => (item.uri ? [item.uri.toString()] : [])))
      : undefined;
    const documents = vscode.workspace.textDocuments.filter(
      (document) =>
        document.isDirty &&
        languageForUri(document.uri) &&
        (!includedUris || includedUris.has(document.uri.toString())),
    );

    const saveResults = await Promise.all(documents.map((document) => document.save()));
    if (saveResults.includes(false)) {
      throw new Error("Could not save dirty test files before running tests.");
    }
  }

  controller.resolveHandler = async (item) => {
    if (item?.uri) {
      await discoverUri(item.uri);
      return;
    }

    await discoverWorkspace();
  };

  controller.refreshHandler = discoverWorkspace;

  controller.createRunProfile(
    "Run",
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      const run = controller.createTestRun(request);
      try {
        if (!vscode.workspace.isTrusted) {
          const excluded = new Set(request.exclude?.map((item) => item.id) ?? []);
          const message = new vscode.TestMessage(UNTRUSTED_WORKSPACE_RUN_MESSAGE);
          const selected: vscode.TestItem[] = [];
          if (request.include) {
            selected.push(...request.include);
          } else {
            controller.items.forEach((item) => selected.push(item));
          }

          run.appendOutput(`${UNTRUSTED_WORKSPACE_RUN_MESSAGE}\r\n`);
          for (const item of selected) {
            erroredTree(item, excluded, run, message);
          }
          return;
        }

        await saveDirtyTestDocuments(request.include);
        const requestedIds = request.include?.map((item) => item.id);
        await discoverWorkspace();
        const nodePath = await ensureSupportedNode(token);

        const excluded = new Set(request.exclude?.map((item) => item.id) ?? []);
        const selected: vscode.TestItem[] = [];
        if (requestedIds) {
          for (const id of requestedIds) {
            const item = itemsById.get(id);
            if (item) {
              selected.push(item);
            }
          }
        } else {
          controller.items.forEach((item) => selected.push(item));
        }

        const plans = new Map<string, RunPlan>();
        for (const item of selected) {
          addToRunPlans(item, excluded, plans, itemData, controller);
        }

        for (const plan of plans.values()) {
          if (token.isCancellationRequested) {
            break;
          }

          for (const item of plan.items) {
            enqueueTree(item, excluded, run);
          }
          // oxlint-disable-next-line no-await-in-loop -- one test process at a time keeps output ordering stable.
          await runNodeTestFile(context, plan, token, run, locationToItem, nodePath);
        }
      } catch (error) {
        run.appendOutput(`${error instanceof Error ? error.message : String(error)}\r\n`);
      } finally {
        run.end();
      }
    },
    true,
  );

  function scheduleDiscover(uri: vscode.Uri): void {
    const fileId = uri.toString();
    const timer = discoveryTimers.get(fileId);
    if (timer) {
      clearTimeout(timer);
    }
    discoveryTimers.set(
      fileId,
      setTimeout(() => {
        discoveryTimers.delete(fileId);
        observeDiscovery(discoverUri(uri));
      }, 200),
    );
  }

  function watchWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): void {
    if (watchersByWorkspace.has(workspaceFolder.uri.toString())) {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolder, "**/*.{test,spec}.{js,mjs,ts,mts}"),
    );
    watcher.onDidCreate(scheduleDiscover);
    watcher.onDidChange(scheduleDiscover);
    watcher.onDidDelete((uri) => {
      removeFile(uri);
    });
    watchersByWorkspace.set(workspaceFolder.uri.toString(), watcher);
    context.subscriptions.push(watcher);
  }

  function unwatchWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder): void {
    const watcher = watchersByWorkspace.get(workspaceFolder.uri.toString());
    if (watcher) {
      watcher.dispose();
      watchersByWorkspace.delete(workspaceFolder.uri.toString());
    }
  }

  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    watchWorkspaceFolder(workspaceFolder);
  }

  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand("vscode-node-test-explorer.refresh", async () => {
      await discoverWorkspace();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const workspaceFolder of event.added) {
        watchWorkspaceFolder(workspaceFolder);
      }
      for (const workspaceFolder of event.removed) {
        unwatchWorkspaceFolder(workspaceFolder);
      }
      observeDiscovery(discoverWorkspace());
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === "file" && languageForUri(event.document.uri)) {
        scheduleDiscover(event.document.uri);
      }
    }),
  );

  observeDiscovery(discoverWorkspace());
}

export function deactivate(): void {}

function languageForUri(uri: vscode.Uri): Lang | undefined {
  if (uri.scheme !== "file") {
    return undefined;
  }

  if (
    uri.path.includes("/node_modules/") ||
    uri.path.includes("/dist/") ||
    uri.path.includes("/out/") ||
    uri.path.includes("/coverage/") ||
    uri.path.includes("/.git/")
  ) {
    return undefined;
  }

  const extension = extname(uri.fsPath);
  if (extension === ".ts" || extension === ".mts") {
    return /\.(test|spec)\.m?ts$/.test(uri.path) ? Lang.TypeScript : undefined;
  }

  if (extension === ".js" || extension === ".mjs") {
    return /\.(test|spec)\.m?js$/.test(uri.path) ? Lang.JavaScript : undefined;
  }

  return undefined;
}

function staticString(node: SgNode): string | undefined {
  if (node.kind() === "string") {
    const text = node.text();
    return text.length >= 2 ? text.slice(1, -1) : undefined;
  }

  if (node.kind() !== "template_string") {
    return undefined;
  }

  let value = "";
  for (const child of node.children()) {
    if (child.kind() === "template_substitution") {
      return undefined;
    }
    if (child.kind() === "string_fragment") {
      value += child.text();
    }
  }
  return value;
}

function firstStringArgument(args: SgNode): string | undefined {
  for (const child of args.children()) {
    if (!child.isNamed()) {
      continue;
    }
    return staticString(child);
  }
  return undefined;
}

function kindForNodeTestExport(name: string): TestKind | undefined {
  if (name === "describe" || name === "suite") {
    return "suite";
  }
  if (name === "test" || name === "it") {
    return "test";
  }
  return undefined;
}

function kindForCallee(
  callee: SgNode,
  directImports: ReadonlyMap<string, TestKind>,
  namespaceImports: ReadonlySet<string>,
): TestKind | undefined {
  if (callee.kind() === "identifier") {
    return directImports.get(callee.text());
  }

  const parts = memberExpressionParts(callee);
  if (!parts) {
    return undefined;
  }

  if (parts.length === 2) {
    const [namespace, name] = parts;
    if (!namespace || !name) {
      return undefined;
    }
    if (namespaceImports.has(namespace)) {
      return kindForNodeTestExport(name);
    }
    if ((name === "skip" || name === "only" || name === "todo") && directImports.has(namespace)) {
      return directImports.get(namespace);
    }
  }

  if (parts.length === 3) {
    const [namespace, name, modifier] = parts;
    if (!namespace || !name || !modifier) {
      return undefined;
    }
    if (
      namespaceImports.has(namespace) &&
      (modifier === "skip" || modifier === "only" || modifier === "todo")
    ) {
      return kindForNodeTestExport(name);
    }
  }

  return undefined;
}

function memberExpressionParts(node: SgNode): string[] | undefined {
  if (node.kind() === "identifier" || node.kind() === "property_identifier") {
    return [node.text()];
  }

  if (node.kind() !== "member_expression") {
    return undefined;
  }

  const object = node.field("object");
  const property = node.field("property");
  if (!object || !property) {
    return undefined;
  }

  const objectParts = memberExpressionParts(object);
  if (
    !objectParts ||
    (property.kind() !== "identifier" && property.kind() !== "property_identifier")
  ) {
    return undefined;
  }

  return [...objectParts, property.text()];
}

function addToRunPlans(
  item: vscode.TestItem,
  excluded: ReadonlySet<string>,
  plans: Map<string, RunPlan>,
  itemData: ReadonlyMap<string, TestData>,
  controller: vscode.TestController,
): void {
  if (excluded.has(item.id)) {
    return;
  }

  const data = itemData.get(item.id);
  if (!data) {
    throw new Error(`Test item ${item.id} is missing run metadata`);
  }

  if (data.namePattern) {
    const fileId = data.uri.toString();
    const plan = plans.get(fileId) ?? {
      fileItem: controller.items.get(fileId) ?? item,
      uri: data.uri,
      items: [],
      includePatterns: [],
      skipPatterns: [],
    };
    plan.items.push(item);
    plan.includePatterns?.push(data.namePattern);
    plans.set(fileId, plan);
    return;
  }

  const plan: RunPlan = {
    fileItem: item,
    uri: data.uri,
    items: [item],
    skipPatterns: [],
  };
  item.children.forEach((child) =>
    collectSkipPatterns(child, excluded, plan.skipPatterns, itemData),
  );
  plans.set(data.uri.toString(), plan);
}

function collectSkipPatterns(
  item: vscode.TestItem,
  excluded: ReadonlySet<string>,
  patterns: string[],
  itemData: ReadonlyMap<string, TestData>,
): void {
  if (excluded.has(item.id)) {
    const data = itemData.get(item.id);
    if (data?.namePattern) {
      patterns.push(data.namePattern);
    }
    return;
  }

  item.children.forEach((child) => collectSkipPatterns(child, excluded, patterns, itemData));
}

function enqueueTree(
  item: vscode.TestItem,
  excluded: ReadonlySet<string>,
  run: vscode.TestRun,
): void {
  if (excluded.has(item.id)) {
    return;
  }

  run.enqueued(item);
  item.children.forEach((child) => enqueueTree(child, excluded, run));
}

function erroredTree(
  item: vscode.TestItem,
  excluded: ReadonlySet<string>,
  run: vscode.TestRun,
  message: vscode.TestMessage,
): void {
  if (excluded.has(item.id)) {
    return;
  }

  run.errored(item, message);
  item.children.forEach((child) => erroredTree(child, excluded, run, message));
}

async function ensureSupportedNode(token: vscode.CancellationToken): Promise<string> {
  const nodePath = nodeExecutable();
  const version = await new Promise<string>((resolve, reject) => {
    const child = spawn(nodePath, ["--version"]);
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `node --version exited with ${code ?? "no code"}`));
      }
    });

    if (token.isCancellationRequested) {
      child.kill();
    }
  });

  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  const isSupported = major > 22 || (major === 22 && minor >= 19);

  if (!isSupported) {
    throw new Error(
      `Node 22.19 or newer is required for test execution; ${nodePath} resolved ${version}.`,
    );
  }

  return nodePath;
}

function nodeExecutable(): string {
  return (
    vscode.workspace.getConfiguration("vscode-node-test-explorer").get("nodePath", "node").trim() ||
    "node"
  );
}

async function runNodeTestFile(
  context: vscode.ExtensionContext,
  plan: RunPlan,
  token: vscode.CancellationToken,
  run: vscode.TestRun,
  locationToItem: ReadonlyMap<string, vscode.TestItem>,
  nodePath: string,
): Promise<void> {
  run.started(plan.fileItem);

  const args = [
    "--test",
    "--test-reporter",
    pathToFileURL(context.asAbsolutePath("dist/reporter.js")).href,
  ];
  if (plan.includePatterns && plan.includePatterns.length > 0) {
    args.push("--test-name-pattern", `(?:${plan.includePatterns.join("|")})`);
  }
  if (plan.skipPatterns.length > 0) {
    args.push("--test-skip-pattern", `(?:${plan.skipPatterns.join("|")})`);
  }
  args.push(plan.uri.fsPath);

  const child = spawn(nodePath, args, {
    cwd: vscode.workspace.getWorkspaceFolder(plan.uri)?.uri.fsPath,
  });
  const cancellation = token.onCancellationRequested(() => {
    child.kill();
  });
  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += String(chunk);
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      handleNodeTestReporterLine(line, run, locationToItem);
    }
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  cancellation.dispose();
  if (stdout.length > 0) {
    handleNodeTestReporterLine(stdout, run, locationToItem);
  }
  if (stderr.length > 0) {
    run.appendOutput(stderr.replace(/\n/g, "\r\n"));
  }

  if (token.isCancellationRequested) {
    run.skipped(plan.fileItem);
  } else if (exitCode === 0) {
    run.passed(plan.fileItem);
  } else {
    run.failed(
      plan.fileItem,
      new vscode.TestMessage(`node --test exited with ${exitCode ?? "no code"}`),
    );
  }
}

function handleNodeTestReporterLine(
  line: string,
  run: vscode.TestRun,
  locationToItem: ReadonlyMap<string, vscode.TestItem>,
): void {
  if (line.trim().length === 0) {
    return;
  }

  let event: NodeTestEvent;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isNodeTestEvent(parsed)) {
      run.appendOutput(`${line}\r\n`);
      return;
    }
    event = parsed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    run.appendOutput(`${line}\r\n`);
    return;
  }

  if (event.type === "test:stdout" || event.type === "test:stderr") {
    const message = event.data?.message;
    if (message) {
      run.appendOutput(message.replace(/\n/g, "\r\n"));
    }
    return;
  }

  const item = itemForNodeTestEvent(event, locationToItem);
  if (!item) {
    if (event.type === "test:fail") {
      run.appendOutput(`${failureMessage(event)}\r\n`);
    }
    return;
  }

  const duration = event.data?.details?.duration_ms;
  if (event.type === "test:start") {
    run.started(item);
  } else if (event.type === "test:pass") {
    run.passed(item, duration);
  } else if (event.type === "test:fail") {
    run.failed(item, testMessageForFailure(event), duration);
  } else if (event.type === "test:skip" || event.type === "test:todo") {
    run.skipped(item);
  }
}

function isNodeTestEvent(value: unknown): value is NodeTestEvent {
  if (!isNodeTestEventCandidate(value) || !isString(value.type)) {
    return false;
  }
  return value.data === undefined || isNodeTestEventData(value.data);
}

function isNodeTestEventCandidate(value: unknown): value is NodeTestEventCandidate {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeTestEventData(value: unknown): value is NodeTestEventData {
  if (!isNodeTestEventDataCandidate(value)) {
    return false;
  }
  return (
    (value.file === undefined || isString(value.file)) &&
    (value.line === undefined || isNumber(value.line)) &&
    (value.column === undefined || isNumber(value.column)) &&
    (value.name === undefined || isString(value.name)) &&
    (value.message === undefined || isString(value.message)) &&
    (value.details === undefined || isNodeTestEventDetails(value.details))
  );
}

function isNodeTestEventDataCandidate(value: unknown): value is NodeTestEventDataCandidate {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeTestEventDetails(value: unknown): value is NodeTestEventDetails {
  if (!isNodeTestEventDetailsCandidate(value)) {
    return false;
  }
  return value.duration_ms === undefined || isNumber(value.duration_ms);
}

function isNodeTestEventDetailsCandidate(value: unknown): value is NodeTestEventDetailsCandidate {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasNodeTestLocation(
  value: NodeTestEventData | undefined,
): value is LocatedNodeTestEventData {
  return (
    value !== undefined &&
    Boolean(value.file) &&
    value.line !== undefined &&
    value.column !== undefined
  );
}

function itemForNodeTestEvent(
  event: NodeTestEvent,
  locationToItem: ReadonlyMap<string, vscode.TestItem>,
): vscode.TestItem | undefined {
  const data = event.data;
  if (!hasNodeTestLocation(data)) {
    return undefined;
  }

  let filePath = vscode.Uri.file(data.file).fsPath;
  try {
    filePath = realpathSync.native(data.file);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    filePath = vscode.Uri.file(data.file).fsPath;
  }

  return locationToItem.get(`${filePath}:${data.line - 1}:${data.column - 1}`);
}

function testMessageForFailure(event: NodeTestEvent): vscode.TestMessage {
  const failure = failureDetails(event);
  const message = new vscode.TestMessage(failure.message);
  if (failure.stack) {
    const stackTrace = stackFrames(failure.stack);
    if (stackTrace.length > 0) {
      message.stackTrace = stackTrace;
      const firstFrame = stackTrace[0];
      if (firstFrame?.uri && firstFrame.position) {
        message.location = new vscode.Location(firstFrame.uri, firstFrame.position);
      }
    }
  }

  if (!message.location) {
    const eventLocation = locationForNodeTestEvent(event);
    if (eventLocation) {
      message.location = eventLocation;
    }
  }

  return message;
}

function failureMessage(event: NodeTestEvent): string {
  return failureDetails(event).message;
}

function failureDetails(event: NodeTestEvent): FailureDetails {
  const details = failureDetailsForValue(event.data?.details?.error);
  if (details?.message) {
    return details;
  }
  return { message: `${event.data?.name ?? "Test"} failed` };
}

function failureDetailsForValue(value: unknown): FailureDetails | undefined {
  if (value instanceof Error) {
    return {
      message: value.message || value.name,
      stack: value.stack,
    };
  }

  if (isString(value)) {
    return { message: value };
  }

  if (isFailurePrimitive(value)) {
    return { message: `${value}` };
  }

  if (isSymbol(value)) {
    return { message: value.description ? `Symbol(${value.description})` : "Symbol()" };
  }

  if (isNamedFunction(value)) {
    return { message: `[Function ${value.name || "anonymous"}]` };
  }

  if (!isFailureProperties(value)) {
    return undefined;
  }

  const failureType = stringProperty(value, "failureType");
  const cause = "cause" in value ? value.cause : undefined;
  if (cause !== undefined) {
    const causeDetails = failureDetailsForValue(cause);
    if (
      causeDetails?.message &&
      (causeDetails.message !== "test failed" || failureType !== "subtestsFailed")
    ) {
      return causeDetails;
    }
  }

  const message = stringProperty(value, "message");
  const inspected = stringProperty(value, "inspect");
  const stack = stringProperty(value, "stack");
  const fallback = inspected ?? jsonSummary(value);
  const messageText = message ?? fallback;
  if (messageText) {
    return { message: messageText, stack };
  }

  return undefined;
}

function isFailurePrimitive(value: unknown): value is bigint | boolean | number {
  return typeof value === "number" || typeof value === "boolean" || typeof value === "bigint";
}

function isSymbol(value: unknown): value is symbol {
  return typeof value === "symbol";
}

function isNamedFunction(value: unknown): value is NamedFunction {
  return typeof value === "function";
}

function isFailureProperties(value: unknown): value is FailureProperties {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function stringProperty(value: FailureProperties, key: FailureStringProperty): string | undefined {
  if (!(key in value)) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    return undefined;
  }

  const property: unknown = descriptor.value;
  return isString(property) && property.length > 0 ? property : undefined;
}

function jsonSummary(value: FailureProperties): string | undefined {
  try {
    const summary = JSON.stringify(value);
    return summary && summary !== "{}" ? summary : undefined;
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return undefined;
  }
}

function locationForNodeTestEvent(event: NodeTestEvent): vscode.Location | undefined {
  const data = event.data;
  if (!hasNodeTestLocation(data)) {
    return undefined;
  }

  return new vscode.Location(
    vscode.Uri.file(data.file),
    new vscode.Position(Math.max(data.line - 1, 0), Math.max(data.column - 1, 0)),
  );
}

function stackFrames(stack: string): vscode.TestMessageStackFrame[] {
  const frames: vscode.TestMessageStackFrame[] = [];
  for (const line of stack.split("\n")) {
    const frame = stackFrame(line);
    if (frame) {
      frames.push(frame);
    }
  }
  return frames;
}

function stackFrame(line: string): vscode.TestMessageStackFrame | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) {
    return undefined;
  }

  const frame = trimmed.slice(3);
  let label = "";
  let locationText = frame;
  const parenthesizedLocationStart = frame.lastIndexOf(" (");
  if (parenthesizedLocationStart !== -1 && frame.endsWith(")")) {
    label = frame.slice(0, parenthesizedLocationStart);
    locationText = frame.slice(parenthesizedLocationStart + 2, -1);
  }

  const match = /^(.*):(\d+):(\d+)$/.exec(locationText);
  if (!match) {
    return undefined;
  }

  const [, source, lineText, columnText] = match;
  const lineNumber = Number(lineText);
  const columnNumber = Number(columnText);
  if (!source || !Number.isInteger(lineNumber) || !Number.isInteger(columnNumber)) {
    return undefined;
  }

  const uri = uriForStackSource(source);
  if (!uri) {
    return undefined;
  }

  return new vscode.TestMessageStackFrame(
    label || basename(uri.fsPath),
    uri,
    new vscode.Position(Math.max(lineNumber - 1, 0), Math.max(columnNumber - 1, 0)),
  );
}

function uriForStackSource(source: string): vscode.Uri | undefined {
  if (source.startsWith("file://")) {
    return vscode.Uri.parse(source);
  }
  if (source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("\\\\")) {
    return vscode.Uri.file(source);
  }
  return undefined;
}

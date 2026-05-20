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
  data?: {
    file?: string;
    line?: number;
    column?: number;
    name?: string;
    message?: string;
    details?: {
      duration_ms?: number;
      error?: unknown;
    };
  };
};

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
      while (
        suiteStack.length > 0 &&
        suiteStack[suiteStack.length - 1]!.endIndex <= test.startIndex
      ) {
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
        await saveDirtyTestDocuments(request.include);
        const requestedIds = request.include?.map((item) => item.id);
        await discoverWorkspace();
        const nodePath = await ensureNode24(token);

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
        void discoverUri(uri);
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
      void discoverWorkspace();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === "file" && languageForUri(event.document.uri)) {
        scheduleDiscover(event.document.uri);
      }
    }),
  );
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

async function ensureNode24(token: vscode.CancellationToken): Promise<string> {
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

  if (!version.startsWith("v24.")) {
    throw new Error(`Node 24 is required for test execution; ${nodePath} resolved ${version}.`);
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
  } catch {
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
    run.failed(item, new vscode.TestMessage(failureMessage(event)), duration);
  } else if (event.type === "test:skip" || event.type === "test:todo") {
    run.skipped(item);
  }
}

function isNodeTestEvent(value: unknown): value is NodeTestEvent {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function itemForNodeTestEvent(
  event: NodeTestEvent,
  locationToItem: ReadonlyMap<string, vscode.TestItem>,
): vscode.TestItem | undefined {
  const data = event.data;
  if (!data?.file || typeof data.line !== "number" || typeof data.column !== "number") {
    return undefined;
  }

  let filePath = vscode.Uri.file(data.file).fsPath;
  try {
    filePath = realpathSync.native(data.file);
  } catch {
    filePath = vscode.Uri.file(data.file).fsPath;
  }

  return locationToItem.get(`${filePath}:${data.line - 1}:${data.column - 1}`);
}

function failureMessage(event: NodeTestEvent): string {
  const error = event.data?.details?.error;
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const cause = "cause" in error ? error.cause : undefined;
    if (cause && typeof cause === "object" && "message" in cause) {
      const message = String(cause.message);
      const stack = "stack" in cause ? String(cause.stack) : undefined;
      return stack && stack !== message ? `${message}\n${stack}` : message;
    }
    if ("message" in error) {
      const message = String(error.message);
      const stack = "stack" in error ? String(error.stack) : undefined;
      return stack && stack !== message ? `${message}\n${stack}` : message;
    }
    if (typeof cause === "string") {
      return cause;
    }
  }
  return `${event.data?.name ?? "Test"} failed`;
}

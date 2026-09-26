/**
 * Offline test suite for pi-quiet-mode.
 *
 * Loads the real extension with jiti (the same loader Pi uses), mocks the
 * extension API and the TUI context, and verifies:
 *   - level switching, cycling and persistence (including v1 migration)
 *   - quiet tool renderers (collapsed = 0 rows, expanded = content, errors = 1 line)
 *   - bash keeps settings.shellPath and actually executes
 *   - the transcript patch removes spacer/invisible rows
 *   - full mode hides intermediate narration, partial mode keeps it
 *   - the level-2 narration guideline is only injected in partial mode
 *
 * Run: node test/test-quiet-mode.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");

const EXT = path.resolve(__dirname, "..", "extensions", "quiet-mode.ts");
const TMP = path.join(require("node:os").tmpdir(), "pi-quiet-mode-test");
const SHELL_PATH = "bash";

function resolvePiPackage() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  try {
    candidates.push(path.resolve(path.dirname(require.resolve("@earendil-works/pi-coding-agent")), ".."));
  } catch {
    // not resolvable from here
  }
  try {
    candidates.push(path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent"));
  } catch {
    // npm unavailable
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error("Cannot locate @earendil-works/pi-coding-agent; set PI_PACKAGE_DIR");
}

const PKG = resolvePiPackage();
const LEVEL_FILE = path.join(TMP, "quiet-mode.json");
const BUILTIN_NAMES = ["read", "bash", "edit", "write", "find", "grep", "ls"];

// Isolate state and mirror a user setting that must survive tool re-registration.
process.env.PI_CODING_AGENT_DIR = TMP;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.writeFileSync(path.join(TMP, "settings.json"), JSON.stringify({ shellPath: SHELL_PATH }, null, 2));
fs.writeFileSync(LEVEL_FILE, JSON.stringify({ level: "off" }, null, 2));

const { createJiti } = require(path.join(PKG, "node_modules/jiti/lib/jiti.cjs"));
const { AssistantMessageComponent, initTheme } = require(path.join(PKG, "dist/index.js"));
const { visibleWidth } = require(path.join(PKG, "node_modules/@earendil-works/pi-tui/dist/index.js"));
initTheme();

const jiti = createJiti(__filename, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": path.join(PKG, "dist/index.js"),
    "@earendil-works/pi-tui": path.join(PKG, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  },
});

const theme = { fg: (_c, t) => t, bold: (t) => t, bg: (_c, t) => t };

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeSink() {
  return { tools: new Map(), commands: new Map(), listeners: new Map(), registerCount: 0 };
}

function makePi(sink) {
  return {
    registerTool: (tool) => {
      sink.registerCount += 1;
      sink.tools.set(tool.name, tool);
    },
    registerCommand: (name, options) => sink.commands.set(name, options),
    on: (event, handler) => {
      if (!sink.listeners.has(event)) sink.listeners.set(event, []);
      sink.listeners.get(event).push(handler);
      return () => {};
    },
    getAllTools: () =>
      BUILTIN_NAMES.map((name) => ({
        name,
        description: `${name} tool`,
        parameters: {},
        promptGuidelines: [],
        sourceInfo: { source: "builtin", path: `<builtin:${name}>`, scope: "user", origin: "top-level" },
      })),
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
  };
}

function makeUiState() {
  return { workingMessage: "<unset>", hiddenThinkingLabel: "<unset>", status: {}, expanded: undefined, toolsExpandedField: false };
}

function makeCtx(uiState, capture) {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/",
    isProjectTrusted: () => false,
    reload: async () => {
      if (capture) capture.reloadCount = (capture.reloadCount ?? 0) + 1;
    },
    sessionManager: {
      getBranch: () => capture?.branch ?? [],
    },
    ui: {
      theme,
      notify: () => {},
      setWorkingMessage: (message) => (uiState.workingMessage = message),
      setHiddenThinkingLabel: (label) => (uiState.hiddenThinkingLabel = label),
      setStatus: (key, value) => (uiState.status[key] = value),
      setToolsExpanded: (value) => {
        uiState.expanded = value;
        uiState.toolsExpandedField = value;
      },
      getToolsExpanded: () => uiState.toolsExpandedField === true,
      onTerminalInput: (handler) => {
        if (capture) capture.inputHandler = handler;
        return () => {};
      },
    },
  };
}

async function emitSessionStart(sink, ctx) {
  for (const handler of sink.listeners.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }
}

async function emitBeforeAgentStart(sink, ctx) {
  const options = { promptGuidelines: [] };
  const event = { type: "before_agent_start", prompt: "hi", systemPromptOptions: options };
  for (const handler of sink.listeners.get("before_agent_start") ?? []) {
    await handler(event, ctx);
  }
  return options.promptGuidelines;
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

const isBlank = (line) =>
  line
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .trim() === "";

function renderMessage(message, label) {
  const component = new AssistantMessageComponent(message, true, undefined, label, 1, []);
  return component.render(100);
}

const textMessage = {
  role: "assistant",
  timestamp: 0,
  stopReason: "stop",
  content: [
    { type: "thinking", thinking: "internal reasoning" },
    { type: "text", text: "This is the answer" },
  ],
};

const intermediateMessage = {
  role: "assistant",
  timestamp: 0,
  stopReason: "toolUse",
  content: [
    { type: "thinking", thinking: "internal reasoning" },
    { type: "text", text: "Now I will inspect the config file." },
    { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
  ],
};

const bashCtx = {
  cwd: "/tmp/",
  model: undefined,
  thinkingLevel: undefined,
  sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
  let failed = false;
  const check = (name, cond, extra = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
    if (!cond) failed = true;
  };

  // 回归：模拟最早 2 级版留下的补丁（用旧变量 pi.quiet-mode.enabled 控制，
  // 会永久删除空行）。新版本必须在加载时把旧变量置 false 将其失效。
  {
    const LEGACY_KEY = Symbol.for("pi.quiet-mode.enabled");
    globalThis[LEGACY_KEY] = true;
    const proto = AssistantMessageComponent.prototype;
    const previousUpdate = proto.updateContent;
    proto.updateContent = function (...args) {
      previousUpdate.apply(this, args);
      if (globalThis[LEGACY_KEY] !== true) return;
      if (Array.isArray(this.contentContainer?.children)) {
        this.contentContainer.children = this.contentContainer.children.filter((child) => {
          if ((child?.constructor?.name ?? "") === "Spacer") return false;
          const text = child?.child?.text;
          if (typeof text === "string" && visibleWidth(text) === 0) return false;
          return true;
        });
      }
    };
  }

  // 回归：模拟旧版 v2 补丁（只处理 hasToolCalls，不管流式）已经挂在原型上。
  // 新版本必须在其之上重新安装委托壳，并保证最终过滤器是最新的。
  {
    const PATCH_FLAG = Symbol.for("pi.quiet-mode.patched");
    const proto = AssistantMessageComponent.prototype;
    const previousUpdate = proto.updateContent;
    proto.updateContent = function (...args) {
      previousUpdate.apply(this, args);
      const level = globalThis[Symbol.for("pi.quiet-mode.level")];
      if (level === "full" && this.hasToolCalls === true && Array.isArray(this.contentContainer?.children)) {
        this.contentContainer.children = this.contentContainer.children.filter(
          (child) => (child?.constructor?.name ?? "") !== "Markdown",
        );
      }
    };
    proto[PATCH_FLAG] = 2;
  }

  // Fresh extension runtime (level off)
  let sink = makeSink();
  let pi = makePi(sink);
  let uiState = makeUiState();
  const capture = { branch: [], inputHandler: undefined };
  let ctx = makeCtx(uiState, capture);

  const loadFactory = async () => {
    const mod = await jiti.import(EXT, { default: true });
    return mod.default ?? mod;
  };

  let factory = await loadFactory();
  check("module exports a factory", typeof factory === "function");
  await factory(pi);
  await emitSessionStart(sink, ctx);
  check("registers /quiet command", sink.commands.has("quiet"));
  check("level off leaves built-ins untouched", sink.tools.size === 0, `tools=${sink.tools.size}`);
  check("level off: Ctrl+O passes through to Pi", capture.inputHandler("\x0f") === undefined);

  // ---- level 1: full ----
  await sink.commands.get("quiet").handler("1", ctx);
  check("off -> quiet rebuilds the transcript", (capture.reloadCount ?? 0) === 1, `reloads=${capture.reloadCount ?? 0}`);
  check("level 1 overrides 7 built-ins", sink.tools.size === 7, `tools=${[...sink.tools.keys()].join(",")}`);
  check("level 1 persists to disk", fs.readFileSync(LEVEL_FILE, "utf-8").includes('"full"'));
  check("working message is Thinking...", uiState.workingMessage === "Thinking...", String(uiState.workingMessage));
  check("hidden thinking label cleared", uiState.hiddenThinkingLabel === "", String(uiState.hiddenThinkingLabel));
  check("status badge shows quiet:1", uiState.status["quiet-mode"] === "quiet:1", String(uiState.status["quiet-mode"]));
  check("tools collapsed on switch", uiState.expanded === false);

  const readDef = sink.tools.get("read");
  check("quiet definition uses self shell", readDef.renderShell === "self");
  check("quiet definition keeps parameters", !!readDef.parameters && typeof readDef.parameters === "object");
  check(
    "collapsed tool call renders 0 rows",
    readDef.renderCall({ path: "/tmp/a.txt" }, theme, { expanded: false, isError: false }).render(100).length === 0,
  );
  check(
    "collapsed tool result renders 0 rows",
    readDef
      .renderResult(
        { content: [{ type: "text", text: "output" }], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        { expanded: false, isError: false },
      )
      .render(100).length === 0,
  );
  const makeRenderCtx = (expanded, args = {}, extra = {}) => ({
    args,
    expanded,
    isError: false,
    isPartial: false,
    state: {},
    showImages: false,
    cwd: "/tmp/",
    argsComplete: true,
    executionStarted: true,
    invalidate: () => {},
    toolCallId: "t",
    lastComponent: undefined,
    ...extra,
  });

  // ---- Ctrl+O 三档循环（安静模式下接管）----
  capture.branch = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "recent-1" }] } },
  ];
  const shownFor = (toolCallId) =>
    readDef
      .renderResult(
        { content: [{ type: "text", text: "x" }], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        makeRenderCtx(false, { path: "/tmp/a.txt" }, { toolCallId }),
      )
      .render(100).length > 0;

  check("level 1: Ctrl+O is intercepted", capture.inputHandler("\x0f")?.consume === true);
  check("cycle 1: recent tool shown", shownFor("recent-1"));
  check("cycle 1: older tool hidden", !shownFor("old-1"));
  check(
    "cycle 1 keeps badge with tools:recent",
    String(uiState.status["quiet-mode"]).includes("tools:recent"),
    String(uiState.status["quiet-mode"]),
  );
  check("cycle 2: Ctrl+O intercepted again", capture.inputHandler("\x0f")?.consume === true);
  check("cycle 2: all tools shown", shownFor("recent-1") && shownFor("old-1"));
  check(
    "cycle 2 keeps badge with tools:all",
    String(uiState.status["quiet-mode"]).includes("tools:all"),
    String(uiState.status["quiet-mode"]),
  );

  const expandedCtx = makeRenderCtx(true, { path: "/tmp/a.txt", limit: 5 });
  check(
    "expanded tool call renders 0 rows (box composed by result)",
    readDef.renderCall({ path: "/tmp/a.txt", limit: 5 }, theme, expandedCtx).render(100).length === 0,
  );
  const expandedRows = readDef
    .renderResult(
      { content: [{ type: "text", text: "line1\nline2" }], details: undefined },
      { expanded: true, isPartial: false },
      theme,
      expandedCtx,
    )
    .render(100);
  check("expanded result uses built-in rendering", expandedRows.length > 0, `rows=${expandedRows.length}`);

  // 回归：the tool slot is rendered collapsed first (our empty Container lands in
  // context.lastComponent). Expanding must not throw when builtin renderers reuse it.
  let expandedAfterCollapsed = null;
  try {
    const collapsedCall = readDef.renderCall({ path: "/tmp/a.txt" }, theme, makeRenderCtx(false, { path: "/tmp/a.txt" }));
    const reuseCtx = makeRenderCtx(true, { path: "/tmp/a.txt" });
    reuseCtx.lastComponent = collapsedCall;
    expandedAfterCollapsed = readDef
      .renderResult(
        { content: [{ type: "text", text: "line1\nline2" }], details: undefined },
        { expanded: true, isPartial: false },
        theme,
        reuseCtx,
      )
      .render(100);
  } catch (error) {
    expandedAfterCollapsed = { error: String(error), length: -1 };
  }
  check(
    "expanded render survives a prior collapsed render",
    !!expandedAfterCollapsed && !expandedAfterCollapsed.error && expandedAfterCollapsed.length > 0,
    `rows=${expandedAfterCollapsed?.length ?? "null"}${expandedAfterCollapsed?.error ? " " + expandedAfterCollapsed.error : ""}`,
  );

  // 第三次 Ctrl+O 回到完全隐藏
  check("cycle 0: Ctrl+O intercepted a third time", capture.inputHandler("\x0f")?.consume === true);
  check("cycle 0: all tools hidden again", !shownFor("recent-1") && !shownFor("old-1"));

  // ---- /quiet recent：配置“最近”档位展开最近几个用户轮次 ----
  await sink.commands.get("quiet").handler("recent 2", ctx);
  check(
    "recent turns persisted",
    JSON.parse(fs.readFileSync(LEVEL_FILE, "utf-8")).recentTurns === 2,
  );
  capture.branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "u1" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1a" }, { type: "toolCall", id: "t1b" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "u2" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t2a" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "u3" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t3a" }] } },
  ];
  check("cycle to recent for the user-turn test", capture.inputHandler("\x0f")?.consume === true);
  check("recent 2 shows tools from the last two turns", shownFor("t2a") && shownFor("t3a"));
  check("recent 2 hides the earlier turn", !shownFor("t1a") && !shownFor("t1b"));
  check(
    "badge shows recent x2",
    String(uiState.status["quiet-mode"]).includes("tools:recent×2"),
    String(uiState.status["quiet-mode"]),
  );
  // 回到全隐藏并恢复默认，避免影响后续用例
  capture.inputHandler("\x0f");
  capture.inputHandler("\x0f");
  await sink.commands.get("quiet").handler("recent 1", ctx);
  const errorRows = readDef
    .renderResult(
      { content: [{ type: "text", text: "ENOENT" }], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      { expanded: false, isError: true },
    )
    .render(100);
  check("collapsed tool error keeps 1 red row", errorRows.length === 1, String(errorRows[0]).trim());

  let lines = renderMessage(intermediateMessage, "");
  check("level 1 hides intermediate narration", lines.length === 0, `rows=${lines.length}`);
  lines = renderMessage(textMessage, "");
  check("level 1 keeps the final answer", lines.some((line) => line.includes("This is the answer")));
  check("level 1 keeps exactly one separator row", lines.filter(isBlank).length === 1, `blank=${lines.filter(isBlank).length}`);
  check("level 1 does not add narration guideline", (await emitBeforeAgentStart(sink, ctx)).length === 0);

  // 流式阶段不能闪现文字，否则会出现“刚输出完就消失”
  const streamingComponent = new AssistantMessageComponent(undefined, true, undefined, "", 1, []);
  streamingComponent.updateContent(textMessage, true);
  check("level 1 hides streaming text (no flash)", streamingComponent.render(100).length === 0);
  // invalidate() re-runs updateContent(message) without the streaming argument;
  // the text must stay hidden (this was the flash-then-disappear bug).
  streamingComponent.updateContent(textMessage);
  check("level 1 stays hidden on invalidate-style update", streamingComponent.render(100).length === 0);
  streamingComponent.updateContent(textMessage, false);
  check(
    "level 1 shows text once the message completes",
    streamingComponent.render(100).some((line) => line.includes("This is the answer")),
  );

  // 回归：reload 重建的历史消息即使因持久化设置而“可见”，安静模式下也必须隐藏
  // （除非本次会话按过 Ctrl+T）
  const restoredThinking = new AssistantMessageComponent(textMessage, false, undefined, "", 1, []);
  const restoredLines = restoredThinking.render(100);
  check(
    "level 1 hides restored thinking after reload",
    !restoredLines.some((line) => line.includes("internal reasoning")),
    `lines=${restoredLines.length}`,
  );

  // Ctrl+T（app.thinking.toggle）：展开/收起思考块
  const thinkingComponent = new AssistantMessageComponent(intermediateMessage, true, undefined, "", 1, []);
  check(
    "level 1: thinking hidden by default",
    !thinkingComponent.render(100).some((line) => line.includes("internal reasoning")),
  );
  thinkingComponent.setHideThinkingBlock(false);
  check(
    "level 1: Ctrl+T reveals thinking",
    thinkingComponent.render(100).some((line) => line.includes("internal reasoning")),
  );
  // 展开思考后，思考与正文之间要保留空行
  const revealedFinal = new AssistantMessageComponent(textMessage, true, undefined, "", 1, []);
  revealedFinal.setHideThinkingBlock(false);
  const revealedLines = revealedFinal.render(100);
  const thinkIdx = revealedLines.findIndex((line) => line.includes("internal reasoning"));
  const answerIdx = revealedLines.findIndex((line) => line.includes("This is the answer"));
  check(
    "level 1: revealed thinking keeps a blank line before the answer",
    thinkIdx >= 0 && answerIdx > thinkIdx && isBlank(revealedLines[answerIdx - 1]),
    `think=${thinkIdx} answer=${answerIdx}`,
  );
  thinkingComponent.setHideThinkingBlock(true);
  check(
    "level 1: Ctrl+T again hides thinking",
    !thinkingComponent.render(100).some((line) => line.includes("internal reasoning")),
  );

  const registeredAfterFull = sink.registerCount;

  // ---- level 2: partial ----
  await sink.commands.get("quiet").handler("2", ctx);
  check("quiet -> quiet does not rebuild", (capture.reloadCount ?? 0) === 1, `reloads=${capture.reloadCount ?? 0}`);
  check("level 2 reuses quiet tool definitions", sink.registerCount === registeredAfterFull);
  check("status badge shows quiet:2", uiState.status["quiet-mode"] === "quiet:2", String(uiState.status["quiet-mode"]));
  lines = renderMessage(intermediateMessage, "");
  check("level 2 keeps intermediate narration", lines.some((line) => line.includes("inspect the config")));
  check("level 2 keeps exactly one separator row", lines.filter(isBlank).length === 1, `blank=${lines.filter(isBlank).length}`);
  const partialStreaming = new AssistantMessageComponent(undefined, true, undefined, "", 1, []);
  partialStreaming.updateContent(textMessage, true);
  check("level 2 streams narration live", partialStreaming.render(100).length > 0);

  // Ctrl+T 在部分安静下同样可用
  const partialThinking = new AssistantMessageComponent(intermediateMessage, true, undefined, "", 1, []);
  check(
    "level 2: thinking hidden by default",
    !partialThinking.render(100).some((line) => line.includes("internal reasoning")),
  );
  partialThinking.setHideThinkingBlock(false);
  check(
    "level 2: Ctrl+T reveals thinking",
    partialThinking.render(100).some((line) => line.includes("internal reasoning")),
  );
  lines = renderMessage(textMessage, "");
  check("level 2 keeps the final answer", lines.some((line) => line.includes("This is the answer")));
  const guidelines = await emitBeforeAgentStart(sink, ctx);
  check("level 2 injects narration guideline", guidelines.length === 1, `guidelines=${guidelines.length}`);

  // ---- level 3: off ----
  await sink.commands.get("quiet").handler("3", ctx);
  check("quiet -> off rebuilds the transcript", (capture.reloadCount ?? 0) === 2, `reloads=${capture.reloadCount ?? 0}`);
  check("level 3 restores plain definitions", sink.tools.get("read").renderShell !== "self");
  // 回归：安静模式期间创建的旧组件切到关闭档后，Ctrl+O 仍能展开/收起
  const staleExpanded = readDef
    .renderResult(
      { content: [{ type: "text", text: "line1\nline2" }], details: undefined },
      { expanded: true, isPartial: false },
      theme,
      makeRenderCtx(true, { path: "/tmp/a.txt" }),
    )
    .render(100);
  check("level 3: stale quiet rows expand (Ctrl+O)", staleExpanded.length > 0, `rows=${staleExpanded.length}`);
  const staleCollapsed = readDef
    .renderResult(
      { content: [{ type: "text", text: "line1\nline2" }], details: undefined },
      { expanded: false, isPartial: false },
      theme,
      makeRenderCtx(false, { path: "/tmp/a.txt" }),
    )
    .render(100);
  check("level 3: stale quiet rows collapse", staleCollapsed.length === 0, `rows=${staleCollapsed.length}`);
  check("level 3 restores default label", uiState.hiddenThinkingLabel === undefined, String(uiState.hiddenThinkingLabel));
  check("level 3 clears status badge", uiState.status["quiet-mode"] === undefined);
  lines = renderMessage(intermediateMessage, "Thinking...");
  check("level 3 has native spacing again", lines.filter(isBlank).length > 0, `blank=${lines.filter(isBlank).length}`);
  check("level 3 does not inject guideline", (await emitBeforeAgentStart(sink, ctx)).length === 0);

  // ---- command cycle: off -> full -> partial -> off ----
  const badge = () => uiState.status["quiet-mode"];
  await sink.commands.get("quiet").handler("", ctx);
  check("cycle off -> 1", badge() === "quiet:1", String(badge()));
  await sink.commands.get("quiet").handler("", ctx);
  check("cycle 1 -> 2", badge() === "quiet:2", String(badge()));
  await sink.commands.get("quiet").handler("", ctx);
  check("cycle 2 -> off", badge() === undefined, String(badge()));

  // ---- bash regression: shellPath must survive both quiet levels ----
  await sink.commands.get("quiet").handler("1", ctx);
  try {
    const result = await sink.tools
      .get("bash")
      .execute("call-1", { command: "echo quiet-fix-ok" }, undefined, undefined, bashCtx);
    const output = result.content.map((part) => part.text ?? "").join("\n");
    check("level 1 bash keeps settings.shellPath", output.includes("quiet-fix-ok"), JSON.stringify(output));
  } catch (error) {
    check("level 1 bash keeps settings.shellPath", false, String(error));
  }

  // ---- reload with persisted level 2 ----
  fs.writeFileSync(LEVEL_FILE, JSON.stringify({ level: "partial" }, null, 2));
  const sink2 = makeSink();
  const pi2 = makePi(sink2);
  const uiState2 = makeUiState();
  const capture2 = { branch: [], inputHandler: undefined };
  const ctx2 = makeCtx(uiState2, capture2);
  factory = await loadFactory();
  await factory(pi2);
  await emitSessionStart(sink2, ctx2);
  check("reload restores level 2 tool overrides", sink2.tools.size === 7, `tools=${sink2.tools.size}`);
  check("reload restores level 2 badge", uiState2.status["quiet-mode"] === "quiet:2");
  check("reload restores narration guideline", (await emitBeforeAgentStart(sink2, ctx2)).length === 1);

  // ---- migration from v1 { quiet: true } ----
  fs.writeFileSync(LEVEL_FILE, JSON.stringify({ quiet: true }, null, 2));
  const sink3 = makeSink();
  const pi3 = makePi(sink3);
  const uiState3 = makeUiState();
  const capture3 = { branch: [], inputHandler: undefined };
  const ctx3 = makeCtx(uiState3, capture3);
  factory = await loadFactory();
  await factory(pi3);
  await emitSessionStart(sink3, ctx3);
  check("v1 state migrates to level 1", sink3.tools.size === 7 && uiState3.status["quiet-mode"] === "quiet:1");

  console.log(failed ? "\nResult: FAILURES" : "\nResult: all passed");
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error("Test crashed:", error);
  process.exit(2);
});

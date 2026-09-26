/**
 * Pi Quiet Mode — three levels of transcript noise control for Pi.
 *
 * Levels:
 *   1 (full)    Hide tools, intermediate narration and thinking labels.
 *               Only a live "Thinking..." indicator and the final answer remain.
 *   2 (partial) Hide tool details, but keep one short narration sentence per step,
 *               so the user can follow what the agent is doing and why.
 *   3 (off)     Native Pi behavior.
 *
 * Commands:
 *   /quiet          cycle  off -> 1 -> 2 -> off
 *   /quiet 1|2|3    select a level directly
 *   /quiet full|partial|off
 *
 * Extras:
 *   - Ctrl+O (app.tools.expand) still expands every tool call and output.
 *   - Tool failures always keep a single red line, even in full mode.
 *   - Level is persisted in <agent-dir>/quiet-mode.json.
 *
 * Implementation notes (important):
 *   - Re-registering a built-in tool replaces its definition, so this extension
 *     recreates it with the exact options agent-session._buildRuntime() uses:
 *       read: { autoResizeImages }
 *       bash: { commandPrefix, shellPath }
 *     Dropping shellPath breaks Git Bash detection (learned the hard way).
 *   - Only tools whose current source is "builtin" are overridden; tools already
 *     replaced by another extension are left alone.
 *   - renderShell: "self" + empty collapsed render => the TUI skips the component
 *     entirely, leaving no placeholder rows.
 *   - Switching back to off re-registers the plain definitions, so interactive-mode's
 *     withBuiltInRenderers() fallback restores the native tool rendering.
 *   - Pi's AssistantMessageComponent always inserts spacer rows and leaves an
 *     ANSI-only row for hidden thinking labels. Those cannot be removed through the
 *     public extension API, so a small, fail-safe patch filters them out while a
 *     quiet level is active. Full mode additionally filters the intermediate
 *     narration Markdown of messages that contain tool calls.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	getPackageDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type AnyToolDefinition = ToolDefinition<any, any, any>;
type QuietLevel = "off" | "full" | "partial";

const MAX_EXPANDED_LINES = 120;
const STATUS_KEY = "quiet-mode";

// The level lives on globalThis because /reload re-imports this module while the
// patched component class stays shared. A global symbol keeps the patch reading
// the current value instead of a stale closure variable.
const LEVEL_KEY = Symbol.for("pi.quiet-mode.level");
const PATCH_FLAG_KEY = Symbol.for("pi.quiet-mode.patched");
// Tracks whether the user explicitly revealed thinking with Ctrl+T in this
// session. Reset on every load so a reload renders history clean again.
const REVEAL_KEY = Symbol.for("pi.quiet-mode.thinking-revealed");
const THINKING_PATCH_KEY = Symbol.for("pi.quiet-mode.thinking-patched");
// The installed wrapper is a stable shell that delegates to whatever filter this
// global symbol points at. Every /reload republishes the filter, so the newest
// implementation always runs even though the wrapper itself is installed once.
const FILTER_KEY = Symbol.for("pi.quiet-mode.filter");
// Only used to upgrade shells from older builds that hard-coded their logic.
const PATCH_VERSION = 4;

const LEVEL_ORDER: QuietLevel[] = ["off", "full", "partial"];

const LEVEL_INFO: Record<QuietLevel, { badge: string; enabled: boolean; notify: string }> = {
	off: {
		badge: "",
		enabled: false,
		notify: "Quiet mode off: native Pi display restored",
	},
	full: {
		badge: "quiet:1",
		enabled: true,
		notify: "Quiet mode 1 (full): tools and process hidden, only the final answer is shown",
	},
	partial: {
		badge: "quiet:2",
		enabled: true,
		notify: "Quiet mode 2 (partial): one narration sentence per step, tool details hidden",
	},
};

/** Injected while level 2 is active so the model narrates each tool step. */
const PARTIAL_GUIDELINE =
	"Before each tool call, write exactly one short sentence in the user's language describing what you are about to do, what you found, or what you plan next. Keep it to a single sentence and do not add details.";

function getLevel(): QuietLevel {
	const value = (globalThis as Record<PropertyKey, unknown>)[LEVEL_KEY];
	return value === "full" || value === "partial" ? value : "off";
}

// 调试日志：PI_QUIET_DEBUG=1 或存在 <agent-dir>/quiet-mode-debug.on 文件时启用。
// 开关文件让开发者无需重启 Pi 就能开启/关闭日志。
function debugLog(message: string): void {
	if (process.env.PI_QUIET_DEBUG !== "1") {
		try {
			if (!existsSync(join(getAgentDir(), "quiet-mode-debug.on"))) return;
		} catch {
			return;
		}
	}
	try {
		appendFileSync(join(getAgentDir(), "quiet-mode-debug.log"), `${new Date().toISOString()} ${message}\n`);
	} catch {
		// ignore
	}
}

function setLevel(level: QuietLevel): void {
	(globalThis as Record<PropertyKey, unknown>)[LEVEL_KEY] = level;
}

/** Built-in tools that can be safely overridden (sampled before we register anything). */
let overridableNames: Set<string> | undefined;
/** What the current session registry currently holds from this extension. */
let toolsRegisteredAs: "quiet" | "plain" | undefined;
/** Names registered by this extension, so reload-time registration needs no sampling. */
let registeredNames: string[] = [];
/** True when registration happened at factory time (no cwd/trust available yet). */
let toolsNeedCtxRefresh = false;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function stateFile(): string {
	return join(getAgentDir(), "quiet-mode.json");
}

function loadState(): { level: QuietLevel; recentTurns: number } {
	let level: QuietLevel = "off";
	let recentTurns = 1;
	try {
		const data = JSON.parse(readFileSync(stateFile(), "utf-8")) as {
			level?: unknown;
			quiet?: unknown;
			recentRounds?: unknown;
			recentTurns?: unknown;
		};
		if (data.level === "off" || data.level === "full" || data.level === "partial") {
			level = data.level;
		} else if (data.quiet === true) {
			// Migrate the original boolean format.
			level = "full";
		} else if (data.quiet === false) {
			level = "off";
		}
		const storedTurns = data.recentTurns ?? data.recentRounds;
		if (typeof storedTurns === "number" && Number.isFinite(storedTurns)) {
			recentTurns = Math.min(20, Math.max(1, Math.round(storedTurns)));
		}
	} catch {
		// Missing or invalid file: defaults.
	}
	return { level, recentTurns };
}

function saveState(): void {
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(stateFile(), JSON.stringify({ level: getLevel(), recentTurns }, null, 2), "utf-8");
	} catch {
		// Persistence failure must not break the session.
	}
}

// ---------------------------------------------------------------------------
// Tool rendering helpers
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function shortenPath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const normalizedHome = homedir().replace(/\\/g, "/");
	return normalized.startsWith(normalizedHome) ? `~${normalized.slice(normalizedHome.length)}` : path;
}

function textOf(result: AgentToolResult<any>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** Rendered output in expanded mode, capped at MAX_EXPANDED_LINES. */
function renderOutput(result: AgentToolResult<any>, theme: Theme): string {
	const raw = textOf(result);
	const hasImage = result.content.some((part) => part.type === "image");

	if (!raw) {
		return hasImage ? theme.fg("dim", "(image)") : "";
	}

	const lines = raw.split("\n");
	const shown = lines.slice(0, MAX_EXPANDED_LINES);
	let text = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (lines.length > shown.length) {
		text += theme.fg("muted", `\n… ${lines.length - shown.length} more lines`);
	}
	return text;
}

/** One-line call description shown when the user expands tool output with Ctrl+O. */
const SUMMARIES: Record<string, (args: any, theme: Theme) => string> = {
	read: (args, theme) => {
		let text = theme.fg("toolTitle", theme.bold("read "));
		text += theme.fg("accent", shortenPath(String(args.path ?? "")));
		if (args.offset !== undefined || args.limit !== undefined) {
			const start = args.offset ?? 1;
			const end = args.limit !== undefined ? start + args.limit - 1 : undefined;
			text += theme.fg("warning", `:${start}${end !== undefined ? `-${end}` : ""}`);
		}
		return text;
	},
	bash: (args, theme) =>
		theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("accent", truncate(String(args.command ?? ""), 120)),
	edit: (args, theme) =>
		theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", shortenPath(String(args.path ?? ""))),
	write: (args, theme) =>
		theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", shortenPath(String(args.path ?? ""))),
	find: (args, theme) =>
		theme.fg("toolTitle", theme.bold("find ")) +
		theme.fg("accent", String(args.pattern ?? "")) +
		theme.fg("dim", ` in ${shortenPath(String(args.path ?? "."))}`),
	grep: (args, theme) =>
		theme.fg("toolTitle", theme.bold("grep ")) +
		theme.fg("accent", `/${String(args.pattern ?? "")}/`) +
		theme.fg("dim", ` in ${shortenPath(String(args.path ?? "."))}`),
	ls: (args, theme) =>
		theme.fg("toolTitle", theme.bold("ls ")) + theme.fg("accent", shortenPath(String(args.path ?? "."))),
};

/**
 * Built-in tool renderers, loaded from the installed package at runtime so that
 * Ctrl+O shows the exact native look (diffs, truncation hints, background box).
 * Loaded lazily and optional: if the import fails we fall back to plain text.
 */
type BuiltInRenderer = {
	renderCall?: (args: any, theme: Theme, context: any) => unknown;
	renderResult?: (result: any, options: any, theme: Theme, context: any) => unknown;
};

let builtInRenderers: Record<string, BuiltInRenderer> = {};
const loggedRenderPaths = new Set<string>();
/** Last logged expansion state per tool call, so every transition is traced. */
const tracedExpansions = new Map<string, string>();

// Ctrl+O cycle in quiet modes: 0 = tool rows hidden, 1 = only the most recent
// batch of tool calls expanded, 2 = all tool rows expanded.
type ToolCycle = 0 | 1 | 2;
let toolCycle: ToolCycle = 0;
let partialToolIds = new Set<string>();
/** How many recent user turns the "recent" cycle step expands. */
let recentTurns = 1;

function isToolShown(toolCallId: string, contextExpanded: boolean): boolean {
	// Level 3: components created by earlier quiet modes must behave like native
	// tool rows again, so defer to the component's own expansion state.
	if (getLevel() === "off") return contextExpanded;
	if (toolCycle === 2) return true;
	if (toolCycle === 1) return partialToolIds.has(toolCallId);
	return false;
}

/**
 * Tool call ids belonging to the most recent `recentTurns` user turns. A turn
 * starts at a user message and covers every assistant tool call after it.
 */
function computePartialToolIds(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	try {
		const branch = ctx.sessionManager.getBranch() as Array<{
			type?: string;
			message?: { role?: string; content?: unknown };
		}>;
		let turns = 0;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry?.type !== "message") continue;
			const role = entry.message?.role;
			if (role === "user") {
				turns++;
				if (turns >= recentTurns) break;
				continue;
			}
			if (role !== "assistant") continue;
			const content = entry.message?.content;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (
					part &&
					typeof part === "object" &&
					(part as { type?: string }).type === "toolCall" &&
					typeof (part as { id?: unknown }).id === "string"
				) {
					ids.add((part as { id: string }).id);
				}
			}
		}
	} catch {
		// Session shape changed: treat everything as non-recent.
	}
	return ids;
}

function logRenderPath(pathKey: string): void {
	if (loggedRenderPaths.has(pathKey)) return;
	loggedRenderPaths.add(pathKey);
	debugLog(`expanded render path: ${pathKey}`);
}

async function loadBuiltInRenderers(): Promise<void> {
	try {
		const entry = join(getPackageDir(), "dist", "core", "tools", "renderers", "index.js");
		const mod = (await import(pathToFileURL(entry).href)) as {
			createAllToolRenderers?: () => Record<string, BuiltInRenderer>;
		};
		if (typeof mod.createAllToolRenderers === "function") {
			builtInRenderers = mod.createAllToolRenderers();
			debugLog(`builtin renderers loaded: ${Object.keys(builtInRenderers).join(",")}`);
		} else {
			debugLog("builtin renderers: factory not found");
		}
	} catch (error) {
		builtInRenderers = {};
		debugLog(`builtin renderers failed: ${String(error)}`);
	}
}

/**
 * Wrap a built-in definition with quiet rendering:
 * - collapsed: call and result render nothing (invisible, no placeholder rows)
 * - expanded (Ctrl+O): the native built-in renderers, wrapped in the same
 *   background box the default shell uses
 * - errors: kept as a single red line even while collapsed
 */
function makeQuietDefinition(
	name: string,
	def: AnyToolDefinition,
	summary: (args: any, theme: Theme) => string,
): AnyToolDefinition {
	return {
		...def,
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!isToolShown(context.toolCallId, context.expanded)) return new Container();
			// The edit renderer draws its own box; every other tool composes call and
			// result inside the result renderer so they share one native-looking box.
			const builtIn = builtInRenderers[name]?.renderCall;
			if (name === "edit" && builtIn) {
				// Built-in renderers reuse context.lastComponent and call setText() on it;
				// our collapsed call component is an empty Container, so mask it.
				return builtIn(args, theme, { ...context, lastComponent: undefined }) as never;
			}
			return new Container();
		},
		renderResult(result, options, theme, context) {
			if (!isToolShown(context.toolCallId, context.expanded)) {
				if (context.isError) {
					const first = truncate(textOf(result), 100);
					return new Text(
						theme.fg("error", `✗ ${name} failed${first ? `: ${first}` : ""} (ctrl+o to view)`),
						0,
						0,
					);
				}
				return new Container();
			}

		const renderer = builtInRenderers[name];
			const builtInCall = renderer?.renderCall;
			const builtInResult = renderer?.renderResult;
			const traceKey = `${name}#${context.toolCallId}`;
			const traceState = `level=${getLevel()} expanded=${String(context.expanded)} shown=${String(isToolShown(context.toolCallId, context.expanded))}`;
			if (tracedExpansions.get(traceKey) !== traceState) {
				tracedExpansions.set(traceKey, traceState);
				debugLog(`tool ${traceKey} ${traceState}`);
			}
			const bg = options.isPartial
				? "toolPendingBg"
				: context.isError
					? "toolErrorBg"
					: "toolSuccessBg";
			// Whenever the row is shown, render the full (expanded) native view.
			const shownOptions = { ...options, expanded: true };

			// Fallback that still looks native: same background box, summary + output.
			const boxedFallback = (): unknown => {
				const box = new Box(1, 1, (text: string) => theme.bg(bg, text));
				box.addChild(new Text(summary(context.args, theme), 0, 0));
				box.addChild(new Text(renderOutput(result, theme), 0, 0));
				return box;
			};

			try {
				// Built-in renderers reuse context.lastComponent (and its setText method);
				// after our empty collapsed render that slot holds a Container, which made
				// them throw and fall back to plain text. Mask it for a fresh component.
				const builtinContext = { ...context, lastComponent: undefined };
				if (name === "edit" && builtInResult) {
					logRenderPath(`${name}:builtin`);
					return builtInResult(result, shownOptions, theme, builtinContext) as never;
				}
				if (builtInResult) {
					logRenderPath(`${name}:builtin`);
					const box = new Box(1, 1, (text: string) => theme.bg(bg, text));
					if (builtInCall) box.addChild(builtInCall(context.args, theme, builtinContext) as never);
					box.addChild(builtInResult(result, shownOptions, theme, builtinContext) as never);
					return box as never;
				}
			} catch (error) {
				debugLog(`expanded render failed for ${name}: ${String(error)}`);
			}

			logRenderPath(`${name}:fallback`);
			return boxedFallback() as never;
		},
	};
}

// ---------------------------------------------------------------------------
// Tool registration (must mirror the session's creation options)
// ---------------------------------------------------------------------------

function buildDefinitions(cwd: string, projectTrusted: boolean): Record<string, AnyToolDefinition> {
	const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
	return {
		read: createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() }),
		bash: createBashToolDefinition(cwd, {
			commandPrefix: settings.getShellCommandPrefix(),
			shellPath: settings.getShellPath(),
		}),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
}

/** Sample overridable tool names before registering overrides. */
function getOverridableNames(pi: ExtensionAPI): Set<string> {
	if (!overridableNames) {
		overridableNames = new Set(
			pi
				.getAllTools()
				.filter((tool) => tool.sourceInfo?.source === "builtin" && SUMMARIES[tool.name])
				.map((tool) => tool.name),
		);
	}
	return overridableNames;
}

/**
 * Make the session registry reflect the level.
 * Quiet and plain definitions both exist because the extension API offers no
 * unregister; switching back to plain definitions restores native rendering.
 */
function ensureTools(pi: ExtensionAPI, ctx: ExtensionContext, level: QuietLevel): void {
	const want: "quiet" | "plain" = level === "off" ? "plain" : "quiet";
	const needsRefresh = want === "quiet" && toolsNeedCtxRefresh;
	if (toolsRegisteredAs === want && !needsRefresh) return;
	if (want === "plain" && toolsRegisteredAs === undefined) return; // fresh registry: nothing to restore

	const names = registeredNames.length > 0 ? registeredNames : [...getOverridableNames(pi)];
	const definitions = buildDefinitions(ctx.cwd, ctx.isProjectTrusted());
	for (const name of names) {
		const def = definitions[name];
		if (!def) continue;
		if (want === "quiet") {
			pi.registerTool(makeQuietDefinition(name, def, SUMMARIES[name]!));
		} else {
			// No renderers => interactive-mode falls back to the built-in renderers.
			pi.registerTool(def);
		}
	}
	registeredNames = names;
	toolsRegisteredAs = want;
	toolsNeedCtxRefresh = false;
}

/**
 * Register quiet tools while the extension factory runs. /reload rebuilds the chat
 * after loading extensions but before session_start, so registering only there left
 * historical tool rows rendered by the plain builtins (visible boxes that could not
 * be hidden). Registering at factory time keeps reloaded history quiet.
 */
function registerQuietToolsAtFactory(pi: ExtensionAPI): void {
	const names = Object.keys(SUMMARIES);
	const definitions = buildDefinitions(process.cwd(), false);
	for (const name of names) {
		const def = definitions[name];
		if (def) pi.registerTool(makeQuietDefinition(name, def, SUMMARIES[name]!));
	}
	registeredNames = names;
	toolsRegisteredAs = "quiet";
	toolsNeedCtxRefresh = true;
}

// ---------------------------------------------------------------------------
// Transcript compaction patch
// ---------------------------------------------------------------------------

/**
 * AssistantMessageComponent always adds spacer rows and leaves an ANSI-only row
 * for a hidden thinking label. The public API cannot remove them, so while a
 * quiet level is active we filter these invisible rows out of the component's
 * content container. Full mode additionally removes the intermediate narration
 * Markdown of messages that contain tool calls. Messages that keep visible
 * content get exactly one leading separator row, so the transcript breathes
 * without accumulating filler; fully hidden messages render zero rows.
 *
 * The patch is guarded with Symbol.for (safe across /reload) and every step
 * fails soft: on any structural change it simply does nothing.
 */

function isSpacer(child: unknown): boolean {
	try {
		return (child as { constructor?: { name?: string } })?.constructor?.name === "Spacer";
	} catch {
		return false;
	}
}

function isInvisibleLabel(child: unknown): boolean {
	try {
		// MouseRegion-wrapped hidden thinking label: a Text with ANSI-only content.
		const inner = (child as { child?: { text?: unknown } })?.child;
		return !!inner && typeof inner.text === "string" && visibleWidth(inner.text) === 0;
	} catch {
		return false;
	}
}

/** MouseRegion-wrapped thinking block (label Text or revealed Markdown). */
function isThinkingBlock(child: unknown): boolean {
	try {
		const inner = (child as { child?: { text?: unknown } })?.child;
		return !!inner && typeof inner.text === "string";
	} catch {
		return false;
	}
}

function isMarkdown(child: unknown): boolean {
	try {
		return (child as { constructor?: { name?: string } })?.constructor?.name === "Markdown";
	} catch {
		return false;
	}
}

/**
 * Current transcript filter. Republished on every load through FILTER_KEY so the
 * installed wrapper always delegates to the latest implementation.
 */
function applyQuietFilter(component: {
	contentContainer?: { children?: unknown[] };
	hasToolCalls?: boolean;
	isStreaming?: boolean;
	__qmSig?: string;
}): void {
	const level = getLevel();
	if (level === "off") return;
	try {
		const container = component.contentContainer;
		if (!container || !Array.isArray(container.children)) return;
		// Hide narration while streaming too. Read the component's own flag instead
		// of the call argument: invalidate() re-runs updateContent(message) without
		// it, which otherwise made streaming text pop in and disappear again.
		const isStreaming = component.isStreaming === true;
		const hideNarration = level === "full" && (component.hasToolCalls === true || isStreaming);
		const revealed = (globalThis as Record<PropertyKey, unknown>)[REVEAL_KEY] === true;
		const before = container.children
			.map((c) => (c as { constructor?: { name?: string } })?.constructor?.name ?? "?")
			.join(",");
		// Drop invisible labels and (in full mode) narration, then normalize blank
		// lines: collapse runs, trim the edges, keep one separator before the first
		// visible block. This keeps a blank line between revealed thinking and the
		// answer instead of gluing them together.
		const kept = container.children.filter((child) => {
			if (isInvisibleLabel(child)) return false;
			// Revealed thinking (the user toggled hideThinkingBlock off, possibly in
			// an earlier session) stays hidden unless Ctrl+T was pressed in this run.
			if (!revealed && isThinkingBlock(child)) return false;
			if (hideNarration && isMarkdown(child)) return false;
			return true;
		});
		const compact: unknown[] = [];
		for (const child of kept) {
			if (isSpacer(child)) {
				if (compact.length === 0 || isSpacer(compact[compact.length - 1])) continue;
			}
			compact.push(child);
		}
		while (compact.length > 0 && isSpacer(compact[0])) compact.shift();
		while (compact.length > 0 && isSpacer(compact[compact.length - 1])) compact.pop();
		container.children = compact.length > 0 ? [new Spacer(1), ...compact] : [];
		const after = container.children
			.map((c) => (c as { constructor?: { name?: string } })?.constructor?.name ?? "?")
			.join(",");
		const sig = `lvl=${level} streaming=${String(isStreaming)} hasTools=${String(component.hasToolCalls)} before=[${before}] after=[${after}]`;
		if (component.__qmSig !== sig) {
			component.__qmSig = sig;
			debugLog(sig);
		}
	} catch {
		// Filtering failed: keep the original content.
	}
}

/** Record explicit Ctrl+T reveals so the filter can distinguish them from restored settings. */
function patchThinkingToggle(): void {
	try {
		const proto = (AssistantMessageComponent as unknown as { prototype?: Record<PropertyKey, unknown> })
			?.prototype;
		if (!proto || typeof proto.setHideThinkingBlock !== "function") return;
		if (proto[THINKING_PATCH_KEY] === PATCH_VERSION) return;
		const original = proto.setHideThinkingBlock as (hide: boolean) => void;
		proto.setHideThinkingBlock = function (this: unknown, hide: boolean) {
			// Set the flag before the original call: it triggers updateContent, and the
			// filter must already see the new reveal state.
			(globalThis as Record<PropertyKey, unknown>)[REVEAL_KEY] = hide !== true;
			original.call(this, hide);
		};
		proto[THINKING_PATCH_KEY] = PATCH_VERSION;
	} catch {
		// Fail soft: fall back to the persisted hideThinkingBlock behavior.
	}
}

function patchAssistantMessages(): void {
	// Publish the latest filter first: older shells left on the prototype will run
	// it too, so even a stale wrapper cannot re-introduce old behavior.
	(globalThis as Record<PropertyKey, unknown>)[FILTER_KEY] = applyQuietFilter;
	patchThinkingToggle();
	try {
		const proto = (AssistantMessageComponent as unknown as { prototype?: Record<PropertyKey, unknown> })
			?.prototype;
		if (!proto || typeof proto.updateContent !== "function") return;
		const current = proto.updateContent as { [PATCH_FLAG_KEY]?: number };
		if (current[PATCH_FLAG_KEY] === PATCH_VERSION) return;

		const original = current as unknown as (...args: unknown[]) => void;
		const shell = function (this: unknown, ...args: unknown[]) {
			// Stale wrappers from older builds are still in the chain and destroy data
			// (they strip spacer rows before the current filter runs). Mask the level as
			// "off" while the inner chain executes so every old level-aware wrapper
			// no-ops, then restore the real level for the current filter.
			const realLevel = getLevel();
			if (realLevel !== "off") setLevel("off");
			try {
				original.apply(this, args);
			} finally {
				setLevel(realLevel);
			}
			const filter = (globalThis as Record<PropertyKey, unknown>)[FILTER_KEY];
			if (typeof filter === "function") (filter as (component: unknown) => void)(this);
		};
		(shell as unknown as Record<PropertyKey, unknown>)[PATCH_FLAG_KEY] = PATCH_VERSION;
		proto.updateContent = shell;
		proto[PATCH_FLAG_KEY] = PATCH_VERSION;
		debugLog(`patch installed: class=${AssistantMessageComponent?.name} version=${PATCH_VERSION}`);
	} catch {
		// Component internals changed: skip the patch, rendering stays native.
	}
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function updateStatusBadge(ctx: ExtensionContext): void {
	const info = LEVEL_INFO[getLevel()];
	if (!info.enabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const suffix =
		toolCycle === 2
			? " · tools:all"
			: toolCycle === 1
				? recentTurns > 1
					? ` · tools:recent×${recentTurns}`
					: " · tools:recent"
				: "";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${info.badge}${suffix}`));
}

/** Re-render every tool row and update the badge after the cycle changed. */
function applyToolCycle(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	partialToolIds = toolCycle === 1 ? computePartialToolIds(ctx) : new Set();
	// A single render pass: flipping the flag triggers setExpanded() on every tool
	// component and our renderers decide visibility from the cycle state, so there
	// is no need for the previous double toggle (which doubled the redraw work and
	// made Pi's full-redraw-on-history-change more likely).
	ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded());
	updateStatusBadge(ctx);
}

function applyUi(ctx: ExtensionContext, level: QuietLevel): void {
	if (ctx.mode !== "tui") return;
	debugLog(`applyUi: level=${level} mode=${ctx.mode}`);
	// Level switches and reloads start from a clean transcript.
	toolCycle = 0;
	partialToolIds = new Set();
	const info = LEVEL_INFO[level];
	ctx.ui.setWorkingMessage(info.enabled ? "Thinking..." : undefined);
	// Hiding the label also triggers updateContent() on existing messages, so the
	// compaction patch is applied or removed immediately.
	ctx.ui.setHiddenThinkingLabel(info.enabled ? "" : undefined);
	// Level switches and reloads always start collapsed; our renderers decide what
	// is visible from the cycle state.
	ctx.ui.setToolsExpanded(false);
	updateStatusBadge(ctx);
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

let terminalInputUnsubscribe: (() => void) | undefined;

export default async function (pi: ExtensionAPI) {
	const initialState = loadState();
	setLevel(initialState.level);
	recentTurns = initialState.recentTurns;
	// A reload builds a fresh transcript: history should render clean even when the
	// persisted hideThinkingBlock setting leaves thinking visible from an earlier peek.
	(globalThis as Record<PropertyKey, unknown>)[REVEAL_KEY] = false;
	// Legacy cleanup: very early builds used a boolean flag under a different key
	// and kept stripping spacer rows whenever it was true — even in level 3. That
	// leftover wrapper is still installed on the component prototype in long-lived
	// sessions, so switch it off explicitly.
	(globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi.quiet-mode.enabled")] = false;
	debugLog(`factory: level=${getLevel()}`);
	patchAssistantMessages();
	await loadBuiltInRenderers();

	// Register before /reload rebuilds the chat so historical tool rows stay quiet.
	if (getLevel() !== "off") {
		try {
			registerQuietToolsAtFactory(pi);
		} catch (error) {
			debugLog(`factory tool registration failed: ${String(error)}`);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		getOverridableNames(pi);
		// Raw key tracing (Ctrl+O = 0x0f, Ctrl+T = 0x14) to correlate expansion
		// glitches reported by users. Never consumes input.
		if (ctx.mode === "tui") {
			try {
				terminalInputUnsubscribe?.();
				terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
					// Ctrl+O is reserved for Pi, so an extension shortcut cannot be
					// registered for it. Input listeners run before the editor, so quiet
					// modes take the key over and cycle tool visibility instead.
					if (data === "\x0f" && getLevel() !== "off") {
						debugLog("key ctrl+o (quiet cycle)");
						toolCycle = ((toolCycle + 1) % 3) as ToolCycle;
						try {
							applyToolCycle(ctx);
						} catch (error) {
							debugLog(`tool cycle failed: ${String(error)}`);
						}
						return { consume: true };
					}
					if (data === "\x0f") debugLog("key ctrl+o (native)");
					else if (data === "\x14") debugLog("key ctrl+t");
					return undefined;
				});
			} catch {
				// Best effort.
			}
		}
		if (getLevel() !== "off") {
			try {
				ensureTools(pi, ctx, getLevel());
			} catch (error) {
				setLevel("off");
				ctx.ui.notify(`Quiet mode init failed, disabled: ${String(error)}`, "error");
			}
		}
		applyUi(ctx, getLevel());
	});

	// Level 2: ask the model for one short narration sentence before each tool call.
	pi.on("before_agent_start", async (event) => {
		if (getLevel() !== "partial") return;
		try {
			event.systemPromptOptions.promptGuidelines.push(PARTIAL_GUIDELINE);
		} catch {
			// Prompt mutation is best-effort.
		}
	});

	pi.registerCommand("quiet", {
		description: "Set quiet level: 1 full, 2 partial, 3 off (no argument cycles); /quiet recent [n]",
		handler: async (args, ctx) => {
			const raw = args.trim().toLowerCase();
			const current = getLevel();
			let next: QuietLevel;

			// /quiet recent [1-20]: how many recent tool batches the "recent" step expands.
			const parts = raw.split(/\s+/).filter(Boolean);
			if (parts[0] === "recent") {
				if (parts[1] === undefined) {
					ctx.ui.notify(
						`Recent user turns: ${recentTurns}. Ctrl+O shows tools from the last ${recentTurns} prompt(s). Usage: /quiet recent 1-20`,
						"info",
					);
					return;
				}
				const parsed = Number.parseInt(parts[1], 10);
				if (!Number.isFinite(parsed) || parsed < 1 || parsed > 20) {
					ctx.ui.notify("Usage: /quiet recent 1-20", "error");
					return;
				}
				recentTurns = parsed;
				saveState();
				updateStatusBadge(ctx);
				ctx.ui.notify(`Recent user turns set to ${recentTurns}`, "info");
				return;
			}

			if (!raw) {
				next = LEVEL_ORDER[(LEVEL_ORDER.indexOf(current) + 1) % LEVEL_ORDER.length]!;
			} else if (raw === "1" || raw === "full" || raw === "on") {
				next = "full";
			} else if (raw === "2" || raw === "partial") {
				next = "partial";
			} else if (raw === "3" || raw === "off") {
				next = "off";
			} else {
				ctx.ui.notify("Usage: /quiet [1|2|3] or /quiet [full|partial|off]", "error");
				return;
			}

			if (next === current) {
				ctx.ui.notify(`Quiet mode is already ${LEVEL_INFO[next].badge || "off"}`, "info");
				return;
			}

			setLevel(next);
			try {
				ensureTools(pi, ctx, next);
			} catch (error) {
				setLevel(current);
				ctx.ui.notify(`Quiet mode switch failed: ${String(error)}`, "error");
				return;
			}

			saveState();
			applyUi(ctx, next);
			ctx.ui.notify(LEVEL_INFO[next].notify, "info");
		},
	});
}

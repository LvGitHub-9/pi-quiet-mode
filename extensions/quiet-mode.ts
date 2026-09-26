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
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type AnyToolDefinition = ToolDefinition<any, any, any>;
type QuietLevel = "off" | "full" | "partial";

const MAX_EXPANDED_LINES = 120;
const STATUS_KEY = "quiet-mode";

// The level lives on globalThis because /reload re-imports this module while the
// patched component class stays shared. A global symbol keeps the patch reading
// the current value instead of a stale closure variable.
const LEVEL_KEY = Symbol.for("pi.quiet-mode.level");
const PATCH_FLAG_KEY = Symbol.for("pi.quiet-mode.patched");

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

function setLevel(level: QuietLevel): void {
	(globalThis as Record<PropertyKey, unknown>)[LEVEL_KEY] = level;
}

/** Built-in tools that can be safely overridden (sampled before we register anything). */
let overridableNames: Set<string> | undefined;
/** What the current session registry currently holds from this extension. */
let toolsRegisteredAs: "quiet" | "plain" | undefined;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function stateFile(): string {
	return join(getAgentDir(), "quiet-mode.json");
}

function loadLevel(): QuietLevel {
	try {
		const data = JSON.parse(readFileSync(stateFile(), "utf-8")) as { level?: unknown; quiet?: unknown };
		if (data.level === "off" || data.level === "full" || data.level === "partial") return data.level;
		// Migrate the original boolean format.
		if (data.quiet === true) return "full";
		if (data.quiet === false) return "off";
	} catch {
		// Missing or invalid file: stay off.
	}
	return "off";
}

function saveLevel(level: QuietLevel): void {
	try {
		const dir = getAgentDir();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(stateFile(), JSON.stringify({ level }, null, 2), "utf-8");
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
 * Wrap a built-in definition with quiet rendering:
 * - collapsed: call and result render nothing (invisible, no placeholder rows)
 * - expanded (Ctrl+O): one-line call summary plus the full output
 * - errors: kept as a single red line even while collapsed
 */
function makeQuietDefinition(
	def: AnyToolDefinition,
	summary: (args: any, theme: Theme) => string,
): AnyToolDefinition {
	return {
		...def,
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!context.expanded) return new Container();
			return new Text(summary(args, theme), 0, 0);
		},
		renderResult(result, _options, theme, context) {
			if (!context.expanded) {
				if (context.isError) {
					const first = truncate(textOf(result), 100);
					return new Text(
						theme.fg("error", `✗ ${def.name} failed${first ? `: ${first}` : ""} (ctrl+o to view)`),
						0,
						0,
					);
				}
				return new Container();
			}
			return new Text(renderOutput(result, theme), 0, 0);
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
	if (toolsRegisteredAs === want) return;
	if (want === "plain" && toolsRegisteredAs === undefined) return; // fresh registry: nothing to restore

	const names = getOverridableNames(pi);
	const definitions = buildDefinitions(ctx.cwd, ctx.isProjectTrusted());
	for (const name of names) {
		const def = definitions[name];
		if (!def) continue;
		if (want === "quiet") {
			pi.registerTool(makeQuietDefinition(def, SUMMARIES[name]!));
		} else {
			// No renderers => interactive-mode falls back to the built-in renderers.
			pi.registerTool(def);
		}
	}
	toolsRegisteredAs = want;
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

function isQuietNoise(child: unknown): boolean {
	try {
		const node = child as { constructor?: { name?: string }; child?: { text?: unknown } };
		if (node?.constructor?.name === "Spacer") return true;
		// MouseRegion-wrapped hidden thinking label: a Text with ANSI-only content.
		const inner = node?.child;
		if (inner && typeof inner.text === "string" && visibleWidth(inner.text) === 0) return true;
	} catch {
		// ignore
	}
	return false;
}

function isMarkdown(child: unknown): boolean {
	try {
		return (child as { constructor?: { name?: string } })?.constructor?.name === "Markdown";
	} catch {
		return false;
	}
}

function patchAssistantMessages(): void {
	try {
		const proto = (AssistantMessageComponent as unknown as { prototype?: Record<PropertyKey, unknown> })
			?.prototype;
		if (!proto || typeof proto.updateContent !== "function" || proto[PATCH_FLAG_KEY]) return;

		const original = proto.updateContent as (...args: unknown[]) => void;
		proto.updateContent = function (
			this: { contentContainer?: { children?: unknown[] }; hasToolCalls?: boolean },
			...args: unknown[]
		) {
			original.apply(this, args);
			const level = getLevel();
			if (level === "off") return;
			try {
				const container = this.contentContainer;
				if (!container || !Array.isArray(container.children)) return;
				const hideNarration = level === "full" && this.hasToolCalls === true;
				const content = container.children.filter((child) => {
					if (isQuietNoise(child)) return false;
					if (hideNarration && isMarkdown(child)) return false;
					return true;
				});
				// Keep one separator row before visible content, nothing for fully hidden messages.
				container.children = content.length > 0 ? [new Spacer(1), ...content] : [];
			} catch {
				// Filtering failed: keep the original content.
			}
		};
		proto[PATCH_FLAG_KEY] = true;
	} catch {
		// Component internals changed: skip the patch, rendering stays native.
	}
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function applyUi(ctx: ExtensionContext, level: QuietLevel): void {
	if (ctx.mode !== "tui") return;
	const info = LEVEL_INFO[level];
	ctx.ui.setWorkingMessage(info.enabled ? "Thinking..." : undefined);
	// Hiding the label also triggers updateContent() on existing messages, so the
	// compaction patch is applied or removed immediately.
	ctx.ui.setHiddenThinkingLabel(info.enabled ? "" : undefined);
	ctx.ui.setStatus(STATUS_KEY, info.enabled ? ctx.ui.theme.fg("dim", info.badge) : undefined);
	if (info.enabled) {
		ctx.ui.setToolsExpanded(false);
	}
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	setLevel(loadLevel());
	patchAssistantMessages();

	pi.on("session_start", async (_event, ctx) => {
		getOverridableNames(pi);
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
		description: "Set quiet level: 1 full, 2 partial, 3 off (no argument cycles)",
		handler: async (args, ctx) => {
			const raw = args.trim().toLowerCase();
			const current = getLevel();
			let next: QuietLevel;

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

			saveLevel(next);
			applyUi(ctx, next);
			ctx.ui.notify(LEVEL_INFO[next].notify, "info");
		},
	});
}

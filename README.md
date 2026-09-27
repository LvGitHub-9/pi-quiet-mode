# pi-quiet-mode

**Three-level quiet mode for [Pi](https://pi.dev).** Keep tool noise out of the way without losing sight of the work.

**English** | [中文](README.zh-CN.md)

Pi's default transcript shows every tool call, every result, and a `Thinking...` label for each hidden thinking block. That is great while debugging and distracting the rest of the time. This extension adds a `/quiet` switch with three levels.

## Levels

| Level | Command | Transcript shows | Best for |
|-------|---------|------------------|----------|
| **1 — full** | `/quiet 1` | A live `Thinking...` indicator, then the final answer. No tool rows, no intermediate narration, no blank filler. | Just giving instructions and reading results. |
| **2 — partial** | `/quiet 2` | One short narration sentence per step (`what I am doing / what I found / what I plan next`), followed by the final answer. Tool details stay hidden. | Watching the agent work without the wall of output. |
| **3 — off** | `/quiet 3` | Native Pi behavior. | Debugging, auditing, full transparency. |

`/quiet` without an argument cycles `off → 1 → 2 → off`. The current level is shown in the status bar as `quiet:1` / `quiet:2` and is remembered across restarts.

In quiet levels **`Ctrl+O` cycles tool visibility**: hidden → tools from the recent prompt(s) → all tools → hidden. `/quiet recent N` (1–20, default 1) sets how many recent user prompts count as "recent"; the status bar shows `tools:recent×N`.

## Install

```bash
# From npm (once published)
pi install npm:pi-quiet-mode

# Straight from git
pi install git:github.com/LvGitHub-9/pi-quiet-mode

# Local checkout for development
pi install /path/to/pi-quiet-mode
```

Or try it without installing:

```bash
pi -e /path/to/pi-quiet-mode/extensions/quiet-mode.ts
```

No configuration needed. Start Pi and run `/quiet`.

## What each level does

**Level 1 (full)**
- Tool calls and outputs render zero rows — there is nothing to scroll past.
- Intermediate assistant narration is hidden; only the last answer of the run is shown.
- Hidden thinking labels and their leftover ANSI-only rows are removed, so no blank lines remain.
- A tool failure still leaves **one red line**, so failures are never silent.
- The live `Thinking...` indicator in the editor border keeps showing that work is in progress.

**Level 2 (partial)**
- Tool calls and outputs are hidden exactly like level 1.
- Assistant narration stays visible. A guideline is injected into the system prompt asking the model to write **exactly one short sentence before each tool call**.
- Failures keep their one red line.

**Level 3 (off)**
- The original definitions are re-registered, so Pi's built-in tool rendering, thinking labels, and spacing come back untouched.

## Extras

- **`Ctrl+O`**: a reserved Pi shortcut, so extensions cannot register it. Quiet levels intercept the key through the terminal input listener and cycle **hidden → recent → all → hidden**. "Recent" covers every tool call made for the last `N` user prompts (`/quiet recent N`). Level 3 keeps Pi's native expand/collapse-all behavior.
- **`Ctrl+T`** still toggles thinking blocks. In quiet levels the reveal only applies to the current session, so a reload renders old history clean again.
- **Persistence**: level and recent-turn count are stored in `<agent-dir>/quiet-mode.json` (`~/.pi/agent/quiet-mode.json` by default).
- **No behavior drift**: the extension recreates built-in tool definitions with the exact options the session uses — including `shellPath`, `shellCommandPrefix`, and `autoResizeImages` — so settings keep working. It only overrides tools that are still `builtin`; tools replaced by other extensions are never touched.
- **Fail-soft internals patch**: Pi's message component always inserts spacer rows and leaves an ANSI-only row for a hidden thinking label, neither of which is removable through the public extension API. The extension carries a small, guarded patch (marked with `Symbol.for`, applied only while a quiet level is active) that filters those rows. If Pi's internals change, the patch silently no-ops and everything still renders normally.

## Known limitations

- Tool output is only hidden, not deleted. `Ctrl+O` (or `/quiet 3`) always brings it back.
- Inline images returned by tools are still displayed by Pi's own component layer.
- Level 2 narration quality depends on the model following the one-sentence guideline.
- The extension covers the built-in tools `read`, `bash`, `edit`, `write`, `find`, `grep`, `ls`. Custom tools keep their own rendering.

## Development

```bash
npm test        # offline suite: level switching, rendering, shellPath regression, patch behavior
```

The test runs the real extension through Pi's own `jiti` loader with a mocked API — no model calls, no network. `PI_PACKAGE_DIR=/path/to/@earendil-works/pi-coding-agent` overrides package discovery.

## 中文说明

完整中文文档见 **[README.zh-CN.md](README.zh-CN.md)**。

## License

MIT

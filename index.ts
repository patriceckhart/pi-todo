/**
 * Pi Todo Extension - To-do list synced with Apple Reminders
 *
 * Features:
 * - LLM tool `todo` for managing todos (add, list, toggle, edit, remove, clear)
 * - `/todo` command to view and manage todos in a custom TUI
 * - Two-way sync with Apple Reminders "pi" list via compiled Swift helper (fast!)
 * - Add new todos directly from the TUI (press `a`)
 * - Multi-line editor for longer descriptions
 * - Priority support (none, low, medium, high)
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

interface Todo {
	id: string;
	title: string;
	body: string;
	done: boolean;
	priority: "none" | "low" | "medium" | "high";
}

interface TodoDetails {
	action: string;
	todos: Todo[];
	error?: string;
}

const PRIORITY_TO_APPLE: Record<string, number> = { none: 0, low: 9, medium: 5, high: 1 };
const APPLE_TO_PRIORITY: Record<number, string> = { 0: "none", 9: "low", 5: "medium", 1: "high" };

// ─── Swift helper binary ──────────────────────────────────────────────────────

function getHelperPath(): string {
	// Resolve relative to this file
	const dir = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
	return join(dir, "reminders-helper");
}

function ensureHelper(): string {
	const helperPath = getHelperPath();
	if (!existsSync(helperPath)) {
		const swiftSrc = join(dirname(helperPath), "reminders-helper.swift");
		execFileSync("swiftc", ["-O", swiftSrc, "-o", helperPath], { timeout: 30000 });
	}
	return helperPath;
}

async function runHelper(...args: string[]): Promise<string> {
	const helper = ensureHelper();
	const { stdout } = await execFileAsync(helper, args, { encoding: "utf-8", timeout: 10000 });
	return stdout.trim();
}

function parseTodo(raw: any): Todo {
	return {
		id: raw.id ?? "",
		title: raw.title ?? "",
		body: raw.body ?? "",
		done: !!raw.done,
		priority: (APPLE_TO_PRIORITY[raw.priority] || "none") as Todo["priority"],
	};
}

// ─── Reminders API (async, fast) ──────────────────────────────────────────────

async function fetchReminders(): Promise<Todo[]> {
	const json = await runHelper("list");
	const raw = JSON.parse(json) as any[];
	return raw.map(parseTodo);
}

async function addReminder(title: string, body: string, priority: Todo["priority"]): Promise<Todo> {
	const params = JSON.stringify({ title, body, priority: PRIORITY_TO_APPLE[priority] ?? 0 });
	const json = await runHelper("add", params);
	return parseTodo(JSON.parse(json));
}

async function toggleReminder(id: string): Promise<Todo> {
	const json = await runHelper("toggle", id);
	return parseTodo(JSON.parse(json));
}

async function updateReminder(id: string, updates: { title?: string; body?: string; priority?: Todo["priority"]; done?: boolean }): Promise<Todo> {
	const params: any = {};
	if (updates.title !== undefined) params.title = updates.title;
	if (updates.body !== undefined) params.body = updates.body;
	if (updates.priority !== undefined) params.priority = PRIORITY_TO_APPLE[updates.priority] ?? 0;
	if (updates.done !== undefined) params.done = updates.done;
	const json = await runHelper("update", id, JSON.stringify(params));
	return parseTodo(JSON.parse(json));
}

async function deleteReminder(id: string): Promise<void> {
	await runHelper("delete", id);
}

async function deleteAllReminders(): Promise<number> {
	const json = await runHelper("clear");
	return JSON.parse(json).count;
}

// ─── Tool schema ──────────────────────────────────────────────────────────────

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "edit", "remove", "clear"] as const),
	title: Type.Optional(Type.String({ description: "Todo title (for add/edit)" })),
	body: Type.Optional(Type.String({ description: "Longer description (for add/edit)" })),
	id: Type.Optional(Type.String({ description: "Todo ID (for toggle/edit/remove)" })),
	priority: Type.Optional(
		StringEnum(["none", "low", "medium", "high"] as const, {
			description: "Priority level (default: none)",
		}),
	),
});

// ─── TUI: Todo List Viewer/Manager ────────────────────────────────────────────

function createTodoListUI(
	initialTodos: Todo[],
	theme: Theme,
	tui: any,
	done: (value: void) => void,
	syncFn: () => Promise<Todo[]>,
) {
	let todos = [...initialTodos];
	let selectedIndex = 0;
	let mode: "list" | "detail" | "edit-body" | "add-title" | "add-body" = "list";
	let cachedLines: string[] | undefined;
	let scrollOffset = 0;
	let syncing = false;

	// For adding new todos
	let newTitle = "";
	let newBody = "";

	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
	const bodyEditor = new Editor(tui, editorTheme);
	const titleEditor = new Editor(tui, editorTheme);

	function refresh() {
		cachedLines = undefined;
		tui.requestRender();
	}

	async function sync() {
		if (syncing) return;
		syncing = true;
		refresh();
		try {
			todos = await syncFn();
		} catch { /* keep local */ }
		if (selectedIndex >= todos.length) selectedIndex = Math.max(0, todos.length - 1);
		syncing = false;
		refresh();
	}

	function priorityBadge(p: string): string {
		switch (p) {
			case "high": return theme.fg("error", "!!!");
			case "medium": return theme.fg("warning", "!!");
			case "low": return theme.fg("muted", "!");
			default: return "";
		}
	}

	function handleInput(data: string) {
		if (syncing) return;

		// ── Add title mode ──
		if (mode === "add-title") {
			if (matchesKey(data, Key.escape)) {
				mode = "list";
				refresh();
				return;
			}
			// Enter on the title editor submits (single-line)
			titleEditor.onSubmit = (value: string) => {
				newTitle = value.trim();
				if (!newTitle) {
					mode = "list";
					refresh();
					return;
				}
				// Move to body editing
				bodyEditor.setText("");
				mode = "add-body";
				refresh();
			};
			titleEditor.handleInput(data);
			refresh();
			return;
		}

		// ── Add body mode ──
		if (mode === "add-body") {
			if (matchesKey(data, Key.escape)) {
				// Save with just title, no body
				newBody = "";
				doAdd();
				return;
			}
			if (matchesKey(data, Key.ctrl("s"))) {
				newBody = bodyEditor.getText().trim();
				doAdd();
				return;
			}
			bodyEditor.handleInput(data);
			refresh();
			return;
		}

		// ── Edit body mode ──
		if (mode === "edit-body") {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("s"))) {
				const todo = todos[selectedIndex];
				if (todo) {
					const nb = bodyEditor.getText().trim();
					todo.body = nb;
					refresh();
					updateReminder(todo.id, { body: nb }).catch(() => {});
				}
				mode = "list";
				refresh();
				return;
			}
			bodyEditor.handleInput(data);
			refresh();
			return;
		}

		// ── Detail mode ──
		if (mode === "detail") {
			if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
				mode = "list";
				refresh();
				return;
			}
			if (matchesKey(data, "e")) {
				const todo = todos[selectedIndex];
				if (todo) {
					bodyEditor.setText(todo.body || "");
					mode = "edit-body";
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.space) || matchesKey(data, Key.enter) || matchesKey(data, "x")) {
				const todo = todos[selectedIndex];
				if (todo) {
					todo.done = !todo.done;
					refresh();
					toggleReminder(todo.id).catch(() => { todo.done = !todo.done; refresh(); });
				}
				return;
			}
			if (matchesKey(data, "d") || matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) {
				const todo = todos[selectedIndex];
				if (todo) {
					todos.splice(selectedIndex, 1);
					if (selectedIndex >= todos.length) selectedIndex = Math.max(0, todos.length - 1);
					mode = "list";
					refresh();
					deleteReminder(todo.id).catch(() => {});
				}
				return;
			}
			return;
		}

		// ── List mode ──
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			done();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (selectedIndex > 0) { selectedIndex--; refresh(); }
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (selectedIndex < todos.length - 1) { selectedIndex++; refresh(); }
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (todos.length > 0) { mode = "detail"; refresh(); }
			return;
		}
		if (matchesKey(data, Key.space) || matchesKey(data, "x")) {
			const todo = todos[selectedIndex];
			if (todo) {
				todo.done = !todo.done;
				refresh();
				toggleReminder(todo.id).catch(() => { todo.done = !todo.done; refresh(); });
			}
			return;
		}
		if (matchesKey(data, "a")) {
			titleEditor.setText("");
			newTitle = "";
			newBody = "";
			mode = "add-title";
			refresh();
			return;
		}
		if (matchesKey(data, "d") || matchesKey(data, Key.delete) || matchesKey(data, Key.backspace)) {
			const todo = todos[selectedIndex];
			if (todo) {
				todos.splice(selectedIndex, 1);
				if (selectedIndex >= todos.length) selectedIndex = Math.max(0, todos.length - 1);
				refresh();
				deleteReminder(todo.id).catch(() => {});
			}
			return;
		}
		if (matchesKey(data, "r")) {
			sync();
			return;
		}
	}

	function doAdd() {
		const title = newTitle;
		const body = newBody;
		// Optimistic: add locally, then sync to Reminders
		const placeholder: Todo = { id: "__pending__", title, body, done: false, priority: "none" };
		todos.push(placeholder);
		selectedIndex = todos.length - 1;
		mode = "list";
		refresh();

		addReminder(title, body, "none").then((real) => {
			const idx = todos.indexOf(placeholder);
			if (idx !== -1) todos[idx] = real;
			refresh();
		}).catch(() => {
			const idx = todos.indexOf(placeholder);
			if (idx !== -1) todos.splice(idx, 1);
			refresh();
		});
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;

		const lines: string[] = [];
		const add = (s: string) => lines.push(truncateToWidth(s, width));
		const separator = theme.fg("accent", "─".repeat(width));

		if (syncing) {
			add(separator);
			add("");
			add(theme.fg("accent", "  ⟳ Syncing with Apple Reminders..."));
			add("");
			add(separator);
			cachedLines = lines;
			return lines;
		}

		// ── Add title mode ──
		if (mode === "add-title") {
			add(separator);
			add(theme.fg("accent", theme.bold("  + New Todo")));
			add("");
			add(theme.fg("muted", "  Title:"));
			const editorLines = titleEditor.render(Math.max(width - 4, 20));
			for (const line of editorLines) add(`  ${line}`);
			add("");
			add(theme.fg("dim", "  Enter to continue to description • Esc to cancel"));
			add(separator);
			cachedLines = lines;
			return lines;
		}

		// ── Add body mode ──
		if (mode === "add-body") {
			add(separator);
			add(theme.fg("accent", theme.bold("  + New Todo")));
			add(theme.fg("text", `  ${newTitle}`));
			add("");
			add(theme.fg("muted", "  Description (optional):"));
			const editorLines = bodyEditor.render(Math.max(width - 4, 20));
			for (const line of editorLines) add(`  ${line}`);
			add("");
			add(theme.fg("dim", "  Ctrl+S to save • Esc to save without description"));
			add(separator);
			cachedLines = lines;
			return lines;
		}

		// ── Edit body mode ──
		if (mode === "edit-body") {
			const todo = todos[selectedIndex];
			add(separator);
			add(theme.fg("accent", theme.bold("  ✎ Edit Description")));
			add(theme.fg("muted", `  ${todo?.title || ""}`));
			add("");
			const editorLines = bodyEditor.render(Math.max(width - 4, 20));
			for (const line of editorLines) add(`  ${line}`);
			add("");
			add(theme.fg("dim", "  Esc/Ctrl+S to save and go back"));
			add(separator);
			cachedLines = lines;
			return lines;
		}

		// ── Detail mode ──
		if (mode === "detail") {
			const todo = todos[selectedIndex];
			if (!todo) { mode = "list"; return render(width); }
			add(separator);
			add("");
			const check = todo.done ? theme.fg("success", "  ✓ ") : theme.fg("dim", "  ○ ");
			const titleText = todo.done ? theme.fg("dim", todo.title) : theme.fg("text", theme.bold(todo.title));
			const pBadge = priorityBadge(todo.priority);
			add(check + titleText + (pBadge ? " " + pBadge : ""));
			add("");
			if (todo.priority !== "none") {
				add(theme.fg("muted", `  Priority: `) + theme.fg("text", todo.priority));
			}
			add(theme.fg("muted", `  Status: `) + (todo.done ? theme.fg("success", "completed") : theme.fg("text", "open")));
			add("");
			if (todo.body) {
				add(theme.fg("muted", "  Description:"));
				for (const bl of todo.body.split("\n")) {
					add(truncateToWidth(`  ${theme.fg("text", bl)}`, width));
				}
			} else {
				add(theme.fg("dim", "  No description"));
			}
			add("");
			add(theme.fg("dim", "  x/Space complete • e edit description • d delete • Esc back"));
			add("");
			add(separator);
			cachedLines = lines;
			return lines;
		}

		// ── List mode ──
		add(separator);
		add("");
		const titleLine =
			theme.fg("accent", theme.bold("  📋 Todos ")) +
			theme.fg("dim", `(${todos.filter((t) => t.done).length}/${todos.length} done)`);
		add(titleLine);
		add("");

		if (todos.length === 0) {
			add(theme.fg("dim", "  No todos yet."));
			add(theme.fg("dim", "  Press a to add one, or r to refresh from Reminders."));
		} else {
			const maxVisible = Math.max(3, 20);
			if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
			if (selectedIndex >= scrollOffset + maxVisible) scrollOffset = selectedIndex - maxVisible + 1;

			const visible = todos.slice(scrollOffset, scrollOffset + maxVisible);
			if (scrollOffset > 0) add(theme.fg("dim", `  ▲ ${scrollOffset} more`));

			for (let i = 0; i < visible.length; i++) {
				const realIdx = scrollOffset + i;
				const todo = visible[i];
				const isSelected = realIdx === selectedIndex;
				const prefix = isSelected ? theme.fg("accent", " ▸ ") : "   ";
				const check = todo.done ? theme.fg("success", "✓ ") : theme.fg("dim", "○ ");
				const titleColor = todo.done ? "dim" : isSelected ? "accent" : "text";
				const titleStr = theme.fg(titleColor, todo.title);
				const pBadge = priorityBadge(todo.priority);
				const bodyHint = todo.body ? theme.fg("dim", " …") : "";
				add(truncateToWidth(`${prefix}${check}${titleStr}${pBadge ? " " + pBadge : ""}${bodyHint}`, width));
			}

			const remaining = todos.length - scrollOffset - maxVisible;
			if (remaining > 0) add(theme.fg("dim", `  ▼ ${remaining} more`));
		}

		add("");
		add(theme.fg("dim", "  ↑↓ navigate • x complete • Enter details • a add • d delete • r refresh • Esc close"));
		add("");
		add(separator);

		cachedLines = lines;
		return lines;
	}

	return {
		render,
		invalidate: () => { cachedLines = undefined; },
		handleInput,
	};
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];

	// Pre-compile the Swift helper at load time (only if missing)
	try { ensureHelper(); } catch { /* will fail later with a clear error */ }

	async function syncFromReminders(): Promise<Todo[]> {
		try {
			todos = await fetchReminders();
		} catch { /* keep local */ }
		return todos;
	}

	// Sync in background on session start (non-blocking)
	pi.on("session_start", async () => { syncFromReminders(); });
	pi.on("session_switch", async () => { syncFromReminders(); });

	// ─── LLM Tool ───────────────────────────────────────────────────────────

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a to-do list synced with Apple Reminders (list 'pi'). Actions: list, add (title, body?, priority?), toggle (id), edit (id, title?, body?, priority?), remove (id), clear. IDs are Apple Reminder IDs.",
		promptSnippet: "Manage todos synced with Apple Reminders",
		promptGuidelines: [
			"Use the todo tool when the user asks about tasks, todos, or reminders.",
			"Always list todos first if you need to reference them by ID.",
			"For adding todos, provide a clear title. Use body for longer descriptions.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			await syncFromReminders();

			switch (params.action) {
				case "list": {
					const open = todos.filter((t) => !t.done);
					const done = todos.filter((t) => t.done);
					let text = "";
					if (todos.length === 0) {
						text = "No todos in the pi list.";
					} else {
						if (open.length > 0) {
							text += "Open:\n";
							text += open.map((t) => {
								let line = `  ○ ${t.title} (id: ${t.id})`;
								if (t.priority !== "none") line += ` [${t.priority}]`;
								if (t.body) line += `\n    ${t.body.split("\n").join("\n    ")}`;
								return line;
							}).join("\n");
						}
						if (done.length > 0) {
							if (open.length > 0) text += "\n\n";
							text += "Completed:\n";
							text += done.map((t) => `  ✓ ${t.title} (id: ${t.id})`).join("\n");
						}
					}
					return {
						content: [{ type: "text", text }],
						details: { action: "list", todos: [...todos] } as TodoDetails,
					};
				}

				case "add": {
					if (!params.title) {
						return {
							content: [{ type: "text", text: "Error: title required for add" }],
							details: { action: "add", todos: [...todos], error: "title required" } as TodoDetails,
						};
					}
					const newTodo = await addReminder(params.title, params.body || "", (params.priority as Todo["priority"]) || "none");
					todos.push(newTodo);
					return {
						content: [{ type: "text", text: `Added todo: ${newTodo.title}${newTodo.body ? ` — ${newTodo.body}` : ""} (id: ${newTodo.id})` }],
						details: { action: "add", todos: [...todos] } as TodoDetails,
					};
				}

				case "toggle": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: { action: "toggle", todos: [...todos], error: "id required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo with id ${params.id} not found` }],
							details: { action: "toggle", todos: [...todos], error: "not found" } as TodoDetails,
						};
					}
					const toggled = await toggleReminder(todo.id);
					todo.done = toggled.done;
					return {
						content: [{ type: "text", text: `Todo "${todo.title}" ${todo.done ? "completed" : "reopened"}` }],
						details: { action: "toggle", todos: [...todos] } as TodoDetails,
					};
				}

				case "edit": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required for edit" }],
							details: { action: "edit", todos: [...todos], error: "id required" } as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo with id ${params.id} not found` }],
							details: { action: "edit", todos: [...todos], error: "not found" } as TodoDetails,
						};
					}
					const updates: any = {};
					if (params.title !== undefined) updates.title = params.title;
					if (params.body !== undefined) updates.body = params.body;
					if (params.priority !== undefined) updates.priority = params.priority;
					const updated = await updateReminder(todo.id, updates);
					todo.title = updated.title;
					todo.body = updated.body;
					todo.priority = updated.priority;
					return {
						content: [{ type: "text", text: `Updated todo: ${todo.title} (id: ${todo.id})` }],
						details: { action: "edit", todos: [...todos] } as TodoDetails,
					};
				}

				case "remove": {
					if (!params.id) {
						return {
							content: [{ type: "text", text: "Error: id required for remove" }],
							details: { action: "remove", todos: [...todos], error: "id required" } as TodoDetails,
						};
					}
					const idx = todos.findIndex((t) => t.id === params.id);
					if (idx === -1) {
						return {
							content: [{ type: "text", text: `Todo with id ${params.id} not found` }],
							details: { action: "remove", todos: [...todos], error: "not found" } as TodoDetails,
						};
					}
					const removed = todos[idx];
					await deleteReminder(removed.id);
					todos.splice(idx, 1);
					return {
						content: [{ type: "text", text: `Removed todo: ${removed.title}` }],
						details: { action: "remove", todos: [...todos] } as TodoDetails,
					};
				}

				case "clear": {
					const count = await deleteAllReminders();
					todos = [];
					return {
						content: [{ type: "text", text: `Cleared ${count} todos from Apple Reminders` }],
						details: { action: "clear", todos: [] } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: { action: "list", todos: [...todos], error: `unknown action` } as TodoDetails,
					};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.title) text += ` ${theme.fg("dim", `"${args.title}"`)}`;
			if (args.id) text += ` ${theme.fg("accent", args.id.slice(-8))}`;
			if (args.priority && args.priority !== "none") text += ` ${theme.fg("warning", `[${args.priority}]`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}
			const todoList = details.todos;
			switch (details.action) {
				case "list": {
					if (todoList.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
					const open = todoList.filter((t) => !t.done);
					const done = todoList.filter((t) => t.done);
					let listText = theme.fg("muted", `${open.length} open, ${done.length} done`);
					if (expanded) {
						for (const t of open) {
							const p = t.priority !== "none" ? theme.fg("warning", ` [${t.priority}]`) : "";
							listText += `\n${theme.fg("dim", "○")} ${theme.fg("text", t.title)}${p}`;
							if (t.body) listText += `\n  ${theme.fg("dim", t.body.split("\n")[0])}`;
						}
						for (const t of done) {
							listText += `\n${theme.fg("success", "✓")} ${theme.fg("dim", t.title)}`;
						}
					}
					return new Text(listText, 0, 0);
				}
				case "add": {
					const added = todoList[todoList.length - 1];
					if (!added) return new Text(theme.fg("success", "✓ Added"), 0, 0);
					const p = added.priority !== "none" ? theme.fg("warning", ` [${added.priority}]`) : "";
					return new Text(theme.fg("success", "✓ Added ") + theme.fg("text", added.title) + p, 0, 0);
				}
				case "toggle":
				case "edit":
				case "remove": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}
				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
				default: {
					const text = result.content[0];
					return new Text(text?.type === "text" ? text.text : "", 0, 0);
				}
			}
		},
	});

	// ─── /todo Command ──────────────────────────────────────────────────────

	pi.registerCommand("todo", {
		description: "View and manage todos (synced with Apple Reminders)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todo requires interactive mode", "error");
				return;
			}

			await syncFromReminders();

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				return createTodoListUI(todos, theme, tui, done, syncFromReminders);
			});
		},
	});
}

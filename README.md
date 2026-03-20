# pi-todo

A [pi](https://github.com/badlogic/pi-mono) extension that gives you a to-do list synced with **Apple Reminders**. The AI can manage your todos via a tool, and you can browse and edit them in an interactive TUI — all changes sync to and from the **"pi"** list in Apple Reminders.

## Installation

### Option 1: Symlink (recommended for development)

```bash
ln -s /path/to/pi-todo ~/.pi/agent/extensions/pi-todo
```

Then start pi normally. The extension is auto-discovered.

### Option 2: Quick test

```bash
pi -e /path/to/pi-todo/index.ts
```

### Option 3: Copy

Copy the `pi-todo` folder into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local).

> After installing via symlink or copy, you can hot-reload with `/reload` — no restart needed.

## Requirements

- **macOS** — uses Apple's Reminders app via a compiled Swift helper (EventKit)
- **Swift** — `swiftc` must be available (ships with Xcode or Xcode Command Line Tools)
- The Swift helper binary (`reminders-helper`) is auto-compiled on first run
- The first time the extension runs it will create a **"pi"** list in Apple Reminders if it doesn't already exist

## Usage

### Ask the AI

Just talk to the AI about your tasks. It has a `todo` tool and knows when to use it.

```
> Add a todo to fix the login bug, high priority
> What's on my todo list?
> Mark the login bug as done
> Add a todo "Refactor auth module" with a description explaining we need to split the middleware
```

### `/todo` command

Type `/todo` to open the interactive TUI:

```
──────────────────────────────────────────
  📋 Todos (1/3 done)

 ▸ ○ Fix login bug !!!
   ○ Refactor auth module …
   ✓ Set up CI pipeline

  ↑↓ navigate • Space toggle • Enter details • a add • d delete • r refresh • Esc close
──────────────────────────────────────────
```

**List mode**

| Key | Action |
|-----|--------|
| `↑` / `k` | Move up |
| `↓` / `j` | Move down |
| `Space` | Toggle done/undone |
| `Enter` | Open detail view |
| `a` | Add a new todo |
| `d` / `Delete` | Delete todo |
| `r` | Refresh from Apple Reminders |
| `Esc` / `q` | Close |

**Detail mode** (press `Enter` on a todo)

| Key | Action |
|-----|--------|
| `Space` / `Enter` | Toggle done/undone |
| `e` | Edit the description (opens multi-line editor) |
| `d` / `Delete` | Delete todo |
| `Esc` / `q` | Back to list |

**Add mode** (press `a` in list view)

1. Type a title, press `Enter`
2. Optionally type a longer description
3. Press `Ctrl+S` to save, or `Esc` to save without a description

**Edit mode** (press `e` in detail view)

A full multi-line text editor for longer descriptions.

| Key | Action |
|-----|--------|
| `Esc` / `Ctrl+S` | Save and go back |

### LLM tool actions

The `todo` tool supports these actions:

| Action | Parameters | Description |
|--------|-----------|-------------|
| `list` | — | Show all todos |
| `add` | `title`, `body?`, `priority?` | Create a new todo |
| `toggle` | `id` | Toggle done/undone |
| `edit` | `id`, `title?`, `body?`, `priority?` | Update a todo |
| `remove` | `id` | Delete a todo |
| `clear` | — | Delete all todos |

Priority levels: `none` (default), `low` (!), `medium` (!!), `high` (!!!)

## Apple Reminders sync

- All todos live in the **"pi"** list in Apple Reminders
- Changes you make in pi show up immediately in Reminders (and on all your iCloud-synced devices)
- Changes you make in the Reminders app show up in pi when you press `r` in the TUI, or when the AI runs `list`
- Priority maps to Apple's system: high → `!!!`, medium → `!!`, low → `!`
- The description field maps to the Reminders "Notes" field

## License

MIT

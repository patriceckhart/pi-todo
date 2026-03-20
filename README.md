# pi-todo

A [pi](https://github.com/badlogic/pi-mono) extension that gives you a to-do list synced with **Apple Reminders**. The AI can manage your todos via a tool, and you can browse and edit them in an interactive TUI — all changes sync to and from the **"pi"** list in Apple Reminders.

## Installation

```bash
pi install npm:@patriceckhart/pi-todo
```

That's it. The extension is auto-discovered on next start or `/reload`.

### Other options

```bash
# Try it without installing
pi -e npm:@patriceckhart/pi-todo

# Install from git
pi install https://github.com/patriceckhart/pi-todo

# Local development
ln -s /path/to/pi-todo ~/.pi/agent/extensions/pi-todo
```

## Requirements

- **macOS** — uses Apple's Reminders app via a compiled Swift helper (EventKit)
- **Swift** — `swiftc` must be available (ships with Xcode or Xcode Command Line Tools)
- The Swift helper binary is auto-compiled on first run
- A **"pi"** list is auto-created in Apple Reminders if it doesn't exist

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

  ↑↓ navigate • x complete • Enter details • a add • d delete • r refresh • Esc close

──────────────────────────────────────────
```

**List mode**

| Key | Action |
|-----|--------|
| `↑` / `k` | Move up |
| `↓` / `j` | Move down |
| `x` / `Space` | Toggle done/undone |
| `Enter` | Open detail view |
| `a` | Add a new todo |
| `d` / `Delete` | Delete todo |
| `r` | Refresh from Apple Reminders |
| `Esc` / `q` | Close |

**Detail mode** (press `Enter` on a todo)

| Key | Action |
|-----|--------|
| `x` / `Space` / `Enter` | Toggle done/undone |
| `e` | Edit the description (opens multi-line editor) |
| `d` / `Delete` | Delete todo |
| `Esc` / `q` | Back to list |

**Add mode** (press `a` in list view)

1. Type a title, press `Enter`
2. Optionally type a longer description
3. Press `Ctrl+S` to save, or `Esc` to save without a description

**Edit mode** (press `e` in detail view)

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

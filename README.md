# Cit Tools

VS Code extension for [cit](https://github.com/daniel-bf/cit) — version control for individual files and config environment management.

## What it does

- **Single-file versioning**: track named snapshots of any file, switch between them from the sidebar
- **Config environment management**: snapshot and restore a whole set of config files at once across named environments (dev, staging, prod)

No git involvement. Nothing is committed unless you choose to.

## Requirements

Install the `cit` CLI first:

```sh
git clone https://github.com/daniel-bf/cit
cd cit
make install
```

The binary must be available on your `PATH` at `/usr/local/bin/cit`.

## Sidebar panels

### Files
Shows all files in your workspace root with their cit tracking status.
- Tracked files appear at the top with a versions icon
- Untracked files show an **Initialize** button
- Right-click a tracked file to Add version or Commit

### Versions
Shows the version history for whatever file is open in your active editor.
- Updates automatically when you switch editor tabs
- Click any version to switch to it instantly
- Right-click a version to remove it
- Toolbar buttons: **Save Version**, **Commit Changes**

### Environments
Shows all saved config environments for the current project.
- Green checkmark on the active environment
- Click any environment to switch all tracked config files at once
- Dirty-file indicator: if any tracked file differs from the current snapshot, a dot appears in the status bar
- Toolbar buttons: **Save Environment**, **Init Environment**, **Refresh**

## Status bar

The status bar shows the current environment and a dot (`●`) when tracked files have unsaved changes:

```
⚙ staging ●
```

Click it to open the environment switcher.

## Commands (Command Palette)

### Single-file versioning

| Command | Description |
|---|---|
| `Cit: Initialize` | Start tracking the active file (creates a baseline version) |
| `Cit: Save Version` | Snapshot the current file state with a name |
| `Cit: Commit Changes` | Update the current version with the file's current content |
| `Cit: Switch Version` | Switch the active file to a different saved version |
| `Cit: Remove Version` | Delete a saved version |
| `Cit: Refresh` | Refresh all panels |

### Environment management

| Command | Description |
|---|---|
| `Cit: Init Environment` | Initialize a `.cit/` environment in the workspace root |
| `Cit: Track File in Environment` | Add a file to the set of tracked config files |
| `Cit: Save Environment` | Snapshot all tracked files as a named environment |
| `Cit: Switch Environment` | Restore all tracked files to a saved environment |
| `Cit: Delete Environment` | Remove a saved environment |

## Workflow example — config environments

```
1. Cit: Init Environment
2. Cit: Track File in Environment  →  pick config/database.yaml
3. Cit: Track File in Environment  →  pick config/redis.yaml
4. Cit: Save Environment           →  name it "dev"
5. Edit configs for staging
6. Cit: Save Environment           →  name it "staging"

Now click "dev" or "staging" in the Environments panel
to switch all config files at once.
```

Environments are stored in `.cit/` in your project root. Gitignore it for local-only configs, or commit it to share environments with your team.

## Known issues

- Only files in the workspace root are shown in the Files panel (no recursive scan yet)
- The `cit` binary must be on PATH; custom install locations are not yet configurable

## Release Notes

### 0.2.0
- Environments panel with atomic multi-file environment switching
- Status bar showing current environment and dirty-file indicator
- Five new env commands: Init, Track, Snapshot, Switch, Delete

### 0.1.0
- Two-panel UI: Files (tracked/untracked status) and Versions (history for active file)
- Version history panel auto-updates when you switch editor tabs
- Uncommitted change detection: warns before discarding on switch
- Remove version with confirmation dialog
- JSON-based communication with cit CLI (no brittle text parsing)

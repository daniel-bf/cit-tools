# Cit Tools

VS Code extension for [cit](https://github.com/daniel-bf/cit) — single-file version control.

## What it does

Track named snapshots of individual files without involving git. Useful for:
- Config files that change between environments (dev, staging, prod)
- Files you want multiple named variants of without cluttering your directory
- Anything where `config.json / config_old.json / config_v2.json` is what you're doing today

## Requirements

Install the `cit` CLI first:

```sh
git clone https://github.com/daniel-bf/cit
cd cit
make install
```

The binary must be on your `PATH` (`/usr/local/bin/cit`).

## How to use

### Files panel
The **Files** panel (Cit sidebar) shows all files in your workspace root.
- Files already tracked by `cit` appear at the top with a versions icon
- Untracked files show an **Initialize** button to start tracking them

### Versions panel
The **Versions** panel shows all saved versions for the file open in your active editor.
- Click a version to switch to it instantly
- Right-click a version to remove it
- Use the toolbar buttons to **Save Version** (snapshot) or **Commit** (update current)

### Commands
All commands are also available via the Command Palette (`Ctrl+Shift+P`):

| Command | Description |
|---|---|
| `Cit: Initialize` | Start tracking the active file |
| `Cit: Save Version` | Snapshot the current file state with a name |
| `Cit: Commit Changes` | Update the current version with unsaved edits |
| `Cit: Switch Version` | Switch active file to a different saved version |
| `Cit: Remove Version` | Delete a saved version |
| `Cit: Refresh` | Refresh the file and version panels |

## Workflow example

```
1. Open database.yaml in your editor
2. Cit: Initialize  →  creates "baseline" version
3. Edit the file for staging
4. Cit: Save Version  →  name it "staging"
5. Edit the file for local dev
6. Cit: Save Version  →  name it "local-dev"

Now you can switch between "baseline", "staging", "local-dev" instantly.
Changes are local — nothing goes to git unless you commit the file itself.
```

## Known issues

- Only files in the workspace root are shown in the Files panel (no recursive scan yet)
- The `cit` binary must be on PATH; custom install locations are not yet configurable

## Release Notes

### 0.1.0
- Two-panel UI: Files (with tracked/untracked status) and Versions (history for active file)
- Version history panel auto-updates when you switch editor tabs
- Uncommitted change detection: warns before discarding changes on switch
- Remove version with confirmation dialog
- JSON-based communication with cit CLI (no brittle text parsing)

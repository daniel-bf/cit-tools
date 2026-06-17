import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';

// ---- Types -----------------------------------------------------------------

interface CitVersion {
  name: string;
  hash: string;
  timestamp: string | null;
  current: boolean;
}

interface CitListResult {
  file: string;
  current_version: string | null;
  versions: CitVersion[];
}

interface CitEnvEntry {
  name: string;
  created_at: string | null;
  file_count: number | null;
  current: boolean;
}

interface CitEnvListResult {
  current_environment: string | null;
  environments: CitEnvEntry[];
}

interface CitEnvStatusResult {
  current_environment: string | null;
  dirty_files: string[];
}

// ---- Version History Tree --------------------------------------------------

class VersionItem extends vscode.TreeItem {
  constructor(
    public readonly version: CitVersion,
    public readonly filePath: string,
  ) {
    super(version.name, vscode.TreeItemCollapsibleState.None);

    const ts = version.timestamp
      ? new Date(version.timestamp).toLocaleString()
      : 'unknown date';
    this.description = `[${version.hash}]  ${ts}`;
    this.tooltip = `${version.name}\n${version.hash}\n${ts}`;
    this.contextValue = version.current ? 'version-current' : 'version';
    this.iconPath = version.current
      ? new vscode.ThemeIcon('check', new vscode.ThemeColor('terminal.ansiGreen'))
      : new vscode.ThemeIcon('git-commit');

    if (!version.current) {
      this.command = {
        command: 'cittools.switch',
        title: 'Switch to version',
        arguments: [filePath, version.name],
      };
    }
  }
}

class VersionTreeProvider implements vscode.TreeDataProvider<VersionItem> {
  private _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  private currentFile: string | null = null;

  setFile(filePath: string | null): void {
    this.currentFile = filePath;
    this._onChange.fire();
  }

  refresh(): void {
    this._onChange.fire();
  }

  getTreeItem(element: VersionItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<VersionItem[]> {
    if (!this.currentFile) {
      return [];
    }
    const result = await runCit([this.currentFile, '--list', '--json']);
    if (!result.success || !result.stdout) {
      return [];
    }
    try {
      const data: CitListResult = JSON.parse(result.stdout);
      return data.versions.map(v => new VersionItem(v, this.currentFile!));
    } catch {
      return [];
    }
  }
}

// ---- Tracked Files Tree ----------------------------------------------------

class FileItem extends vscode.TreeItem {
  constructor(
    public readonly filePath: string,
    public readonly tracked: boolean,
  ) {
    super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = vscode.Uri.file(filePath);
    this.contextValue = tracked ? 'file-tracked' : 'file-untracked';
    this.iconPath = new vscode.ThemeIcon(tracked ? 'versions' : 'file');
    this.tooltip = tracked ? `${filePath} (tracked by cit)` : `${filePath} (not tracked)`;
    this.description = tracked ? undefined : 'not tracked';
    this.command = {
      command: 'cittools.selectFile',
      title: 'Select file',
      arguments: [filePath],
    };
  }
}

class FileTreeProvider implements vscode.TreeDataProvider<FileItem> {
  private _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  constructor(private workspaceRoot: string) {}

  refresh(): void {
    this._onChange.fire();
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<FileItem[]> {
    const files = this.listFiles(this.workspaceRoot);
    const envTracked = getEnvTrackedFiles(this.workspaceRoot);
    const items = files.map(f => {
      const rel = path.relative(this.workspaceRoot, f);
      return new FileItem(f, envTracked.has(rel));
    });
    return items.sort((a, b) => {
      if (a.tracked !== b.tracked) { return a.tracked ? -1 : 1; }
      return a.filePath.localeCompare(b.filePath);
    });
  }

  public listFiles(dir: string): string[] {
    const { readdirSync, statSync } = require('fs') as typeof import('fs');
    try {
      return readdirSync(dir)
        .filter(e => !e.startsWith('.') && e !== 'node_modules')
        .map(e => path.join(dir, e))
        .filter(p => { try { return statSync(p).isFile(); } catch { return false; } });
    } catch {
      return [];
    }
  }
}

// ---- Helpers ---------------------------------------------------------------

// Reads .cit/project.yaml synchronously to get env-tracked files (no subprocess).
function getEnvTrackedFiles(workspaceRoot: string): Set<string> {
  const yamlPath = path.join(workspaceRoot, '.cit', 'project.yaml');
  try {
    const { readFileSync } = require('fs') as typeof import('fs');
    const content = readFileSync(yamlPath, 'utf8');
    const files = new Set<string>();
    let inList = false;
    for (const line of content.split('\n')) {
      if (line.startsWith('tracked_files:')) { inList = true; }
      else if (inList && line.startsWith('  - ')) { files.add(line.slice(4).trim()); }
      else if (inList && line.length > 0 && !line.startsWith(' ')) { break; }
    }
    return files;
  } catch {
    return new Set();
  }
}

function runCit(args: string[]): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    // Quote the first argument (file path) to handle spaces
    const quotedArgs = args.map((a, i) => (i === 0 ? `"${a}"` : a));
    child_process.exec(`cit ${quotedArgs.join(' ')}`, (error, stdout, stderr) => {
      resolve({ success: !error, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// Run cit with a specific working directory (for env subcommands)
function runCitInDir(
  cwd: string,
  args: string[]
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    child_process.exec(`cit ${args.join(' ')}`, { cwd }, (error, stdout, stderr) => {
      resolve({ success: !error, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

function resolveFilePath(item: unknown): string | null {
  if (item instanceof FileItem) { return item.filePath; }
  if (item instanceof vscode.Uri) { return item.fsPath; }
  return vscode.window.activeTextEditor?.document.uri.fsPath ?? null;
}

// ---- Environment Tree ------------------------------------------------------

class EnvItem extends vscode.TreeItem {
  constructor(public readonly env: CitEnvEntry) {
    super(env.name, vscode.TreeItemCollapsibleState.None);

    const ts = env.created_at ? new Date(env.created_at).toLocaleString() : 'unknown';
    const count = env.file_count ?? 0;
    this.description = `[${ts}]  ${count} file(s)`;
    this.tooltip = `${env.name}\nSaved: ${ts}\nFiles: ${count}`;
    this.contextValue = env.current ? 'env-current' : 'env';
    this.iconPath = env.current
      ? new vscode.ThemeIcon('check', new vscode.ThemeColor('terminal.ansiGreen'))
      : new vscode.ThemeIcon('server-environment');

    if (!env.current) {
      this.command = {
        command: 'cittools.envSwitch',
        title: 'Switch to environment',
        arguments: [env.name],
      };
    }
  }
}

class EnvironmentTreeProvider implements vscode.TreeDataProvider<EnvItem> {
  private _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  constructor(private workspaceRoot: string) {}

  refresh(): void {
    this._onChange.fire();
  }

  getTreeItem(element: EnvItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<EnvItem[]> {
    const result = await runCitInDir(this.workspaceRoot, ['env', 'list', '--json']);
    if (!result.success || !result.stdout) {
      return [];
    }
    try {
      const data: CitEnvListResult = JSON.parse(result.stdout);
      return data.environments.map(e => new EnvItem(e));
    } catch {
      return [];
    }
  }
}

// ---- Activation ------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showInformationMessage('Cit-tools: no workspace folder is open.');
    return;
  }

  const versionProvider = new VersionTreeProvider();
  const fileProvider = new FileTreeProvider(workspaceRoot);
  const envProvider = new EnvironmentTreeProvider(workspaceRoot);

  const fileTreeView = vscode.window.createTreeView('cittools.fileTreeView', {
    treeDataProvider: fileProvider,
  });

  const versionTreeView = vscode.window.createTreeView('cittools.versionView', {
    treeDataProvider: versionProvider,
  });

  const envTreeView = vscode.window.createTreeView('cittools.envView', {
    treeDataProvider: envProvider,
  });

  // Status bar: shows current environment
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'cittools.envSwitch';
  statusBar.tooltip = 'Cit environment — click to switch';
  context.subscriptions.push(statusBar);

  async function updateStatusBar() {
    const result = await runCitInDir(workspaceRoot!, ['env', 'status', '--json']);
    if (result.success && result.stdout) {
      try {
        const data: CitEnvStatusResult = JSON.parse(result.stdout);
        const env = data.current_environment ?? 'no env';
        const dirty = data.dirty_files.length > 0 ? ' ●' : '';
        statusBar.text = `$(server-environment) ${env}${dirty}`;
        statusBar.show();
        return;
      } catch { /* fall through */ }
    }
    statusBar.hide();
  }

  updateStatusBar();

  // Auto-refresh Files panel when .cit/project.yaml changes (track/untrack)
  const yamlWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '.cit/project.yaml')
  );
  yamlWatcher.onDidChange(() => fileProvider.refresh());
  yamlWatcher.onDidCreate(() => fileProvider.refresh());

  // Auto-refresh Files panel when files are added or removed from workspace root
  const fsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '*')
  );
  fsWatcher.onDidCreate(() => fileProvider.refresh());
  fsWatcher.onDidDelete(() => fileProvider.refresh());

  context.subscriptions.push(yamlWatcher, fsWatcher);

  // Keep version panel in sync with the active editor
  const editorListener = vscode.window.onDidChangeActiveTextEditor(editor => {
    versionProvider.setFile(editor?.document.uri.fsPath ?? null);
  });

  if (vscode.window.activeTextEditor) {
    versionProvider.setFile(vscode.window.activeTextEditor.document.uri.fsPath);
  }

  // ---- Commands ------------------------------------------------------------

  const selectFileCmd = vscode.commands.registerCommand(
    'cittools.selectFile',
    (filePath: string) => {
      versionProvider.setFile(filePath);
      vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
        .then(doc => vscode.window.showTextDocument(doc));
    }
  );

  const initCmd = vscode.commands.registerCommand(
    'cittools.init',
    async (item?: unknown) => {
      const filePath = resolveFilePath(item);
      if (!filePath) { return; }
      const result = await runCit([filePath, '--init']);
      if (result.success) {
        vscode.window.showInformationMessage(`Cit: initialized '${path.basename(filePath)}'`);
        fileProvider.refresh();
        versionProvider.setFile(filePath);
      } else {
        vscode.window.showErrorMessage(`Cit init failed: ${result.stderr}`);
      }
    }
  );

  const addCmd = vscode.commands.registerCommand(
    'cittools.add',
    async (item?: unknown) => {
      const filePath = resolveFilePath(item);
      if (!filePath) { return; }
      const name = await vscode.window.showInputBox({
        prompt: 'Version name',
        placeHolder: 'e.g. staging, debug, v2',
        validateInput: v => (v ? null : 'Name cannot be empty'),
      });
      if (!name) { return; }
      const result = await runCit([filePath, '--add', name]);
      if (result.success) {
        vscode.window.showInformationMessage(`Cit: saved version '${name}'`);
        versionProvider.refresh();
        fileProvider.refresh();
      } else {
        vscode.window.showErrorMessage(`Cit add failed: ${result.stderr}`);
      }
    }
  );

  const commitCmd = vscode.commands.registerCommand(
    'cittools.commit',
    async (item?: unknown) => {
      const filePath = resolveFilePath(item);
      if (!filePath) { return; }
      const result = await runCit([filePath, '--commit']);
      if (result.success) {
        vscode.window.showInformationMessage('Cit: committed changes to current version');
        versionProvider.refresh();
      } else {
        vscode.window.showErrorMessage(`Cit commit failed: ${result.stderr}`);
      }
    }
  );

  const switchCmd = vscode.commands.registerCommand(
    'cittools.switch',
    async (filePath: string, versionName?: string) => {
      if (!versionName) {
        const listResult = await runCit([filePath, '--list', '--json']);
        if (!listResult.success) {
          vscode.window.showErrorMessage(`Failed to list versions: ${listResult.stderr}`);
          return;
        }
        const data: CitListResult = JSON.parse(listResult.stdout);
        const pick = await vscode.window.showQuickPick(
          data.versions.map(v => ({
            label: v.name,
            description: v.current ? '(current)' : `[${v.hash}]`,
            detail: v.timestamp ? new Date(v.timestamp).toLocaleString() : undefined,
          })),
          { placeHolder: 'Select version to switch to' }
        );
        if (!pick) { return; }
        versionName = pick.label;
      }

      const doSwitch = async (force: boolean) => {
        const args = force
          ? [filePath, '--switch', versionName!, '--force']
          : [filePath, '--switch', versionName!];
        return runCit(args);
      };

      let result = await doSwitch(false);

      if (!result.success && result.stderr.includes('uncommitted')) {
        const choice = await vscode.window.showWarningMessage(
          `'${path.basename(filePath)}' has uncommitted changes. Discard and switch?`,
          'Discard & Switch', 'Cancel'
        );
        if (choice !== 'Discard & Switch') { return; }
        result = await doSwitch(true);
      }

      if (result.success) {
        vscode.window.showInformationMessage(`Cit: switched to '${versionName}'`);
        versionProvider.refresh();
        // Refresh the open editor so it shows the switched content
        await vscode.commands.executeCommand('workbench.action.revertFile');
      } else {
        vscode.window.showErrorMessage(`Cit switch failed: ${result.stderr}`);
      }
    }
  );

  const removeCmd = vscode.commands.registerCommand(
    'cittools.remove',
    async (item?: VersionItem | unknown) => {
      let filePath: string | null;
      let versionName: string | undefined;

      if (item instanceof VersionItem) {
        filePath = item.filePath;
        versionName = item.version.name;
      } else {
        filePath = resolveFilePath(item);
        if (!filePath) { return; }
        const listResult = await runCit([filePath, '--list', '--json']);
        if (!listResult.success) { return; }
        const data: CitListResult = JSON.parse(listResult.stdout);
        const nonCurrent = data.versions.filter(v => !v.current);
        if (!nonCurrent.length) {
          vscode.window.showWarningMessage('No removable versions (cannot remove the current version).');
          return;
        }
        const pick = await vscode.window.showQuickPick(nonCurrent.map(v => v.name), {
          placeHolder: 'Select version to remove',
        });
        if (!pick) { return; }
        versionName = pick;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Remove version '${versionName}'? This cannot be undone.`,
        { modal: true },
        'Remove'
      );
      if (confirmed !== 'Remove') { return; }

      const result = await runCit([filePath, '--remove', versionName!]);
      if (result.success) {
        vscode.window.showInformationMessage(`Cit: removed version '${versionName}'`);
        versionProvider.refresh();
      } else {
        vscode.window.showErrorMessage(`Cit remove failed: ${result.stderr}`);
      }
    }
  );

  const refreshCmd = vscode.commands.registerCommand('cittools.refresh', () => {
    fileProvider.refresh();
    versionProvider.refresh();
    envProvider.refresh();
    updateStatusBar();
  });

  // ---- Environment commands ------------------------------------------------

  const envInitCmd = vscode.commands.registerCommand('cittools.envInit', async () => {
    const result = await runCitInDir(workspaceRoot, ['env', 'init']);
    if (result.success) {
      vscode.window.showInformationMessage('Cit: environment initialized');
      fileProvider.refresh();
      envProvider.refresh();
      updateStatusBar();
    } else {
      vscode.window.showErrorMessage(`Cit env init failed: ${result.stderr}`);
    }
  });

  const envTrackCmd = vscode.commands.registerCommand('cittools.envTrack', async () => {
    const files = fileProvider['listFiles'](workspaceRoot).map(f =>
      path.relative(workspaceRoot, f)
    );
    if (!files.length) {
      vscode.window.showWarningMessage('No files in workspace root to track.');
      return;
    }
    const pick = await vscode.window.showQuickPick(files, {
      placeHolder: 'Select a file to track',
    });
    if (!pick) { return; }
    const result = await runCitInDir(workspaceRoot, ['env', 'track', pick]);
    if (result.success) {
      vscode.window.showInformationMessage(`Cit: tracking '${pick}'`);
      fileProvider.refresh();
      envProvider.refresh();
    } else {
      vscode.window.showErrorMessage(`Cit env track failed: ${result.stderr}`);
    }
  });

  const envSnapshotCmd = vscode.commands.registerCommand('cittools.envSnapshot', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Environment name',
      placeHolder: 'e.g. dev, staging, debug-verbose',
      validateInput: v => (v ? null : 'Name cannot be empty'),
    });
    if (!name) { return; }
    const result = await runCitInDir(workspaceRoot, ['env', 'snapshot', name]);
    if (result.success) {
      vscode.window.showInformationMessage(`Cit: saved environment '${name}'`);
      envProvider.refresh();
      updateStatusBar();
    } else {
      vscode.window.showErrorMessage(`Cit env snapshot failed: ${result.stderr}`);
    }
  });

  const envSwitchCmd = vscode.commands.registerCommand(
    'cittools.envSwitch',
    async (envName?: string) => {
      if (!envName) {
        const listResult = await runCitInDir(workspaceRoot, ['env', 'list', '--json']);
        if (!listResult.success || !listResult.stdout) {
          vscode.window.showErrorMessage('No cit environments found. Run "Cit: Init Environment" first.');
          return;
        }
        const data: CitEnvListResult = JSON.parse(listResult.stdout);
        if (!data.environments.length) {
          vscode.window.showInformationMessage('No environments saved yet. Use "Cit: Save Environment" first.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          data.environments.map(e => ({
            label: e.name,
            description: e.current ? '(current)' : undefined,
            detail: e.created_at ? new Date(e.created_at).toLocaleString() : undefined,
          })),
          { placeHolder: 'Select environment to switch to' }
        );
        if (!pick) { return; }
        envName = pick.label;
      }

      const doSwitch = async (force: boolean) =>
        runCitInDir(workspaceRoot, force
          ? ['env', 'switch', envName!, '--force']
          : ['env', 'switch', envName!]
        );

      let result = await doSwitch(false);

      if (!result.success && (result.stderr.includes('unsaved') || result.stderr.includes('uncommitted'))) {
        const choice = await vscode.window.showWarningMessage(
          `Some tracked files have unsaved changes. Discard and switch to '${envName}'?`,
          'Discard & Switch', 'Cancel'
        );
        if (choice !== 'Discard & Switch') { return; }
        result = await doSwitch(true);
      }

      if (result.success) {
        vscode.window.showInformationMessage(`Cit: switched to environment '${envName}'`);
        envProvider.refresh();
        updateStatusBar();
        // Reload any open editors that may have been changed by the switch
        await vscode.commands.executeCommand('workbench.action.revertFile');
      } else {
        vscode.window.showErrorMessage(`Cit env switch failed: ${result.stderr}`);
      }
    }
  );

  const envDeleteCmd = vscode.commands.registerCommand(
    'cittools.envDelete',
    async (item?: EnvItem) => {
      let envName: string | undefined = item?.env.name;

      if (!envName) {
        const listResult = await runCitInDir(workspaceRoot, ['env', 'list', '--json']);
        if (!listResult.success || !listResult.stdout) { return; }
        const data: CitEnvListResult = JSON.parse(listResult.stdout);
        const nonCurrent = data.environments.filter(e => !e.current);
        if (!nonCurrent.length) {
          vscode.window.showWarningMessage('No removable environments (cannot delete the current one).');
          return;
        }
        const pick = await vscode.window.showQuickPick(nonCurrent.map(e => e.name), {
          placeHolder: 'Select environment to delete',
        });
        if (!pick) { return; }
        envName = pick;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Delete environment '${envName}'? This cannot be undone.`,
        { modal: true },
        'Delete'
      );
      if (confirmed !== 'Delete') { return; }

      const result = await runCitInDir(workspaceRoot, ['env', 'delete', envName]);
      if (result.success) {
        vscode.window.showInformationMessage(`Cit: deleted environment '${envName}'`);
        envProvider.refresh();
        updateStatusBar();
      } else {
        vscode.window.showErrorMessage(`Cit env delete failed: ${result.stderr}`);
      }
    }
  );

  context.subscriptions.push(
    fileTreeView, versionTreeView, envTreeView, editorListener,
    selectFileCmd, initCmd, addCmd, commitCmd, switchCmd, removeCmd, refreshCmd,
    envInitCmd, envTrackCmd, envSnapshotCmd, envSwitchCmd, envDeleteCmd,
  );
}

export function deactivate() {}

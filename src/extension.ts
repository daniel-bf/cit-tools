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

// ---- Helpers ---------------------------------------------------------------

function relativeTime(isoStr: string | null): string {
  if (!isoStr) { return 'unknown'; }
  const ms = Date.now() - new Date(isoStr).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) { return 'just now'; }
  const min = Math.floor(sec / 60);
  if (min < 60) { return `${min}min ago`; }
  const hr = Math.floor(min / 60);
  if (hr < 24) { return `${hr}hr ago`; }
  return `${Math.floor(hr / 24)}d ago`;
}

// Reads .cit/project.yaml synchronously to get env-tracked files.
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
    const quotedArgs = args.map((a, i) => (i === 0 ? `"${a}"` : a));
    child_process.exec(`cit ${quotedArgs.join(' ')}`, (error, stdout, stderr) => {
      resolve({ success: !error, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

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

// Reload all open editors that are showing tracked files, then restore focus.
async function reloadTrackedEditors(workspaceRoot: string): Promise<void> {
  const trackedRels = [...getEnvTrackedFiles(workspaceRoot)];
  if (trackedRels.length === 0) { return; }
  const trackedAbs = new Set(trackedRels.map(rel => path.join(workspaceRoot, rel)));
  const originalActive = vscode.window.activeTextEditor;

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText && trackedAbs.has(input.uri.fsPath)) {
        await vscode.window.showTextDocument(input.uri, {
          viewColumn: group.viewColumn,
          preview: false,
          preserveFocus: false,
        });
        await vscode.commands.executeCommand('workbench.action.revertFile');
      }
    }
  }

  if (originalActive) {
    await vscode.window.showTextDocument(originalActive.document, {
      viewColumn: originalActive.viewColumn,
      preview: false,
    });
  }
}

// ---- Version History Tree --------------------------------------------------

class VersionItem extends vscode.TreeItem {
  constructor(
    public readonly version: CitVersion,
    public readonly filePath: string,
  ) {
    super(version.name, vscode.TreeItemCollapsibleState.None);

    const ts = version.timestamp ? relativeTime(version.timestamp) : 'unknown';
    this.description = `[${version.hash.slice(0, 7)}]  ${ts}`;
    this.tooltip = `${version.name}\n${version.hash}\n${version.timestamp ? new Date(version.timestamp).toLocaleString() : ''}`;
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

  refresh(): void { this._onChange.fire(); }

  getTreeItem(element: VersionItem): vscode.TreeItem { return element; }

  async getChildren(): Promise<VersionItem[]> {
    if (!this.currentFile) { return []; }
    const result = await runCit([this.currentFile, '--list', '--json']);
    if (!result.success || !result.stdout) { return []; }
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
    public readonly dirty: boolean = false,
  ) {
    super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = vscode.Uri.file(filePath);
    this.contextValue = tracked ? 'file-tracked' : 'file-untracked';

    if (dirty) {
      this.iconPath = new vscode.ThemeIcon(
        'circle-filled',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
      );
      this.description = 'modified';
      this.tooltip = `${filePath}\nModified — differs from current environment snapshot`;
    } else if (tracked) {
      this.iconPath = new vscode.ThemeIcon('versions');
      this.description = undefined;
      this.tooltip = `${filePath} (tracked)`;
    } else {
      this.iconPath = new vscode.ThemeIcon('file');
      this.description = 'not tracked';
      this.tooltip = filePath;
    }

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
  public showAll = false;

  constructor(private workspaceRoot: string) {}

  refresh(): void { this._onChange.fire(); }

  getTreeItem(element: FileItem): vscode.TreeItem { return element; }

  async getChildren(): Promise<FileItem[]> {
    const envTracked = getEnvTrackedFiles(this.workspaceRoot);

    let dirtyFiles = new Set<string>();
    if (envTracked.size > 0) {
      const result = await runCitInDir(this.workspaceRoot, ['env', 'status', '--json']);
      if (result.success && result.stdout) {
        try {
          const data: CitEnvStatusResult = JSON.parse(result.stdout);
          dirtyFiles = new Set(data.dirty_files);
        } catch { /* no env initialized yet */ }
      }
    }

    if (this.showAll) {
      const files = this.listFiles(this.workspaceRoot);
      return files
        .map(f => {
          const rel = path.relative(this.workspaceRoot, f);
          return new FileItem(f, envTracked.has(rel), dirtyFiles.has(rel));
        })
        .sort((a, b) => {
          if (a.tracked !== b.tracked) { return a.tracked ? -1 : 1; }
          if (a.dirty !== b.dirty) { return a.dirty ? -1 : 1; }
          return a.filePath.localeCompare(b.filePath);
        });
    }

    // Tracked-only mode (default)
    return [...envTracked]
      .map(rel => new FileItem(path.join(this.workspaceRoot, rel), true, dirtyFiles.has(rel)))
      .sort((a, b) => {
        if (a.dirty !== b.dirty) { return a.dirty ? -1 : 1; }
        return a.filePath.localeCompare(b.filePath);
      });
  }

  public listFiles(dir: string): string[] {
    const { readdirSync, statSync } = require('fs') as typeof import('fs');
    try {
      return readdirSync(dir)
        .filter((e: string) => !e.startsWith('.') && e !== 'node_modules')
        .map((e: string) => path.join(dir, e))
        .filter((p: string) => { try { return statSync(p).isFile(); } catch { return false; } });
    } catch {
      return [];
    }
  }
}

// ---- Environment Tree ------------------------------------------------------

class EnvFileItem extends vscode.TreeItem {
  constructor(
    public readonly rel: string,
    public readonly dirty: boolean,
    public readonly isCurrent: boolean,
  ) {
    super(rel, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'env-file';

    if (!isCurrent) {
      this.iconPath = new vscode.ThemeIcon('file');
      this.description = undefined;
    } else if (dirty) {
      this.iconPath = new vscode.ThemeIcon(
        'circle-filled',
        new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
      );
      this.description = 'modified';
      this.tooltip = `${rel} — modified since last snapshot`;
    } else {
      this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('terminal.ansiGreen'));
      this.description = 'clean';
      this.tooltip = `${rel} — matches snapshot`;
    }
  }
}

class EnvItem extends vscode.TreeItem {
  constructor(public readonly env: CitEnvEntry) {
    super(env.name, vscode.TreeItemCollapsibleState.Collapsed);

    const ts = relativeTime(env.created_at);
    const count = env.file_count ?? 0;
    this.description = `${ts}  ·  ${count} file(s)`;
    this.tooltip = `${env.name}\nSaved: ${env.created_at ? new Date(env.created_at).toLocaleString() : 'unknown'}\nFiles: ${count}`;
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

class EnvironmentTreeProvider implements vscode.TreeDataProvider<EnvItem | EnvFileItem> {
  private _onChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onChange.event;

  constructor(private workspaceRoot: string) {}

  refresh(): void { this._onChange.fire(); }

  getTreeItem(element: EnvItem | EnvFileItem): vscode.TreeItem { return element; }

  async getChildren(element?: EnvItem | EnvFileItem): Promise<(EnvItem | EnvFileItem)[]> {
    if (!element) {
      // Root: return environment list
      const result = await runCitInDir(this.workspaceRoot, ['env', 'list', '--json']);
      if (!result.success || !result.stdout) { return []; }
      try {
        const data: CitEnvListResult = JSON.parse(result.stdout);
        return data.environments.map(e => new EnvItem(e));
      } catch {
        return [];
      }
    }

    if (element instanceof EnvItem) {
      // Child: return tracked files for this environment
      const trackedFiles = [...getEnvTrackedFiles(this.workspaceRoot)];
      if (trackedFiles.length === 0) { return []; }

      let dirtyFiles = new Set<string>();
      if (element.env.current) {
        const statusResult = await runCitInDir(this.workspaceRoot, ['env', 'status', '--json']);
        if (statusResult.success && statusResult.stdout) {
          try {
            const data: CitEnvStatusResult = JSON.parse(statusResult.stdout);
            dirtyFiles = new Set(data.dirty_files);
          } catch { /* ignore */ }
        }
      }

      return trackedFiles.map(rel => new EnvFileItem(rel, dirtyFiles.has(rel), element.env.current));
    }

    return [];
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

  // Status bar: shows current environment + dirty indicator
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

  // Auto-refresh Files panel when .cit/project.yaml changes
  const yamlWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '.cit/project.yaml')
  );
  yamlWatcher.onDidChange(() => fileProvider.refresh());
  yamlWatcher.onDidCreate(() => fileProvider.refresh());

  // Auto-refresh Files panel when files are added/removed from workspace root
  const fsWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '*')
  );
  fsWatcher.onDidCreate(() => fileProvider.refresh());
  fsWatcher.onDidDelete(() => fileProvider.refresh());

  context.subscriptions.push(yamlWatcher, fsWatcher);

  // Update status bar when a tracked config file is saved
  const saveListener = vscode.workspace.onDidSaveTextDocument(doc => {
    const rel = path.relative(workspaceRoot!, doc.uri.fsPath);
    if (getEnvTrackedFiles(workspaceRoot!).has(rel)) {
      updateStatusBar();
      fileProvider.refresh();
    }
  });
  context.subscriptions.push(saveListener);

  // Keep version panel in sync with active editor
  const editorListener = vscode.window.onDidChangeActiveTextEditor(editor => {
    versionProvider.setFile(editor?.document.uri.fsPath ?? null);
  });
  context.subscriptions.push(editorListener);

  if (vscode.window.activeTextEditor) {
    versionProvider.setFile(vscode.window.activeTextEditor.document.uri.fsPath);
  }

  // ---- Commands -------------------------------------------------------------

  const selectFileCmd = vscode.commands.registerCommand(
    'cittools.selectFile',
    (filePath: string) => {
      versionProvider.setFile(filePath);
      vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
        .then(doc => vscode.window.showTextDocument(doc));
    }
  );

  const setShowAll = (value: boolean) => {
    fileProvider.showAll = value;
    vscode.commands.executeCommand('setContext', 'cit.showAllFiles', value);
    fileProvider.refresh();
  };

  const showAllFilesCmd = vscode.commands.registerCommand('cittools.showAllFiles', () => setShowAll(true));
  const showTrackedOnlyCmd = vscode.commands.registerCommand('cittools.showTrackedOnly', () => setShowAll(false));
  const toggleFileViewCmd = vscode.commands.registerCommand('cittools.toggleFileView', () => setShowAll(!fileProvider.showAll));

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
            description: v.current ? '(current)' : `[${v.hash.slice(0, 7)}]`,
            detail: v.timestamp ? relativeTime(v.timestamp) : undefined,
          })),
          { placeHolder: 'Select version to switch to' }
        );
        if (!pick) { return; }
        versionName = pick.label;
      }

      const doSwitch = (force: boolean) =>
        runCit(force
          ? [filePath, '--switch', versionName!, '--force']
          : [filePath, '--switch', versionName!]);

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

      const result = await runCit([filePath!, '--remove', versionName!]);
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

  // ---- Environment commands -------------------------------------------------

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
    const files = fileProvider.listFiles(workspaceRoot).map(f =>
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

  const envUntrackCmd = vscode.commands.registerCommand(
    'cittools.envUntrack',
    async (item?: FileItem) => {
      let relMut: string | undefined;

      if (item instanceof FileItem) {
        relMut = path.relative(workspaceRoot, item.filePath);
      } else {
        const tracked = [...getEnvTrackedFiles(workspaceRoot)];
        if (!tracked.length) {
          vscode.window.showWarningMessage('No files are currently tracked.');
          return;
        }
        relMut = await vscode.window.showQuickPick(tracked, {
          placeHolder: 'Select a file to untrack',
        });
        if (!relMut) { return; }
      }

      // Capture in const so TypeScript keeps the string narrowing across subsequent awaits
      const rel: string = relMut;

      const confirmed = await vscode.window.showWarningMessage(
        `Untrack '${rel}' from the environment? Existing snapshots are not affected.`,
        { modal: true },
        'Untrack'
      );
      if (confirmed !== 'Untrack') { return; }

      const result = await runCitInDir(workspaceRoot, ['env', 'untrack', rel]);
      if (result.success) {
        vscode.window.showInformationMessage(`Cit: untracked '${rel}'`);
        fileProvider.refresh();
        envProvider.refresh();
      } else {
        vscode.window.showErrorMessage(`Cit env untrack failed: ${result.stderr}`);
      }
    }
  );

  const envSnapshotCmd = vscode.commands.registerCommand('cittools.envSnapshot', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Environment name',
      placeHolder: 'e.g. dev, staging, debug-verbose',
      validateInput: v => (v ? null : 'Name cannot be empty'),
    });
    if (!name) { return; }

    // Check if name already exists
    const listResult = await runCitInDir(workspaceRoot, ['env', 'list', '--json']);
    let exists = false;
    if (listResult.success && listResult.stdout) {
      try {
        const data: CitEnvListResult = JSON.parse(listResult.stdout);
        exists = data.environments.some(e => e.name === name);
      } catch { /* ignore */ }
    }

    const args = exists ? ['env', 'snapshot', name, '--overwrite'] : ['env', 'snapshot', name];
    const result = await runCitInDir(workspaceRoot, args);
    if (result.success) {
      vscode.window.showInformationMessage(`Cit: saved environment '${name}'`);
      envProvider.refresh();
      updateStatusBar();
    } else {
      vscode.window.showErrorMessage(`Cit env snapshot failed: ${result.stderr}`);
    }
  });

  const envRenameCmd = vscode.commands.registerCommand(
    'cittools.envRename',
    async (item?: EnvItem) => {
      let oldName: string | undefined = item?.env.name;

      if (!oldName) {
        const listResult = await runCitInDir(workspaceRoot, ['env', 'list', '--json']);
        if (!listResult.success || !listResult.stdout) { return; }
        const data: CitEnvListResult = JSON.parse(listResult.stdout);
        if (!data.environments.length) { return; }
        oldName = await vscode.window.showQuickPick(data.environments.map(e => e.name), {
          placeHolder: 'Select environment to rename',
        });
        if (!oldName) { return; }
      }

      const newName = await vscode.window.showInputBox({
        prompt: `Rename '${oldName}' to`,
        value: oldName,
        validateInput: v => (v && v !== oldName ? null : 'Enter a different name'),
      });
      if (!newName) { return; }

      const result = await runCitInDir(workspaceRoot, ['env', 'rename', oldName, newName]);
      if (result.success) {
        vscode.window.showInformationMessage(`Cit: renamed '${oldName}' → '${newName}'`);
        envProvider.refresh();
        updateStatusBar();
      } else {
        vscode.window.showErrorMessage(`Cit env rename failed: ${result.stderr}`);
      }
    }
  );

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
            detail: e.created_at ? relativeTime(e.created_at) : undefined,
          })),
          { placeHolder: 'Select environment to switch to' }
        );
        if (!pick) { return; }
        envName = pick.label;
      }

      const doSwitch = (force: boolean) =>
        runCitInDir(workspaceRoot, force
          ? ['env', 'switch', envName!, '--force']
          : ['env', 'switch', envName!]);

      let result = await doSwitch(false);

      if (!result.success && (result.stderr.includes('unsaved') || result.stderr.includes('uncommitted'))) {
        const choice = await vscode.window.showWarningMessage(
          `Some tracked files have unsaved changes.`,
          { modal: true },
          'Save as new environment...', 'Discard & Switch'
        );

        if (choice === 'Save as new environment...') {
          const saveName = await vscode.window.showInputBox({
            prompt: 'Save current state as environment',
            placeHolder: 'e.g. dev-experiment, wip',
            validateInput: v => (v ? null : 'Name cannot be empty'),
          });
          if (!saveName) { return; }
          const saveResult = await runCitInDir(workspaceRoot, ['env', 'snapshot', saveName]);
          if (!saveResult.success) {
            vscode.window.showErrorMessage(`Failed to save: ${saveResult.stderr}`);
            return;
          }
          vscode.window.showInformationMessage(`Cit: saved '${saveName}'`);
          result = await doSwitch(false);
        } else if (choice === 'Discard & Switch') {
          result = await doSwitch(true);
        } else {
          return;
        }
      }

      if (result.success) {
        vscode.window.showInformationMessage(`Cit: switched to environment '${envName}'`);
        envProvider.refresh();
        fileProvider.refresh();
        updateStatusBar();
        await reloadTrackedEditors(workspaceRoot);
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
        envName = await vscode.window.showQuickPick(nonCurrent.map(e => e.name), {
          placeHolder: 'Select environment to delete',
        });
        if (!envName) { return; }
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
    fileTreeView, versionTreeView, envTreeView,
    selectFileCmd, showAllFilesCmd, showTrackedOnlyCmd, toggleFileViewCmd,
    initCmd, addCmd, commitCmd, switchCmd, removeCmd, refreshCmd,
    envInitCmd, envTrackCmd, envUntrackCmd, envSnapshotCmd, envRenameCmd, envSwitchCmd, envDeleteCmd,
  );
}

export function deactivate() {}

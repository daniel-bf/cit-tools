import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';

class FileTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<void | vscode.TreeItem | null | undefined> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<void | vscode.TreeItem | null | undefined> = this._onDidChangeTreeData.event;

  constructor(private workspaceRoot: string) {}

  // Returns tree item for a given element
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  // Returns the children of a given element (files/subdirectories)
  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      return this.getFilesInDirectory(this.workspaceRoot);
    }

    if (element.collapsibleState === vscode.TreeItemCollapsibleState.Collapsed) {
      return this.getFilesInDirectory(element.resourceUri?.fsPath || '');
    }

    return [];
  }

  private async getFilesInDirectory(directory: string): Promise<vscode.TreeItem[]> {
    const files = await this.readDirectory(directory);
    return files.map(file => this.createTreeItem(file, directory));
  }

  private async readDirectory(directory: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      fs.readdir(directory, (err, files) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(files);
      });
    });
  }

  private createTreeItem(fileName: string, directory: string): vscode.TreeItem {
    const fullPath = path.join(directory, fileName);
    const stat = fs.statSync(fullPath);

    const treeItem = new vscode.TreeItem(
      fullPath,
      stat.isDirectory() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    if (!stat.isDirectory()) {
      treeItem.label = fileName;
      treeItem.contextValue = 'file';
      treeItem.command = {
        command: 'cittools.openFile',
        title: 'Open File',
        arguments: [vscode.Uri.file(fullPath)]
      };
    } else {
      treeItem.label = fileName;
      treeItem.contextValue = 'directory';
    }

    treeItem.resourceUri = vscode.Uri.file(fullPath);
    
    treeItem.iconPath = stat.isDirectory() 
      ? new vscode.ThemeIcon('folder')
      : new vscode.ThemeIcon('file');

    return treeItem;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}




export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.rootPath || '';
  
  if (!workspaceRoot) {
    vscode.window.showInformationMessage('No workspace is open');
    return;
  }

  const treeDataProvider = new FileTreeDataProvider(workspaceRoot);
  const fileTreeView = vscode.window.createTreeView('cittools.fileTreeView', {
    treeDataProvider: treeDataProvider,
  });

  // Register commands for each context menu item
  const commitCommand = vscode.commands.registerCommand('cittools.commit', (item: vscode.TreeItem) => {
    if (!item.resourceUri) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }
    vscode.window.showInformationMessage(`Commit selected file: ${item.resourceUri.fsPath}`);
    runGitCommand(item.resourceUri, `cit ${item.resourceUri.fsPath} --commit`);
  });

  const switchCommand = vscode.commands.registerCommand('cittools.switch', (item: vscode.TreeItem) => {
    if (!item.resourceUri) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }
    vscode.window.showInformationMessage(`Switch selected file: ${item.resourceUri.fsPath}`);
    runGitCommand(item.resourceUri, `cit ${item.resourceUri.fsPath} --switch`);
  });

  const addCommand = vscode.commands.registerCommand('cittools.add', (item: vscode.TreeItem) => {
    if (!item.resourceUri) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }
    vscode.window.showInformationMessage(`Adding version for file: ${item.resourceUri.fsPath}`);
    // Implement your add logic here
    runGitCommand(item.resourceUri, `cit ${item.resourceUri.fsPath} --add`);
  });
  
  const initCommand = vscode.commands.registerCommand('cittools.init', (item: vscode.TreeItem) => {
    if (!item.resourceUri) {
      vscode.window.showErrorMessage('No file selected');
      return;
    }
    vscode.window.showInformationMessage(`Initializing cit for: ${item.resourceUri.fsPath}`);
    // Implement your add logic here (e.g., staging the file in Git)
    runGitCommand(item.resourceUri, `cit ${item.resourceUri.fsPath} --init`);
  });

  const openFileCommand = vscode.commands.registerCommand('cittools.openFile', (uri: vscode.Uri) => {
    vscode.workspace.openTextDocument(uri).then(doc => {
      vscode.window.showTextDocument(doc);
    });
  });

  context.subscriptions.push(commitCommand);
  context.subscriptions.push(switchCommand);
  context.subscriptions.push(addCommand);
  context.subscriptions.push(initCommand);
  context.subscriptions.push(openFileCommand);
  context.subscriptions.push(fileTreeView);
}

// Helper function to run git commands
async function runGitCommand(uri: vscode.Uri, command: string) {


  // Add version  if command is add
  if(command.includes('add')){
    const versionName = await vscode.window.showInputBox({
      prompt: 'Enter new version name',
      placeHolder: 'version_name'
    });
    
    if (!versionName) {
      vscode.window.showWarningMessage('Adding version cancelled - no version name provided');
      return;
    }
    
    command = command + ` ${versionName}`;
  }

  // select from list of versions if command is switch
  if(command.includes('switch')){
    // Get list of versions
    const versions = await new Promise<string[]>((resolve, reject) => {
      const listCommand = `cit ${uri.fsPath} --list`;
      const cp = require('child_process');
      cp.exec(listCommand, { cwd: vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath }, (error: any, stdout: string, stderr: string) => {
        if (error) {
          reject(error);
          return;
        }
        // Split output into array and remove empty lines
        const versions = stdout.split('\n').filter(v => v.trim());
        resolve(versions);
      });
    });

	// takes all elements except first two
	let versions_names = versions.slice(2);
    //get only version name  splited by :
	versions_names = versions_names.map(versions_names => versions_names.split(':')[0].trim());
	
	if (!versions_names.length) {
      vscode.window.showWarningMessage('No versions available for this file');
      return;
    }

    const versionName = await vscode.window.showQuickPick(versions_names, {
      placeHolder: 'Select version to switch to'
    });
    
    if (!versionName) {
      vscode.window.showWarningMessage('Switch cancelled - no version selected');
      return;
    }
    
    command = command + ` ${versionName}`;
  }


  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
  }

  const cp = require('child_process');
  try {
      cp.exec(command, { cwd: workspaceFolder.uri.fsPath }, (error: any, stdout: string, stderr: string) => {
          if (error) {
              vscode.window.showErrorMessage(`Error: ${error.message}`);
              return;
          }
          if (stderr) {
              vscode.window.showErrorMessage(`Error: ${stderr}`);
              return;
          }
          vscode.window.showInformationMessage(`Success: ${stdout}`);
      });
  } catch (error) {
      vscode.window.showErrorMessage(`Failed to execute command: ${error}`);
  }
}

export function deactivate() {}




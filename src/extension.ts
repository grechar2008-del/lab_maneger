import * as vscode from 'vscode';
import { ProjectManager } from './projectManager';
import { ProjectTreeProvider, type ProjectTreeNode } from './projectTree';

/** Создаёт дерево и регистрирует команды расширения. */
export function activate(context: vscode.ExtensionContext): void {
    const tree = new ProjectTreeProvider();
    const manager = new ProjectManager(context, tree);
    const view = vscode.window.createTreeView('labManager.projects', {
        treeDataProvider: tree,
        showCollapseAll: true
    });

    context.subscriptions.push(tree, view);
    context.subscriptions.push(tree.onDidChangeTreeData(() => {
        view.description = tree.getOnlyUnsubmitted() ? 'Только несданные' : 'Все';
    }));
    const commands: Array<[string, (node?: ProjectTreeNode) => void | Promise<void>]> = [
        ['addProject', () => manager.add()],
        ['showProjects', () => manager.open()],
        ['openProject', (node) => manager.open(node)],
        ['editProject', (node) => manager.edit(node)],
        ['changeProjectPath', (node) => manager.changePath(node)],
        ['deleteProject', (node) => manager.remove(node)],
        ['refreshProjects', () => manager.refresh()],
        ['changeStatus', (node) => manager.changeStatus(node)],
        ['toggleUnsubmitted', () => manager.toggleFilter()],
        ['addMaterial', (node) => manager.addMaterial(node)],
        ['openMaterial', (node) => manager.openMaterial(node)],
        ['changeMaterialPath', (node) => manager.changeMaterialPath(node)],
        ['removeMaterial', (node) => manager.removeMaterial(node)]
    ];

    for (const [name, action] of commands) {
        context.subscriptions.push(vscode.commands.registerCommand(
            `lab-maneger.${name}`,
            (node?: ProjectTreeNode) => manager.run(() => action(node))
        ));
    }
    void manager.run(() => manager.refresh());
}

/** Ресурсы освобождаются автоматически через context.subscriptions. */
export function deactivate(): void {}

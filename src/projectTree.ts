import * as vscode from 'vscode';
import { STATUS_INFO, type ProjectMaterial, type StudyProject } from './project';

/** Уровни дерева: предмет, проект, прикреплённый материал. */
export type ProjectTreeNode =
    | { kind: 'subject'; subject: string }
    | { kind: 'project'; project: StudyProject }
    | { kind: 'material'; projectId: string; material: ProjectMaterial };

/** Дерево проектов с фильтром несданных и вложенными материалами. */
export class ProjectTreeProvider implements vscode.TreeDataProvider<ProjectTreeNode>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<ProjectTreeNode | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;
    private projects: StudyProject[] = [];
    private onlyUnsubmitted = false;

    /** Обновляет содержимое, сохраняя выбранный фильтр. */
    setProjects(projects: StudyProject[]): void {
        this.projects = projects;
        this.emitter.fire(undefined);
    }

    /** Включает или отключает фильтрацию сданных работ. */
    setOnlyUnsubmitted(value: boolean): void {
        this.onlyUnsubmitted = value;
        this.emitter.fire(undefined);
    }

    /** Возвращает текущий режим фильтрации. */
    getOnlyUnsubmitted(): boolean {
        return this.onlyUnsubmitted;
    }

    /** Возвращает видимые предметы, проекты или материалы. */
    getChildren(element?: ProjectTreeNode): ProjectTreeNode[] {
        const visible = this.projects.filter((project) => !this.onlyUnsubmitted || project.status !== 'submitted');
        if (!element) {
            return [...new Set(visible.map((project) => project.subject))]
                .sort((a, b) => a.localeCompare(b, 'ru'))
                .map((subject) => ({ kind: 'subject', subject }));
        }
        if (element.kind === 'material') { return []; }
        if (element.kind === 'project') {
            const project = this.projects.find((item) => item.id === element.project.id);
            return (project?.materials ?? []).map((material) => ({
                kind: 'material', projectId: element.project.id, material
            }));
        }
        return visible
            .filter((project) => project.subject === element.subject)
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
            .map((project) => ({ kind: 'project', project }));
    }

    /** Настраивает подписи, контекстные меню, раскрытие и открытие элементов. */
    getTreeItem(element: ProjectTreeNode): vscode.TreeItem {
        if (element.kind === 'subject') {
            const item = new vscode.TreeItem(element.subject, vscode.TreeItemCollapsibleState.Expanded);
            item.id = `subject:${element.subject}`;
            item.iconPath = new vscode.ThemeIcon('book');
            return item;
        }
        if (element.kind === 'material') {
            const material = element.material;
            const item = new vscode.TreeItem(material.label, vscode.TreeItemCollapsibleState.None);
            item.id = `material:${element.projectId}:${material.id}`;
            item.description = material.kind === 'file' ? 'Файл' : 'Ссылка';
            item.tooltip = material.target;
            item.contextValue = material.kind === 'file' ? 'labMaterialFile' : 'labMaterialLink';
            item.iconPath = new vscode.ThemeIcon(material.kind === 'file' ? 'file' : 'link-external');
            item.command = {
                command: 'lab-maneger.openMaterial', title: 'Открыть материал', arguments: [element]
            };
            return item;
        }
        const project = element.project;
        const status = STATUS_INFO[project.status];
        const item = new vscode.TreeItem(project.name, project.materials.length
            ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = project.id;
        item.description = status.label;
        item.tooltip = `${project.name}\n${project.subject}\nСтатус: ${status.label}\n${project.path}`;
        item.iconPath = new vscode.ThemeIcon(status.icon);
        item.contextValue = 'labProject';
        // Для проекта с материалами нажатие раскрывает материалы. Код открывается через ПКМ.
        if (project.materials.length === 0) {
            item.command = { command: 'lab-maneger.openProject', title: 'Открыть проект', arguments: [element] };
        }
        return item;
    }

    /** Освобождает обработчики событий. */
    dispose(): void { this.emitter.dispose(); }
}

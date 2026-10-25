import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { STATUS_INFO, type ProjectMaterial, type ProjectStatus, type StudyProject } from './project';
import { getProjects, saveProjects } from './projectStorage';
import { ProjectTreeProvider, type ProjectTreeNode } from './projectTree';

/** Управляет командами, диалогами и изменениями списка проектов. */
export class ProjectManager {
    // Одна изменяющая операция за раз в текущем окне расширения.
    private busy = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly tree: ProjectTreeProvider
    ) { }

    /** Читает данные в дерево. Вызывается также при ручном обновлении. */
    refresh(): void {
        this.tree.setOnlyUnsubmitted(this.context.globalState.get<boolean>('labManager.onlyUnsubmitted', false));
        this.tree.setProjects(getProjects(this.context.globalState));
    }

    /** Показывает ошибку команды, не оставляя отклонённый Promise без обработки. */
    async run(action: () => void | Promise<void>): Promise<void> {
        try {
            await action();
        } catch (error) {
            console.error('Lab Manager:', error);
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Lab Manager: ${message}`);
        }
    }

    /** Запрещает пересекающиеся диалоги изменения данных в одном окне. */
    private async change(action: () => Promise<void>): Promise<void> {
        if (this.busy) {
            void vscode.window.showWarningMessage('Сначала заверши текущую операцию Lab Manager.');
            return;
        }
        this.busy = true;
        try {
            await action();
        } finally {
            this.busy = false;
        }
    }

    /** Проверяет возможность прочитать папку, а не произвольный файл. */
    private async ensureDirectory(folderPath: string): Promise<void> {
        let info: vscode.FileStat;
        try {
            info = await vscode.workspace.fs.stat(vscode.Uri.file(folderPath));
        } catch {
            throw new Error('Папка недоступна: она могла быть перемещена, удалена или закрыта правами доступа.');
        }
        if ((info.type & vscode.FileType.Directory) === 0) {
            throw new Error('Выбранный путь не указывает на папку.');
        }
    }

    /** Нормализует путь. Для существующих папок учитывает символические ссылки. */
    private async pathKey(folderPath: string): Promise<string> {
        let resolved = path.resolve(folderPath);
        try {
            resolved = await realpath(resolved);
        } catch {
            // Недоступная старая запись всё равно участвует в сравнении путей.
        }
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }

    /** Ищет повторную папку, исключая редактируемую запись. */
    private async ensureUnique(folderPath: string, exceptId?: string): Promise<void> {
        const target = await this.pathKey(folderPath);
        for (const project of getProjects(this.context.globalState)) {
            if (project.id !== exceptId && await this.pathKey(project.path) === target) {
                throw new Error('Эта папка уже добавлена в список проектов.');
            }
        }
    }

    /** Запрашивает непустую строку. Escape возвращает undefined. */
    private async text(prompt: string, value = ''): Promise<string | undefined> {
        const result = await vscode.window.showInputBox({
            title: 'Lab Manager',
            prompt,
            value,
            ignoreFocusOut: true,
            validateInput: (input) => input.trim() ? undefined : 'Поле не может быть пустым.'
        });
        return result === undefined ? undefined : result.trim();
    }

    /** Находит проект из контекстного меню или предлагает поиск по списку. */
    private async select(node?: ProjectTreeNode): Promise<StudyProject | undefined> {
        const projects = getProjects(this.context.globalState);
        if (node?.kind === 'project') {
            return projects.find((project) => project.id === node.project.id);
        }
        if (projects.length === 0) {
            void vscode.window.showInformationMessage('Список пуст. Сначала добавь учебный проект.');
            return undefined;
        }
        const items = [...projects]
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
            .map((project) => ({
                label: project.name,
                description: `${project.subject} · ${STATUS_INFO[project.status].label}`,
                detail: project.path,
                project
            }));
        const selected = await vscode.window.showQuickPick(items, {
            title: 'Учебные проекты',
            placeHolder: 'Найди проект по названию или предмету',
            matchOnDescription: true
        });
        return selected?.project;
    }

    /** Сохраняет изменения и обновляет представление только после успешной записи. */
    private async persist(projects: StudyProject[]): Promise<void> {
        await saveProjects(this.context.globalState, projects);
        this.tree.setProjects(projects);
    }

    /** Добавляет текущую локальную папку после проверок и заполнения полей. */
    async add(): Promise<void> {
        await this.change(async () => {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders?.length) {
                throw new Error('Сначала открой папку учебного проекта.');
            }
            if (folders.length !== 1) {
                throw new Error('Поддерживается только одна корневая папка.');
            }
            const folder = folders[0];
            if (vscode.env.remoteName || folder.uri.scheme !== 'file') {
                throw new Error('Поддерживаются только локальные папки.');
            }
            const folderPath = folder.uri.fsPath;
            await this.ensureDirectory(folderPath);
            await this.ensureUnique(folderPath);
            const name = await this.text('Название учебного проекта', folder.name);
            if (name === undefined) { return; }
            const subject = await this.text('Название предмета');
            if (subject === undefined) { return; }
            // Повторное чтение после диалогов уменьшает риск записи устаревшего списка.
            await this.ensureUnique(folderPath);
            const projects = getProjects(this.context.globalState);
            projects.push({ id: randomUUID(), name, path: folderPath, subject, status: 'not-started', materials: [] });
            await this.persist(projects);
            void vscode.window.showInformationMessage(`Проект «${name}» сохранён. Всего: ${projects.length}`);
        });
    }

    /** Открывает выбранный проект. Для недоступной папки предлагает сменить путь. */
    async open(node?: ProjectTreeNode): Promise<void> {
        const project = await this.select(node);
        if (!project) { return; }
        try {
            await this.ensureDirectory(project.path);
        } catch {
            const answer = await vscode.window.showWarningMessage(
                'Папка проекта недоступна. Можно указать её новое расположение.',
                'Указать новую папку'
            );
            if (answer === 'Указать новую папку') {
                await this.changePath({ kind: 'project', project });
            }
            return;
        }
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(project.path), {
            forceNewWindow: true
        });
    }

    /** Изменяет название и предмет; отмена любого диалога не меняет запись. */
    async edit(node?: ProjectTreeNode): Promise<void> {
        await this.change(async () => {
            const project = await this.select(node);
            if (!project) { return; }
            const name = await this.text('Название учебного проекта', project.name);
            if (name === undefined) { return; }
            const subject = await this.text('Название предмета', project.subject);
            if (subject === undefined) { return; }
            const projects = getProjects(this.context.globalState);
            const index = projects.findIndex((item) => item.id === project.id);
            if (index < 0) { throw new Error('Запись уже удалена. Обнови список.'); }
            projects[index] = { ...projects[index], name, subject };
            await this.persist(projects);
            void vscode.window.showInformationMessage('Данные проекта обновлены.');
        });
    }

    /** Меняет путь, проверяя существование папки и отсутствие дубликата. */
    async changePath(node?: ProjectTreeNode): Promise<void> {
        await this.change(async () => {
            const project = await this.select(node);
            if (!project) { return; }
            const selected = await vscode.window.showOpenDialog({
                title: 'Новая папка проекта',
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Выбрать папку'
            });
            if (!selected?.length) { return; }
            const uri = selected[0];
            if (vscode.env.remoteName || uri.scheme !== 'file') {
                throw new Error('Поддерживаются только локальные папки.');
            }
            await this.ensureDirectory(uri.fsPath);
            await this.ensureUnique(uri.fsPath, project.id);
            const projects = getProjects(this.context.globalState);
            const index = projects.findIndex((item) => item.id === project.id);
            if (index < 0) { throw new Error('Запись уже удалена. Обнови список.'); }
            projects[index] = { ...projects[index], path: uri.fsPath };
            await this.persist(projects);
            void vscode.window.showInformationMessage('Путь к проекту обновлён.');
        });
    }

    /** Удаляет только запись. Не вызывает удаление файлов или папок. */
    async remove(node?: ProjectTreeNode): Promise<void> {
        await this.change(async () => {
            const project = await this.select(node);
            if (!project) { return; }
            const answer = await vscode.window.showWarningMessage(
                `Убрать «${project.name}» из списка? Файлы на диске останутся.`,
                { modal: true },
                'Убрать из списка'
            );
            if (answer !== 'Убрать из списка') { return; }
            const projects = getProjects(this.context.globalState);
            await this.persist(projects.filter((item) => item.id !== project.id));
            void vscode.window.showInformationMessage('Запись удалена. Файлы не затронуты.');
        });
    }

    /** Меняет статус выбранной работы, не меняя остальные поля. */
    async changeStatus(node?: ProjectTreeNode): Promise<void> {
        await this.change(async () => {
            const project = await this.select(node);
            if (!project) { return; }
            const options = (Object.keys(STATUS_INFO) as ProjectStatus[]).map((status) => ({
                label: `$(${STATUS_INFO[status].icon}) ${STATUS_INFO[status].label}`,
                description: status === project.status ? 'Текущий статус' : '',
                status
            }));
            const selected = await vscode.window.showQuickPick(options, { title: 'Статус работы' });
            if (!selected) { return; }
            const projects = getProjects(this.context.globalState);
            const item = projects.find((value) => value.id === project.id);
            if (!item) { throw new Error('Проект уже удалён. Обнови список.'); }
            item.status = selected.status;
            await this.persist(projects);
            void vscode.window.showInformationMessage(`Статус: ${STATUS_INFO[item.status].label}`);
        });
    }

    /** Фильтр скрывает только сданные проекты, не удаляя их из хранилища. */
    async toggleFilter(): Promise<void> {
        await this.change(async () => {
            const value = !this.tree.getOnlyUnsubmitted();
            await this.context.globalState.update('labManager.onlyUnsubmitted', value);
            this.tree.setOnlyUnsubmitted(value);
            void vscode.window.showInformationMessage(value
                ? 'Фильтр: только несданные. Сданные проекты скрыты из дерева.'
                : 'Фильтр отключён: показаны все проекты.');
        });
    }

    /** Проверяет URL: разрешены только HTTP и HTTPS, не команды редактора. */
    private parseWebUrl(value: string): string {
        let url: URL;
        try { url = new URL(value.trim()); } catch { throw new Error('Введи полный адрес, например https://example.com/task.'); }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            throw new Error('Разрешены только ссылки http:// и https://.');
        }
        return url.href;
    }

    /** Прикрепляет существующий локальный файл либо веб-ссылку к проекту. */
    async addMaterial(node?: ProjectTreeNode): Promise<void> {
        await this.change(async () => {
            const project = await this.select(node);
            if (!project) { return; }
            const kind = await vscode.window.showQuickPick([
                {
                    label: 'Локальный файл',
                    description: 'Условие, отчёт, PDF, DOCX и другие файлы',
                    materialKind: 'file' as const
                },
                {
                    label: 'Веб-ссылка',
                    description: 'Задание, репозиторий или другая HTTP(S)-страница',
                    materialKind: 'link' as const
                }
            ], { title: 'Добавление материала' });
            if (!kind) { return; }
            let target: string;
            let suggestedName: string;
            if (kind.materialKind === 'file') {
                const files = await vscode.window.showOpenDialog({
                    title: 'Выбери файл материала', canSelectFiles: true,
                    canSelectFolders: false, canSelectMany: false, openLabel: 'Прикрепить'
                });
                if (!files?.length) { return; }
                if (vscode.env.remoteName || files[0].scheme !== 'file') {
                    throw new Error('Поддерживаются только локальные файлы.');
                }
                target = files[0].fsPath;
                await this.ensureFile(target);
                suggestedName = path.basename(target);
            } else {
                const address = await vscode.window.showInputBox({
                    title: 'Адрес материала', prompt: 'Полная ссылка HTTP(S)',
                    placeHolder: 'https://example.com/task', ignoreFocusOut: true,
                    validateInput: (value) => {
                        try { this.parseWebUrl(value); return undefined; }
                        catch (error) { return error instanceof Error ? error.message : 'Некорректная ссылка.'; }
                    }
                });
                if (address === undefined) { return; }
                target = this.parseWebUrl(address);
                suggestedName = new URL(target).hostname;
            }
            const label = await this.text('Название материала, например «Условие» или «Отчёт»', suggestedName);
            if (label === undefined) { return; }
            const projects = getProjects(this.context.globalState);
            const item = projects.find((value) => value.id === project.id);
            if (!item) { throw new Error('Проект уже удалён.'); }
            const targetKey = kind.materialKind === 'file' ? await this.pathKey(target) : target;
            for (const material of item.materials) {
                if (material.kind !== kind.materialKind) { continue; }
                const key = material.kind === 'file' ? await this.pathKey(material.target) : this.parseWebUrl(material.target);
                if (key === targetKey) { throw new Error('Этот материал уже прикреплён к проекту.'); }
            }
            item.materials.push({ id: randomUUID(), label, kind: kind.materialKind, target });
            await this.persist(projects);
            void vscode.window.showInformationMessage(`Материал «${label}» прикреплён. Сам файл не копировался.`);
        });
    }

    /** Проверяет доступность обычного файла, включая символическую ссылку на файл. */
    private async ensureFile(filePath: string): Promise<void> {
        let info: vscode.FileStat;
        try { info = await vscode.workspace.fs.stat(vscode.Uri.file(filePath)); }
        catch { throw new Error('Файл недоступен. Возможно, он перемещён, удалён или закрыт правами доступа.'); }
        if ((info.type & vscode.FileType.File) === 0) { throw new Error('Этот путь не указывает на файл.'); }
    }

    /** Находит актуальный материал по узлу дерева либо предлагает выбрать его. */
    private async selectMaterial(node?: ProjectTreeNode): Promise<{ projectId: string; material: ProjectMaterial } | undefined> {
        const projects = getProjects(this.context.globalState);
        if (node?.kind === 'material') {
            const project = projects.find((item) => item.id === node.projectId);
            const material = project?.materials.find((item) => item.id === node.material.id);
            if (!material) { throw new Error('Материал уже удалён. Обнови список.'); }
            return { projectId: node.projectId, material };
        }
        const project = await this.select(node);
        if (!project) { return undefined; }
        if (project.materials.length === 0) {
            void vscode.window.showInformationMessage('К проекту пока не прикреплены материалы.');
            return undefined;
        }
        const selected = await vscode.window.showQuickPick(project.materials.map((material) => ({
            label: material.label, description: material.kind === 'file' ? 'Файл' : 'Ссылка',
            detail: material.target, material
        })), { title: 'Материалы проекта' });
        return selected ? { projectId: project.id, material: selected.material } : undefined;
    }

    /** Открывает материал системным приложением или браузером. */
    async openMaterial(node?: ProjectTreeNode): Promise<void> {
        const selected = await this.selectMaterial(node);
        if (!selected) { return; }
        const material = selected.material;
        let uri: vscode.Uri;
        if (material.kind === 'file') {
            try { await this.ensureFile(material.target); }
            catch {
                const answer = await vscode.window.showWarningMessage(
                    'Файл материала недоступен. Можно указать его новое расположение.', 'Указать файл'
                );
                if (answer === 'Указать файл') {
                    await this.changeMaterialPath({ kind: 'material', ...selected });
                }
                return;
            }
            uri = vscode.Uri.file(material.target);
        } else {
            uri = vscode.Uri.parse(this.parseWebUrl(material.target));
        }
        const opened = await vscode.env.openExternal(uri);
        if (!opened) {
            throw new Error('Система не смогла открыть материал. Проверь приложение по умолчанию для этого типа файла.');
        }
    }

    /** Обновляет путь прикреплённого файла. Применяется и к отсутствующим файлам. */
    async changeMaterialPath(node?: ProjectTreeNode): Promise<void> {
        await this.change(async () => {
            const selected = await this.selectMaterial(node);
            if (!selected) { return; }
            if (selected.material.kind !== 'file') { throw new Error('Путь можно менять только у локального файла.'); }
            const files = await vscode.window.showOpenDialog({
                title: 'Новое расположение материала', canSelectFiles: true,
                canSelectFolders: false, canSelectMany: false, openLabel: 'Выбрать файл'
            });
            if (!files?.length) { return; }
            if (vscode.env.remoteName || files[0].scheme !== 'file') { throw new Error('Нужен локальный файл.'); }
            await this.ensureFile(files[0].fsPath);
            const projects = getProjects(this.context.globalState);
            const project = projects.find((item) => item.id === selected.projectId);
            const material = project?.materials.find((item) => item.id === selected.material.id);
            if (!project || !material) { throw new Error('Материал уже удалён.'); }
            const key = await this.pathKey(files[0].fsPath);
            for (const other of project.materials) {
                if (other.id !== material.id && other.kind === 'file' && await this.pathKey(other.target) === key) {
                    throw new Error('Этот файл уже прикреплён к проекту.');
                }
            }
            material.target = files[0].fsPath;
            await this.persist(projects);
            void vscode.window.showInformationMessage('Путь материала обновлён. Выбери его ещё раз для открытия.');
        });
    }

    /** Удаляет прикрепление после подтверждения, не трогая файл на диске. */
    async removeMaterial(node?: ProjectTreeNode): Promise<void> {
        await this.change(async () => {
            const selected = await this.selectMaterial(node);
            if (!selected) { return; }
            const answer = await vscode.window.showWarningMessage(
                `Открепить «${selected.material.label}»? Сам файл не удаляется.`,
                { modal: true }, 'Открепить'
            );
            if (answer !== 'Открепить') { return; }
            const projects = getProjects(this.context.globalState);
            const project = projects.find((item) => item.id === selected.projectId);
            if (!project) { throw new Error('Проект уже удалён.'); }
            project.materials = project.materials.filter((item) => item.id !== selected.material.id);
            await this.persist(projects);
            void vscode.window.showInformationMessage('Материал откреплён. Файл на диске не изменён.');
        });
    }
}

import type { Memento } from 'vscode';
import { STATUS_INFO, type ProjectMaterial, type ProjectStatus, type StudyProject } from './project';

const STORAGE_KEY = 'labManager.projects';

/** Проверяет наличие непустой строки. */
function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** Проверяет структуру и безопасную схему веб-ссылки материала. */
function isMaterial(value: unknown): value is ProjectMaterial {
    if (typeof value !== 'object' || value === null) { return false; }
    const item = value as Record<string, unknown>;
    if (!nonEmpty(item.id) || !nonEmpty(item.label) || !nonEmpty(item.target)) { return false; }
    if (item.kind === 'file') { return true; }
    if (item.kind !== 'link') { return false; }
    try {
        const url = new URL(item.target);
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch { return false; }
}

/** Проверяет запись и дополняет формат первой версии без потери существующих полей. */
function decodeProject(value: unknown): StudyProject {
    if (typeof value !== 'object' || value === null) {
        throw new Error('Некорректный формат проекта.');
    }
    const item = value as Record<string, unknown>;
    if (!nonEmpty(item.id) || !nonEmpty(item.name) || !nonEmpty(item.path) || !nonEmpty(item.subject)) {
        throw new Error('В сохранённом проекте отсутствуют обязательные поля.');
    }
    const status = item.status === undefined ? 'not-started' : item.status;
    if (typeof status !== 'string' || !Object.prototype.hasOwnProperty.call(STATUS_INFO, status)) {
        throw new Error('Неизвестный статус сохранённого проекта.');
    }
    const materials = item.materials === undefined ? [] : item.materials;
    if (!Array.isArray(materials) || !materials.every(isMaterial)) {
        throw new Error('Некорректный список материалов проекта.');
    }
    if (new Set(materials.map((material) => material.id)).size !== materials.length) {
        throw new Error('В материалах проекта повторяются идентификаторы.');
    }
    return {
        id: item.id, name: item.name, path: item.path, subject: item.subject,
        status: status as ProjectStatus,
        materials: materials.map((material) => ({ ...material }))
    };
}

/** Читает список, автоматически дополняя старые записи статусом и материалами. */
export function getProjects(storage: Memento): StudyProject[] {
    const value: unknown = storage.get<unknown>(STORAGE_KEY, []);
    if (!Array.isArray(value)) { throw new Error('Некорректный формат списка проектов.'); }
    const projects = value.map(decodeProject);
    if (new Set(projects.map((project) => project.id)).size !== projects.length) {
        throw new Error('В списке проектов повторяются идентификаторы.');
    }
    return projects;
}

/** Валидирует и сохраняет весь список. Исходные повреждённые данные не сбрасываются. */
export async function saveProjects(storage: Memento, projects: StudyProject[]): Promise<void> {
    const checked = projects.map(decodeProject);
    if (new Set(checked.map((project) => project.id)).size !== checked.length) {
        throw new Error('В списке проектов повторяются идентификаторы.');
    }
    await storage.update(STORAGE_KEY, checked);
}

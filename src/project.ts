/** Допустимые состояния учебной работы. */
export type ProjectStatus = 'not-started' | 'in-progress' | 'ready' | 'submitted';

/** Подписи и значки статусов используются в меню и дереве. */
export const STATUS_INFO: Record<ProjectStatus, { label: string; icon: string }> = {
    'not-started': { label: 'Не начата', icon: 'circle-large-outline' },
    'in-progress': { label: 'В работе', icon: 'sync' },
    'ready': { label: 'Готова', icon: 'check' },
    'submitted': { label: 'Сдана', icon: 'pass-filled' }
};

/** Материал — ссылка на локальный файл или HTTP(S)-страницу. Файлы не копируются. */
export interface ProjectMaterial {
    id: string;
    label: string;
    kind: 'file' | 'link';
    target: string;
}

/** Сохранённая запись учебного проекта. */
export interface StudyProject {
    id: string;
    name: string;
    path: string;
    subject: string;
    status: ProjectStatus;
    materials: ProjectMaterial[];
}

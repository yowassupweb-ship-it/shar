/** Студия картинок: галерея, референсы, рисование и то, что студия знает о вкусе человека (по оценкам). */

/** Метка на фото: точка (x, y) или область (ещё w, h). Координаты — доли ширины и высоты от левого верхнего угла (0…1). */
export interface StudioMark { n?: number; x: number; y: number; w?: number; h?: number; note: string }

export interface StudioImage {
  id: string;
  prompt: string;
  aspect: string;
  model: string;
  /** studio — нарисована здесь; chat — агентом в чате «Ядра»; upload — своё фото для правки. */
  source: 'studio' | 'chat' | 'upload';
  name: string;
  url: string;
  refs: string[];
  parentId: string | null;
  /** 1 — понравилось, −1 — нет, 0 — без оценки. */
  rating: -1 | 0 | 1;
  reason: string;
  favorite: boolean;
  note: string;
  tags: string[];
  /** Метки правок на фото: их видит агент (studio_gallery) и получает следующая правка этой картинки. */
  marks: StudioMark[];
  createdAt: string;
}

export interface StudioRef {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  note: string;
  url: string;
  tags: string[];
  uses: number;
  createdAt: string;
}

export interface StudioInsights {
  liked: Array<{ prompt: string; aspect: string; note: string }>;
  avoid: Array<{ prompt: string; reason: string }>;
  aspect: string;
  favoriteRefs: string[];
  rated: number;
}

export interface StudioState {
  images: StudioImage[];
  refs: StudioRef[];
  insights: StudioInsights;
  hasKey: boolean;
  kinds: Record<string, string>;
  aspects: string[];
  model: string;
}

async function call<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = String((await res.json())?.detail || ''); } catch { /* не JSON */ }
    throw new Error(detail || 'Не удалось — проверьте связь');
  }
  return (await res.json()) as T;
}

export const studioApi = {
  load: () => call<StudioState>('/api/studio'),
  generate: (body: { prompt: string; aspect: string; refs: string[]; parentId?: string; useStyle: boolean }) =>
    call<{ image: StudioImage; note: string }>('/api/studio/generate', 'POST', body),
  /** Своё фото для правки: файл, загруженный в Шар, становится картинкой галереи. */
  uploadPhoto: (key: string, name = '') => call<{ image: StudioImage }>('/api/studio/uploads', 'POST', { key, name }),
  patchImage: (id: string, patch: Partial<Pick<StudioImage, 'rating' | 'reason' | 'favorite' | 'note' | 'tags' | 'name' | 'marks'>>) =>
    call<{ image: StudioImage; insights?: StudioInsights }>(`/api/studio/images/${id}`, 'PATCH', patch),
  deleteImage: (id: string) => call<{ ok: true }>(`/api/studio/images/${id}`, 'DELETE'),
  addRef: (body: { name?: string; kind: string; note?: string; key?: string; imageId?: string; tags?: string[] }) =>
    call<{ ref: StudioRef }>('/api/studio/refs', 'POST', body),
  patchRef: (id: string, patch: Partial<Pick<StudioRef, 'name' | 'kind' | 'note' | 'tags'>>) =>
    call<{ ref: StudioRef }>(`/api/studio/refs/${id}`, 'PATCH', patch),
  deleteRef: (id: string) => call<{ ok: true }>(`/api/studio/refs/${id}`, 'DELETE'),
};

import type { Annotation, VoiceNote } from './types.ts';

export type StoreListener = (annotations: readonly Annotation[]) => void;

interface HistoryEntry {
  annotations: Annotation[];
}

/**
 * In-memory annotation store with undo/redo and change notification.
 *
 * Pure (no DOM / Electron) so it can be unit tested. The renderer drives it from
 * pointer/keyboard input and renders from `getAll()`; the main process collects
 * `getAll()` at submit time via IPC.
 *
 * Annotations persist across review-mode toggles — they are only discarded by
 * an explicit {@link clear} or after a successful submit.
 */
export class AnnotationStore {
  #annotations: Annotation[] = [];
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #listeners = new Set<StoreListener>();
  #maxHistory: number;

  constructor(options: { maxHistory?: number } = {}) {
    this.#maxHistory = options.maxHistory ?? 100;
  }

  getAll(): readonly Annotation[] {
    return this.#annotations;
  }

  get size(): number {
    return this.#annotations.length;
  }

  getById(id: string): Annotation | undefined {
    return this.#annotations.find((a) => a.id === id);
  }

  getByDisplay(displayId: number): Annotation[] {
    return this.#annotations.filter((a) => a.displayId === displayId);
  }

  canUndo(): boolean {
    return this.#undo.length > 0;
  }

  canRedo(): boolean {
    return this.#redo.length > 0;
  }

  add(annotation: Annotation): void {
    this.#pushHistory();
    this.#annotations.push(annotation);
    this.#emit();
  }

  /** Shallow-merge a partial update onto an existing annotation by id. */
  update(id: string, patch: Partial<Annotation>): boolean {
    const idx = this.#annotations.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    this.#pushHistory();
    const current = this.#annotations[idx]!;
    // `kind` is never changed by a patch; cast is safe for a same-kind merge.
    this.#annotations[idx] = { ...current, ...patch, kind: current.kind } as Annotation;
    this.#emit();
    return true;
  }

  attachVoiceNote(id: string, voiceNote: VoiceNote): boolean {
    return this.update(id, { voiceNote } as Partial<Annotation>);
  }

  /** Replace an annotation wholesale by id (used for move/transform). */
  setAnnotation(id: string, next: Annotation, recordHistory = true): boolean {
    const idx = this.#annotations.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    if (recordHistory) this.#pushHistory();
    this.#annotations[idx] = next;
    this.#emit();
    return true;
  }

  /** Push the current state onto the undo stack without changing anything. */
  checkpoint(): void {
    this.#pushHistory();
  }

  /** Remove the most recent undo checkpoint (e.g. a canceled move/resize). */
  dropLastCheckpoint(): void {
    this.#undo.pop();
  }

  setTranscript(id: string, transcript: string): boolean {
    const a = this.getById(id);
    if (!a || !a.voiceNote) return false;
    return this.update(id, {
      voiceNote: { ...a.voiceNote, transcript, transcriptError: undefined },
    } as Partial<Annotation>);
  }

  setTranscriptError(id: string, error: string): boolean {
    const a = this.getById(id);
    if (!a || !a.voiceNote) return false;
    return this.update(id, {
      voiceNote: { ...a.voiceNote, transcriptError: error },
    } as Partial<Annotation>);
  }

  remove(id: string): boolean {
    const idx = this.#annotations.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    this.#pushHistory();
    this.#annotations.splice(idx, 1);
    this.#emit();
    return true;
  }

  clear(): void {
    if (this.#annotations.length === 0) return;
    this.#pushHistory();
    this.#annotations = [];
    this.#emit();
  }

  undo(): boolean {
    const prev = this.#undo.pop();
    if (!prev) return false;
    this.#redo.push({ annotations: this.#snapshot() });
    this.#annotations = prev.annotations;
    this.#emit();
    return true;
  }

  redo(): boolean {
    const next = this.#redo.pop();
    if (!next) return false;
    this.#undo.push({ annotations: this.#snapshot() });
    this.#annotations = next.annotations;
    this.#emit();
    return true;
  }

  subscribe(listener: StoreListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Replace the full set without recording undo history (e.g. hydrate). */
  hydrate(annotations: Annotation[]): void {
    this.#annotations = annotations.map(cloneAnnotation);
    this.#undo = [];
    this.#redo = [];
    this.#emit();
  }

  #snapshot(): Annotation[] {
    return this.#annotations.map(cloneAnnotation);
  }

  #pushHistory(): void {
    this.#undo.push({ annotations: this.#snapshot() });
    if (this.#undo.length > this.#maxHistory) this.#undo.shift();
    this.#redo = [];
  }

  #emit(): void {
    const view = this.#annotations;
    for (const l of this.#listeners) l(view);
  }
}

/** Structured-clone-free deep copy adequate for the annotation shapes. */
export function cloneAnnotation(a: Annotation): Annotation {
  return JSON.parse(JSON.stringify(a)) as Annotation;
}

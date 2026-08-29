import type {
  FrameActionRequest,
  FrameStateMessage,
  OverlayRendererConfig,
  ReviewDestination,
} from "../main/ipc-channels.ts";
import { AnnotationStore, cloneAnnotation } from "../shared/annotation-store.ts";
import {
  annotationBounds,
  annotationHandles,
  annotationHitTest,
  rectFromPoints,
  resizeAnnotation,
  translateAnnotation,
  type HandleId,
} from "../shared/geometry.ts";
import { createIdFactory } from "../shared/id.ts";
import type {
  Annotation,
  AnnotationStyle,
  DisplayInfo,
  Point,
  ReviewTarget,
  TextAnnotation,
  ToolKind,
  VoicePinAnnotation,
} from "../shared/types.ts";
import { AudioRecorder } from "./audio-recorder.ts";
import { getBridge } from "./bridge.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

interface DragState {
  tool: Extract<ToolKind, "pen" | "rectangle" | "arrow">;
  startLocal: Point;
  points: Point[];
  lastLocal: Point;
}

interface ToolDef {
  tool: ToolKind;
  glyph: string;
  label: string;
  key: string;
}

const TOOLS: ToolDef[] = [
  { tool: "select", glyph: "⤢", label: "Select", key: "V" },
  { tool: "pen", glyph: "✎", label: "Pen", key: "P" },
  { tool: "rectangle", glyph: "▭", label: "Box", key: "R" },
  { tool: "arrow", glyph: "➜", label: "Arrow", key: "A" },
  { tool: "text", glyph: "T", label: "Text", key: "T" },
  { tool: "voicePin", glyph: "◉", label: "Voice note", key: "C" },
];

interface MoveState {
  id: string;
  origin: Annotation;
  startGlobal: Point;
  moved: boolean;
}

interface ResizeState {
  id: string;
  origin: Annotation;
  handle: HandleId;
  startGlobal: Point;
  changed: boolean;
}

/**
 * The per-display overlay UI. Owns an {@link AnnotationStore} (this display's
 * annotations in GLOBAL DIP coordinates) and renders them as SVG + DOM markers.
 *
 * Interaction model (simple + robust): the main process makes the whole window
 * interactive and focused while a review session is active, so every tool works
 * immediately and the text box / microphone receive focus. There is no
 * per-pixel click-through guessing. An explicit "Pass-through" toggle lets the
 * user click the app underneath; they resume with a global shortcut.
 */
export class OverlayApp {
  #bridge = getBridge();
  #store = new AnnotationStore();
  #nextId = createIdFactory("ann");

  #display: DisplayInfo = {
    id: 0,
    bounds: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
    scaleFactor: window.devicePixelRatio || 1,
  };
  #config: OverlayRendererConfig = {
    colors: [
      "#ff3b30",
      "#ff9500",
      "#ffcc00",
      "#34c759",
      "#0a84ff",
      "#bf5af2",
      "#ffffff",
      "#000000",
    ],
    defaultColor: "#ff3b30",
    defaultStrokeWidth: 4,
    tint: "rgba(10,12,20,0.06)",
    voiceEnabled: true,
    toggleShortcutLabel: "Ctrl+Shift+Space",
    submitShortcutLabel: "Ctrl+Enter",
    passthroughShortcutLabel: "Ctrl+Shift+S",
  };

  #tool: ToolKind = "pen";
  #color = "#ff3b30";
  #strokeWidth = 4;

  #active = false;
  #passthrough = false;
  #boundSessionId: string | undefined;
  #boundSessionTitle: string | undefined;
  #destinations: ReviewDestination[] = [];
  #frameState: FrameStateMessage = {
    frameId: "frame-1",
    index: 0,
    count: 1,
    annotationCount: 0,
    totalAnnotationCount: 0,
  };
  #drag: DragState | null = null;
  #move: MoveState | null = null;
  #resize: ResizeState | null = null;
  #selectedId: string | null = null;
  #activePointerId: number | null = null;
  #editing = false;
  #recordingId: string | null = null;
  #skipNextRender = false;
  #suppressNextSync = false;

  #recorder = new AudioRecorder();
  #startingRecording = false;

  // DOM
  #root!: HTMLDivElement;
  #svg!: SVGSVGElement;
  #committedLayer!: SVGGElement;
  #liveLayer!: SVGGElement;
  #markers!: HTMLDivElement;
  #toolbar!: HTMLDivElement;
  #status!: HTMLDivElement;
  #recordPanel!: HTMLDivElement;
  #hint!: HTMLDivElement;
  #passthroughBanner!: HTMLDivElement;
  #shortcutsPanel!: HTMLDivElement;
  #picker!: HTMLDivElement;

  start(): void {
    this.#buildDom();
    this.#wireBridge();
    this.#wireInput();
    this.#store.subscribe(() => this.#onStoreChange());
    this.#applyActive(false);
    this.#exposeTestApi();
    this.#signalReadyAfterPaint();
  }

  #signalReadyAfterPaint(): void {
    if (typeof requestAnimationFrame !== "function") {
      this.#bridge.ready();
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.#bridge.ready());
    });
  }

  // ---------- coordinates ----------

  #toGlobal(local: Point): Point {
    return { x: local.x + this.#display.bounds.x, y: local.y + this.#display.bounds.y };
  }
  #toLocal(global: Point): Point {
    return { x: global.x - this.#display.bounds.x, y: global.y - this.#display.bounds.y };
  }
  #style(): AnnotationStyle {
    return { color: this.#color, strokeWidth: this.#strokeWidth };
  }

  // ---------- bridge ----------

  #wireBridge(): void {
    this.#bridge.onInit((msg) => {
      this.#display = msg.display;
      this.#config = msg.config;
      this.#color = msg.config.defaultColor;
      this.#strokeWidth = msg.config.defaultStrokeWidth;
      this.#root.style.setProperty("--tint", msg.config.tint);
      this.#buildToolbar();
      this.#buildHint();
    });
    this.#bridge.onSetTool((tool) => this.#selectTool(tool, false));
    this.#bridge.onSession((s) => {
      this.#boundSessionId = s.boundSessionId;
      this.#boundSessionTitle = s.boundSessionTitle;
      this.#destinations = s.destinations ?? [];
      this.#applyActive(s.active);
      if (s.active) this.#applyPassthrough(s.passthrough);
    });
    this.#bridge.onClear(() => {
      this.#suppressNextSync = true;
      this.#store.hydrate([]);
      this.#updateToolbarCounts();
    });
    this.#bridge.onHydrate((m) => {
      this.#frameState = { ...this.#frameState, frameId: m.frameId };
      this.#suppressNextSync = true;
      this.#store.hydrate(m.annotations ?? []);
      this.#updateToolbarCounts();
    });
    this.#bridge.onNotice((m) => this.#showNotice(m.text, m.kind, m.timeoutMs ?? 2600));
    this.#bridge.onCaptureMode((on) => this.#root.classList.toggle("capturing", on));
    this.#bridge.onRequestSubmit(() => {
      void this.#requestSubmit();
    });
    this.#bridge.onEdit((m) => {
      if (m.action === "undo") this.#store.undo();
      else this.#store.redo();
    });
    this.#bridge.onFrameState((m) => {
      this.#frameState = m;
      this.#updateToolbarCounts();
    });
  }

  #noticeTimer: ReturnType<typeof setTimeout> | undefined;

  #showNotice(text: string, kind: "info" | "success" | "error", timeoutMs: number): void {
    this.#status.textContent = text;
    this.#status.dataset["kind"] = kind;
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    if (timeoutMs > 0) {
      this.#noticeTimer = setTimeout(() => {
        this.#status.dataset["kind"] = "idle";
        this.#status.textContent = this.#idleStatus();
      }, timeoutMs);
    }
  }

  #applyActive(active: boolean): void {
    this.#active = active;
    if (!active) {
      this.#cancelActiveGesture();
      this.#setSelected(null);
      this.#endTextEditing(true);
      if (this.#recorder.recording) this.#recorder.cancel();
      this.#setRecordingPin(null);
      this.#passthrough = false;
    }
    this.#root.classList.toggle("active", active);
    if (active) {
      this.#flashHint();
      this.#maybePulseToolbar();
      this.#status.dataset["kind"] = "idle";
      this.#status.textContent = this.#idleStatus();
    }
  }

  #maybePulseToolbar(): void {
    let seen = false;
    try {
      seen = localStorage.getItem("overlayReview.seenToolbar") === "1";
    } catch {
      /* ignore */
    }
    if (seen) return;
    this.#toolbar.classList.add("first-show");
    try {
      localStorage.setItem("overlayReview.seenToolbar", "1");
    } catch {
      /* ignore */
    }
    setTimeout(() => this.#toolbar.classList.remove("first-show"), 4200);
  }

  #applyPassthrough(on: boolean): void {
    this.#passthrough = on;
    this.#root.classList.toggle("passthrough", on);
    this.#passthroughBanner.hidden = !on;
    const ptText = this.#passthroughBanner.querySelector("#pt-text");
    if (ptText) {
      ptText.textContent = `Using the app underneath — click anywhere below. Press ${this.#config.passthroughShortcutLabel} (or Esc) to resume drawing.`;
    }
    if (on) {
      this.#cancelDrag();
      this.#status.dataset["kind"] = "idle";
      this.#status.textContent = `Using the app underneath — press ${this.#config.passthroughShortcutLabel} or Esc to resume drawing`;
    } else {
      this.#status.dataset["kind"] = "idle";
      this.#status.textContent = this.#idleStatus();
    }
  }

  #idleStatus(): string {
    const guide: Record<ToolKind, string> = {
      select: "Select — click a mark to move it; drag handles to resize; Delete to remove",
      pen: "Pen — drag to draw freehand",
      rectangle: "Box — drag to frame a region",
      arrow: "Arrow — drag to point at something",
      text: "Text — click anywhere to type a note",
      voicePin: "Voice note — click to drop a pin, then record",
    };
    return `${guide[this.#tool]} · ${this.#config.submitShortcutLabel} to send · Esc to exit`;
  }

  // ---------- tools ----------

  #selectTool(tool: ToolKind, broadcast = true): void {
    this.#tool = tool;
    for (const btn of this.#toolbar.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      const isActive = btn.dataset["tool"] === tool;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", String(isActive));
    }
    this.#cancelDrag();
    this.#root.dataset["tool"] = tool;
    if (tool !== "select") this.#setSelected(null);
    if (this.#active && !this.#passthrough) {
      this.#status.dataset["kind"] = "idle";
      this.#status.textContent = this.#idleStatus();
    }
  }

  // ---------- input ----------

  #wireInput(): void {
    this.#root.addEventListener("pointerdown", (e) => this.#onPointerDown(e));
    window.addEventListener("pointermove", (e) => this.#onPointerMove(e));
    window.addEventListener("pointerup", (e) => this.#onPointerUp(e));
    window.addEventListener("pointercancel", () => this.#cancelActiveGesture());
    this.#root.addEventListener("lostpointercapture", () => this.#cancelActiveGesture());
    window.addEventListener("keydown", (e) => this.#onKeyDown(e));
  }

  #cancelActiveGesture(): void {
    if (this.#resize) this.#cancelResize();
    else if (this.#move) this.#cancelMove();
    else this.#cancelDrag();
  }

  #isInteractiveTarget(t: EventTarget | null): boolean {
    return (
      t instanceof Node &&
      (this.#toolbar.contains(t) ||
        this.#markers.contains(t) ||
        this.#recordPanel.contains(t) ||
        this.#hint.contains(t) ||
        this.#picker.contains(t) ||
        this.#shortcutsPanel.contains(t))
    );
  }

  #canDraw(): boolean {
    return this.#active && !this.#passthrough && !this.#recordingId;
  }

  #onPointerDown(e: PointerEvent): void {
    if (!this.#canDraw() || this.#isInteractiveTarget(e.target)) return;
    const local = { x: e.clientX, y: e.clientY };
    switch (this.#tool) {
      case "pen":
      case "rectangle":
      case "arrow":
        this.#drag = { tool: this.#tool, startLocal: local, lastLocal: local, points: [local] };
        this.#activePointerId = e.pointerId;
        try {
          this.#root.setPointerCapture(e.pointerId);
        } catch {
          /* best effort */
        }
        break;
      case "text":
        this.#beginText(local);
        break;
      case "voicePin":
        this.#dropVoicePin(local);
        break;
      case "select":
        this.#beginSelectOrMove(local, e.pointerId);
        break;
    }
  }

  #beginSelectOrMove(local: Point, pointerId: number): void {
    const g = this.#toGlobal(local);
    // 1) If something is selected, check its resize handles first.
    if (this.#selectedId) {
      const sel = this.#store.getById(this.#selectedId);
      if (sel) {
        for (const h of annotationHandles(sel)) {
          if (Math.hypot(h.point.x - g.x, h.point.y - g.y) <= 11) {
            this.#resize = {
              id: sel.id,
              origin: cloneAnnotation(sel),
              handle: h.id,
              startGlobal: g,
              changed: false,
            };
            this.#activePointerId = pointerId;
            try {
              this.#root.setPointerCapture(pointerId);
            } catch {
              /* best effort */
            }
            return;
          }
        }
      }
    }
    // 2) Topmost hit (last added renders on top).
    const all = this.#store.getAll();
    let hit: Annotation | undefined;
    for (let i = all.length - 1; i >= 0; i--) {
      if (annotationHitTest(all[i]!, g, 10)) {
        hit = all[i];
        break;
      }
    }
    if (!hit) {
      this.#setSelected(null);
      return;
    }
    this.#setSelected(hit.id);
    this.#move = { id: hit.id, origin: cloneAnnotation(hit), startGlobal: g, moved: false };
    this.#activePointerId = pointerId;
    try {
      this.#root.setPointerCapture(pointerId);
    } catch {
      /* best effort */
    }
  }

  #onPointerMove(e: PointerEvent): void {
    if (this.#activePointerId !== null && e.pointerId !== this.#activePointerId) return;
    const local = { x: e.clientX, y: e.clientY };
    if (this.#resize) {
      const g = this.#toGlobal(local);
      const dx = g.x - this.#resize.startGlobal.x;
      const dy = g.y - this.#resize.startGlobal.y;
      if (!this.#resize.changed && Math.hypot(dx, dy) >= 2) {
        this.#resize.changed = true;
        this.#store.checkpoint();
      }
      if (this.#resize.changed) {
        this.#store.setAnnotation(
          this.#resize.id,
          resizeAnnotation(this.#resize.origin, this.#resize.handle, dx, dy),
          false,
        );
      }
      return;
    }
    if (this.#move) {
      const g = this.#toGlobal(local);
      const dx = g.x - this.#move.startGlobal.x;
      const dy = g.y - this.#move.startGlobal.y;
      if (!this.#move.moved && Math.hypot(dx, dy) >= 2) {
        this.#move.moved = true;
        this.#store.checkpoint(); // one undo step for the whole move
      }
      if (this.#move.moved) {
        this.#store.setAnnotation(
          this.#move.id,
          translateAnnotation(this.#move.origin, dx, dy),
          false,
        );
      }
      return;
    }
    if (!this.#drag) return;
    this.#drag.lastLocal = local;
    if (this.#drag.tool === "pen") {
      const pts = this.#drag.points;
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(local.x - last.x, local.y - last.y) >= 2) pts.push(local);
    }
    this.#renderLive();
  }

  #onPointerUp(e: PointerEvent): void {
    if (this.#activePointerId !== null && e.pointerId !== this.#activePointerId) return;
    if (this.#resize) {
      this.#resize = null;
      this.#releasePointer();
      return;
    }
    if (this.#move) {
      this.#move = null;
      this.#releasePointer();
      return;
    }
    const drag = this.#drag;
    this.#releasePointer();
    if (!drag) return;
    this.#drag = null;
    this.#commitDrag(drag);
    this.#renderLive();
  }

  #setSelected(id: string | null): void {
    if (this.#selectedId === id) return;
    this.#selectedId = id;
    this.#render();
  }

  #releasePointer(): void {
    if (this.#activePointerId !== null) {
      try {
        this.#root.releasePointerCapture(this.#activePointerId);
      } catch {
        /* ignore */
      }
      this.#activePointerId = null;
    }
  }

  #cancelDrag(): void {
    this.#releasePointer();
    if (this.#drag) {
      this.#drag = null;
      this.#renderLive();
    }
  }

  #cancelMove(): void {
    this.#releasePointer();
    const m = this.#move;
    this.#move = null;
    if (m && m.moved) {
      // Revert to the pre-move position and drop the (now redundant) checkpoint.
      this.#store.setAnnotation(m.id, m.origin, false);
      this.#store.dropLastCheckpoint();
    }
  }

  #cancelResize(): void {
    this.#releasePointer();
    const r = this.#resize;
    this.#resize = null;
    if (r && r.changed) {
      this.#store.setAnnotation(r.id, r.origin, false);
      this.#store.dropLastCheckpoint();
    }
  }

  #commitDrag(drag: DragState): void {
    const id = this.#nextId();
    const style = this.#style();
    const createdAt = Date.now();
    if (drag.tool === "pen") {
      if (drag.points.length < 2) return;
      this.#store.add({
        id,
        kind: "pen",
        displayId: this.#display.id,
        createdAt,
        style,
        points: drag.points.map((p) => this.#toGlobal(p)),
      });
    } else if (drag.tool === "rectangle") {
      const r = rectFromPoints(this.#toGlobal(drag.startLocal), this.#toGlobal(drag.lastLocal));
      if (r.width < 3 && r.height < 3) return;
      this.#store.add({
        id,
        kind: "rectangle",
        displayId: this.#display.id,
        createdAt,
        style,
        rect: r,
      });
    } else {
      const from = this.#toGlobal(drag.startLocal);
      const to = this.#toGlobal(drag.lastLocal);
      if (Math.hypot(to.x - from.x, to.y - from.y) < 4) return;
      this.#store.add({
        id,
        kind: "arrow",
        displayId: this.#display.id,
        createdAt,
        style,
        from,
        to,
      });
    }
  }

  // ---------- text ----------

  #beginText(local: Point): void {
    // Clean up any previously-placed empty text boxes before adding a new one.
    for (const a of [...this.#store.getAll()]) {
      if (a.kind === "text" && a.text.trim() === "") this.#store.remove(a.id);
    }
    const id = this.#nextId();
    const annotation: TextAnnotation = {
      id,
      kind: "text",
      displayId: this.#display.id,
      createdAt: Date.now(),
      style: { ...this.#style(), fontSize: 18 },
      text: "",
      position: this.#toGlobal(local),
    };
    this.#store.add(annotation);
    this.#editing = true;
    queueMicrotask(() => this.#focusTextEditor(id));
  }

  #focusTextEditor(id: string): void {
    const el = this.#markers.querySelector<HTMLTextAreaElement>(`[data-text-input="${id}"]`);
    if (el) {
      el.focus();
      el.select();
    }
  }

  #endTextEditing(removeEmpty: boolean): void {
    if (!this.#editing) return;
    this.#editing = false;
    if (removeEmpty) {
      for (const a of [...this.#store.getAll()]) {
        if (a.kind === "text" && a.text.trim() === "") this.#store.remove(a.id);
      }
    }
  }

  // ---------- voice ----------

  #dropVoicePin(local: Point): void {
    const id = this.#nextId();
    const pin: VoicePinAnnotation = {
      id,
      kind: "voicePin",
      displayId: this.#display.id,
      createdAt: Date.now(),
      style: this.#style(),
      position: this.#toGlobal(local),
    };
    this.#store.add(pin);
    // Do NOT auto-start recording — let the user press the mic when ready
    // (avoids an abrupt permission prompt on every pin and accidental pins).
    this.#status.dataset["kind"] = "idle";
    this.#status.textContent = "Voice pin placed — press 🎤 on the pin to record your note";
  }

  #setRecordingPin(id: string | null): void {
    this.#recordingId = id;
    this.#recordPanel.classList.toggle("is-recording", id !== null);
    this.#recordPanel.hidden = id === null;
    this.#root.classList.toggle("recording", id !== null);
    if (id === null) this.#stopRecTimer();
  }

  async #startRecording(annotationId: string): Promise<void> {
    if (this.#recordingId || this.#startingRecording) return;
    this.#startingRecording = true;
    try {
      await this.#recorder.start();
      this.#setRecordingPin(annotationId);
      this.#startRecTimer();
      this.#status.dataset["kind"] = "idle";
      this.#status.textContent = "Recording audio note… speak, then Stop & attach";
      this.#render();
    } catch (err) {
      this.#setRecordingPin(null);
      this.#bridge.reportError({ message: `Mic error: ${errMsg(err)}` });
      this.#status.dataset["kind"] = "error";
      this.#status.textContent =
        "Microphone blocked — allow mic access, then press 🎤 again to retry";
    } finally {
      this.#startingRecording = false;
    }
  }

  #recTimer: ReturnType<typeof setInterval> | undefined;
  #recStartedAt = 0;

  #startRecTimer(): void {
    this.#stopRecTimer(); // never leak a previous interval
    this.#recStartedAt = performance.now();
    const label = this.#recordPanel.querySelector(".rec-label");
    const tick = (): void => {
      if (!label) return;
      const s = Math.floor((performance.now() - this.#recStartedAt) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      label.textContent = `🎙 Recording audio note ${mm}:${ss} — your screen is not being recorded`;
    };
    tick();
    this.#recTimer = setInterval(tick, 500);
  }

  #stopRecTimer(): void {
    if (this.#recTimer) {
      clearInterval(this.#recTimer);
      this.#recTimer = undefined;
    }
  }

  async #stopRecording(commit: boolean): Promise<void> {
    const id = this.#recordingId;
    if (!id) return;
    this.#setRecordingPin(null);
    this.#stopRecTimer();
    try {
      if (!commit) {
        this.#recorder.cancel();
        this.#status.textContent = "Voice note canceled";
        this.#render();
        return;
      }
      const clip = await this.#recorder.stop();
      this.#store.attachVoiceNote(id, { ...clip });
      this.#status.textContent = "Transcribing…";
      try {
        const transcript = await this.#bridge.transcribe({ clip });
        if (transcript) this.#store.setTranscript(id, transcript);
        this.#status.textContent = transcript
          ? "Voice note added"
          : "Voice note added (no transcript)";
      } catch (err) {
        this.#store.setTranscriptError(id, errMsg(err));
        this.#status.textContent = "Voice saved (transcription failed)";
      }
    } finally {
      this.#render();
    }
  }

  // ---------- rendering ----------

  #onStoreChange(): void {
    if (this.#suppressNextSync) {
      this.#suppressNextSync = false;
    } else {
      this.#bridge.sync({
        frameId: this.#frameState.frameId,
        annotations: [...this.#store.getAll()],
      });
    }
    if (this.#skipNextRender) {
      this.#skipNextRender = false;
      this.#updateToolbarCounts();
      return;
    }
    this.#render();
    this.#updateToolbarCounts();
  }

  #render(): void {
    this.#committedLayer.replaceChildren();
    for (const a of this.#store.getAll()) {
      const node = this.#renderVector(a);
      if (node) this.#committedLayer.appendChild(node);
    }
    // Selection highlight + resize handles (Select tool).
    if (this.#selectedId) {
      const sel = this.#store.getById(this.#selectedId);
      if (sel) {
        const b = annotationBounds(sel);
        const tl = this.#toLocal({ x: b.x, y: b.y });
        const pad = 6;
        const box = document.createElementNS(SVG_NS, "rect");
        box.setAttribute("x", String(tl.x - pad));
        box.setAttribute("y", String(tl.y - pad));
        box.setAttribute("width", String(Math.max(0, b.width) + pad * 2));
        box.setAttribute("height", String(Math.max(0, b.height) + pad * 2));
        box.setAttribute("fill", "none");
        box.setAttribute("stroke", "#0a84ff");
        box.setAttribute("stroke-width", "1.5");
        box.setAttribute("stroke-dasharray", "5 4");
        box.setAttribute("rx", "4");
        box.setAttribute("class", "select-chrome");
        this.#committedLayer.appendChild(box);
        // Resize handles (rectangle corners / arrow endpoints).
        for (const h of annotationHandles(sel)) {
          const hl = this.#toLocal(h.point);
          const hs = 8;
          const sq = document.createElementNS(SVG_NS, "rect");
          sq.setAttribute("x", String(hl.x - hs / 2));
          sq.setAttribute("y", String(hl.y - hs / 2));
          sq.setAttribute("width", String(hs));
          sq.setAttribute("height", String(hs));
          sq.setAttribute("fill", "#ffffff");
          sq.setAttribute("stroke", "#0a84ff");
          sq.setAttribute("stroke-width", "1.5");
          sq.setAttribute("class", "select-chrome");
          this.#committedLayer.appendChild(sq);
        }
      } else {
        this.#selectedId = null;
      }
    }
    this.#markers.replaceChildren();
    for (const a of this.#store.getAll()) {
      if (a.kind === "text") this.#markers.appendChild(this.#renderText(a));
      if (a.kind === "voicePin") this.#markers.appendChild(this.#renderPin(a));
    }
  }

  #renderLive(): void {
    this.#liveLayer.replaceChildren();
    const drag = this.#drag;
    if (!drag) return;
    const stroke = this.#color;
    const sw = String(this.#strokeWidth);
    if (drag.tool === "pen") {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", toPathD(drag.points));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke);
      path.setAttribute("stroke-width", sw);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      this.#liveLayer.appendChild(path);
    } else if (drag.tool === "rectangle") {
      const r = rectFromPoints(drag.startLocal, drag.lastLocal);
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(r.x));
      rect.setAttribute("y", String(r.y));
      rect.setAttribute("width", String(r.width));
      rect.setAttribute("height", String(r.height));
      rect.setAttribute("fill", "none");
      rect.setAttribute("stroke", stroke);
      rect.setAttribute("stroke-width", sw);
      this.#liveLayer.appendChild(rect);
    } else {
      this.#liveLayer.appendChild(this.#arrowNode(drag.startLocal, drag.lastLocal, stroke, sw));
    }
  }

  #renderVector(a: Annotation): SVGElement | null {
    const stroke = a.style.color;
    const sw = String(a.style.strokeWidth);
    if (a.kind === "pen") {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", toPathD(a.points.map((p) => this.#toLocal(p))));
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", stroke);
      path.setAttribute("stroke-width", sw);
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      return path;
    }
    if (a.kind === "rectangle") {
      const tl = this.#toLocal({ x: a.rect.x, y: a.rect.y });
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(tl.x));
      rect.setAttribute("y", String(tl.y));
      rect.setAttribute("width", String(a.rect.width));
      rect.setAttribute("height", String(a.rect.height));
      rect.setAttribute("fill", "none");
      rect.setAttribute("stroke", stroke);
      rect.setAttribute("stroke-width", sw);
      return rect;
    }
    if (a.kind === "arrow") {
      return this.#arrowNode(this.#toLocal(a.from), this.#toLocal(a.to), stroke, sw);
    }
    return null;
  }

  #arrowNode(from: Point, to: Point, stroke: string, sw: string): SVGGElement {
    const g = document.createElementNS(SVG_NS, "g");
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(from.x));
    line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(to.x));
    line.setAttribute("y2", String(to.y));
    line.setAttribute("stroke", stroke);
    line.setAttribute("stroke-width", sw);
    line.setAttribute("stroke-linecap", "round");
    g.appendChild(line);
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    const len = 14 + Number(sw);
    const wing = Math.PI / 7;
    const p1 = { x: to.x - len * Math.cos(ang - wing), y: to.y - len * Math.sin(ang - wing) };
    const p2 = { x: to.x - len * Math.cos(ang + wing), y: to.y - len * Math.sin(ang + wing) };
    const head = document.createElementNS(SVG_NS, "polygon");
    head.setAttribute("points", `${to.x},${to.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`);
    head.setAttribute("fill", stroke);
    g.appendChild(head);
    return g;
  }

  #renderText(a: TextAnnotation): HTMLElement {
    const local = this.#toLocal(a.position);
    const wrap = document.createElement("div");
    wrap.className = "marker text-marker";
    wrap.style.left = `${local.x}px`;
    wrap.style.top = `${local.y}px`;

    const ta = document.createElement("textarea");
    ta.className = "text-input";
    ta.dataset["textInput"] = a.id;
    ta.value = a.text;
    ta.rows = 1;
    ta.style.color = a.style.color;
    ta.style.fontSize = `${a.style.fontSize ?? 18}px`;
    ta.placeholder = "Type a note…";
    ta.addEventListener("input", () => {
      this.#skipNextRender = true;
      this.#store.update(a.id, { text: ta.value } as Partial<Annotation>);
      autoSize(ta);
    });
    ta.addEventListener("focus", () => {
      this.#editing = true;
    });
    ta.addEventListener("blur", () => {
      // Do NOT remove empty boxes here — a transient focus loss must not delete
      // the box mid-edit. Empty boxes are cleaned up when a new text starts,
      // on Esc, on exit, and are filtered out of the submitted payload.
      this.#editing = false;
    });
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        // Esc cancels this note: remove it if empty, otherwise just commit.
        const empty = ta.value.trim() === "";
        ta.blur();
        if (empty) this.#store.remove(a.id);
      }
    });
    wrap.appendChild(ta);
    wrap.appendChild(this.#micButton(a.id, Boolean(a.voiceNote)));
    const del = document.createElement("button");
    del.className = "icon-btn del-btn";
    del.title = "Delete this note";
    del.setAttribute("aria-label", "Delete text note");
    del.textContent = "✕";
    del.addEventListener("click", () => this.#store.remove(a.id));
    wrap.appendChild(del);
    queueMicrotask(() => autoSize(ta));
    return wrap;
  }

  #renderPin(a: VoicePinAnnotation): HTMLElement {
    const local = this.#toLocal(a.position);
    const wrap = document.createElement("div");
    wrap.className = "marker pin-marker";
    wrap.style.left = `${local.x}px`;
    wrap.style.top = `${local.y}px`;
    wrap.style.setProperty("--pin", a.style.color);

    const dot = document.createElement("div");
    dot.className = "pin-dot";
    const recording = this.#recordingId === a.id;
    dot.textContent = recording ? "●" : a.voiceNote ? "🎙" : "＋";
    if (recording) dot.classList.add("recording");
    wrap.appendChild(dot);

    const bubble = document.createElement("div");
    bubble.className = "pin-bubble";
    const transcript = a.voiceNote?.transcript;
    const transcriptErr = a.voiceNote?.transcriptError;
    if (recording) {
      bubble.textContent = "Recording… speak now, then ■";
    } else if (transcript) {
      const truncated = transcript.length > 90;
      bubble.textContent = truncated
        ? `"${transcript.slice(0, 90)}…" (full note sent to agent)`
        : `"${transcript}"`;
    } else if (transcriptErr) {
      bubble.textContent = "🔊 voice note (transcript unavailable)";
    } else if (a.voiceNote) {
      bubble.textContent = "🔊 voice note attached";
    } else {
      bubble.textContent = "Press 🎤 to record";
    }
    wrap.appendChild(bubble);

    wrap.appendChild(this.#micButton(a.id, Boolean(a.voiceNote)));
    const del = document.createElement("button");
    del.className = "icon-btn del-btn";
    del.title = "Delete this pin";
    del.setAttribute("aria-label", "Delete voice pin");
    del.textContent = "✕";
    del.addEventListener("click", () => this.#store.remove(a.id));
    wrap.appendChild(del);
    return wrap;
  }

  #micButton(annotationId: string, has: boolean): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "icon-btn mic-btn";
    const recording = this.#recordingId === annotationId;
    btn.title = recording
      ? "Stop recording & save to this pin"
      : has
        ? "Replace voice note"
        : "Record audio note (attaches to this pin)";
    btn.setAttribute("aria-label", btn.title);
    btn.textContent = recording ? "■" : "🎤";
    btn.addEventListener("click", () => {
      if (this.#recordingId === annotationId) void this.#stopRecording(true);
      else void this.#startRecording(annotationId);
    });
    return btn;
  }

  // ---------- DOM scaffold ----------

  #buildDom(): void {
    const root = document.createElement("div");
    root.id = "overlay-root";
    root.innerHTML = `
      <div class="tint"></div>
      <svg id="vector" xmlns="${SVG_NS}"></svg>
      <div id="markers"></div>
      <div id="toolbar"></div>
      <div id="hint"></div>
      <div id="passthrough-banner" hidden>
        <span class="pt-dot"></span>
        <span id="pt-text">Using the app underneath — click below; press Esc to resume drawing.</span>
      </div>
      <div id="status"></div>
      <div id="shortcuts-panel" hidden></div>
      <div id="dest-picker" hidden></div>
      <div id="record-panel" hidden>
        <span class="rec-dot"></span><span class="rec-label">🎙 Recording audio note — your screen is <em>not</em> being recorded</span>
        <button id="rec-stop" class="btn primary">Stop &amp; attach</button>
        <button id="rec-cancel" class="btn">Cancel</button>
      </div>`;
    document.body.appendChild(root);
    this.#root = root;
    this.#svg = root.querySelector("#vector") as unknown as SVGSVGElement;
    this.#markers = root.querySelector("#markers") as HTMLDivElement;
    this.#toolbar = root.querySelector("#toolbar") as HTMLDivElement;
    this.#status = root.querySelector("#status") as HTMLDivElement;
    this.#status.setAttribute("role", "status");
    this.#status.setAttribute("aria-live", "polite");
    this.#recordPanel = root.querySelector("#record-panel") as HTMLDivElement;
    this.#recordPanel.setAttribute("aria-live", "polite");
    this.#hint = root.querySelector("#hint") as HTMLDivElement;
    this.#passthroughBanner = root.querySelector("#passthrough-banner") as HTMLDivElement;
    this.#picker = root.querySelector("#dest-picker") as HTMLDivElement;
    this.#shortcutsPanel = root.querySelector("#shortcuts-panel") as HTMLDivElement;

    this.#liveLayer = document.createElementNS(SVG_NS, "g");
    this.#liveLayer.id = "live";
    this.#committedLayer = document.createElementNS(SVG_NS, "g");
    this.#committedLayer.id = "committed";
    this.#svg.appendChild(this.#committedLayer);
    this.#svg.appendChild(this.#liveLayer);

    (root.querySelector("#rec-stop") as HTMLButtonElement).addEventListener("click", () =>
      this.#stopRecording(true),
    );
    (root.querySelector("#rec-cancel") as HTMLButtonElement).addEventListener("click", () =>
      this.#stopRecording(false),
    );
    this.#buildToolbar();
    this.#buildHint();
  }

  #buildHint(): void {
    this.#hint.innerHTML = `
      <button id="hint-dismiss" class="hint-x icon-btn" title="Dismiss (press ? for shortcuts)" aria-label="Dismiss tips">✕</button>
      <strong>Review mode</strong> — annotate one or more screen states, then send them to the agent.
      <span>Pick a tool and draw · use <em>+ Frame</em> to capture this state and move to the next · each frame keeps its own marks.</span>
      <span><strong>Your screen is captured only when you press Send</strong> — it's a screenshot with your marks, not a video.</span>
      <span class="keys">${this.#config.submitShortcutLabel} send · Esc exit · ${this.#config.passthroughShortcutLabel} use the app underneath · ? all shortcuts</span>`;
    this.#hint.querySelector("#hint-dismiss")?.addEventListener("click", () => {
      this.#hint.style.display = "none";
      try {
        localStorage.setItem("overlayReview.hintDismissed", "1");
      } catch {
        /* ignore */
      }
    });
    this.#buildShortcutsPanel();
  }

  #buildShortcutsPanel(): void {
    const c = this.#config;
    this.#shortcutsPanel.innerHTML = `
      <button class="sc-close icon-btn" title="Close (Esc)" aria-label="Close shortcuts">✕</button>
      <div class="sc-title">Keyboard shortcuts</div>
      <div><kbd>P</kbd> Pen · <kbd>R</kbd> Box · <kbd>A</kbd> Arrow · <kbd>T</kbd> Text · <kbd>C</kbd> Voice note</div>
      <div><kbd>Alt+N</kbd> add frame · <kbd>Alt+P</kbd> previous frame · <kbd>Alt+→</kbd>/<kbd>Alt+←</kbd> next/previous</div>
      <div><kbd>Ctrl/⌘+Z</kbd> undo · <kbd>Shift+Z</kbd> redo</div>
      <div><kbd>${c.submitShortcutLabel}</kbd> send to agent</div>
      <div><kbd>${c.passthroughShortcutLabel}</kbd> use the app underneath</div>
      <div><kbd>Esc</kbd> cancel / exit · <kbd>?</kbd> toggle this panel</div>`;
    this.#shortcutsPanel
      .querySelector(".sc-close")
      ?.addEventListener("click", () => this.#toggleShortcutsPanel(false));
  }

  #flashHint(): void {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem("overlayReview.hintDismissed") === "1";
    } catch {
      /* ignore */
    }
    if (dismissed) {
      this.#hint.style.display = "none";
      return;
    }
    this.#hint.style.display = "";
    this.#hint.classList.remove("flash");
    void this.#hint.offsetWidth;
    this.#hint.classList.add("flash");
  }

  #buildToolbar(): void {
    this.#toolbar.replaceChildren();

    // Row 1: tools + colors.
    const row1 = document.createElement("div");
    row1.className = "toolbar-row";

    const group = document.createElement("div");
    group.className = "tool-group";
    for (const t of TOOLS) {
      const btn = document.createElement("button");
      btn.className = "tool-btn";
      btn.dataset["tool"] = t.tool;
      btn.title = `${t.label} (${t.key})`;
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-keyshortcuts", t.key);
      btn.innerHTML = `<span class="glyph">${t.glyph}</span><span class="lbl">${t.label}</span>`;
      btn.addEventListener("click", () => this.#selectTool(t.tool));
      group.appendChild(btn);
    }
    row1.appendChild(group);

    const colors = document.createElement("div");
    colors.className = "color-group";
    colors.setAttribute("role", "radiogroup");
    colors.setAttribute("aria-label", "Ink color");
    for (const c of this.#config.colors) {
      const sw = document.createElement("button");
      sw.className = "swatch";
      sw.style.background = c;
      sw.title = c;
      sw.setAttribute("role", "radio");
      sw.setAttribute("aria-label", `Color ${c}`);
      sw.setAttribute("aria-checked", c === this.#color ? "true" : "false");
      sw.tabIndex = c === this.#color ? 0 : -1;
      const pick = (): void => {
        this.#color = c;
        for (const s of colors.querySelectorAll(".swatch")) {
          s.classList.remove("active");
          s.setAttribute("aria-checked", "false");
          (s as HTMLElement).tabIndex = -1;
        }
        sw.classList.add("active");
        sw.setAttribute("aria-checked", "true");
        sw.tabIndex = 0;
      };
      sw.addEventListener("click", pick);
      if (c === this.#color) sw.classList.add("active");
      colors.appendChild(sw);
    }
    colors.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const all = [...colors.querySelectorAll<HTMLElement>(".swatch")];
      const idx = all.findIndex((s) => s === document.activeElement);
      if (idx < 0) return;
      const next =
        e.key === "ArrowRight" ? (idx + 1) % all.length : (idx - 1 + all.length) % all.length;
      all[next]?.focus();
      all[next]?.click();
    });
    row1.appendChild(colors);
    this.#toolbar.appendChild(row1);

    const frames = document.createElement("div");
    frames.className = "frame-group toolbar-row";
    frames.appendChild(
      this.#actionBtn("‹ Prev", "Previous frame", () => {
        void this.#requestFrameAction("previous");
      }),
    );
    frames.appendChild(
      this.#actionBtn("Move ‹", "Move frame earlier", () => {
        void this.#requestFrameAction("move-previous");
      }),
    );
    const frameCount = document.createElement("span");
    frameCount.id = "frame-count";
    frameCount.className = "frame-count";
    frames.appendChild(frameCount);
    frames.appendChild(
      this.#actionBtn("+ Frame", "Capture this frame and add another", () => {
        void this.#requestFrameAction("add");
      }),
    );
    frames.appendChild(
      this.#actionBtn("Move ›", "Move frame later", () => {
        void this.#requestFrameAction("move-next");
      }),
    );
    frames.appendChild(
      this.#actionBtn("Next ›", "Next frame", () => {
        void this.#requestFrameAction("next");
      }),
    );
    frames.appendChild(
      this.#actionBtn("Delete frame", "Delete or clear the current frame", () => {
        void this.#requestFrameAction("delete");
      }),
    );
    this.#toolbar.appendChild(frames);

    // Row 3: actions.
    const actions = document.createElement("div");
    actions.className = "action-group toolbar-row";
    actions.appendChild(this.#actionBtn("↶ Undo", "Undo (Ctrl+Z)", () => this.#store.undo()));
    actions.appendChild(this.#actionBtn("↷ Redo", "Redo (Ctrl+Shift+Z)", () => this.#store.redo()));
    actions.appendChild(this.#actionBtn("🗑 Clear", "Clear all", () => this.#store.clear()));
    const pt = this.#actionBtn(
      "⤧ Use app",
      `Use the app underneath — click below (${this.#config.passthroughShortcutLabel})`,
      () => this.#bridge.requestPassthrough({ on: true }),
    );
    pt.classList.add("pt-btn");
    actions.appendChild(pt);
    const submit = this.#actionBtn(
      "➤ Send to agent",
      `Submit review (${this.#config.submitShortcutLabel})`,
      () => {
        void this.#requestSubmit();
      },
    );
    submit.classList.add("primary");
    submit.id = "submit-btn";
    actions.appendChild(submit);
    actions.appendChild(this.#actionBtn("✕ Exit", "Exit review (Esc)", () => this.#requestExit()));
    this.#toolbar.appendChild(actions);

    this.#selectTool(this.#tool, false);
    this.#updateToolbarCounts();
  }

  #actionBtn(label: string, title: string, on: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.title = title;
    btn.textContent = label;
    btn.addEventListener("click", on);
    return btn;
  }

  #updateToolbarCounts(): void {
    const submit = this.#toolbar.querySelector("#submit-btn");
    const total = this.#frameState.totalAnnotationCount || this.#store.size;
    if (submit) {
      submit.textContent = `Send all (${total})`;
      (submit as HTMLButtonElement).classList.toggle("empty", total === 0);
    }
    const frameCount = this.#toolbar.querySelector("#frame-count");
    if (frameCount) {
      frameCount.textContent = `Frame ${this.#frameState.index + 1} / ${this.#frameState.count}`;
    }
    const frameButtons = [
      ...this.#toolbar.querySelectorAll<HTMLButtonElement>(".frame-group .btn"),
    ];
    const [prev, movePrev, add, moveNext, next, del] = frameButtons;
    const busy = Boolean(this.#frameState.busy);
    if (prev) prev.disabled = busy || this.#frameState.index <= 0;
    if (movePrev) movePrev.disabled = busy || this.#frameState.index <= 0;
    if (add) add.disabled = busy;
    if (moveNext) moveNext.disabled = busy || this.#frameState.index >= this.#frameState.count - 1;
    if (next) next.disabled = busy || this.#frameState.index >= this.#frameState.count - 1;
    if (del) {
      del.disabled = busy;
      del.textContent = this.#frameState.count <= 1 ? "Clear frame" : "Delete frame";
    }
  }

  async #requestFrameAction(action: FrameActionRequest["action"]): Promise<void> {
    if (!this.#active || this.#frameState.busy) return;
    if (this.#recordingId) {
      this.#showNotice("Finishing your voice note…", "info", 0);
      await this.#stopRecording(true);
    }
    if (this.#editing) this.#endTextEditing(false);
    this.#bridge.frameAction({ action });
  }

  #toggleShortcutsPanel(force?: boolean): void {
    const show = force ?? this.#shortcutsPanel.hidden;
    this.#shortcutsPanel.hidden = !show;
    if (show) {
      this.#shortcutsPanel.setAttribute("role", "dialog");
      this.#shortcutsPanel.setAttribute("aria-label", "Keyboard shortcuts");
      queueMicrotask(() =>
        this.#shortcutsPanel.querySelector<HTMLButtonElement>(".sc-close")?.focus(),
      );
    }
  }

  // ---------- submit routing / destination picker ----------

  #submitInFlight = false;

  async #requestSubmit(): Promise<void> {
    if (!this.#active || this.#submitInFlight) return;
    this.#submitInFlight = true;
    try {
      // Finalize an in-progress voice note first, so the recording is stopped,
      // attached and transcribed instead of being silently discarded by the
      // submit + clear (which would delete the pin the audio belongs to).
      if (this.#recordingId) {
        this.#showNotice("Finishing your voice note…", "info", 0);
        await this.#stopRecording(true);
      }
      // Session-scoped: send straight to the bound session, no picker. The main
      // process is authoritative for emptiness (it aggregates every display), so
      // we do NOT hard-block here on this display's local count — marks may live
      // on another monitor. Main shows "Nothing to send yet" if truly empty.
      if (this.#boundSessionId) {
        this.#submitTo({
          sessionId: this.#boundSessionId,
          sessionTitle: this.#boundSessionTitle,
          isNew: false,
        });
        return;
      }
      // Freestyle with known destinations: let the user choose (avoid opening an
      // empty picker when this single-window freestyle session has nothing).
      if (this.#destinations.length > 0) {
        if (this.#frameState.totalAnnotationCount === 0 && this.#store.size === 0) {
          this.#showNotice(
            "Nothing to send yet — draw, type, or drop a voice pin first.",
            "info",
            2600,
          );
          return;
        }
        this.#openPicker();
        return;
      }
      // Freestyle, no destinations available: start a new session.
      this.#submitTo({ isNew: true });
    } finally {
      this.#submitInFlight = false;
    }
  }

  #submitTo(target: ReviewTarget): void {
    this.#closePicker();
    this.#bridge.submit({ target });
  }

  #openPicker(): void {
    const submitLabel = this.#config.submitShortcutLabel;
    const rows: string[] = [];
    rows.push(
      `<button class="picker-row picker-new" data-new="1">＋ New session <span class="picker-hint">default · Enter</span></button>`,
    );
    for (const d of this.#destinations.slice(0, 8)) {
      rows.push(
        `<button class="picker-row" data-id="${escapeHtml(d.id)}">${escapeHtml(d.title)}</button>`,
      );
    }
    this.#picker.innerHTML = `
      <div class="picker-title" id="picker-title">Send review to…</div>
      ${rows.join("")}
      <button class="picker-cancel" data-cancel="1">Cancel (Esc)</button>`;
    this.#picker.setAttribute("role", "dialog");
    this.#picker.setAttribute("aria-modal", "true");
    this.#picker.setAttribute("aria-labelledby", "picker-title");
    this.#picker.hidden = false;
    this.#picker.querySelectorAll<HTMLButtonElement>(".picker-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset["new"]) this.#submitTo({ isNew: true });
        else {
          const id = btn.dataset["id"]!;
          const dest = this.#destinations.find((d) => d.id === id);
          this.#submitTo({ sessionId: id, sessionTitle: dest?.title, isNew: false });
        }
      });
    });
    this.#picker
      .querySelector<HTMLButtonElement>("[data-cancel]")
      ?.addEventListener("click", () => this.#closePicker());
    // Focus the default (New session) for keyboard users.
    queueMicrotask(() => this.#picker.querySelector<HTMLButtonElement>(".picker-new")?.focus());
    void submitLabel;
  }

  #closePicker(): void {
    const wasOpen = !this.#picker.hidden;
    this.#picker.hidden = true;
    this.#picker.replaceChildren();
    // Return focus to the Send button so keyboard users are not stranded.
    if (wasOpen) this.#toolbar.querySelector<HTMLButtonElement>("#submit-btn")?.focus();
  }

  #pickerOpen(): boolean {
    return !this.#picker.hidden;
  }

  #confirmingExit = false;
  #confirmExitTimer: ReturnType<typeof setTimeout> | undefined;

  #requestExit(): void {
    const n = this.#store.size;
    if (n === 0 || this.#confirmingExit) {
      this.#confirmingExit = false;
      if (this.#confirmExitTimer) clearTimeout(this.#confirmExitTimer);
      this.#bridge.exit();
      return;
    }
    // First exit attempt with unsent marks: confirm.
    this.#confirmingExit = true;
    this.#showNotice(
      `${n} unsent mark(s) — press ${this.#config.submitShortcutLabel} to send, or Esc/Exit again to discard.`,
      "error",
      4000,
    );
    if (this.#confirmExitTimer) clearTimeout(this.#confirmExitTimer);
    this.#confirmExitTimer = setTimeout(() => {
      this.#confirmingExit = false;
    }, 4000);
  }

  #onKeyDown(e: KeyboardEvent): void {
    if (!this.#active) return;
    if (this.#editing && e.key !== "Escape") return;
    const k = e.key.toLowerCase();
    if (e.key === "Escape") {
      if (this.#pickerOpen()) this.#closePicker();
      else if (!this.#shortcutsPanel.hidden) this.#toggleShortcutsPanel(false);
      else if (this.#recordingId) void this.#stopRecording(false);
      else if (this.#resize) this.#cancelResize();
      else if (this.#move) this.#cancelMove();
      else if (this.#drag) this.#cancelDrag();
      else if (this.#editing) this.#endTextEditing(true);
      else if (this.#selectedId) this.#setSelected(null);
      else if (this.#passthrough) this.#bridge.requestPassthrough({ on: false });
      else this.#requestExit();
      return;
    }
    if (this.#pickerOpen() && e.key === "Enter") {
      e.preventDefault();
      const focused = document.activeElement as HTMLElement | null;
      if (focused && focused.classList.contains("picker-row")) focused.click();
      else this.#submitTo({ isNew: true });
      return;
    }
    if (this.#pickerOpen() && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const rows = [...this.#picker.querySelectorAll<HTMLButtonElement>(".picker-row")];
      if (rows.length) {
        const cur = rows.findIndex((r) => r === document.activeElement);
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = cur < 0 ? 0 : (cur + delta + rows.length) % rows.length;
        rows[next]?.focus();
      }
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this.#selectedId) {
      e.preventDefault();
      const id = this.#selectedId;
      this.#selectedId = null;
      this.#store.remove(id);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k === "z") {
      e.preventDefault();
      if (e.shiftKey) this.#store.redo();
      else this.#store.undo();
      return;
    }
    if (e.altKey && (k === "n" || e.key === "ArrowRight")) {
      e.preventDefault();
      void this.#requestFrameAction(k === "n" ? "add" : "next");
      return;
    }
    if (e.altKey && (k === "p" || e.key === "ArrowLeft")) {
      e.preventDefault();
      void this.#requestFrameAction("previous");
      return;
    }
    if (e.key === "?" || (e.shiftKey && k === "/")) {
      this.#toggleShortcutsPanel();
      return;
    }
    if (e.ctrlKey || e.metaKey || this.#passthrough) return;
    const match = TOOLS.find((t) => t.key.toLowerCase() === k);
    if (match) this.#selectTool(match.tool);
  }

  // ---------- test hook ----------

  #exposeTestApi(): void {
    const api = {
      addPin: (x: number, y: number, label?: string): string => {
        const id = this.#nextId();
        const pin: VoicePinAnnotation = {
          id,
          kind: "voicePin",
          displayId: this.#display.id,
          createdAt: Date.now(),
          style: this.#style(),
          position: this.#toGlobal({ x, y }),
        };
        if (label) pin.label = label;
        this.#store.add(pin);
        return id;
      },
      addRect: (x: number, y: number, w: number, h: number): string => {
        const id = this.#nextId();
        this.#store.add({
          id,
          kind: "rectangle",
          displayId: this.#display.id,
          createdAt: Date.now(),
          style: this.#style(),
          rect: rectFromPoints(this.#toGlobal({ x, y }), this.#toGlobal({ x: x + w, y: y + h })),
        });
        return id;
      },
      addText: (x: number, y: number, text: string): string => {
        const id = this.#nextId();
        this.#store.add({
          id,
          kind: "text",
          displayId: this.#display.id,
          createdAt: Date.now(),
          style: { ...this.#style(), fontSize: 18 },
          text,
          position: this.#toGlobal({ x, y }),
        });
        return id;
      },
      clickToolbar: (tool: ToolKind): boolean => {
        const btn = this.#toolbar.querySelector<HTMLButtonElement>(`[data-tool="${tool}"]`);
        if (!btn) return false;
        btn.click();
        return this.#tool === tool;
      },
      selectAt: (x: number, y: number): string | null => {
        this.#beginSelectOrMove({ x, y }, 1);
        this.#move = null;
        return this.#selectedId;
      },
      moveSelectedBy: (dxLocal: number, dyLocal: number): boolean => {
        const id = this.#selectedId;
        if (!id) return false;
        const a = this.#store.getById(id);
        if (!a) return false;
        this.#store.checkpoint();
        this.#store.setAnnotation(id, translateAnnotation(a, dxLocal, dyLocal), false);
        return true;
      },
      resizeSelectedBy: (handle: HandleId, dxLocal: number, dyLocal: number): boolean => {
        const id = this.#selectedId;
        if (!id) return false;
        const a = this.#store.getById(id);
        if (!a) return false;
        this.#store.checkpoint();
        this.#store.setAnnotation(id, resizeAnnotation(a, handle, dxLocal, dyLocal), false);
        return true;
      },
      deleteSelected: (): boolean => {
        const id = this.#selectedId;
        if (!id) return false;
        this.#selectedId = null;
        return this.#store.remove(id);
      },
      annotationAnchorLocal: (id: string): { x: number; y: number } | null => {
        const a = this.#store.getById(id);
        if (!a) return null;
        const g =
          a.kind === "rectangle"
            ? { x: a.rect.x + a.rect.width / 2, y: a.rect.y + a.rect.height / 2 }
            : a.kind === "voicePin" || a.kind === "text"
              ? a.position
              : { x: 0, y: 0 };
        return this.#toLocal(g);
      },
      requestSubmit: (): void => {
        void this.#requestSubmit();
      },
      pickerVisible: (): boolean => this.#pickerOpen(),
      pickerOptions: (): string[] =>
        [...this.#picker.querySelectorAll<HTMLButtonElement>(".picker-row")].map((b) =>
          (b.textContent ?? "").trim(),
        ),
      pickerPick: (index: number): boolean => {
        const rows = this.#picker.querySelectorAll<HTMLButtonElement>(".picker-row");
        const btn = rows[index];
        if (!btn) return false;
        btn.click();
        return true;
      },
      state: () => ({
        active: this.#active,
        passthrough: this.#passthrough,
        tool: this.#tool,
        recording: this.#recordingId !== null,
        recordPanelHidden: this.#recordPanel.hidden,
        toolbarVisible: getComputedStyle(this.#toolbar).opacity !== "0",
        count: this.#store.size,
        editing: this.#editing,
        selectedId: this.#selectedId,
        boundSessionId: this.#boundSessionId ?? null,
        destinations: this.#destinations.length,
        pickerVisible: this.#pickerOpen(),
        frame: { ...this.#frameState },
      }),
    };
    (window as unknown as { __overlayTest?: typeof api }).__overlayTest = api;
  }
}

function toPathD(points: readonly Point[]): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  let d = `M ${first!.x} ${first!.y}`;
  for (const p of rest) d += ` L ${p.x} ${p.y}`;
  return d;
}

function autoSize(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
  ta.style.width = "auto";
  ta.style.width = `${Math.min(420, Math.max(120, ta.scrollWidth + 4))}px`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

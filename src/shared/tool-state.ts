import type { OverlayMode, ToolKind } from './types.ts';

/**
 * Events that drive the overlay interaction state machine.
 *
 * The machine's job is to decide, at every moment, the {@link OverlayMode} and
 * therefore whether the overlay window should capture the mouse (interactive)
 * or let clicks pass through to the underlying app. Keeping this logic pure and
 * explicit prevents "stuck" states where the overlay eats all clicks or passes
 * through when it should be drawing.
 */
export type InteractionEvent =
  | { type: 'enterReview' }
  | { type: 'exitReview' }
  | { type: 'pointerEnterHud' }
  | { type: 'pointerLeaveHud' }
  | { type: 'gestureStart' }
  | { type: 'gestureEnd' }
  | { type: 'beginTextEdit' }
  | { type: 'endTextEdit' }
  | { type: 'beginVoice' }
  | { type: 'endVoice' }
  | { type: 'beginSubmit' }
  | { type: 'endSubmit' }
  | { type: 'fail' }
  | { type: 'recover' }
  | { type: 'escape' };

/** Modes in which the overlay must capture mouse input (not click-through). */
const CAPTURING_MODES: ReadonlySet<OverlayMode> = new Set<OverlayMode>([
  'hudHover',
  'drawing',
  'textEditing',
  'voiceRecording',
]);

/** Tools that produce a drag gesture and need capture from down..up. */
const GESTURE_TOOLS: ReadonlySet<ToolKind> = new Set<ToolKind>([
  'pen',
  'rectangle',
  'arrow',
]);

export function isCapturingMode(mode: OverlayMode): boolean {
  return CAPTURING_MODES.has(mode);
}

export function toolUsesGesture(tool: ToolKind): boolean {
  return GESTURE_TOOLS.has(tool);
}

/** Pure transition function. Unknown transitions keep the current mode. */
export function nextMode(current: OverlayMode, event: InteractionEvent): OverlayMode {
  switch (event.type) {
    case 'enterReview':
      return current === 'idle' ? 'passthrough' : current;
    case 'exitReview':
      return 'idle';
    case 'escape':
      // Cancel any active sub-interaction; never leave review entirely.
      return current === 'idle' ? 'idle' : 'passthrough';
    case 'fail':
      return 'error';
    case 'recover':
      return current === 'error' ? 'passthrough' : current;
  }

  // The remaining events only apply while in review (not idle/error).
  if (current === 'idle' || current === 'error') return current;

  switch (event.type) {
    case 'pointerEnterHud':
      return current === 'passthrough' ? 'hudHover' : current;
    case 'pointerLeaveHud':
      return current === 'hudHover' ? 'passthrough' : current;
    case 'gestureStart':
      return current === 'passthrough' || current === 'hudHover'
        ? 'drawing'
        : current;
    case 'gestureEnd':
      return current === 'drawing' ? 'passthrough' : current;
    case 'beginTextEdit':
      return 'textEditing';
    case 'endTextEdit':
      return current === 'textEditing' ? 'passthrough' : current;
    case 'beginVoice':
      return 'voiceRecording';
    case 'endVoice':
      return current === 'voiceRecording' ? 'passthrough' : current;
    case 'beginSubmit':
      return 'submitting';
    case 'endSubmit':
      return current === 'submitting' ? 'passthrough' : current;
    default:
      return current;
  }
}

export interface MachineSnapshot {
  mode: OverlayMode;
  tool: ToolKind;
  /** True when the overlay should be interactive (capture the mouse). */
  capturing: boolean;
}

/** Stateful wrapper around {@link nextMode} with the active tool. */
export class InteractionMachine {
  #mode: OverlayMode = 'idle';
  #tool: ToolKind = 'select';
  #onChange: ((s: MachineSnapshot) => void) | undefined;

  constructor(onChange?: (s: MachineSnapshot) => void) {
    this.#onChange = onChange;
  }

  get mode(): OverlayMode {
    return this.#mode;
  }

  get tool(): ToolKind {
    return this.#tool;
  }

  get capturing(): boolean {
    // While submitting the overlay is hidden, so it should not capture.
    return isCapturingMode(this.#mode);
  }

  snapshot(): MachineSnapshot {
    return { mode: this.#mode, tool: this.#tool, capturing: this.capturing };
  }

  setTool(tool: ToolKind): MachineSnapshot {
    if (tool !== this.#tool) {
      this.#tool = tool;
      this.#emit();
    }
    return this.snapshot();
  }

  send(event: InteractionEvent): MachineSnapshot {
    const next = nextMode(this.#mode, event);
    if (next !== this.#mode) {
      this.#mode = next;
      this.#emit();
    }
    return this.snapshot();
  }

  #emit(): void {
    this.#onChange?.(this.snapshot());
  }
}

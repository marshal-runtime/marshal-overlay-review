/**
 * Public, framework-free surface of the overlay's domain logic. Safe to import
 * from both the Electron main process and the renderer, and unit-testable
 * without a display.
 */
export * from './types.ts';
export * from './geometry.ts';
export * from './id.ts';
export * from './annotation-store.ts';
export * from './tool-state.ts';
export * from './review.ts';
export * from './attachments.ts';

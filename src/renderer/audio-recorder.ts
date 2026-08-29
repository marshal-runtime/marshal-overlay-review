import type { VoiceClip } from '../shared/types.ts';

const PREFERRED_MIME = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of PREFERRED_MIME) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error ?? new Error('read failed'));
    fr.onloadend = () => {
      const result = typeof fr.result === 'string' ? fr.result : '';
      resolve(result.split(',')[1] ?? '');
    };
    fr.readAsDataURL(blob);
  });
}

/**
 * Thin wrapper around MediaRecorder that yields a {@link VoiceClip}
 * (base64 audio + mime + duration). Handles permission errors and missing
 * microphones gracefully so a failed recording never wedges the overlay.
 */
export class AudioRecorder {
  #media: MediaRecorder | undefined;
  #stream: MediaStream | undefined;
  #chunks: Blob[] = [];
  #startedAt = 0;

  get recording(): boolean {
    return this.#media?.state === 'recording';
  }

  async start(): Promise<void> {
    if (this.recording) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone not available in this environment');
    }
    this.#stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const mime = pickMime();
      this.#media = new MediaRecorder(
        this.#stream,
        mime ? { mimeType: mime } : undefined,
      );
      this.#chunks = [];
      this.#media.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) this.#chunks.push(e.data);
      };
      this.#media.start();
      this.#startedAt = performance.now();
    } catch (err) {
      // MediaRecorder construction/start failed — release the live mic stream.
      this.#cleanup();
      throw err;
    }
  }

  async stop(): Promise<VoiceClip> {
    const media = this.#media;
    const stream = this.#stream;
    const chunks = this.#chunks;
    if (!media) throw new Error('Not recording');
    // Detach from the instance up-front so a concurrent start() creates a fresh
    // recorder/stream that this stop() will not tear down in its finally block.
    if (this.#media === media) this.#media = undefined;
    if (this.#stream === stream) this.#stream = undefined;
    if (this.#chunks === chunks) this.#chunks = [];
    try {
      const durationMs = Math.max(0, Math.round(performance.now() - this.#startedAt));
      const stopped = new Promise<void>((resolve) => {
        media.addEventListener('stop', () => resolve(), { once: true });
      });
      media.stop();
      await stopped;
      const blob = new Blob(chunks, { type: media.mimeType || 'audio/webm' });
      const audioBase64 = await blobToBase64(blob);
      const mimeType = media.mimeType || 'audio/webm';
      return { audioBase64, mimeType, durationMs };
    } finally {
      // Release only THIS recording's mic stream, never a newer one.
      stream?.getTracks().forEach((t) => t.stop());
    }
  }

  cancel(): void {
    try {
      if (this.#media && this.#media.state !== 'inactive') this.#media.stop();
    } catch {
      /* ignore */
    }
    this.#cleanup();
  }

  #cleanup(): void {
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = undefined;
    this.#media = undefined;
    this.#chunks = [];
  }
}

// Lain's mouth while she speaks. The native voice sends one track per sentence: how open her
// mouth is every 20 ms, stamped with the wall-clock time that audio will be heard. The avatar
// samples it every frame, so the jaw moves with the sound rather than with a timer.

type Segment = { at: number; step: number; open: Uint8Array };

export class MouthTrack {
  private segments: Segment[] = [];
  /**
   * True when her neural voice is installed: it always sends tracks, so no track means silence
   * (e.g. the static lead-in). False for the system voice, which sends none.
   */
  driven = false;

  /** Adds a sentence. `open` is comma-separated 0–100 values, one per `step` ms from `at` (epoch ms). */
  push(at: number, step: number, open: string) {
    const values = Uint8Array.from(open.split(','), Number);
    const now = Date.now();
    this.segments = this.segments.filter((s) => s.at + s.step * s.open.length > now - 1000);
    this.segments.push({ at, step, open: values });
  }

  clear() {
    this.segments = [];
  }

  /**
   * Mouth openness 0–1 at `now`: 0 when nothing is being heard. null only for the system voice,
   * which has no track, so the avatar animates on its own.
   */
  sample(now: number): number | null {
    if (!this.driven) return null;
    for (const s of this.segments) {
      const index = (now - s.at) / s.step;
      if (index < 0 || index >= s.open.length) continue;
      const i = Math.floor(index);
      const next = s.open[Math.min(i + 1, s.open.length - 1)];
      return (s.open[i] + (next - s.open[i]) * (index - i)) / 100;
    }
    return 0;
  }
}

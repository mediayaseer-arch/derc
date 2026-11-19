export const VISITOR_ALERT_SOUND_URL = "/notification.mp3";

export type VisitorAlertAudio = {
  preload: string;
  volume: number;
  currentTime?: number;
  play: () => Promise<unknown>;
};

export function playFallbackNotificationChime(volume = 0.35): void {
  try {
    if (typeof window === "undefined") return;
    const Ctx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;

    // First note: D5 (587.33 Hz) short crisp attack
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(587.33, now);
    gain1.gain.setValueAtTime(volume, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.13);

    // Second note: A5 (880 Hz) + harmonic (1760 Hz) resonant chime
    const start2 = now + 0.12;
    const osc2 = ctx.createOscillator();
    const osc2Harm = ctx.createOscillator();
    const gain2 = ctx.createGain();
    const gain2Harm = ctx.createGain();

    osc2.type = "sine";
    osc2.frequency.setValueAtTime(880, start2);
    gain2.gain.setValueAtTime(volume, start2);
    gain2.gain.exponentialRampToValueAtTime(0.0008, start2 + 0.72);

    osc2Harm.type = "sine";
    osc2Harm.frequency.setValueAtTime(1760, start2);
    gain2Harm.gain.setValueAtTime(volume * 0.28, start2);
    gain2Harm.gain.exponentialRampToValueAtTime(0.0005, start2 + 0.55);

    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2Harm.connect(gain2Harm);
    gain2Harm.connect(ctx.destination);

    osc2.start(start2);
    osc2.stop(start2 + 0.75);
    osc2Harm.start(start2);
    osc2Harm.stop(start2 + 0.58);
  } catch {
    // Ignore Web Audio errors
  }
}

export function playVisitorAlertSound(
  createAudio: () => VisitorAlertAudio
): void {
  try {
    const audio = createAudio();
    audio.preload = "auto";
    audio.volume = 0.9;
    if (typeof audio.currentTime === "number") {
      audio.currentTime = 0;
    }
    void audio.play().catch(() => {
      playFallbackNotificationChime();
    });
  } catch {
    playFallbackNotificationChime();
  }
}

export function distinctVisitorAlertKinds<T extends string>(
  kinds: readonly T[]
): T[] {
  return Array.from(new Set(kinds));
}

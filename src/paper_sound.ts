/** Paper effects use a gesture-unlocked context so automatic turns also work on mobile. */
type PaperSound = "book_open" | "page_turn";
let context: AudioContext | undefined;
const buffers = new Map<PaperSound, Promise<AudioBuffer>>();

/** Unlock effects during a click so mobile browsers allow later automatic page turns. */
export function unlockPaperSounds(enabled: boolean): void {
  if (!enabled) return;
  try {
    context ??= new AudioContext();
    void context.resume().catch(() => {});
    for (const kind of ["book_open", "page_turn"] as const) {
      if (buffers.has(kind)) continue;
      const current = context;
      const loading = fetch(`/sounds/${kind}.wav`)
        .then((response) => {
          if (!response.ok) throw new Error("Som de papel indisponível.");
          return response.arrayBuffer();
        })
        .then((bytes) => current.decodeAudioData(bytes));
      buffers.set(kind, loading);
      void loading.catch(() => buffers.delete(kind));
    }
  } catch {
    // Effects are optional when the browser cannot provide Web Audio.
  }
}

/** Mix cached paper independently of the narration element and its pause state. */
export function playPaperSound(kind: PaperSound, enabled: boolean): void {
  if (!enabled) return;
  unlockPaperSounds(enabled);
  const current = context;
  const buffer = buffers.get(kind);
  if (!current || !buffer) return;
  void buffer
    .then((decoded) => {
      if (current.state !== "running") return;
      const source = current.createBufferSource();
      const gain = current.createGain();
      source.buffer = decoded;
      gain.gain.value = kind === "book_open" ? 0.4 : 0.36;
      source.connect(gain);
      gain.connect(current.destination);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
      };
      source.start();
    })
    .catch(() => {});
}

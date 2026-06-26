export interface RecorderApi {
  toggle(): Promise<void>;
  play(): void;
  hasRecording(): boolean;
  isRecording(): boolean;
}

export interface RecorderOpts {
  onStateChange?: (state: 'idle' | 'recording' | 'has-recording') => void;
  onError?: (msg: string) => void;
}

export function initRecorder(opts: RecorderOpts = {}): RecorderApi {
  let mediaRecorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let lastUrl: string | null = null;
  let playbackEl: HTMLAudioElement | null = null;
  let recording = false;

  function emit() {
    opts.onStateChange?.(recording ? 'recording' : lastUrl ? 'has-recording' : 'idle');
  }

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunks = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        if (lastUrl) URL.revokeObjectURL(lastUrl);
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        lastUrl = URL.createObjectURL(blob);
        recording = false;
        emit();
      };
      mr.start();
      mediaRecorder = mr;
      recording = true;
      emit();
    } catch (err) {
      opts.onError?.(`mic error: ${(err as Error).message}`);
      recording = false;
      emit();
    }
  }

  function stop() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      mediaRecorder = null;
    }
  }

  return {
    async toggle() { recording ? stop() : await start(); },
    play() {
      if (!lastUrl) return;
      if (!playbackEl) playbackEl = new Audio();
      playbackEl.src = lastUrl;
      playbackEl.currentTime = 0;
      playbackEl.play().catch(() => {});
    },
    hasRecording: () => !!lastUrl,
    isRecording: () => recording,
  };
}

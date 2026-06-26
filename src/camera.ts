const DEVICE_KEY = 'phonetic_atlas_cam_v1';

export function initCamera(): void {
  const toggleEl = document.getElementById('showCam') as HTMLInputElement | null;
  const chipEl = document.getElementById('chip-cam');
  const pipEl = document.getElementById('cam-pip');
  const videoEl = document.getElementById('cam-video') as HTMLVideoElement | null;
  const closeEl = document.getElementById('cam-close');
  const deviceEl = document.getElementById('cam-device') as HTMLSelectElement | null;
  const statusEl = document.getElementById('status');
  if (!toggleEl || !chipEl || !pipEl || !videoEl) return;

  let stream: MediaStream | null = null;

  function setStatus(msg: string) {
    if (statusEl) statusEl.textContent = msg;
  }

  function stopTracks() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    videoEl!.srcObject = null;
  }

  function stop() {
    stopTracks();
    pipEl!.setAttribute('hidden', '');
    chipEl!.classList.remove('on');
  }

  async function populateDevices() {
    if (!deviceEl || !navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const current = stream?.getVideoTracks()[0]?.getSettings().deviceId;
    deviceEl.innerHTML = cams
      .map((d, i) => `<option value="${d.deviceId}">${d.label || `Camera ${i + 1}`}</option>`)
      .join('');
    if (current) deviceEl.value = current;
    deviceEl.hidden = cams.length < 2;
  }

  async function openStream(deviceId: string | null) {
    stopTracks();
    const video: MediaTrackConstraints = deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: 'user' };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      if ((err as Error).name === 'OverconstrainedError' && deviceId) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' }, audio: false,
        });
      } else {
        throw err;
      }
    }
    videoEl!.srcObject = stream;
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('camera unavailable (needs https or localhost)');
      toggleEl!.checked = false;
      return;
    }
    try {
      await openStream(localStorage.getItem(DEVICE_KEY));
      pipEl!.removeAttribute('hidden');
      chipEl!.classList.add('on');
      setStatus('');
      await populateDevices();
    } catch (err) {
      setStatus('camera blocked: ' + (err as Error).name);
      toggleEl!.checked = false;
      stop();
    }
  }

  toggleEl.addEventListener('change', () => {
    if (toggleEl.checked) start();
    else stop();
  });

  closeEl?.addEventListener('click', () => {
    toggleEl.checked = false;
    stop();
  });

  deviceEl?.addEventListener('change', async () => {
    localStorage.setItem(DEVICE_KEY, deviceEl.value);
    try {
      await openStream(deviceEl.value);
    } catch (err) {
      setStatus('camera blocked: ' + (err as Error).name);
      toggleEl.checked = false;
      stop();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && stream) {
      toggleEl.checked = false;
      stop();
    }
  });

  window.addEventListener('pagehide', stop);

  const POS_KEY = 'phonetic_atlas_cam_pos_v1';
  const resizeEl = document.getElementById('cam-resize');

  function savePos() {
    localStorage.setItem(POS_KEY, JSON.stringify({
      left: pipEl!.style.left, top: pipEl!.style.top,
      width: pipEl!.style.width,
    }));
  }

  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (p) {
      if (p.width) pipEl.style.width = p.width;
      if (p.left && p.top) {
        pipEl.style.left = p.left;
        pipEl.style.top = p.top;
        pipEl.style.right = 'auto';
        pipEl.style.bottom = 'auto';
      }
    }
  } catch { /* ignore bad saved state */ }

  let drag: { sx: number; sy: number; ox: number; oy: number } | null = null;
  pipEl.addEventListener('pointerdown', e => {
    if ((e.target as HTMLElement).closest('button, select, .cam-resize')) return;
    const r = pipEl!.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    pipEl!.setPointerCapture(e.pointerId);
  });
  pipEl.addEventListener('pointermove', e => {
    if (!drag) return;
    const w = pipEl!.offsetWidth, h = pipEl!.offsetHeight;
    const l = Math.min(Math.max(0, drag.ox + e.clientX - drag.sx),
                       window.innerWidth - w);
    const t = Math.min(Math.max(0, drag.oy + e.clientY - drag.sy),
                       window.innerHeight - h);
    pipEl!.style.left = l + 'px';
    pipEl!.style.top = t + 'px';
    pipEl!.style.right = 'auto';
    pipEl!.style.bottom = 'auto';
  });
  pipEl.addEventListener('pointerup', e => {
    if (!drag) return;
    drag = null;
    pipEl!.releasePointerCapture(e.pointerId);
    savePos();
  });

  let rz: { sx: number; sw: number } | null = null;
  resizeEl?.addEventListener('pointerdown', e => {
    e.stopPropagation();
    rz = { sx: e.clientX, sw: pipEl!.offsetWidth };
    resizeEl!.setPointerCapture(e.pointerId);
  });
  resizeEl?.addEventListener('pointermove', e => {
    if (!rz) return;
    const max = Math.min(640,
      window.innerWidth - pipEl!.getBoundingClientRect().left - 8);
    pipEl!.style.width =
      Math.min(Math.max(140, rz.sw + e.clientX - rz.sx), max) + 'px';
  });
  resizeEl?.addEventListener('pointerup', e => {
    if (!rz) return;
    rz = null;
    resizeEl!.releasePointerCapture(e.pointerId);
    savePos();
  });

  window.addEventListener('resize', () => {
    if (pipEl!.hasAttribute('hidden') || !pipEl!.style.left) return;
    const r = pipEl!.getBoundingClientRect();
    pipEl!.style.left = Math.min(parseFloat(pipEl!.style.left),
      Math.max(0, window.innerWidth - r.width)) + 'px';
    pipEl!.style.top = Math.min(parseFloat(pipEl!.style.top),
      Math.max(0, window.innerHeight - r.height)) + 'px';
  });
}

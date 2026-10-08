// Browser-side helpers for tools/check-barcode.mjs: render barcode fixtures onto canvases.

/** Draw a 1D module string ('1' = bar) with quiet zones. */
export function drawLinear(modules, { moduleWidth = 3, height = 150, quiet = 15, margin = 20 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = (modules.length + quiet * 2) * moduleWidth;
  canvas.height = height + margin * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] === '1') ctx.fillRect((quiet + i) * moduleWidth, margin, moduleWidth, height);
  }
  return canvas;
}

/** Draw a 2D boolean matrix (true = dark) with a quiet zone. */
export function drawMatrix(matrix, { scale = 6, quiet = 4 } = {}) {
  const n = matrix.length;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = (n + quiet * 2) * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) if (matrix[y][x]) ctx.fillRect((quiet + x) * scale, (quiet + y) * scale, scale, scale);
  }
  return canvas;
}

/** A blank white canvas (must decode to nothing). */
export function blankCanvas(width = 320, height = 200) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

/**
 * A playing <video> fed by canvas.captureStream() (simulates a camera feed).
 * Resolves to null if the browser cannot produce a frame within `timeout` ms.
 */
export async function videoFromCanvas(canvas, { timeout = 5000 } = {}) {
  if (typeof canvas.captureStream !== 'function') return null;
  const ctx = canvas.getContext('2d');
  const snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let painting = true;
  const repaint = () => {
    if (!painting) return;
    ctx.putImageData(snapshot, 0, 0); // keep the canvas "dirty" so frames keep flowing
    requestAnimationFrame(repaint);
  };
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = canvas.captureStream(30);
  repaint();
  try {
    await video.play();
    const start = performance.now();
    while (!(video.readyState >= 2 && video.videoWidth > 0)) {
      if (performance.now() - start > timeout) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
    return {
      video,
      stop() {
        painting = false;
        video.pause();
        for (const track of video.srcObject.getTracks()) track.stop();
      },
    };
  } catch {
    painting = false;
    return null;
  }
}

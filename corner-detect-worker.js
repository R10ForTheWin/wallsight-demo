/* ============================================================
   Corner-detection worker — runs OpenCV.js off the main thread.

   Why this file exists: loading opencv.js's ~10MB WASM module on the main
   thread appeared to block Safari badly enough that nothing else could
   run until it finished — not just slow, but frozen: no UI updates, no
   same-thread setTimeout firing, not even a plain synchronous button tap
   registering. Confirmed via real device testing, not simulated. Moving
   the load and all the OpenCV work here means no matter how long or how
   blocking that compile is, it can't freeze the page — the main thread
   stays free to run its own timeout and respond to taps regardless.

   Protocol (all messages are plain objects via postMessage):
     main -> worker: { type: "detect", reqId, buffer, width, height }
       buffer is a transferred ArrayBuffer of RGBA8 pixel data (the same
       already-downscaled ~480px-wide frame the main thread used to feed
       cv.imread(canvas) directly — resizing still happens on the main
       thread via canvas drawImage, not duplicated here).
     worker -> main: { type: "ready" }              — cv finished loading
                      { type: "result", reqId, quad } — quad is 4 {x,y}
                        points normalized to [0,1] within that frame, or
                        null if nothing found
                      { type: "error", reqId, message }
   ============================================================ */

// self.Module MUST be defined before importScripts runs — this is the
// standard Emscripten pattern (a pre-existing config object the generated
// code finds and calls back on), not something you can react to after the
// fact. Confirmed by direct testing: reacting afterwards (checking
// self.cv.getBuildInformation, or self.cv.onRuntimeInitialized, or even
// Promise.resolve(self.cv).then(...) on the thenable self.cv becomes in a
// worker) never resolved even after 2 real minutes — by the time
// importScripts returns, the library has already self-invoked its factory
// with an empty default Module, so nothing set afterward is in time to
// matter. Pre-defining Module here and letting the library find and use
// it resolves in under a second.
//
// Second, separate trap: resolve() with a plain boolean here, never with
// self.cv itself. self.cv remains thenable-shaped (has a .then method)
// even after real initialization, and passing it anywhere in a Promise
// chain — as a resolve() value OR returned from a .then() callback —
// makes the Promise spec's thenable-assimilation rules chain onto its
// non-standard .then instead of just using it as a value, which hangs
// forever (confirmed by direct testing: this alone, independent of the
// Module-timing issue above, was enough to hang it). getCv()'s callers
// read the self.cv global directly after awaiting; it's never passed
// through a resolved/returned value anywhere.
let cvReadyPromise = new Promise((resolve) => {
  self.Module = {
    onRuntimeInitialized() { resolve(true); },
  };
});
importScripts("opencv.js");
function getCv() {
  return cvReadyPromise;
}
getCv().then(() => postMessage({ type: "ready" }));

// Sorts 4 points into consistent rotational order around their centroid —
// identical to the main thread's old orderCorners().
function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  return pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

// Same validated pipeline as the old main-thread detectQuad(), just
// operating on an already-constructed Mat instead of cv.imread(canvas) —
// there's no canvas/DOM here, the main thread hands over raw pixels
// instead. See wallsight-demo.html's git history for the validation notes
// (tested against a real photo of this room's whiteboard before ever
// being wired into the live app).
function detectQuad(cv, src, width, height) {
  let gray, blurred, edges, dilated, kernel, contours, hierarchy;
  try {
    gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    edges = new cv.Mat();
    cv.Canny(blurred, edges, 40, 120);
    dilated = new cv.Mat();
    kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, dilated, kernel);
    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = width * height;
    let best = null;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const hull = new cv.Mat();
      cv.convexHull(cnt, hull);
      const peri = cv.arcLength(hull, true);
      for (const eps of [0.02, 0.03, 0.04, 0.05]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, eps * peri, true);
        if (approx.rows === 4) {
          const area = Math.abs(cv.contourArea(approx));
          const areaFrac = area / frameArea;
          if (areaFrac > 0.08) {
            const pts = [];
            for (let j = 0; j < 4; j++) pts.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
            const cx = pts.reduce((s, p) => s + p.x, 0) / 4, cy = pts.reduce((s, p) => s + p.y, 0) / 4;
            const centerDist = Math.hypot(cx - width / 2, cy - height / 2) / width;
            let maxAngleDev = 0;
            for (let k = 0; k < 4; k++) {
              const p0 = pts[(k + 3) % 4], p1 = pts[k], p2 = pts[(k + 1) % 4];
              const v1 = { x: p0.x - p1.x, y: p0.y - p1.y }, v2 = { x: p2.x - p1.x, y: p2.y - p1.y };
              const dot = v1.x * v2.x + v1.y * v2.y;
              const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
              const angle = Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
              maxAngleDev = Math.max(maxAngleDev, Math.abs(angle - 90));
            }
            const w1 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            const w2 = Math.hypot(pts[2].x - pts[3].x, pts[2].y - pts[3].y);
            const h1 = Math.hypot(pts[3].x - pts[0].x, pts[3].y - pts[0].y);
            const h2 = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y);
            let ratio = ((w1 + w2) / 2) / ((h1 + h2) / 2);
            if (ratio < 1) ratio = 1 / ratio; // point winding direction is arbitrary
            // Known prior: this room's whiteboard is roughly 1.65:1.
            if (ratio >= 1.15 && ratio <= 2.1) {
              const aspectDev = Math.abs(ratio - 1.65);
              const score = -centerDist * 2 - maxAngleDev * 0.05 - aspectDev;
              if (!best || score > best.score) {
                best = { score, pts: pts.map((p) => ({ x: p.x / width, y: p.y / height })) };
              }
            }
            approx.delete();
            break;
          }
        }
        approx.delete();
      }
      hull.delete();
      cnt.delete();
    }
    return best ? orderCorners(best.pts) : null;
  } finally {
    [gray, blurred, edges, dilated, kernel, hierarchy].forEach((m) => m && m.delete());
    if (contours) contours.delete();
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== "detect") return;
  const { reqId, buffer, width, height } = msg;
  try {
    await getCv();
    const cv = self.cv; // read directly, not as getCv()'s resolved value — see the comment above cvReadyPromise
    const data = new Uint8ClampedArray(buffer);
    const src = cv.matFromImageData({ data, width, height });
    let quad;
    try {
      quad = detectQuad(cv, src, width, height);
    } finally {
      src.delete();
    }
    postMessage({ type: "result", reqId, quad });
  } catch (err) {
    postMessage({ type: "error", reqId, message: (err && err.message) || String(err) });
  }
};

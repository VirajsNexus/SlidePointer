// ── presenter.js ───────────────────────────────────────
//  This page:
//   • Accesses the webcam (which faces the presentation screen)
//   • Detects the laser dot in each video frame
//   • Maps camera coords → slide normalised coords via 4-pt calibration
//   • Sends LASER_POS to Presentation window over BroadcastChannel
//   • Also sends CLEAR, SLIDE_NEXT, SLIDE_PREV
// ──────────────────────────────────────────────────────

// ── DOM ───────────────────────────────────────────────
var camVideo       = document.getElementById('camVideo');
var camCanvas      = document.getElementById('camCanvas');
var camWrap        = document.getElementById('camWrap');
var camPlaceholder = document.getElementById('camPlaceholder');
var camBtn         = document.getElementById('camBtn');
var calBtn         = document.getElementById('calBtn');
var calBanner      = document.getElementById('calBanner');
var calRow         = document.getElementById('calRow');
var resetCalBtn    = document.getElementById('resetCalBtn');
var laserDotEl     = document.getElementById('laserDot');
var laserTxt       = document.getElementById('laserTxt');
var connDot        = document.getElementById('connDot');
var connTxt        = document.getElementById('connTxt');
var logList        = document.getElementById('logList');
var logEmpty       = document.getElementById('logEmpty');

var cCtx = camCanvas.getContext('2d');
// Offscreen canvas for pixel sampling (full video res)
var offC = document.createElement('canvas');
var offX = offC.getContext('2d');

// ── State ─────────────────────────────────────────────
var tracking   = false;
var camStream  = null;
var rafId      = null;
var laserColor = 'red';
var sensitivity= 55;
var smoothing  = 3;
var smoothPos  = null;
var calibrated = false;
var calibrating= false;
var corners    = [];          // [{x,y}] normalised 0–1, 4 points TL→TR→BR→BL
var slideInfo  = { page:1, total:1 };
var connLostTmr= null;
var lastLog    = 0;

// ── Color detectors ───────────────────────────────────
var detectors = {
  red:    function (r,g,b) { return r>155 && g<85  && b<85  && r-g>90 && r-b>90; },
  green:  function (r,g,b) { return g>155 && r<105 && b<105 && g-r>70 && g-b>70; },
  blue:   function (r,g,b) { return b>155 && r<105 && g<105 && b-r>70 && b-g>70; },
  white:  function (r,g,b) { return r>210 && g>210 && b>210; },
  yellow: function (r,g,b) { return r>180 && g>180 && b<85; },
};

// ══════════════════════════════════════════════════════
//  CAMERA
// ══════════════════════════════════════════════════════
camBtn.addEventListener('click', function () {
  if (tracking) stopCam(); else startCam();
});

async function startCam() {
  var attempts = [
    { video: { width:{ideal:1280}, height:{ideal:720}, facingMode:'environment' } },
    { video: { width:{ideal:1280}, height:{ideal:720} } },
    { video: true }
  ];
  camStream = null;
  for (var i = 0; i < attempts.length; i++) {
    try { camStream = await navigator.mediaDevices.getUserMedia(attempts[i]); break; }
    catch (e) {
      if (i === attempts.length - 1) {
        alert('Camera access failed:\n' + e.message +
              '\n\nMake sure you opened http://localhost:3000 in Chrome/Edge.');
        return;
      }
    }
  }
  camVideo.srcObject = camStream;
  await new Promise(function (r) { camVideo.onloadedmetadata = r; });
  await camVideo.play();
  fitCam();
  camPlaceholder.style.display = 'none';
  tracking = true;
  camBtn.textContent   = 'Stop Camera';
  camBtn.className     = 'btn-sm';
  laserDotEl.className = 'sdot on';
  laserTxt.textContent = 'Camera ' + camVideo.videoWidth + '×' + camVideo.videoHeight;
  runLoop();
}

function stopCam() {
  if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; }
  tracking = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  camPlaceholder.style.display = 'flex';
  camBtn.textContent   = '▶ Start Camera';
  camBtn.className     = 'btn-sm cyan';
  laserDotEl.className = 'sdot';
  laserTxt.textContent = 'Camera off';
  chSend({ type: 'LASER_OFF' });
}

function fitCam() {
  var vw = camVideo.videoWidth  || 1280;
  var vh = camVideo.videoHeight || 720;
  var pw = camWrap.clientWidth  || 500;
  // Use available height in the panel (minus topbar and calRow)
  var ph = (camWrap.parentElement.clientHeight - 48 - 42) || 360;
  var sc = Math.min(pw / vw, ph / vh);
  camWrap.style.height = Math.round(vh * sc) + 'px';
}

window.addEventListener('resize', function () { if (tracking) setTimeout(fitCam, 120); });

// ══════════════════════════════════════════════════════
//  CALIBRATION
// ══════════════════════════════════════════════════════
calBtn.addEventListener('click', function () {
  if (!tracking) { alert('Start the camera first, then calibrate.'); return; }
  beginCal();
});

resetCalBtn.addEventListener('click', function () {
  calibrated = false; calibrating = false; corners = [];
  calRow.style.display  = 'none';
  calBanner.style.display = 'none';
  camCanvas.style.pointerEvents = 'none';
  camCanvas.style.cursor = 'default';
  camCanvas.removeEventListener('click', onCalClick);
  calBtn.textContent = '⊹ Calibrate';
  updateDots();
});

var CAL_LABELS = ['TOP-LEFT', 'TOP-RIGHT', 'BOTTOM-RIGHT', 'BOTTOM-LEFT'];

function beginCal() {
  calibrating = true; calibrated = false; corners = [];
  calRow.style.display    = 'flex';
  calBanner.style.display = 'block';
  calBanner.style.background = '#ffe000';
  calBanner.style.color      = '#000';
  updateBanner();
  updateDots();
  camCanvas.style.pointerEvents = 'all';
  camCanvas.style.cursor        = 'crosshair';
  camCanvas.addEventListener('click', onCalClick);
}

function onCalClick(e) {
  if (!calibrating) return;
  var r     = camCanvas.getBoundingClientRect();
  // camCanvas has CSS scaleX(-1) — un-mirror the X click
  var normX = 1 - ((e.clientX - r.left)  / r.width);
  var normY =     (e.clientY  - r.top)   / r.height;
  corners.push({ x: normX, y: normY });
  updateBanner();
  updateDots();
  if (corners.length === 4) finishCal();
}

function updateBanner() {
  var n = corners.length;
  if (n < 4) {
    calBanner.textContent = 'Click ' + CAL_LABELS[n] + ' corner of the slide (' + (n+1) + '/4)';
  }
}

function updateDots() {
  for (var i = 0; i < 4; i++) {
    var el = document.getElementById('c' + i);
    if (el) el.className = 'cal-dot' + (i < corners.length ? ' done' : '');
  }
}

function finishCal() {
  calibrating = false; calibrated = true;
  camCanvas.style.pointerEvents = 'none';
  camCanvas.style.cursor        = 'default';
  camCanvas.removeEventListener('click', onCalClick);
  calBanner.style.background = '#00e5ff';
  calBanner.style.color      = '#000';
  calBanner.textContent      = '✓ Calibrated! Point your laser at the slide.';
  calBtn.textContent         = 'Re-calibrate';
  setTimeout(function () { calBanner.style.display = 'none'; }, 3500);
}

// ══════════════════════════════════════════════════════
//  BILINEAR QUAD INVERSE MAP
//  Maps (px,py) in normalised camera space → (u,v) normalised slide space
// ══════════════════════════════════════════════════════
function mapQuad(px, py) {
  var tl=corners[0], tr=corners[1], br=corners[2], bl=corners[3];
  var u=0.5, v=0.5;
  for (var iter=0; iter<16; iter++) {
    var qx = (1-u)*(1-v)*tl.x + u*(1-v)*tr.x + u*v*br.x + (1-u)*v*bl.x;
    var qy = (1-u)*(1-v)*tl.y + u*(1-v)*tr.y + u*v*br.y + (1-u)*v*bl.y;
    var dxdu = -(1-v)*tl.x + (1-v)*tr.x + v*br.x - v*bl.x;
    var dydu = -(1-v)*tl.y + (1-v)*tr.y + v*br.y - v*bl.y;
    var dxdv = -(1-u)*tl.x -    u*tr.x  + u*br.x + (1-u)*bl.x;
    var dydv = -(1-u)*tl.y -    u*tr.y  + u*br.y + (1-u)*bl.y;
    var det  = dxdu*dydv - dxdv*dydu;
    if (Math.abs(det) < 1e-10) break;
    u += ( dydv*(px-qx) - dxdv*(py-qy)) / det;
    v += (-dydu*(px-qx) + dxdu*(py-qy)) / det;
    u = Math.max(0, Math.min(1, u));
    v = Math.max(0, Math.min(1, v));
  }
  return { u: u, v: v };
}

// ══════════════════════════════════════════════════════
//  MAIN DETECTION LOOP
// ══════════════════════════════════════════════════════
function runLoop() {
  if (!tracking) return;
  detectFrame();
  rafId = requestAnimationFrame(runLoop);
}

function detectFrame() {
  if (!camVideo.readyState || camVideo.readyState < 2) return;
  var vw = camVideo.videoWidth, vh = camVideo.videoHeight;
  if (!vw || !vh) return;

  // Draw current frame to offscreen canvas
  offC.width = vw; offC.height = vh;
  offX.drawImage(camVideo, 0, 0, vw, vh);
  var px  = offX.getImageData(0, 0, vw, vh).data;
  var det = detectors[laserColor] || detectors.red;
  var minBrightness = Math.round(255 * (1 - (sensitivity / 100) * 0.72));

  // Find centroid of matching pixels
  var sx=0, sy=0, cnt=0;
  for (var y=0; y<vh; y+=2) {
    for (var x=0; x<vw; x+=2) {
      var i = (y*vw + x) * 4;
      var r=px[i], g=px[i+1], b=px[i+2];
      if ((r+g+b)/3 > minBrightness && det(r,g,b)) {
        sx += x; sy += y; cnt++;
      }
    }
  }

  // Draw on camera overlay (always, even with no laser)
  var dispW = camCanvas.offsetWidth  || 640;
  var dispH = camCanvas.offsetHeight || 360;
  camCanvas.width  = dispW;
  camCanvas.height = dispH;
  cCtx.clearRect(0, 0, dispW, dispH);
  drawCornerOverlay(dispW, dispH);

  if (cnt > 5) {
    // Raw position in video pixel space
    var rawX = sx / cnt;
    var rawY = sy / cnt;
    // Un-mirror (CSS scaleX(-1) on video)
    var mirX = vw - rawX;
    // Normalise to 0–1 in camera frame
    var ncx = mirX / vw;
    var ncy = rawY / vh;

    // Exponential smoothing
    var alpha = smoothing / 10;
    if (!smoothPos) smoothPos = { x: ncx, y: ncy };
    else {
      smoothPos.x = smoothPos.x * alpha + ncx * (1 - alpha);
      smoothPos.y = smoothPos.y * alpha + ncy * (1 - alpha);
    }
    var scx = smoothPos.x, scy = smoothPos.y;

    // Draw laser circle on camera overlay
    drawLaserCircle(scx * dispW, scy * dispH);

    // Map camera coords → slide coords
    var slideNx, slideNy;
    if (calibrated && corners.length === 4) {
      var mapped = mapQuad(scx, scy);
      slideNx = mapped.u;
      slideNy = mapped.v;
    } else {
      slideNx = scx;
      slideNy = scy;
    }

    if (slideNx >= 0 && slideNx <= 1 && slideNy >= 0 && slideNy <= 1) {
      // ★ Send laser position — Presentation does the highlight
      chSend({ type: 'LASER_POS', normX: slideNx, normY: slideNy });
      laserDotEl.className = 'sdot track';
      laserTxt.textContent = 'Laser ' + Math.round(slideNx*100) + '%, ' + Math.round(slideNy*100) + '%';
      addLog(slideNx, slideNy);
    } else {
      chSend({ type: 'LASER_OFF' });
      laserDotEl.className = 'sdot on';
      laserTxt.textContent = 'Laser outside slide';
    }

  } else {
    smoothPos = null;
    chSend({ type: 'LASER_OFF' });
    laserDotEl.className = 'sdot on';
    laserTxt.textContent = calibrated ? 'No laser detected' : 'Camera on — calibrate first!';
  }
}

// ── Draw laser detection circle on camera overlay ──
function drawLaserCircle(x, y) {
  cCtx.beginPath(); cCtx.arc(x, y, 12, 0, Math.PI*2);
  cCtx.strokeStyle = '#ff3c6e'; cCtx.lineWidth = 2.5; cCtx.stroke();
  cCtx.beginPath(); cCtx.arc(x, y, 4, 0, Math.PI*2);
  cCtx.fillStyle = '#ff3c6e'; cCtx.fill();
  // Crosshair
  cCtx.strokeStyle = 'rgba(255,60,110,0.5)'; cCtx.lineWidth = 1;
  cCtx.beginPath(); cCtx.moveTo(x-20, y); cCtx.lineTo(x+20, y); cCtx.stroke();
  cCtx.beginPath(); cCtx.moveTo(x, y-20); cCtx.lineTo(x, y+20); cCtx.stroke();
}

// ── Draw calibration corner dots + quad outline on overlay ──
function drawCornerOverlay(w, h) {
  if (!corners.length) return;
  var cols  = ['#00e5ff','#ffe000','#ff3c6e','#00ff88'];
  var names = ['TL','TR','BR','BL'];
  corners.forEach(function (c, i) {
    var px = c.x * w, py = c.y * h;
    cCtx.beginPath(); cCtx.arc(px, py, 9, 0, Math.PI*2);
    cCtx.fillStyle = cols[i]; cCtx.fill();
    cCtx.fillStyle = '#000'; cCtx.font = 'bold 8px monospace';
    cCtx.textAlign = 'center'; cCtx.textBaseline = 'middle';
    cCtx.fillText(names[i], px, py);
  });
  if (corners.length === 4) {
    cCtx.beginPath();
    cCtx.moveTo(corners[0].x*w, corners[0].y*h);
    cCtx.lineTo(corners[1].x*w, corners[1].y*h);
    cCtx.lineTo(corners[2].x*w, corners[2].y*h);
    cCtx.lineTo(corners[3].x*w, corners[3].y*h);
    cCtx.closePath();
    cCtx.strokeStyle = 'rgba(0,229,255,0.55)'; cCtx.lineWidth = 1.5; cCtx.stroke();
  }
}

// ── Detection log ──
function addLog(nx, ny) {
  var now = Date.now();
  if (now - lastLog < 400) return;   // don't spam log
  lastLog = now;
  logEmpty.style.display = 'none';
  var div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML =
    '<div class="lw">↗ Laser detected</div>' +
    '<div class="lc">' + Math.round(nx*100) + '%, ' + Math.round(ny*100) +
    '% · page ' + slideInfo.page + '/' + slideInfo.total + '</div>';
  var existing = logList.querySelectorAll('.log-entry');
  if (existing.length >= 12) existing[existing.length-1].remove();
  logList.insertBefore(div, logList.firstChild);
}

// ══════════════════════════════════════════════════════
//  UI CONTROLS
// ══════════════════════════════════════════════════════
document.getElementById('sensSlider').addEventListener('input', function () {
  sensitivity = parseInt(this.value);
  document.getElementById('sensVal').textContent = sensitivity;
});
document.getElementById('smoothSlider').addEventListener('input', function () {
  smoothing = parseInt(this.value);
  document.getElementById('smoothVal').textContent = smoothing;
});
document.getElementById('swatches').addEventListener('click', function (e) {
  var sw = e.target.closest('.sw'); if (!sw) return;
  document.querySelectorAll('.sw').forEach(function (s) { s.classList.remove('active'); });
  sw.classList.add('active');
  laserColor = sw.dataset.c;
});

// Clear highlights button
var clearBtn = document.getElementById('clearBtn');
if (clearBtn) clearBtn.addEventListener('click', function () { chSend({ type:'CLEAR' }); });

// ══════════════════════════════════════════════════════
//  BROADCAST CHANNEL — receive from Presentation
// ══════════════════════════════════════════════════════
ch.addEventListener('message', function (e) {
  var m = e.data;
  if (m.type === 'PONG') {
    slideInfo = { page: m.page, total: m.total };
    connDot.className   = 'sdot conn';
    connTxt.textContent = 'Presentation: connected (pg ' + m.page + '/' + m.total + ')';
    clearTimeout(connLostTmr);
    connLostTmr = setTimeout(function () {
      connDot.className   = 'sdot';
      connTxt.textContent = 'Presentation: not connected';
    }, 7000);
  }
  if (m.type === 'SLIDE_INFO') {
    slideInfo = { page: m.page, total: m.total };
  }
});

// ── Heartbeat ping to Presentation ──
setInterval(function () { chSend({ type: 'PING' }); }, 2500);

// ── presentation.js ────────────────────────────────────
//  This page:
//   • Lets user upload a PDF or image
//   • Renders it on slideCanvas
//   • Listens for LASER_POS from Presenter via BroadcastChannel
//   • Runs pixel analysis on slideCanvas to find the word
//     under the laser and draws a yellow highlight
// ──────────────────────────────────────────────────────

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ── DOM ───────────────────────────────────────────────
var uploadScreen = document.getElementById('uploadScreen');
var slideScreen  = document.getElementById('slideScreen');
var dropZone     = document.getElementById('dropZone');
var fileInput    = document.getElementById('fileInput');
var slideCanvas  = document.getElementById('slideCanvas');
var hlCanvas     = document.getElementById('hlCanvas');
var laserDotEl   = document.getElementById('laserDot');
var slideCtr     = document.getElementById('slideCtr');
var prevBtn      = document.getElementById('prevBtn');
var nextBtn      = document.getElementById('nextBtn');
var connDot      = document.getElementById('connDot');
var connTxt      = document.getElementById('connTxt');

var sCtx = slideCanvas.getContext('2d');
var hCtx = hlCanvas.getContext('2d');

// ── State ─────────────────────────────────────────────
var pdfDoc       = null;
var currentPage  = 1;
var totalPages   = 1;
var isImage      = false;
var imgCache     = null;
var lastHL       = 0;
var laserOffTmr  = null;
var connLostTmr  = null;

// ══════════════════════════════════════════════════════
//  FILE UPLOAD
// ══════════════════════════════════════════════════════
dropZone.addEventListener('click', function () { fileInput.click(); });
dropZone.addEventListener('dragover',  function (e) { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', function ()  { dropZone.classList.remove('over'); });
dropZone.addEventListener('drop', function (e) {
  e.preventDefault(); dropZone.classList.remove('over');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', function () {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});

async function loadFile(file) {
  clearHL();
  if (file.type === 'application/pdf') {
    isImage = false; imgCache = null;
    try {
      pdfDoc      = await pdfjsLib.getDocument(URL.createObjectURL(file)).promise;
      totalPages  = pdfDoc.numPages;
      currentPage = 1;
      showSlideScreen();
      await renderPDF(currentPage);
    } catch (err) { alert('Could not load PDF:\n' + err.message); }

  } else if (file.type.startsWith('image/')) {
    isImage = true; pdfDoc = null;
    totalPages = 1; currentPage = 1;
    var img = new Image();
    img.onload  = function () { imgCache = img; showSlideScreen(); renderImg(); };
    img.onerror = function () { alert('Could not load image.'); };
    img.src = URL.createObjectURL(file);

  } else {
    alert('Unsupported file.\n\nUse PDF, PNG, JPG or WEBP.\nFor PPTX: File → Export → PDF first.');
    return;
  }
  updateNav();
}

// ══════════════════════════════════════════════════════
//  RENDERING
// ══════════════════════════════════════════════════════
async function renderPDF(num) {
  if (!pdfDoc) return;
  var page  = await pdfDoc.getPage(num);
  var base  = page.getViewport({ scale: 1 });
  var dpr   = window.devicePixelRatio || 1;
  var area  = document.getElementById('slideArea');
  var aw    = area.clientWidth  || window.innerWidth;
  var ah    = area.clientHeight || window.innerHeight - 44;
  var scale = Math.min(aw / base.width, ah / base.height) * dpr;
  var vp    = page.getViewport({ scale: scale });

  slideCanvas.width  = vp.width;
  slideCanvas.height = vp.height;
  slideCanvas.style.width  = Math.round(vp.width  / dpr) + 'px';
  slideCanvas.style.height = Math.round(vp.height / dpr) + 'px';
  sCtx.clearRect(0, 0, vp.width, vp.height);
  await page.render({ canvasContext: sCtx, viewport: vp }).promise;
  syncHL(); broadcastInfo();
}

function renderImg() {
  if (!imgCache) return;
  var dpr  = window.devicePixelRatio || 1;
  var area = document.getElementById('slideArea');
  var aw   = area.clientWidth  || window.innerWidth;
  var ah   = area.clientHeight || window.innerHeight - 44;
  var sc   = Math.min(aw / imgCache.width, ah / imgCache.height);
  var dw   = Math.round(imgCache.width  * sc);
  var dh   = Math.round(imgCache.height * sc);
  slideCanvas.width  = dw * dpr;
  slideCanvas.height = dh * dpr;
  slideCanvas.style.width  = dw + 'px';
  slideCanvas.style.height = dh + 'px';
  sCtx.save(); sCtx.scale(dpr, dpr);
  sCtx.drawImage(imgCache, 0, 0, dw, dh);
  sCtx.restore();
  syncHL(); broadcastInfo();
}

// Keep hlCanvas exactly over slideCanvas
function syncHL() {
  hlCanvas.width  = slideCanvas.width;
  hlCanvas.height = slideCanvas.height;
  var r = slideCanvas.getBoundingClientRect();
  var a = document.getElementById('slideArea').getBoundingClientRect();
  hlCanvas.style.position = 'absolute';
  hlCanvas.style.left     = (r.left - a.left) + 'px';
  hlCanvas.style.top      = (r.top  - a.top)  + 'px';
  hlCanvas.style.width    = r.width  + 'px';
  hlCanvas.style.height   = r.height + 'px';
}

function broadcastInfo() {
  chSend({ type:'SLIDE_INFO', page:currentPage, total:totalPages,
           w:slideCanvas.width, h:slideCanvas.height });
}

// ══════════════════════════════════════════════════════
//  NAV
// ══════════════════════════════════════════════════════
function updateNav() {
  slideCtr.textContent = currentPage + ' / ' + totalPages;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
}
prevBtn.addEventListener('click', async function () {
  if (currentPage > 1) { currentPage--; clearHL(); await renderPDF(currentPage); updateNav(); }
});
nextBtn.addEventListener('click', async function () {
  if (currentPage < totalPages) { currentPage++; clearHL(); await renderPDF(currentPage); updateNav(); }
});
document.addEventListener('keydown', function (e) {
  if (slideScreen.style.display === 'none') return;
  if (e.key==='ArrowRight'||e.key==='ArrowDown') nextBtn.click();
  if (e.key==='ArrowLeft' ||e.key==='ArrowUp')   prevBtn.click();
  if (e.key==='f'||e.key==='F11') { e.preventDefault(); toggleFS(); }
  if (e.key==='Escape' && document.fullscreenElement) document.exitFullscreen();
});

// ══════════════════════════════════════════════════════
//  UI
// ══════════════════════════════════════════════════════
function showSlideScreen() {
  uploadScreen.style.display = 'none';
  slideScreen.style.display  = 'flex';
}
document.getElementById('changeFileBtn').addEventListener('click', function () {
  pdfDoc=null; imgCache=null; isImage=false;
  slideScreen.style.display  = 'none';
  uploadScreen.style.display = 'flex';
  fileInput.value = ''; clearHL();
});
function toggleFS() {
  if (!document.fullscreenElement)
    document.getElementById('slideArea').requestFullscreen();
  else document.exitFullscreen();
}
document.getElementById('fsBtn').addEventListener('click', toggleFS);

// Auto-hide nav
var navTmr;
document.addEventListener('mousemove', function () {
  document.getElementById('presNav').classList.remove('hidden');
  clearTimeout(navTmr);
  navTmr = setTimeout(function () {
    document.getElementById('presNav').classList.add('hidden');
  }, 3000);
});

// Re-render on resize
var resTmr;
window.addEventListener('resize', function () {
  clearTimeout(resTmr);
  resTmr = setTimeout(function () {
    if (pdfDoc) renderPDF(currentPage);
    else if (imgCache) renderImg();
    else syncHL();
  }, 180);
});

// ══════════════════════════════════════════════════════
//  LASER DOT
// ══════════════════════════════════════════════════════
function showLaser(nx, ny) {
  var r = slideCanvas.getBoundingClientRect();
  var a = document.getElementById('slideArea').getBoundingClientRect();
  laserDotEl.style.left    = (r.left - a.left + nx * r.width)  + 'px';
  laserDotEl.style.top     = (r.top  - a.top  + ny * r.height) + 'px';
  laserDotEl.style.display = 'block';
  clearTimeout(laserOffTmr);
  laserOffTmr = setTimeout(hideLaser, 500);
}
function hideLaser() { laserDotEl.style.display = 'none'; }

// ══════════════════════════════════════════════════════
//  WORD HIGHLIGHT — pixel analysis on our own canvas
// ══════════════════════════════════════════════════════
function highlightWord(normX, normY) {
  // Throttle to 200 ms
  var now = Date.now();
  if (now - lastHL < 200) return;
  lastHL = now;

  var cw = slideCanvas.width;
  var ch = slideCanvas.height;
  if (!cw || !ch) return;

  var cx = normX * cw;
  var cy = normY * ch;

  // Horizontal strip ~4% of canvas height centred on laser Y
  var stripH = Math.max(20, Math.round(ch * 0.040));
  var stripY = Math.max(0, Math.round(cy - stripH / 2));
  var safeH  = Math.min(stripH, ch - stripY);
  if (safeH <= 0) { drawFallback(normX, normY); return; }

  // Sample pixels
  var imgData;
  try { imgData = sCtx.getImageData(0, stripY, cw, safeH); }
  catch (e) { drawFallback(normX, normY); return; }

  var d = imgData.data;

  // Does column x contain a dark pixel (ink)?
  function colInk(col) {
    if (col < 0 || col >= cw) return false;
    for (var row = 0; row < safeH; row++) {
      var i = (row * cw + col) * 4;
      if (d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114 < 160) return true;
    }
    return false;
  }

  // Walk LEFT from laser X — stop when 6 consecutive empty columns
  var wordLeft = Math.floor(cx);
  var gap = 0;
  for (var x = Math.floor(cx); x >= 0; x--) {
    if (colInk(x)) { gap = 0; wordLeft = x; }
    else { gap++; if (gap >= 6) break; }
  }

  // Walk RIGHT from laser X — stop when 6 consecutive empty columns
  var wordRight = Math.floor(cx);
  gap = 0;
  for (var x = Math.floor(cx); x < cw; x++) {
    if (colInk(x)) { gap = 0; wordRight = x; }
    else { gap++; if (gap >= 6) break; }
  }

  var wordW = wordRight - wordLeft;

  // Sanity: if no ink found at all, fall back
  if (wordW < 4) { drawFallback(normX, normY); return; }
  // If word is suspiciously wide (no gap found), narrow to ±15% of width
  if (wordW > cw * 0.5) {
    wordLeft  = Math.max(0, cx - cw * 0.15);
    wordRight = Math.min(cw, cx + cw * 0.15);
    wordW = wordRight - wordLeft;
  }

  // Draw highlight with padding
  var pad = Math.max(4, Math.round(ch * 0.005));
  var hx = Math.max(0, wordLeft - pad);
  var hy = Math.max(0, stripY   - pad);
  var hw = Math.min(cw - hx, wordW + pad * 2);
  var hh = safeH + pad * 2;

  hCtx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
  hCtx.fillStyle   = 'rgba(255, 220, 0, 0.38)';
  hCtx.fillRect(hx, hy, hw, hh);
  hCtx.strokeStyle = '#ffe000';
  hCtx.lineWidth   = Math.max(2, cw / 700);
  hCtx.strokeRect(hx, hy, hw, hh);
}

// Fallback: small box around laser point
function drawFallback(normX, normY) {
  var cw = hlCanvas.width, ch = hlCanvas.height;
  var cx = normX * cw, cy = normY * ch;
  var bw = cw * 0.14, bh = ch * 0.045;
  var hx = Math.max(0, cx - bw / 2), hy = Math.max(0, cy - bh / 2);
  hCtx.clearRect(0, 0, cw, ch);
  hCtx.fillStyle   = 'rgba(255, 220, 0, 0.38)';
  hCtx.fillRect(hx, hy, bw, bh);
  hCtx.strokeStyle = '#ffe000';
  hCtx.lineWidth   = 2;
  hCtx.strokeRect(hx, hy, bw, bh);
}

function clearHL() {
  if (hCtx) hCtx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);
}

// ══════════════════════════════════════════════════════
//  BROADCAST CHANNEL — receive from Presenter
// ══════════════════════════════════════════════════════
ch.addEventListener('message', function (e) {
  var m = e.data;

  if (m.type === 'PING') {
    chSend({ type:'PONG', page:currentPage, total:totalPages });
    connDot.className   = 'conn-dot conn';
    connTxt.textContent = 'Presenter: connected';
    clearTimeout(connLostTmr);
    connLostTmr = setTimeout(function () {
      connDot.className   = 'conn-dot';
      connTxt.textContent = 'Presenter: not connected';
    }, 7000);
  }

  if (m.type === 'LASER_POS') {
    showLaser(m.normX, m.normY);
    highlightWord(m.normX, m.normY);
  }

  if (m.type === 'LASER_OFF')  hideLaser();
  if (m.type === 'CLEAR')      clearHL();
  if (m.type === 'SLIDE_NEXT') nextBtn.click();
  if (m.type === 'SLIDE_PREV') prevBtn.click();
});

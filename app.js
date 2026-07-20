'use strict';

/* =====================================================================
 * Glitch Tile Editor
 * - 이미지를 8×8 타일로 분절해 아틀라스에 누적하고, 타일(또는 타일 블록)을
 *   브러시로 BG/SPR 두 레이어 캔버스에 찍는 글리치 그래픽 편집기.
 * ===================================================================== */

const TILE = 8;           // 분절 단위(px), 고정
const ATLAS_COLS = 16;    // 아틀라스 한 행의 타일 수
const MAX_UNDO = 100;
const MIN_GRID = 1, MAX_GRID = 256;

/* ===== 상태 ===== */
const state = {
  gridW: 32,
  gridH: 24,
  bg: null,               // Int32Array, 값 = 아틀라스 인덱스, -1 = 빈 셀
  sprite: null,
  activeLayer: 'sprite',
  visible: { bg: true, sprite: true },
  tool: 'stamp',
  brush: null,            // {w, h, cells: Int32Array}
  source: null,           // {name, w, h, cells: Int32Array}
  srcSel: null,           // 소스 패널 선택 {x, y, w, h}
  sel: null,              // 캔버스 선택 {x, y, w, h}
  floating: null,         // 이동 중인 선택 {x, y, w, h, cells, canvas}
  showGrid: true,
  zoom: 1,
  panX: 0,
  panY: 0,
  undoStack: [],
  redoStack: [],
  projectName: '무제',
  projectId: null,
  nes: null,               // NES 팔레트 상태 (init에서 defaultNesState로 채움)
};

/* ===== DOM ===== */
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const sourceCanvas = $('source-canvas');
const sourceCtx = sourceCanvas.getContext('2d');
const brushPreview = $('brush-preview');
const zoomLabel = $('zoom-label');
const sizeValue = $('size-value');
const selectionBar = $('selection-bar');

/* ===== 아틀라스 ===== */
/* 타일 픽셀의 원본 저장소는 CPU 버퍼(atlas.buf)이고, 캔버스는 drawImage용
 * 파생물이다. iOS Safari에서 캔버스 읽기/쓰기를 대량 반복하면 앱이 강제
 * 종료되므로, 분절처럼 타일이 대량 추가되는 동안에는 캔버스 쓰기를 미뤘다가
 * syncAtlasCanvas()로 한 번에 반영한다. */
const TILE_BYTES = TILE * TILE * 4;

const atlas = {
  canvas: document.createElement('canvas'),
  ctx: null,
  count: 0,
  keys: new Map(),        // 타일 픽셀 키 -> 인덱스 (dedup)
  buf: new Uint8ClampedArray(TILE_BYTES * 256),
  cap: 256,
};
atlas.canvas.width = ATLAS_COLS * TILE;
atlas.canvas.height = TILE;
atlas.ctx = atlas.canvas.getContext('2d', { willReadFrequently: true });

let atlasBatch = false;                 // true면 캔버스 반영을 sync 시점까지 지연
const scratchImage = new ImageData(TILE, TILE);

function atlasPos(i) {
  return { sx: (i % ATLAS_COLS) * TILE, sy: Math.floor(i / ATLAS_COLS) * TILE };
}

function tileBytes(i) {
  return atlas.buf.subarray(i * TILE_BYTES, (i + 1) * TILE_BYTES);
}

function atlasEnsureBuf(count) {
  if (count <= atlas.cap) return;
  atlas.cap = Math.max(count, atlas.cap * 2);
  const grown = new Uint8ClampedArray(TILE_BYTES * atlas.cap);
  grown.set(atlas.buf);
  atlas.buf = grown;
}

function atlasEnsureCanvas(count) {
  const rows = Math.max(1, Math.ceil(count / ATLAS_COLS));
  const needed = rows * TILE;
  if (atlas.canvas.height >= needed) return;
  const old = atlas.canvas;
  const grown = document.createElement('canvas');
  grown.width = old.width;
  grown.height = Math.max(needed, old.height * 2);
  const gctx = grown.getContext('2d', { willReadFrequently: true });
  gctx.drawImage(old, 0, 0);
  atlas.canvas = grown;
  atlas.ctx = gctx;
}

function putTileToCanvas(idx) {
  atlasEnsureCanvas(atlas.count);
  scratchImage.data.set(tileBytes(idx));
  const { sx, sy } = atlasPos(idx);
  atlas.ctx.putImageData(scratchImage, sx, sy);
}

function syncAtlasCanvas() {
  // buf 전체를 캔버스에 putImageData 1회로 반영 (배치 종료 시)
  const rows = Math.max(1, Math.ceil(atlas.count / ATLAS_COLS));
  const needed = rows * TILE;
  if (atlas.canvas.height < needed) {
    atlas.canvas.height = Math.max(needed, atlas.canvas.height * 2);   // 리사이즈로 클리어됨
    atlas.ctx = atlas.canvas.getContext('2d', { willReadFrequently: true });
  }
  const img = new ImageData(ATLAS_COLS * TILE, rows * TILE);
  const rowBytes = TILE * 4;
  const imgRowBytes = ATLAS_COLS * TILE * 4;
  for (let i = 0; i < atlas.count; i++) {
    const bytes = tileBytes(i);
    const { sx, sy } = atlasPos(i);
    for (let y = 0; y < TILE; y++) {
      img.data.set(bytes.subarray(y * rowBytes, (y + 1) * rowBytes),
        (sy + y) * imgRowBytes + sx * 4);
    }
  }
  atlas.ctx.putImageData(img, 0, 0);
}

function tileKey(data) {
  let key = '';
  for (let i = 0; i < data.length; i += 8) {
    key += String.fromCharCode(
      data[i], data[i + 1], data[i + 2], data[i + 3],
      data[i + 4], data[i + 5], data[i + 6], data[i + 7]);
  }
  return key;
}

function atlasAdd(bytes) {
  let empty = true;
  for (let i = 3; i < bytes.length; i += 4) {
    if (bytes[i] !== 0) { empty = false; break; }
  }
  if (empty) return -1;
  const key = tileKey(bytes);
  const found = atlas.keys.get(key);
  if (found !== undefined) return found;
  const idx = atlas.count++;
  atlasEnsureBuf(atlas.count);
  atlas.buf.set(bytes, idx * TILE_BYTES);
  atlas.keys.set(key, idx);
  if (!atlasBatch) putTileToCanvas(idx);
  return idx;
}

function drawTile(target, idx, dx, dy) {
  if (idx < 0 || idx >= atlas.count) return;
  const { sx, sy } = atlasPos(idx);
  target.drawImage(atlas.canvas, sx, sy, TILE, TILE, dx, dy, TILE, TILE);
}

/* ===== 타일 픽셀 변환 (회전/반전/리컬러) ===== */
const tileTransformCache = new Map();   // "idx:op" -> 변환된 타일 인덱스

function transformTile(idx, op) {
  if (idx < 0) return -1;
  const key = `${idx}:${op}`;
  const cached = tileTransformCache.get(key);
  if (cached !== undefined) return cached;
  const src = tileBytes(idx);
  const out = new Uint8ClampedArray(TILE_BYTES);
  const s = new Uint32Array(src.buffer, src.byteOffset, TILE * TILE);
  const d = new Uint32Array(out.buffer);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      let px = x, py = y;
      if (op === 'rot90') { px = y; py = TILE - 1 - x; }        // 시계방향 90°
      else if (op === 'flipH') { px = TILE - 1 - x; }
      else if (op === 'flipV') { py = TILE - 1 - y; }
      d[y * TILE + x] = s[py * TILE + px];
    }
  }
  const result = atlasAdd(out);
  tileTransformCache.set(key, result);
  return result;
}

function transformBrush(op) {
  const b = state.brush;
  if (!b) return;
  let w = b.w, h = b.h;
  const cells = new Int32Array(b.w * b.h);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const t = transformTile(b.cells[y * b.w + x], op);
      if (op === 'rot90') cells[x * b.h + (b.h - 1 - y)] = t;   // (x,y) -> (h-1-y, x)
      else if (op === 'flipH') cells[y * b.w + (b.w - 1 - x)] = t;
      else cells[(b.h - 1 - y) * b.w + x] = t;
    }
  }
  if (op === 'rot90') { w = b.h; h = b.w; }
  state.brush = { w, h, cells };
  renderBrushPreview();
}

/* ===== NES PPU 방식 팔레트 시스템 =====
 * - 마스터 팔레트(기본: NES 2C02 54색, 파일로 교체 가능)에서만 색을 고른다
 * - 공용 배경색 1 + BG 서브팔레트 4개 + SPR 서브팔레트 4개, 각 3색
 * - 타일 하나를 서브팔레트로 양자화하면 최대 4색(NES 규칙)이 된다
 */
// 기본 마스터 팔레트: 사용자 제공 nintendoentertainmentsystem.pal (JASC, 55색)
// 원본 파일: palettes/nintendoentertainmentsystem.pal
const NES_MASTER = [
  '#000000', '#FCFCFC', '#F8F8F8', '#BCBCBC', '#7C7C7C', '#A4E4FC', '#3CBCFC', '#0078F8',
  '#0000FC', '#B8B8F8', '#6888FC', '#0058F8', '#0000BC', '#D8B8F8', '#9878F8', '#6844FC',
  '#4428BC', '#F8B8F8', '#F878F8', '#D800CC', '#940084', '#F8A4C0', '#F85898', '#E40058',
  '#A80020', '#F0D0B0', '#F87858', '#F83800', '#A81000', '#FCE0A8', '#FCA044', '#E45C10',
  '#881400', '#F8D878', '#F8B800', '#AC7C00', '#503000', '#D8F878', '#B8F818', '#00B800',
  '#007800', '#B8F8B8', '#58D854', '#00A800', '#006800', '#B8F8D8', '#58F898', '#00A844',
  '#005800', '#00FCFC', '#00E8D8', '#008888', '#004058', '#F8D8F8', '#787878',
];
let masterPalette = NES_MASTER.slice();

function hexToRGB(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0').toUpperCase()).join('');
}

function defaultNesState() {
  const presets = [
    ['#A81000', '#E45C10', '#FCE0A8'],   // 갈색·주황조
    ['#007800', '#00B800', '#B8F818'],   // 초록조
    ['#0000FC', '#0078F8', '#3CBCFC'],   // 파랑조
    ['#7C7C7C', '#BCBCBC', '#FCFCFC'],   // 회색조
  ];
  return {
    backdrop: '#000000',
    bgPals: presets.map(p => p.slice()),
    sprPals: presets.map(p => p.slice()),
    activePal: 0,
  };
}

function nearestInList(r, g, b, rgbList) {
  let best = rgbList[0], bestDist = Infinity;
  for (const c of rgbList) {
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

const tileQuantCache = new Map();   // "idx|색목록" -> 양자화된 타일 인덱스
function quantizeTile(idx, hexColors) {
  if (idx < 0) return -1;
  const key = idx + '|' + hexColors.join(',');
  const cached = tileQuantCache.get(key);
  if (cached !== undefined) return cached;
  const rgbList = hexColors.map(hexToRGB);
  const d = Uint8ClampedArray.from(tileBytes(idx));
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [r, g, b] = nearestInList(d[i], d[i + 1], d[i + 2], rgbList);
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  const result = atlasAdd(d);
  tileQuantCache.set(key, result);
  return result;
}

const tileSwapCache = new Map();   // "idx|from|to" -> 색 대치된 타일 인덱스
function swapTileColor(idx, fromRGB, toRGB) {
  if (idx < 0) return -1;
  const key = idx + '|' + fromRGB.join(',') + '|' + toRGB.join(',');
  const cached = tileSwapCache.get(key);
  if (cached !== undefined) return cached;
  const d = Uint8ClampedArray.from(tileBytes(idx));
  let touched = false;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (d[i] === fromRGB[0] && d[i + 1] === fromRGB[1] && d[i + 2] === fromRGB[2]) {
      d[i] = toRGB[0]; d[i + 1] = toRGB[1]; d[i + 2] = toRGB[2];
      touched = true;
    }
  }
  const result = touched ? atlasAdd(d) : idx;
  tileSwapCache.set(key, result);
  return result;
}

function extractTileBytes(buf, imgW, tx, ty, out) {
  // 큰 버퍼에서 8×8 타일 픽셀을 행 단위로 복사 (캔버스 API·할당 불호출 — iOS 안전)
  const rowBytes = TILE * 4;
  for (let y = 0; y < TILE; y++) {
    const srcOff = ((ty * TILE + y) * imgW + tx * TILE) * 4;
    out.set(buf.subarray(srcOff, srcOff + rowBytes), y * rowBytes);
  }
  return out;
}

function rebuildAtlasKeys() {
  atlas.keys.clear();
  for (let i = 0; i < atlas.count; i++) {
    atlas.keys.set(tileKey(tileBytes(i)), i);
  }
}

/* ===== 이미지 분절 ===== */
let sliceSeq = 0;   // 분절 도중 다른 에셋을 누르면 이전 작업 중단

async function sliceImage(img, name) {
  const seq = ++sliceSeq;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  const scaleDown = Math.min(1, 1024 / Math.max(w, h));
  w = Math.max(TILE, Math.floor((w * scaleDown) / TILE) * TILE);
  h = Math.max(TILE, Math.floor((h * scaleDown) / TILE) * TILE);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cc = c.getContext('2d', { willReadFrequently: true });
  cc.imageSmoothingEnabled = false;
  cc.drawImage(img, 0, 0, w, h);
  // 전체를 1회만 읽는다 — 타일마다 getImageData를 부르면 iOS에서 리드백 폭증으로 앱이 종료됨
  const buf = cc.getImageData(0, 0, w, h).data;
  c.width = c.height = 0;   // 임시 캔버스 메모리 즉시 반환 (iOS)
  const gw = w / TILE, gh = h / TILE;
  const cells = new Int32Array(gw * gh);
  const scratch = new Uint8ClampedArray(TILE_BYTES);
  $('source-name').textContent = `${name} — 분절 중…`;
  // 캔버스 쓰기도 배치로 미룬다 — 고유 타일마다 putImageData를 하면 iOS에서 종료됨
  atlasBatch = true;
  try {
    for (let ty = 0; ty < gh; ty++) {
      for (let tx = 0; tx < gw; tx++) {
        cells[ty * gw + tx] = atlasAdd(extractTileBytes(buf, w, tx, ty, scratch));
      }
      if (ty % 16 === 15) {
        await new Promise(r => setTimeout(r, 0));   // UI에 양보 (저사양 기기 응답성)
        if (seq !== sliceSeq) return;               // 더 새로운 분절이 시작됨
      }
    }
  } finally {
    atlasBatch = false;
    syncAtlasCanvas();   // 추가된 타일 전체를 putImageData 1회로 반영
  }
  state.source = { name, w: gw, h: gh, cells };
  state.srcSel = null;
  buildSourceBitmap();
  $('source-name').textContent = `${name} — ${gw}×${gh} 타일`;
  $('btn-place').hidden = false;
  $('source-panel').classList.remove('collapsed');
  resizeSourceCanvas();
  fitSourceView();
  renderSourcePanel();
  autosaveSoon();
}

/* ===== 문서 (레이어) ===== */
function newDoc(w, h) {
  state.gridW = w;
  state.gridH = h;
  state.bg = new Int32Array(w * h).fill(-1);
  state.sprite = new Int32Array(w * h).fill(-1);
  state.undoStack = [];
  state.redoStack = [];
  state.sel = null;
  state.floating = null;
  state.projectName = '무제';
  state.projectId = null;
}

function activeCells() {
  return state.activeLayer === 'bg' ? state.bg : state.sprite;
}

function inGrid(cx, cy) {
  return cx >= 0 && cy >= 0 && cx < state.gridW && cy < state.gridH;
}

/* ===== undo/redo ===== */
function snapshot() {
  return {
    bg: state.bg.slice(),
    sprite: state.sprite.slice(),
    gridW: state.gridW,
    gridH: state.gridH,
  };
}
function restore(s) {
  state.bg = s.bg.slice();
  state.sprite = s.sprite.slice();
  state.gridW = s.gridW;
  state.gridH = s.gridH;
  state.sel = null;
  state.floating = null;
  updateSelectionBar();
  updateSizeLabel();
}
function pushUndo() {
  state.undoStack.push(snapshot());
  if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
  state.redoStack = [];
}
function undo() {
  if (!state.undoStack.length) return;
  discardFloating();
  state.redoStack.push(snapshot());
  restore(state.undoStack.pop());
  renderAll();
  autosaveSoon();
}
function redo() {
  if (!state.redoStack.length) return;
  discardFloating();
  state.undoStack.push(snapshot());
  restore(state.redoStack.pop());
  renderAll();
  autosaveSoon();
}

/* ===== 캔버스 크기 조절 (1타일 단위) ===== */
function resizeGrid(newW, newH) {
  newW = Math.min(MAX_GRID, Math.max(MIN_GRID, newW));
  newH = Math.min(MAX_GRID, Math.max(MIN_GRID, newH));
  if (newW === state.gridW && newH === state.gridH) return;
  commitFloating();
  pushUndo();
  const remap = (src) => {
    const out = new Int32Array(newW * newH).fill(-1);
    const copyW = Math.min(state.gridW, newW);
    const copyH = Math.min(state.gridH, newH);
    for (let y = 0; y < copyH; y++) {
      for (let x = 0; x < copyW; x++) out[y * newW + x] = src[y * state.gridW + x];
    }
    return out;
  };
  state.bg = remap(state.bg);
  state.sprite = remap(state.sprite);
  state.gridW = newW;
  state.gridH = newH;
  state.sel = null;
  updateSelectionBar();
  updateSizeLabel();
  renderAll();
  autosaveSoon();
}

function updateSizeLabel() {
  sizeValue.textContent = `${state.gridW}×${state.gridH}`;
}

/* ===== 뷰 (줌/팬) ===== */
function fitScale() {
  const r = stage.getBoundingClientRect();
  return Math.min(r.width / (state.gridW * TILE), r.height / (state.gridH * TILE)) * 0.92;
}
function viewScale() { return fitScale() * state.zoom; }  // 화면px / 문서px

function fitView() {
  const r = stage.getBoundingClientRect();
  state.zoom = 1;
  const v = viewScale();
  state.panX = (r.width - state.gridW * TILE * v) / 2;
  state.panY = (r.height - state.gridH * TILE * v) / 2;
}

function screenToCell(x, y) {
  const cell = viewScale() * TILE;
  return {
    cx: Math.floor((x - state.panX) / cell),
    cy: Math.floor((y - state.panY) / cell),
  };
}

/* ===== 렌더링 ===== */
const docCanvas = document.createElement('canvas');
const docCtx = docCanvas.getContext('2d');

let checkerPattern = null;
function getCheckerPattern() {
  if (checkerPattern) return checkerPattern;
  const p = document.createElement('canvas');
  p.width = TILE * 2; p.height = TILE * 2;
  const pc = p.getContext('2d');
  pc.fillStyle = '#3a3f58';
  pc.fillRect(0, 0, TILE * 2, TILE * 2);
  pc.fillStyle = '#454b6b';
  pc.fillRect(0, 0, TILE, TILE);
  pc.fillRect(TILE, TILE, TILE, TILE);
  checkerPattern = ctx.createPattern(p, 'repeat');
  return checkerPattern;
}

function renderDoc() {
  docCanvas.width = state.gridW * TILE;
  docCanvas.height = state.gridH * TILE;
  docCtx.imageSmoothingEnabled = false;
  const layers = [];
  if (state.visible.bg) layers.push(state.bg);
  if (state.visible.sprite) layers.push(state.sprite);
  for (const cells of layers) {
    for (let y = 0; y < state.gridH; y++) {
      for (let x = 0; x < state.gridW; x++) {
        drawTile(docCtx, cells[y * state.gridW + x], x * TILE, y * TILE);
      }
    }
  }
}

function render() {
  const r = stage.getBoundingClientRect();
  ctx.clearRect(0, 0, r.width, r.height);
  const v = viewScale();
  const W = state.gridW * TILE, H = state.gridH * TILE;

  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(v, v);
  ctx.imageSmoothingEnabled = false;

  // 문서 배경 체커 (투명 표시)
  ctx.fillStyle = getCheckerPattern();
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(docCanvas, 0, 0);

  // 이동 중인 플로팅 선택
  if (state.floating) {
    const f = state.floating;
    ctx.globalAlpha = 0.95;
    ctx.drawImage(f.canvas, f.x * TILE, f.y * TILE);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#7aa2f7';
    ctx.lineWidth = 2 / v;
    ctx.setLineDash([6 / v, 4 / v]);
    ctx.strokeRect(f.x * TILE, f.y * TILE, f.w * TILE, f.h * TILE);
    ctx.setLineDash([]);
  }

  // 캔버스 선택 영역
  if (state.sel) {
    const s = state.sel;
    ctx.strokeStyle = '#7aa2f7';
    ctx.lineWidth = 2 / v;
    ctx.setLineDash([6 / v, 4 / v]);
    ctx.strokeRect(s.x * TILE, s.y * TILE, s.w * TILE, s.h * TILE);
    ctx.setLineDash([]);
  }

  // 패턴 채우기 드래그 영역
  if (patternRect) {
    const r = patternRect;
    ctx.strokeStyle = '#9ece6a';
    ctx.lineWidth = 2 / v;
    ctx.setLineDash([6 / v, 4 / v]);
    ctx.strokeRect(r.x * TILE, r.y * TILE, r.w * TILE, r.h * TILE);
    ctx.setLineDash([]);
  }

  // 격자
  const cell = v * TILE;
  if (state.showGrid && cell >= 6) {
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1 / v;
    ctx.beginPath();
    for (let i = 0; i <= state.gridW; i++) {
      ctx.moveTo(i * TILE, 0); ctx.lineTo(i * TILE, H);
    }
    for (let i = 0; i <= state.gridH; i++) {
      ctx.moveTo(0, i * TILE); ctx.lineTo(W, i * TILE);
    }
    ctx.stroke();
  }

  // 외곽선
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5 / v;
  ctx.strokeRect(0, 0, W, H);
  ctx.restore();

  zoomLabel.textContent = Math.round(state.zoom * 100) + '%';
}

function renderAll() {
  renderDoc();
  render();
}

function resizeCanvas() {
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  checkerPattern = null;
  render();
}

/* ===== 브러시 ===== */
function setBrush(w, h, cells) {
  state.brush = { w, h, cells: Int32Array.from(cells) };
  renderBrushPreview();
}

function setSingleBrush(idx) {
  if (idx < 0) return;
  setBrush(1, 1, [idx]);
}

function renderBrushPreview() {
  const pc = brushPreview.getContext('2d');
  pc.clearRect(0, 0, brushPreview.width, brushPreview.height);
  const b = state.brush;
  if (!b) return;
  const off = document.createElement('canvas');
  off.width = b.w * TILE; off.height = b.h * TILE;
  const oc = off.getContext('2d');
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) drawTile(oc, b.cells[y * b.w + x], x * TILE, y * TILE);
  }
  pc.imageSmoothingEnabled = false;
  const s = Math.min(brushPreview.width / off.width, brushPreview.height / off.height, 4);
  const dw = off.width * s, dh = off.height * s;
  pc.drawImage(off, (brushPreview.width - dw) / 2, (brushPreview.height - dh) / 2, dw, dh);
}

function stampAt(cx, cy) {
  const b = state.brush;
  if (!b) return;
  const cells = activeCells();
  const ox = cx - Math.floor(b.w / 2);
  const oy = cy - Math.floor(b.h / 2);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const t = b.cells[y * b.w + x];
      if (t < 0) continue;
      const gx = ox + x, gy = oy + y;
      if (inGrid(gx, gy)) cells[gy * state.gridW + gx] = t;
    }
  }
}

function eraseAt(cx, cy) {
  if (inGrid(cx, cy)) activeCells()[cy * state.gridW + cx] = -1;
}

function scatterAt(cx, cy) {
  if (!atlas.count || !inGrid(cx, cy)) return;
  activeCells()[cy * state.gridW + cx] = Math.floor(Math.random() * atlas.count);
}

function pickAt(cx, cy) {
  if (!inGrid(cx, cy)) return;
  const idx = activeCells()[cy * state.gridW + cx];
  if (idx >= 0) setSingleBrush(idx);
}

function cellsOnLine(a, b) {
  // 브레젠험 직선 (드래그 보간)
  const out = [];
  let x0 = a.cx, y0 = a.cy;
  const x1 = b.cx, y1 = b.cy;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return out;
}

/* ===== 선택 (이동/삭제/브러시) ===== */
function normRect(a, b) {
  const x = Math.max(0, Math.min(a.cx, b.cx));
  const y = Math.max(0, Math.min(a.cy, b.cy));
  const x2 = Math.min(state.gridW - 1, Math.max(a.cx, b.cx));
  const y2 = Math.min(state.gridH - 1, Math.max(a.cy, b.cy));
  if (x2 < x || y2 < y) return null;
  return { x, y, w: x2 - x + 1, h: y2 - y + 1 };
}

function rectCells(rect, layerCells) {
  const out = new Int32Array(rect.w * rect.h);
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      out[y * rect.w + x] = layerCells[(rect.y + y) * state.gridW + (rect.x + x)];
    }
  }
  return out;
}

function inRect(cx, cy, r) {
  return r && cx >= r.x && cy >= r.y && cx < r.x + r.w && cy < r.y + r.h;
}

function buildFloatCanvas(cells, w, h) {
  const fc = document.createElement('canvas');
  fc.width = w * TILE; fc.height = h * TILE;
  const fctx = fc.getContext('2d');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) drawTile(fctx, cells[y * w + x], x * TILE, y * TILE);
  }
  return fc;
}

function liftSelection() {
  // 선택 영역을 활성 레이어에서 들어 올려 플로팅으로 전환
  const s = state.sel;
  if (!s) return;
  pushUndo();
  const cells = activeCells();
  const lifted = rectCells(s, cells);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) cells[(s.y + y) * state.gridW + (s.x + x)] = -1;
  }
  state.floating = {
    x: s.x, y: s.y, w: s.w, h: s.h,
    cells: lifted, canvas: buildFloatCanvas(lifted, s.w, s.h),
  };
  state.sel = null;
  renderAll();
}

function duplicateSelection() {
  // 선택 영역을 원본은 그대로 둔 채 복사해 플로팅으로
  const s = state.sel;
  if (!s) return;
  pushUndo();
  const copied = rectCells(s, activeCells());
  state.floating = {
    x: s.x, y: s.y, w: s.w, h: s.h,
    cells: copied, canvas: buildFloatCanvas(copied, s.w, s.h),
  };
  state.sel = null;
  renderAll();
}

function stampFloatingInPlace() {
  // 플로팅 내용을 현재 위치에 찍되 플로팅은 유지 (연속 도장)
  const f = state.floating;
  if (!f) return;
  pushUndo();
  const cells = activeCells();
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const t = f.cells[y * f.w + x];
      if (t < 0) continue;
      const gx = f.x + x, gy = f.y + y;
      if (inGrid(gx, gy)) cells[gy * state.gridW + gx] = t;
    }
  }
  renderAll();
  autosaveSoon();
}

function commitFloating() {
  const f = state.floating;
  if (!f) return;
  const cells = activeCells();
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const t = f.cells[y * f.w + x];
      if (t < 0) continue;
      const gx = f.x + x, gy = f.y + y;
      if (inGrid(gx, gy)) cells[gy * state.gridW + gx] = t;
    }
  }
  state.floating = null;
  updateSelectionBar();
  renderAll();
  autosaveSoon();
}

function discardFloating() {
  state.floating = null;
}

function clearSelection() {
  commitFloating();
  state.sel = null;
  updateSelectionBar();
  render();
}

function updateSelectionBar() {
  selectionBar.hidden = !(state.sel || state.floating);
  const palApply = $('pal-apply');
  if (palApply) palApply.textContent = state.sel ? '선택 영역에 적용' : '전체에 적용';
}

$('sel-delete').addEventListener('click', () => {
  if (state.floating) {
    // 들어 올린 시점에 undo가 쌓여 있으므로 그대로 버리면 삭제가 된다
    state.floating = null;
  } else if (state.sel) {
    pushUndo();
    const s = state.sel;
    const cells = activeCells();
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) cells[(s.y + y) * state.gridW + (s.x + x)] = -1;
    }
    state.sel = null;
  }
  updateSelectionBar();
  renderAll();
  autosaveSoon();
});

$('sel-brush').addEventListener('click', () => {
  let picked = null;
  if (state.floating) {
    picked = { w: state.floating.w, h: state.floating.h, cells: state.floating.cells };
    commitFloating();
  } else if (state.sel) {
    picked = { w: state.sel.w, h: state.sel.h, cells: rectCells(state.sel, activeCells()) };
    state.sel = null;
  }
  if (picked) {
    setBrush(picked.w, picked.h, picked.cells);
    setTool('stamp');
  }
  updateSelectionBar();
  render();
});

$('sel-done').addEventListener('click', clearSelection);

$('sel-dup').addEventListener('click', () => {
  if (state.floating) stampFloatingInPlace();
  else duplicateSelection();
  updateSelectionBar();
});

$('brush-rot').addEventListener('click', () => transformBrush('rot90'));
$('brush-fliph').addEventListener('click', () => transformBrush('flipH'));
$('brush-flipv').addEventListener('click', () => transformBrush('flipV'));

/* ===== NES 팔레트 패널 ===== */
const palettePanel = $('palette-panel');
let palSelectedSlot = null;   // null | 'backdrop' | 0 | 1 | 2
let swapMode = false;
let swapFrom = null;          // [r,g,b] | null
let swapTo = null;            // hex | null

function currentPalSet() {
  return state.activeLayer === 'bg' ? state.nes.bgPals : state.nes.sprPals;
}
function currentSubpal() {
  return currentPalSet()[state.nes.activePal];
}

function paletteScopeRect() {
  return state.sel || { x: 0, y: 0, w: state.gridW, h: state.gridH };
}

function renderPaletteUI() {
  if (!state.nes) return;
  $('pal-set-label').textContent = state.activeLayer === 'bg' ? 'BG 팔레트' : 'SPR 팔레트';
  $('pal-apply').textContent = state.sel ? '선택 영역에 적용' : '전체에 적용';

  // 서브팔레트 탭 (P0~P3, 3색 미리보기 줄무늬)
  const tabs = $('pal-tabs');
  tabs.innerHTML = '';
  currentPalSet().forEach((pal, i) => {
    const b = document.createElement('button');
    b.className = 'pal-tab' + (i === state.nes.activePal ? ' active' : '');
    b.style.background = `linear-gradient(90deg, ${pal[0]} 33%, ${pal[1]} 33% 66%, ${pal[2]} 66%)`;
    b.title = `서브팔레트 ${i}`;
    b.addEventListener('click', () => {
      state.nes.activePal = i;
      palSelectedSlot = null;
      renderPaletteUI();
    });
    tabs.appendChild(b);
  });

  // 배경색 + 슬롯 3개
  const backdrop = $('pal-backdrop');
  backdrop.style.background = state.nes.backdrop;
  backdrop.classList.toggle('selected', palSelectedSlot === 'backdrop');
  const slots = $('pal-slots');
  slots.innerHTML = '';
  currentSubpal().forEach((hex, i) => {
    const b = document.createElement('button');
    b.className = 'pal-slot' + (palSelectedSlot === i ? ' selected' : '');
    b.style.background = hex;
    b.addEventListener('click', () => {
      palSelectedSlot = palSelectedSlot === i ? null : i;
      renderPaletteUI();
    });
    slots.appendChild(b);
  });
  $('pal-hint').textContent = palSelectedSlot !== null
    ? '아래 마스터 팔레트에서 색을 고르세요'
    : '슬롯을 탭한 뒤 아래에서 색을 고르세요';

  // 색 대치 행
  $('pal-swap-row').hidden = !swapMode;
  $('pal-swap-toggle').classList.toggle('active', swapMode);
  $('swap-from').style.background = swapFrom ? rgbToHex(...swapFrom) : 'transparent';
  $('swap-to').style.background = swapTo || 'transparent';
  $('swap-hint').textContent = !swapFrom
    ? '캔버스를 탭해 원본 색을 집으세요'
    : (!swapTo ? '아래에서 바꿀 색을 고르세요' : '대치 실행을 누르세요');

  renderMasterGrid();
}

function renderMasterGrid() {
  const grid = $('master-grid');
  grid.innerHTML = '';
  for (const hex of masterPalette) {
    const b = document.createElement('button');
    b.className = 'master-swatch';
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => {
      if (swapMode) {
        swapTo = hex;
      } else if (palSelectedSlot === 'backdrop') {
        state.nes.backdrop = hex;
        autosaveSoon();
      } else if (palSelectedSlot !== null) {
        currentSubpal()[palSelectedSlot] = hex;
        autosaveSoon();
      }
      renderPaletteUI();
    });
    grid.appendChild(b);
  }
}

// 서브팔레트 양자화: 범위 내 활성 레이어 타일을 [배경색(BG만)+3색]으로
$('pal-apply').addEventListener('click', () => {
  commitFloating();
  const colors = state.activeLayer === 'bg'
    ? [state.nes.backdrop, ...currentSubpal()]
    : currentSubpal().slice();
  pushUndo();
  const r = paletteScopeRect();
  const cells = activeCells();
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const i = (r.y + y) * state.gridW + (r.x + x);
      cells[i] = quantizeTile(cells[i], colors);
    }
  }
  renderAll();
  autosaveSoon();
});

// 색 대치: 원본 색(캔버스에서 집은 색)을 대상 색으로, 양쪽 레이어 모두
$('swap-exec').addEventListener('click', () => {
  if (!swapFrom || !swapTo) return;
  commitFloating();
  pushUndo();
  const toRGB = hexToRGB(swapTo);
  const r = paletteScopeRect();
  for (const cells of [state.bg, state.sprite]) {
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const i = (r.y + y) * state.gridW + (r.x + x);
        cells[i] = swapTileColor(cells[i], swapFrom, toRGB);
      }
    }
  }
  swapFrom = null;
  swapTo = null;
  renderPaletteUI();
  renderAll();
  autosaveSoon();
});

$('pal-swap-toggle').addEventListener('click', () => {
  swapMode = !swapMode;
  if (!swapMode) { swapFrom = null; swapTo = null; }
  renderPaletteUI();
});

$('btn-palette').addEventListener('click', (e) => {
  palettePanel.hidden = !palettePanel.hidden;
  e.currentTarget.classList.toggle('active', !palettePanel.hidden);
  if (palettePanel.hidden) { swapMode = false; swapFrom = null; swapTo = null; }
  renderPaletteUI();
  resizeCanvas();
});
$('btn-palette-close').addEventListener('click', () => {
  palettePanel.hidden = true;
  $('btn-palette').classList.remove('active');
  swapMode = false; swapFrom = null; swapTo = null;
  resizeCanvas();
});

// 캔버스에서 픽셀 색 집기 (색 대치 모드)
function pickCanvasColor(x, y) {
  const v = viewScale();
  const px = Math.floor((x - state.panX) / v);
  const py = Math.floor((y - state.panY) / v);
  if (px < 0 || py < 0 || px >= docCanvas.width || py >= docCanvas.height) return;
  const d = docCtx.getImageData(px, py, 1, 1).data;
  if (d[3] === 0) return;   // 투명은 무시
  swapFrom = [d[0], d[1], d[2]];
  renderPaletteUI();
}

/* ===== 팔레트 파일 가져오기 ===== */
function parsePaletteFile(bytes) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const colors = [];
  const push = (r, g, b) => {
    const hex = rgbToHex(r, g, b);
    if (!colors.includes(hex)) colors.push(hex);
  };
  if (/^JASC-PAL/i.test(text)) {
    // JASC-PAL / 0100 / 개수 / "r g b" ...
    for (const line of text.split(/\r?\n/).slice(3)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)/);
      if (m) push(+m[1], +m[2], +m[3]);
    }
  } else if (/^GIMP Palette/i.test(text)) {
    for (const line of text.split(/\r?\n/).slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)/);
      if (m) push(+m[1], +m[2], +m[3]);
    }
  } else if (/^[\s#;0-9a-fA-F\r\n]+$/.test(text) && /[0-9a-fA-F]{6}/.test(text)) {
    // .hex (Lospec): 한 줄에 색 하나
    for (const m of text.matchAll(/(?:#|^|\s)([0-9a-fA-F]{6})(?=\s|$)/gm)) {
      const [r, g, b] = hexToRGB('#' + m[1]);
      push(r, g, b);
    }
  } else if (bytes.length >= 192 && bytes.length % 3 === 0) {
    // NES .pal 바이너리: RGB 트리플렛, 앞 64색만
    for (let i = 0; i < Math.min(64 * 3, bytes.length); i += 3) {
      push(bytes[i], bytes[i + 1], bytes[i + 2]);
    }
  }
  return colors.slice(0, 64);
}

function setMasterPalette(colors) {
  masterPalette = colors;
  tileQuantCache.clear();
  renderPaletteUI();
  dbReq('kv', 'readwrite', s => s.put({ key: 'masterPalette', colors })).catch(() => {});
}

$('pal-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const colors = parsePaletteFile(bytes);
    if (colors.length < 2) {
      alert('팔레트를 읽지 못했습니다. 지원 형식: NES .pal(바이너리), JASC .pal, .hex, .gpl');
      return;
    }
    setMasterPalette(colors);
  } catch (_) {
    alert('팔레트 파일을 여는 중 오류가 발생했습니다.');
  }
});

$('pal-reset').addEventListener('click', () => setMasterPalette(NES_MASTER.slice()));

/* ===== 행/열 시프트 (글리치) ===== */
const shiftState = { active: false, start: null, axis: null, snap: null };

function applyShift(cx, cy) {
  const dx = cx - shiftState.start.cx;
  const dy = cy - shiftState.start.cy;
  if (!shiftState.axis) {
    if (dx === 0 && dy === 0) return;
    shiftState.axis = Math.abs(dx) >= Math.abs(dy) ? 'row' : 'col';
  }
  const cells = activeCells();
  const { gridW: w, gridH: h } = state;
  cells.set(shiftState.snap);
  if (shiftState.axis === 'row') {
    const y = shiftState.start.cy;
    if (y < 0 || y >= h) return;
    for (let x = 0; x < w; x++) {
      cells[y * w + x] = shiftState.snap[y * w + (((x - dx) % w) + w) % w];
    }
  } else {
    const x = shiftState.start.cx;
    if (x < 0 || x >= w) return;
    for (let y = 0; y < h; y++) {
      cells[y * w + x] = shiftState.snap[((((y - dy) % h) + h) % h) * w + x];
    }
  }
}

/* ===== 포인터 입력 (터치/펜슬/마우스) ===== */
const pointers = new Map();
let drawing = false;
let lastCell = null;
let pinch = null;
let undoPushed = false;
let marqueeStart = null;
let floatDrag = null;      // {startCx, startCy, origX, origY}
let patternStart = null;   // 패턴 채우기 드래그 시작 셀
let patternRect = null;    // 패턴 채우기 미리보기 영역

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

  if (pointers.size === 2 && e.pointerType === 'touch') {
    cancelStroke();
    const [p1, p2] = [...pointers.values()];
    pinch = {
      dist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
      cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2,
      panX: state.panX, panY: state.panY, zoom: state.zoom,
    };
    return;
  }
  if (pointers.size > 1) return;

  // 색 대치 모드: 캔버스 탭 = 픽셀 색 집기
  if (swapMode && !palettePanel.hidden) {
    pickCanvasColor(e.offsetX, e.offsetY);
    return;
  }

  const { cx, cy } = screenToCell(e.offsetX, e.offsetY);
  drawing = true;

  switch (state.tool) {
    case 'stamp':
      pushUndo(); undoPushed = true;
      stampAt(cx, cy);
      lastCell = { cx, cy };
      renderAll();
      break;
    case 'eraser':
      pushUndo(); undoPushed = true;
      eraseAt(cx, cy);
      lastCell = { cx, cy };
      renderAll();
      break;
    case 'scatter':
      pushUndo(); undoPushed = true;
      scatterAt(cx, cy);
      lastCell = { cx, cy };
      renderAll();
      break;
    case 'picker':
      pickAt(cx, cy);
      break;
    case 'shift':
      pushUndo(); undoPushed = true;
      shiftState.active = true;
      shiftState.start = { cx, cy };
      shiftState.axis = null;
      shiftState.snap = activeCells().slice();
      break;
    case 'pattern':
      if (state.brush) {
        patternStart = { cx, cy };
        patternRect = normRect(patternStart, patternStart);
        render();
      }
      break;
    case 'select':
      if (state.floating && inRect(cx, cy, state.floating)) {
        floatDrag = { startCx: cx, startCy: cy, origX: state.floating.x, origY: state.floating.y };
      } else if (state.sel && inRect(cx, cy, state.sel)) {
        liftSelection();
        floatDrag = { startCx: cx, startCy: cy, origX: state.floating.x, origY: state.floating.y };
      } else {
        commitFloating();
        state.sel = null;
        marqueeStart = { cx, cy };
        updateSelectionBar();
        render();
      }
      break;
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

  if (pinch && pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
    state.zoom = Math.min(16, Math.max(0.2, pinch.zoom * (dist / pinch.dist)));
    const applied = state.zoom / pinch.zoom;
    state.panX = cx - (pinch.cx - pinch.panX) * applied;
    state.panY = cy - (pinch.cy - pinch.panY) * applied;
    render();
    return;
  }
  if (!drawing) return;

  const { cx, cy } = screenToCell(e.offsetX, e.offsetY);

  switch (state.tool) {
    case 'stamp':
    case 'eraser':
    case 'scatter': {
      if (lastCell && cx === lastCell.cx && cy === lastCell.cy) return;
      const fn = state.tool === 'stamp' ? stampAt : state.tool === 'eraser' ? eraseAt : scatterAt;
      for (const [x, y] of cellsOnLine(lastCell || { cx, cy }, { cx, cy })) fn(x, y);
      lastCell = { cx, cy };
      renderAll();
      break;
    }
    case 'shift':
      if (shiftState.active) {
        applyShift(cx, cy);
        renderAll();
      }
      break;
    case 'pattern':
      if (patternStart) {
        patternRect = normRect(patternStart, { cx, cy });
        render();
      }
      break;
    case 'select':
      if (floatDrag && state.floating) {
        state.floating.x = floatDrag.origX + (cx - floatDrag.startCx);
        state.floating.y = floatDrag.origY + (cy - floatDrag.startCy);
        render();
      } else if (marqueeStart) {
        state.sel = normRect(marqueeStart, { cx, cy });
        render();
      }
      break;
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!drawing || pointers.size > 0) return;

  if (state.tool === 'shift' && shiftState.active && !shiftState.axis && undoPushed) {
    state.undoStack.pop();   // 움직임 없던 시프트는 undo 항목 제거
    undoPushed = false;
  }
  shiftState.active = false;
  shiftState.snap = null;

  if (state.tool === 'pattern' && patternStart) {
    // 드래그 영역을 브러시 블록으로 반복 타일링
    const r = patternRect;
    const b = state.brush;
    if (r && b) {
      pushUndo();
      const cells = activeCells();
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const t = b.cells[(y % b.h) * b.w + (x % b.w)];
          if (t >= 0) cells[(r.y + y) * state.gridW + (r.x + x)] = t;
        }
      }
      renderDoc();
    }
    patternStart = null;
    patternRect = null;
  }

  if (state.tool === 'select') {
    if (marqueeStart && !state.sel) {
      // 드래그 없이 탭: 1칸 선택
      state.sel = normRect(marqueeStart, marqueeStart);
    }
    marqueeStart = null;
    floatDrag = null;
    updateSelectionBar();
  }

  drawing = false;
  lastCell = null;
  undoPushed = false;
  render();
  autosaveSoon();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function cancelStroke() {
  if (!drawing) return;
  if (undoPushed) {
    // 한 손가락으로 긋다가 두 손가락 제스처로 전환: 방금 획을 되돌림
    restore(state.undoStack.pop());
    undoPushed = false;
  }
  shiftState.active = false;
  shiftState.snap = null;
  marqueeStart = null;
  floatDrag = null;
  patternStart = null;
  patternRect = null;
  drawing = false;
  lastCell = null;
  renderAll();
}

/* ===== 소스 패널 (핀치 줌/팬 가능한 뷰) ===== */
const srcView = { zoom: 1, panX: 0, panY: 0 };
let srcFit = 1;                 // 화면에 꽉 차는 기준 배율
const srcPointers = new Map();
let srcPinch = null;
let srcDrag = null;

function srcScale() { return srcFit * srcView.zoom; }   // 화면px / 소스px

function resizeSourceCanvas() {
  const body = $('source-body');
  const rect = body.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;      // 접힘 상태
  const dpr = window.devicePixelRatio || 1;
  sourceCanvas.width = rect.width * dpr;
  sourceCanvas.height = rect.height * dpr;
  sourceCanvas.style.width = rect.width + 'px';
  sourceCanvas.style.height = rect.height + 'px';
  sourceCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderSourcePanel();
}

function fitSourceView() {
  const src = state.source;
  if (!src) return;
  const rect = $('source-body').getBoundingClientRect();
  if (rect.width < 10) return;
  srcFit = Math.min(rect.width / (src.w * TILE), rect.height / (src.h * TILE));
  srcView.zoom = 1;
  const v = srcScale();
  srcView.panX = (rect.width - src.w * TILE * v) / 2;
  srcView.panY = (rect.height - src.h * TILE * v) / 2;
}

let sourceBitmap = null;   // 소스 그리드 사전 렌더 (매 프레임 drawImage 1회로 줄임)

function buildSourceBitmap() {
  const src = state.source;
  if (!src) { sourceBitmap = null; return; }
  sourceBitmap = document.createElement('canvas');
  sourceBitmap.width = src.w * TILE;
  sourceBitmap.height = src.h * TILE;
  const bctx = sourceBitmap.getContext('2d');
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      drawTile(bctx, src.cells[y * src.w + x], x * TILE, y * TILE);
    }
  }
}

function renderSourcePanel() {
  const rect = sourceCanvas.getBoundingClientRect();
  sourceCtx.clearRect(0, 0, rect.width, rect.height);
  const src = state.source;
  if (!src) return;
  const v = srcScale();
  sourceCtx.save();
  sourceCtx.translate(srcView.panX, srcView.panY);
  sourceCtx.scale(v, v);
  sourceCtx.imageSmoothingEnabled = false;
  if (sourceBitmap) sourceCtx.drawImage(sourceBitmap, 0, 0);
  // 외곽선
  sourceCtx.strokeStyle = 'rgba(255,255,255,0.25)';
  sourceCtx.lineWidth = 1 / v;
  sourceCtx.strokeRect(0, 0, src.w * TILE, src.h * TILE);
  // 선택 범위
  if (state.srcSel) {
    const s = state.srcSel;
    sourceCtx.strokeStyle = '#7aa2f7';
    sourceCtx.lineWidth = 2 / v;
    sourceCtx.strokeRect(s.x * TILE, s.y * TILE, s.w * TILE, s.h * TILE);
  }
  sourceCtx.restore();
}

function srcCellFromPoint(x, y) {
  const src = state.source;
  const cell = srcScale() * TILE;
  return {
    cx: Math.min(src.w - 1, Math.max(0, Math.floor((x - srcView.panX) / cell))),
    cy: Math.min(src.h - 1, Math.max(0, Math.floor((y - srcView.panY) / cell))),
  };
}

sourceCanvas.addEventListener('pointerdown', (e) => {
  if (!state.source) return;
  sourceCanvas.setPointerCapture(e.pointerId);
  srcPointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

  if (srcPointers.size === 2 && e.pointerType === 'touch') {
    // 두 손가락: 선택 취소하고 핀치 줌/팬
    srcDrag = null;
    const [p1, p2] = [...srcPointers.values()];
    srcPinch = {
      dist: Math.hypot(p1.x - p2.x, p1.y - p2.y),
      cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2,
      panX: srcView.panX, panY: srcView.panY, zoom: srcView.zoom,
    };
    return;
  }
  if (srcPointers.size > 1) return;

  const c = srcCellFromPoint(e.offsetX, e.offsetY);
  srcDrag = { start: c };
  state.srcSel = { x: c.cx, y: c.cy, w: 1, h: 1 };
  renderSourcePanel();
});

sourceCanvas.addEventListener('pointermove', (e) => {
  if (!srcPointers.has(e.pointerId)) return;
  srcPointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

  if (srcPinch && srcPointers.size === 2) {
    const [p1, p2] = [...srcPointers.values()];
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
    srcView.zoom = Math.min(40, Math.max(0.5, srcPinch.zoom * (dist / srcPinch.dist)));
    const applied = srcView.zoom / srcPinch.zoom;
    srcView.panX = cx - (srcPinch.cx - srcPinch.panX) * applied;
    srcView.panY = cy - (srcPinch.cy - srcPinch.panY) * applied;
    renderSourcePanel();
    return;
  }
  if (!srcDrag || !state.source) return;

  const c = srcCellFromPoint(e.offsetX, e.offsetY);
  const x = Math.min(srcDrag.start.cx, c.cx);
  const y = Math.min(srcDrag.start.cy, c.cy);
  state.srcSel = {
    x, y,
    w: Math.abs(c.cx - srcDrag.start.cx) + 1,
    h: Math.abs(c.cy - srcDrag.start.cy) + 1,
  };
  renderSourcePanel();
});

function srcPointerEnd(e) {
  srcPointers.delete(e.pointerId);
  if (srcPointers.size < 2) srcPinch = null;
  if (!srcDrag || !state.source || srcPointers.size > 0) return;
  const s = state.srcSel;
  const src = state.source;
  const cells = new Int32Array(s.w * s.h);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      cells[y * s.w + x] = src.cells[(s.y + y) * src.w + (s.x + x)];
    }
  }
  setBrush(s.w, s.h, cells);
  setTool('stamp');
  srcDrag = null;
}
sourceCanvas.addEventListener('pointerup', srcPointerEnd);
sourceCanvas.addEventListener('pointercancel', srcPointerEnd);

// 데스크톱: 휠 = 커서 기준 줌
sourceCanvas.addEventListener('wheel', (e) => {
  if (!state.source) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
  const newZoom = Math.min(40, Math.max(0.5, srcView.zoom * factor));
  const applied = newZoom / srcView.zoom;
  srcView.zoom = newZoom;
  srcView.panX = e.offsetX - (e.offsetX - srcView.panX) * applied;
  srcView.panY = e.offsetY - (e.offsetY - srcView.panY) * applied;
  renderSourcePanel();
}, { passive: false });

$('btn-source-fit').addEventListener('click', () => {
  fitSourceView();
  renderSourcePanel();
});

$('btn-source-toggle').addEventListener('click', (e) => {
  const panel = $('source-panel');
  panel.classList.toggle('collapsed');
  e.currentTarget.textContent = panel.classList.contains('collapsed') ? '▴' : '▾';
  if (!panel.classList.contains('collapsed')) resizeSourceCanvas();
  resizeCanvas();   // 스테이지 높이가 변하므로 메인 캔버스도 갱신
});

$('btn-place').addEventListener('click', () => {
  // 소스 전체를 활성 레이어 (0,0)에 배치
  const src = state.source;
  if (!src) return;
  commitFloating();
  pushUndo();
  const cells = activeCells();
  for (let y = 0; y < Math.min(src.h, state.gridH); y++) {
    for (let x = 0; x < Math.min(src.w, state.gridW); x++) {
      const t = src.cells[y * src.w + x];
      if (t >= 0) cells[y * state.gridW + x] = t;
    }
  }
  renderAll();
  autosaveSoon();
});

/* ===== 에셋 브라우저 ===== */
async function loadAssetIndex() {
  const wrap = $('asset-list');
  try {
    const res = await fetch('assets/index.json', { cache: 'no-cache' });
    const index = await res.json();
    wrap.innerHTML = '';
    for (const [folder, files] of Object.entries(index)) {
      const sec = document.createElement('div');
      sec.className = 'asset-folder';
      const h = document.createElement('h4');
      h.textContent = '📁 ' + folder;
      const grid = document.createElement('div');
      grid.className = 'asset-grid';
      for (const file of files) {
        const url = `assets/${folder}/${file}`;
        const item = document.createElement('button');
        item.className = 'asset-item';
        const img = document.createElement('img');
        img.src = url;
        img.alt = file;
        const label = document.createElement('span');
        label.textContent = file.replace(/\.[^.]+$/, '');
        item.append(img, label);
        item.addEventListener('click', () => {
          const loader = new Image();
          loader.onload = () => {
            sliceImage(loader, `${folder}/${label.textContent}`);
            closeDrawers();
          };
          loader.src = url;
          wrap.querySelectorAll('.asset-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
        });
        grid.appendChild(item);
      }
      sec.append(h, grid);
      wrap.appendChild(sec);
    }
    if (!Object.keys(index).length) wrap.textContent = '에셋이 없습니다.';
  } catch (_) {
    wrap.textContent = '에셋 목록을 불러오지 못했습니다.';
  }
}

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    sliceImage(img, file.name.replace(/\.[^.]+$/, ''));
    URL.revokeObjectURL(url);
    closeDrawers();
  };
  img.src = url;
  e.target.value = '';
});

/* ===== 도구/레이어/크기 UI ===== */
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool-mode').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));
  if (tool !== 'select') clearSelection();
}
document.querySelectorAll('.tool-mode').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

function setLayer(layer) {
  clearSelection();
  state.activeLayer = layer;
  $('layer-bg').classList.toggle('active', layer === 'bg');
  $('layer-sprite').classList.toggle('active', layer === 'sprite');
  palSelectedSlot = null;
  if (!palettePanel.hidden) renderPaletteUI();
}
$('layer-bg').addEventListener('click', () => setLayer('bg'));
$('layer-sprite').addEventListener('click', () => setLayer('sprite'));

function toggleVis(layer, btn) {
  state.visible[layer] = !state.visible[layer];
  btn.classList.toggle('off', !state.visible[layer]);
  renderAll();
}
$('vis-bg').addEventListener('click', (e) => toggleVis('bg', e.currentTarget));
$('vis-sprite').addEventListener('click', (e) => toggleVis('sprite', e.currentTarget));

$('w-minus').addEventListener('click', () => resizeGrid(state.gridW - 1, state.gridH));
$('w-plus').addEventListener('click', () => resizeGrid(state.gridW + 1, state.gridH));
$('h-minus').addEventListener('click', () => resizeGrid(state.gridW, state.gridH - 1));
$('h-plus').addEventListener('click', () => resizeGrid(state.gridW, state.gridH + 1));

$('btn-grid').addEventListener('click', (e) => {
  state.showGrid = !state.showGrid;
  e.currentTarget.classList.toggle('active', state.showGrid);
  render();
});
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);

/* ===== PNG 내보내기 ===== */
$('btn-export').addEventListener('click', () => {
  commitFloating();
  renderDoc();
  const SCALE = 4;
  const out = document.createElement('canvas');
  out.width = docCanvas.width * SCALE;
  out.height = docCanvas.height * SCALE;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = false;
  octx.drawImage(docCanvas, 0, 0, out.width, out.height);
  const a = document.createElement('a');
  a.href = out.toDataURL('image/png');
  a.download = (state.projectName || 'glitch-tile') + '.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
});

/* ===== 저장 (IndexedDB) ===== */
const DB_NAME = 'glitch-tile-editor';
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('projects', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
function dbReq(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  }));
}

function serializeDoc() {
  renderDoc();
  return {
    version: 1,
    gridW: state.gridW,
    gridH: state.gridH,
    bg: Array.from(state.bg),
    sprite: Array.from(state.sprite),
    atlas: atlas.canvas.toDataURL('image/png'),
    atlasCount: atlas.count,
    nes: JSON.parse(JSON.stringify(state.nes)),
    name: state.projectName,
    thumb: docCanvas.toDataURL('image/png'),
    updated: Date.now(),
  };
}

function loadDoc(doc) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      atlas.canvas.width = img.width;
      atlas.canvas.height = img.height;
      atlas.ctx = atlas.canvas.getContext('2d', { willReadFrequently: true });
      atlas.ctx.imageSmoothingEnabled = false;
      atlas.ctx.drawImage(img, 0, 0);
      atlas.count = doc.atlasCount;
      // 캔버스 → CPU 버퍼 복원 (전체 1회 읽기)
      atlasEnsureBuf(atlas.count);
      const whole = atlas.ctx.getImageData(0, 0, atlas.canvas.width, atlas.canvas.height).data;
      for (let i = 0; i < atlas.count; i++) {
        extractTileBytes(whole, atlas.canvas.width, i % ATLAS_COLS, Math.floor(i / ATLAS_COLS),
          tileBytes(i));
      }
      rebuildAtlasKeys();
      tileTransformCache.clear();   // 아틀라스가 교체되었으므로 변환 캐시 무효화
      tileQuantCache.clear();
      tileSwapCache.clear();
      if (doc.nes) state.nes = doc.nes;
      // 마스터 팔레트는 전역(kv 'masterPalette')으로만 관리 — 문서에 저장하지 않음
      if (!palettePanel.hidden) renderPaletteUI();
      state.gridW = doc.gridW;
      state.gridH = doc.gridH;
      state.bg = Int32Array.from(doc.bg);
      state.sprite = Int32Array.from(doc.sprite);
      state.projectName = doc.name || '무제';
      state.undoStack = [];
      state.redoStack = [];
      state.sel = null;
      state.floating = null;
      state.brush = null;
      state.source = null;
      state.srcSel = null;
      sourceBitmap = null;
      $('source-name').textContent = '에셋을 선택하세요';
      $('btn-place').hidden = true;
      renderSourcePanel();
      renderBrushPreview();
      updateSelectionBar();
      updateSizeLabel();
      fitView();
      renderAll();
      resolve();
    };
    img.onerror = () => resolve();
    img.src = doc.atlas;
  });
}

let autosaveTimer = null;
function autosaveSoon() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      dbReq('kv', 'readwrite', s => s.put({ key: 'current', doc: serializeDoc() })).catch(() => {});
    } catch (_) { /* 무시 */ }
  }, 500);
}

async function restoreAutosave() {
  try {
    const row = await dbReq('kv', 'readonly', s => s.get('current'));
    if (row && row.doc) {
      await loadDoc(row.doc);
      return true;
    }
  } catch (_) { /* 무시 */ }
  return false;
}

async function saveProject(name) {
  const doc = serializeDoc();
  doc.name = name;
  if (state.projectId != null) doc.id = state.projectId;
  const id = await dbReq('projects', 'readwrite', s => s.put(doc));
  state.projectId = id;
  state.projectName = name;
  autosaveSoon();
  refreshSavedList();
}

async function refreshSavedList() {
  const list = $('saved-list');
  list.innerHTML = '';
  let projects = [];
  try {
    projects = (await dbReq('projects', 'readonly', s => s.getAll())) || [];
  } catch (_) { /* 무시 */ }
  projects.sort((a, b) => b.updated - a.updated);
  for (const p of projects) {
    const li = document.createElement('li');
    const thumb = document.createElement('img');
    thumb.src = p.thumb;
    thumb.width = 56; thumb.height = 42;
    thumb.style.objectFit = 'contain';
    thumb.style.imageRendering = 'pixelated';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${p.name} (${p.gridW}×${p.gridH})`;

    const loadBtn = document.createElement('button');
    loadBtn.textContent = '열기';
    loadBtn.addEventListener('click', async () => {
      await loadDoc(p);
      state.projectId = p.id;
      closeDrawers();
      autosaveSoon();
    });

    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', async () => {
      await dbReq('projects', 'readwrite', s => s.delete(p.id));
      if (state.projectId === p.id) state.projectId = null;
      refreshSavedList();
    });

    li.append(thumb, name, loadBtn, delBtn);
    list.appendChild(li);
  }
  if (!projects.length) {
    const li = document.createElement('li');
    li.textContent = '저장된 작업이 없습니다.';
    li.style.opacity = '0.6';
    li.style.fontSize = '13px';
    list.appendChild(li);
  }
}

/* ===== 전체 백업 (모든 프로젝트 + 현재 캔버스 + 팔레트) ===== */
$('btn-backup-export').addEventListener('click', async () => {
  let projects = [];
  try {
    projects = (await dbReq('projects', 'readonly', s => s.getAll())) || [];
  } catch (_) { /* 프로젝트가 없어도 계속 */ }
  const backup = {
    app: 'tile-editor-backup',
    version: 1,
    exported: Date.now(),
    master: masterPalette.slice(),
    current: serializeDoc(),
    projects,
  };
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tile-editor-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

$('backup-import').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup.app !== 'tile-editor-backup' || !backup.current) throw new Error('bad format');
    if (backup.master && backup.master.length >= 2) setMasterPalette(backup.master.slice());
    // 저장된 프로젝트는 지우지 않고 백업분을 추가 (id 충돌 방지 위해 새 id 발급)
    for (const p of backup.projects || []) {
      const { id, ...rest } = p;
      await dbReq('projects', 'readwrite', s => s.add(rest));
    }
    await loadDoc(backup.current);
    state.projectId = null;
    refreshSavedList();
    autosaveSoon();
  } catch (_) {
    alert('백업 파일을 읽지 못했습니다. 이 앱에서 내보낸 .json 파일인지 확인해주세요.');
  }
});

/* ===== 서랍 UI ===== */
function closeDrawers() {
  document.querySelectorAll('.drawer').forEach(d => d.classList.add('hidden'));
}
$('btn-menu').addEventListener('click', () => {
  $('project-drawer').classList.remove('hidden');
  $('save-name').value = state.projectName;
  refreshSavedList();
});
$('btn-assets').addEventListener('click', () => {
  $('asset-drawer').classList.remove('hidden');
});
document.querySelectorAll('.btn-close-drawer').forEach(b =>
  b.addEventListener('click', closeDrawers));
document.querySelectorAll('.drawer').forEach(d =>
  d.addEventListener('click', (e) => { if (e.target === d) closeDrawers(); }));

$('btn-new').addEventListener('click', () => {
  newDoc(32, 24);
  updateSizeLabel();
  fitView();
  renderAll();
  closeDrawers();
  autosaveSoon();
});
$('btn-save').addEventListener('click', () => {
  const name = $('save-name').value.trim() || '무제';
  saveProject(name);
});

/* ===== 온라인/오프라인 표시 ===== */
function updateOnline() { $('offline-badge').hidden = navigator.onLine; }
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);

/* ===== 초기화 ===== */
window.addEventListener('resize', () => {
  resizeCanvas();
  resizeSourceCanvas();
});
window.addEventListener('contextmenu', (e) => e.preventDefault());

async function init() {
  state.nes = defaultNesState();
  newDoc(32, 24);
  updateSizeLabel();
  updateOnline();
  loadAssetIndex();
  try {
    const row = await dbReq('kv', 'readonly', s => s.get('masterPalette'));
    if (row && row.colors && row.colors.length >= 2) masterPalette = row.colors.slice();
  } catch (_) { /* 무시 */ }
  const restored = await restoreAutosave();
  if (!restored) {
    fitView();
    resizeCanvas();
    renderAll();
  } else {
    resizeCanvas();
  }
  resizeSourceCanvas();
}
init();

/* ===== 테스트/디버그 훅 ===== */
window.__state = () => state;
window.__countFilled = (layer) => {
  const cells = layer === 'bg' ? state.bg : state.sprite;
  let n = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] >= 0) n++;
  return n;
};
window.__layerHash = (layer) => {
  const cells = layer === 'bg' ? state.bg : state.sprite;
  let h = 0;
  for (let i = 0; i < cells.length; i++) h = (h * 31 + cells[i] + 2) | 0;
  return h;
};
window.__cellCenter = (cx, cy) => {
  const cell = viewScale() * TILE;
  return { x: state.panX + (cx + 0.5) * cell, y: state.panY + (cy + 0.5) * cell };
};
window.__srcCellCenter = (cx, cy) => {
  const cell = srcScale() * TILE;
  return { x: srcView.panX + (cx + 0.5) * cell, y: srcView.panY + (cy + 0.5) * cell };
};

/* ===== 서비스 워커 등록 (오프라인 지원) ===== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

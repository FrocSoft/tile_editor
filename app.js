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

/* ===== 프로젝트 이름 규칙: "SCR XXDD" (XX=랜덤, DD=날짜 코드) ===== */
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 만든 날짜(1~366일째)를 36진수 두 자리로 — 본인만 역산할 수 있는 날짜 코드
function dayOfYear(d) {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
                   - Date.UTC(d.getFullYear(), 0, 0)) / 86400000);
}

function dayCode(d = new Date()) {
  const doy = dayOfYear(d);
  return B36[Math.floor(doy / 36)] + B36[doy % 36];
}

function randScrName(code = dayCode()) {
  const r = () => B36[Math.floor(Math.random() * 36)];
  return `SCR-${r()}${r()}${code}`;
}

/* ===== 상태 ===== */
const state = {
  gridW: 32,
  gridH: 24,
  bg: null,               // Int32Array, 값 = 아틀라스 인덱스, -1 = 빈 셀
  sprite: null,
  activeLayer: 'sprite',
  visible: { bg: true, sprite: true },
  linkLayers: false,       // 🔗 선택/이동을 두 레이어에 동시 적용
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
  projectName: randScrName(),  // 새 프로젝트 기본 이름 = SCR XXDD (랜덤2 + 날짜코드2)
  projectId: null,
  dirty: false,                // 마지막 저장/불러오기 이후 변경 여부
  nes: null,               // NES 팔레트 상태 (init에서 defaultNesState로 채움)
};

/* ===== DOM ===== */
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let mainDpr = 1;   // 렌더 시작마다 변환을 리셋해, 예외로 어긋난 프레임이 누적되지 않게 함
let srcDpr = 1;
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
  // 소스 사각형이 캔버스 밖이면 iOS Safari는 예외를 던진다 — 조용히 건너뜀
  if (sy + TILE > atlas.canvas.height || sx + TILE > atlas.canvas.width) return;
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
    backdropFill: true,      // NES처럼 배경색을 모든 레이어 아래에 깔지 여부
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

/* ===== 이미지 분절 (대형 이미지는 자동 페이지 분할) ===== */
let sliceSeq = 0;               // 분절 도중 다른 에셋을 누르면 이전 작업 중단
const PAGE_TILE_BUDGET = 1536;  // 페이지당 최대 타일 수 — 저사양 iOS에서 안전한 상한
let sourceMeta = null;          // 현재 소스의 원본 이미지·페이징 정보

async function sliceImage(img, name) {
  const seq = ++sliceSeq;
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  const scaleDown = Math.min(1, 2048 / Math.max(w, h));
  w = Math.max(TILE, Math.floor((w * scaleDown) / TILE) * TILE);
  h = Math.max(TILE, Math.floor((h * scaleDown) / TILE) * TILE);
  const gw = w / TILE, gh = h / TILE;
  const rowsPerPage = Math.max(1, Math.min(gh, Math.floor(PAGE_TILE_BUDGET / gw)));
  sourceMeta = {
    img, name, w, h, gw, gh, rowsPerPage,
    pageCount: Math.ceil(gh / rowsPerPage),
  };
  await slicePage(0, seq);
}

async function slicePage(pageIdx, seq = ++sliceSeq) {
  const m = sourceMeta;
  if (!m) return;
  const rowStart = pageIdx * m.rowsPerPage;
  const rows = Math.min(m.rowsPerPage, m.gh - rowStart);
  // 해당 페이지 영역만 리샘플해서 1회 읽는다 — 큰 이미지도 페이지 단위라 가볍다
  const c = document.createElement('canvas');
  c.width = m.w; c.height = rows * TILE;
  const cc = c.getContext('2d', { willReadFrequently: true });
  cc.imageSmoothingEnabled = false;
  const iw = m.img.naturalWidth || m.img.width;
  const ih = m.img.naturalHeight || m.img.height;
  cc.drawImage(m.img,
    0, rowStart * TILE * (ih / m.h), iw, rows * TILE * (ih / m.h),
    0, 0, m.w, rows * TILE);
  const buf = cc.getImageData(0, 0, m.w, rows * TILE).data;
  c.width = c.height = 0;   // 임시 캔버스 메모리 즉시 반환 (iOS)
  const cells = new Int32Array(m.gw * rows);
  const scratch = new Uint8ClampedArray(TILE_BYTES);
  $('source-name').textContent = `${m.name} — 분절 중…`;
  // 캔버스 쓰기도 배치로 미룬다 — 고유 타일마다 putImageData를 하면 iOS에서 종료됨
  atlasBatch = true;
  try {
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < m.gw; tx++) {
        cells[ty * m.gw + tx] = atlasAdd(extractTileBytes(buf, m.w, tx, ty, scratch));
      }
      if (ty % 8 === 7) {
        await new Promise(r => setTimeout(r, 0));   // UI에 양보 (저사양 기기 응답성)
        if (seq !== sliceSeq) return;               // 더 새로운 분절이 시작됨
      }
    }
  } finally {
    atlasBatch = false;
    syncAtlasCanvas();   // 추가된 타일 전체를 putImageData 1회로 반영
  }
  state.source = { name: m.name, w: m.gw, h: rows, cells, page: pageIdx, pageCount: m.pageCount };
  state.srcSel = null;
  buildSourceBitmap();
  const pageInfo = m.pageCount > 1 ? ` ${pageIdx + 1}/${m.pageCount}쪽` : '';
  $('source-name').textContent = `${m.name}${pageInfo} — ${m.gw}×${rows} 타일`;
  $('btn-place').hidden = false;
  updateSourcePager();
  $('source-panel').classList.remove('collapsed');
  resizeSourceCanvas();
  fitSourceView();
  renderSourcePanel();
  autosaveSoon();
}

function updateSourcePager() {
  const multi = !!(sourceMeta && sourceMeta.pageCount > 1);
  $('src-prev').hidden = !multi;
  $('src-next').hidden = !multi;
  if (multi && state.source) {
    $('src-prev').disabled = state.source.page === 0;
    $('src-next').disabled = state.source.page >= sourceMeta.pageCount - 1;
  }
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
  state.projectName = randScrName();
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
  // NES의 backdrop: 모든 레이어 아래에 깔려 여백도 타일 속 빈 픽셀도 이 색이 된다
  if (state.nes && state.nes.backdropFill) {
    docCtx.fillStyle = state.nes.backdrop;
    docCtx.fillRect(0, 0, docCanvas.width, docCanvas.height);
  }
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
  ctx.setTransform(mainDpr, 0, 0, mainDpr, 0, 0);   // 이전 프레임 예외로 남은 변환 제거
  ctx.clearRect(0, 0, r.width, r.height);
  const v = viewScale();
  const W = state.gridW * TILE, H = state.gridH * TILE;

  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(v, v);
  ctx.imageSmoothingEnabled = false;

  // 문서 배경 체커 (투명 표시) — 배경색 채우기가 켜져 있으면 불필요
  if (!(state.nes && state.nes.backdropFill)) {
    ctx.fillStyle = getCheckerPattern();
    ctx.fillRect(0, 0, W, H);
  }
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

  // 브러시 고스트: 마우스 호버 또는 터치 스탬프 미리보기
  if (hoverCell && (!drawing || touchPreview)) {
    const hc = hoverCell;
    if ((state.tool === 'stamp' || state.tool === 'pattern') && state.brush) {
      const b = state.brush;
      const ox = state.tool === 'stamp' ? hc.cx - Math.floor(b.w / 2) : hc.cx;
      const oy = state.tool === 'stamp' ? hc.cy - Math.floor(b.h / 2) : hc.cy;
      ctx.globalAlpha = 0.5;
      for (let y = 0; y < b.h; y++) {
        for (let x = 0; x < b.w; x++) {
          drawTile(ctx, b.cells[y * b.w + x], (ox + x) * TILE, (oy + y) * TILE);
        }
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5 / v;
      ctx.strokeRect(ox * TILE, oy * TILE, b.w * TILE, b.h * TILE);
    } else if (inGrid(hc.cx, hc.cy)) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5 / v;
      ctx.strokeRect(hc.cx * TILE, hc.cy * TILE, TILE, TILE);
    }
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
  mainDpr = dpr;
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

function layerCellsOf(name) {
  return name === 'bg' ? state.bg : state.sprite;
}

function selLayers() {
  // 🔗 레이어 연동이 켜져 있으면 두 레이어를 함께 선택/이동
  return state.linkLayers ? ['bg', 'sprite'] : [state.activeLayer];
}

function buildFloatCanvas(layers, w, h) {
  const fc = document.createElement('canvas');
  fc.width = w * TILE; fc.height = h * TILE;
  const fctx = fc.getContext('2d');
  for (const name of ['bg', 'sprite']) {   // BG 아래, 스프라이트 위 순서로 합성
    const cells = layers[name];
    if (!cells) continue;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) drawTile(fctx, cells[y * w + x], x * TILE, y * TILE);
    }
  }
  return fc;
}

function liftSelection() {
  // 선택 영역을 레이어에서 들어 올려 플로팅으로 전환
  const s = state.sel;
  if (!s) return;
  pushUndo();
  const lifted = {};
  for (const name of selLayers()) {
    const cells = layerCellsOf(name);
    lifted[name] = rectCells(s, cells);
    for (let y = 0; y < s.h; y++) {
      for (let x = 0; x < s.w; x++) cells[(s.y + y) * state.gridW + (s.x + x)] = -1;
    }
  }
  state.floating = {
    x: s.x, y: s.y, w: s.w, h: s.h,
    layers: lifted, canvas: buildFloatCanvas(lifted, s.w, s.h),
  };
  state.sel = null;
  renderAll();
}

function duplicateSelection() {
  // 선택 영역을 원본은 그대로 둔 채 복사해 플로팅으로
  const s = state.sel;
  if (!s) return;
  pushUndo();
  const copied = {};
  for (const name of selLayers()) copied[name] = rectCells(s, layerCellsOf(name));
  state.floating = {
    x: s.x, y: s.y, w: s.w, h: s.h,
    layers: copied, canvas: buildFloatCanvas(copied, s.w, s.h),
  };
  state.sel = null;
  renderAll();
}

function stampFloatingInPlace() {
  // 플로팅 내용을 현재 위치에 찍되 플로팅은 유지 (연속 도장)
  const f = state.floating;
  if (!f) return;
  pushUndo();
  writeFloating(f);
  renderAll();
  autosaveSoon();
}

function writeFloating(f) {
  for (const [name, src] of Object.entries(f.layers)) {
    const cells = layerCellsOf(name);
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const t = src[y * f.w + x];
        if (t < 0) continue;
        const gx = f.x + x, gy = f.y + y;
        if (inGrid(gx, gy)) cells[gy * state.gridW + gx] = t;
      }
    }
  }
}

function commitFloating() {
  const f = state.floating;
  if (!f) return;
  writeFloating(f);
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
    for (const name of selLayers()) {
      const cells = layerCellsOf(name);
      for (let y = 0; y < s.h; y++) {
        for (let x = 0; x < s.w; x++) cells[(s.y + y) * state.gridW + (s.x + x)] = -1;
      }
    }
    state.sel = null;
  }
  updateSelectionBar();
  renderAll();
  autosaveSoon();
});

$('sel-brush').addEventListener('click', () => {
  // 브러시화: 연동 시 스프라이트가 배경을 덮는 합성 결과를 사용
  const compose = (layers, w, h) => {
    const bg = layers.bg, spr = layers.sprite;
    const out = new Int32Array(w * h).fill(-1);
    for (let i = 0; i < out.length; i++) {
      out[i] = spr && spr[i] >= 0 ? spr[i] : (bg ? bg[i] : (spr ? spr[i] : -1));
    }
    return out;
  };
  let picked = null;
  if (state.floating) {
    const f = state.floating;
    picked = { w: f.w, h: f.h, cells: compose(f.layers, f.w, f.h) };
    commitFloating();
  } else if (state.sel) {
    const s = state.sel;
    const layers = {};
    for (const name of selLayers()) layers[name] = rectCells(s, layerCellsOf(name));
    picked = { w: s.w, h: s.h, cells: compose(layers, s.w, s.h) };
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

// "연속" 토글: 켜면 터치 스탬프가 미리보기에서 잠깐(DWELL_MS) 멈출 때
// 첫 타일이 확정되고, 그때부터 드래그로 연속 칠하기가 된다.
// (동시 두 손 터치는 iOS 사파리에서 신뢰할 수 없어 토글+멈춤 방식을 쓴다)
$('btn-stamp-mode').addEventListener('click', (e) => {
  stampContinuous = !stampContinuous;
  e.currentTarget.classList.toggle('active', stampContinuous);
  dbReq('kv', 'readwrite', s => s.put({ key: 'stampMode', continuous: stampContinuous })).catch(() => {});
});

async function restoreStampMode() {
  try {
    const row = await dbReq('kv', 'readonly', s => s.get('stampMode'));
    if (row) {
      stampContinuous = !!row.continuous;
      $('btn-stamp-mode').classList.toggle('active', stampContinuous);
    }
  } catch (_) { /* 무시 */ }
}

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
  $('pal-backdrop-fill').classList.toggle('active', !!state.nes.backdropFill);
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
        state.dirty = true;
        renderAll();          // 배경색 채우기가 켜져 있으면 즉시 반영
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

// 배경색 슬롯 선택 (고른 뒤 마스터 팔레트에서 색을 누르면 배경색이 바뀐다)
$('pal-backdrop').addEventListener('click', () => {
  palSelectedSlot = palSelectedSlot === 'backdrop' ? null : 'backdrop';
  renderPaletteUI();
});

// 배경색 채우기 토글: 끄면 여백이 투명해져 투명 PNG로 내보낼 수 있다
$('pal-backdrop-fill').addEventListener('click', () => {
  state.nes.backdropFill = !state.nes.backdropFill;
  state.dirty = true;
  renderPaletteUI();
  renderAll();
  autosaveSoon();
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
let panDrag = null;        // 마우스 가운데 버튼 팬 {x, y, panX, panY}
let hoverCell = null;      // 마우스 호버 셀 (브러시 고스트 표시용)
let touchPreview = false;  // 터치 스탬프: 누르는 동안 반투명 미리보기, 떼면 확정
let stampContinuous = false;   // "연속" 토글 상태 — 미리보기에서 멈추면 확정 후 드래그 연속
let dwellTimer = null;         // 연속 모드: 같은 칸에 DWELL_MS 머무르면 확정
const DWELL_MS = 300;

// 연속 모드에서 미리보기 → 잠깐 멈추면 첫 타일을 확정하고 연속 칠하기로 전환
function armDwell() {
  clearTimeout(dwellTimer);
  dwellTimer = setTimeout(() => {
    if (!drawing || !touchPreview || !hoverCell) return;
    if (state.tool !== 'stamp' || !state.brush) return;
    pushUndo(); undoPushed = true;
    stampAt(hoverCell.cx, hoverCell.cy);
    lastCell = { cx: hoverCell.cx, cy: hoverCell.cy };
    touchPreview = false;
    hoverCell = null;
    renderAll();
  }, DWELL_MS);
}

canvas.addEventListener('pointerdown', (e) => {
  if (!exportMenu.hidden) exportMenu.hidden = true;   // 캔버스 터치 시 내보내기 창 닫기
  // 마우스 가운데 버튼: 캔버스 이동 (데스크탑)
  if (e.pointerType === 'mouse' && e.button === 1) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    panDrag = { x: e.offsetX, y: e.offsetY, panX: state.panX, panY: state.panY };
    return;
  }
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
      if (e.pointerType !== 'mouse' && state.brush) {
        // 터치/펜슬: 누르는 동안 반투명 미리보기, 떼면 확정.
        // 연속 모드면 같은 칸에 잠깐 멈출 때 확정하고 드래그 연속으로 전환.
        touchPreview = true;
        hoverCell = { cx, cy };
        if (stampContinuous) armDwell();
        render();
        break;
      }
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
  if (panDrag) {
    state.panX = panDrag.panX + (e.offsetX - panDrag.x);
    state.panY = panDrag.panY + (e.offsetY - panDrag.y);
    render();
    return;
  }
  // 마우스 호버(버튼 안 누른 상태): 브러시 고스트 위치 갱신
  if (e.pointerType === 'mouse' && !pointers.has(e.pointerId)) {
    const c = screenToCell(e.offsetX, e.offsetY);
    if (!hoverCell || c.cx !== hoverCell.cx || c.cy !== hoverCell.cy) {
      hoverCell = c;
      render();
    }
    return;
  }
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
      if (touchPreview) {
        if (!hoverCell || cx !== hoverCell.cx || cy !== hoverCell.cy) {
          hoverCell = { cx, cy };
          if (stampContinuous) armDwell();   // 칸이 바뀌면 멈춤 타이머 재시작
          render();
        }
        break;
      }
      /* fallthrough */
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
  if (panDrag) { panDrag = null; return; }
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!drawing || pointers.size > 0) return;
  clearTimeout(dwellTimer);

  if (state.tool === 'shift' && shiftState.active && !shiftState.axis && undoPushed) {
    state.undoStack.pop();   // 움직임 없던 시프트는 undo 항목 제거
    undoPushed = false;
  }
  shiftState.active = false;
  shiftState.snap = null;

  if (touchPreview) {
    if (hoverCell) {
      pushUndo();
      stampAt(hoverCell.cx, hoverCell.cy);
    }
    touchPreview = false;
    hoverCell = null;
    renderAll();
  }

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

canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse' && hoverCell) {
    hoverCell = null;
    render();
  }
});

// 데스크탑: 휠 = 커서 기준 줌 (트랙패드 핀치 포함)
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const newZoom = Math.min(16, Math.max(0.2, state.zoom * factor));
  const applied = newZoom / state.zoom;
  state.zoom = newZoom;
  state.panX = e.offsetX - (e.offsetX - state.panX) * applied;
  state.panY = e.offsetY - (e.offsetY - state.panY) * applied;
  render();
}, { passive: false });
// 가운데 버튼 자동 스크롤 방지
canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

function cancelStroke() {
  if (!drawing) return;
  clearTimeout(dwellTimer);
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
  touchPreview = false;
  hoverCell = null;
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
  srcDpr = dpr;
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
  // CPU 버퍼에서 조립해 putImageData 1회 — 셀마다 drawImage하면 iOS가 버거워함
  const img = new ImageData(sourceBitmap.width, sourceBitmap.height);
  const rowBytes = TILE * 4;
  const imgRowBytes = sourceBitmap.width * 4;
  for (let cy = 0; cy < src.h; cy++) {
    for (let cx = 0; cx < src.w; cx++) {
      const idx = src.cells[cy * src.w + cx];
      if (idx < 0 || idx >= atlas.count) continue;
      const bytes = tileBytes(idx);
      for (let y = 0; y < TILE; y++) {
        img.data.set(bytes.subarray(y * rowBytes, (y + 1) * rowBytes),
          (cy * TILE + y) * imgRowBytes + cx * rowBytes);
      }
    }
  }
  sourceBitmap.getContext('2d').putImageData(img, 0, 0);
}

function renderSourcePanel() {
  const rect = sourceCanvas.getBoundingClientRect();
  sourceCtx.setTransform(srcDpr, 0, 0, srcDpr, 0, 0);   // 이전 프레임 예외로 남은 변환 제거
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

let srcPanDrag = null;

sourceCanvas.addEventListener('pointerdown', (e) => {
  if (!state.source) return;
  if (e.pointerType === 'mouse' && e.button === 1) {
    e.preventDefault();
    sourceCanvas.setPointerCapture(e.pointerId);
    srcPanDrag = { x: e.offsetX, y: e.offsetY, panX: srcView.panX, panY: srcView.panY };
    return;
  }
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
  if (srcPanDrag) {
    srcView.panX = srcPanDrag.panX + (e.offsetX - srcPanDrag.x);
    srcView.panY = srcPanDrag.panY + (e.offsetY - srcPanDrag.y);
    renderSourcePanel();
    return;
  }
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
  if (srcPanDrag) { srcPanDrag = null; return; }
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
sourceCanvas.addEventListener("pointercancel", srcPointerEnd);
sourceCanvas.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });

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

const srcHandle = $('source-resize-handle');
let srcResize = null;      // {startY, startH}
let srcResizeRaf = false;

srcHandle.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  srcHandle.setPointerCapture(e.pointerId);
  srcResize = { startY: e.clientY, startH: $('source-body').getBoundingClientRect().height };
  srcHandle.classList.add('active');
});
srcHandle.addEventListener('pointermove', (e) => {
  if (!srcResize) return;
  const h = Math.min(window.innerHeight * 0.6,
    Math.max(120, srcResize.startH + (srcResize.startY - e.clientY)));
  $('source-body').style.height = h + 'px';
  if (!srcResizeRaf) {
    srcResizeRaf = true;
    requestAnimationFrame(() => {
      srcResizeRaf = false;
      resizeSourceCanvas();   // 캔버스 영역이 실시간으로 재배분됨
      resizeCanvas();
    });
  }
});
function endSrcResize() {
  if (!srcResize) return;
  srcResize = null;
  srcHandle.classList.remove('active');
  resizeSourceCanvas();
  resizeCanvas();
  dbReq('kv', 'readwrite', s =>
    s.put({ key: 'srcPanelH', h: Math.round($('source-body').getBoundingClientRect().height) })
  ).catch(() => {});
}
srcHandle.addEventListener('pointerup', endSrcResize);
srcHandle.addEventListener('pointercancel', endSrcResize);

async function restoreSrcPanelH() {
  try {
    const row = await dbReq('kv', 'readonly', s => s.get('srcPanelH'));
    if (row && row.h >= 120) $('source-body').style.height = row.h + 'px';
  } catch (_) { /* 무시 */ }
}

$('btn-source-fit').addEventListener('click', () => {
  fitSourceView();
  renderSourcePanel();
});

$('src-prev').addEventListener('click', () => {
  if (sourceMeta && state.source && state.source.page > 0) slicePage(state.source.page - 1);
});
$('src-next').addEventListener('click', () => {
  if (sourceMeta && state.source && state.source.page < sourceMeta.pageCount - 1) {
    slicePage(state.source.page + 1);
  }
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
// 에셋 항목 하나를 그린다 (리포·클라우드 공통 모양)
function assetItemEl(labelText, thumbSrc, onPick, onDelete) {
  const item = document.createElement('button');
  item.className = 'asset-item';
  const img = document.createElement('img');
  img.src = thumbSrc;
  img.alt = labelText;
  const label = document.createElement('span');
  label.textContent = labelText;
  item.append(img, label);
  item.addEventListener('click', () => {
    document.querySelectorAll('#asset-list .asset-item').forEach(el => el.classList.remove('active'));
    item.classList.add('active');
    onPick();
  });
  if (onDelete) {
    const del = document.createElement('span');
    del.className = 'asset-del';
    del.textContent = '✕';
    del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
    item.appendChild(del);
  }
  return item;
}

function assetFolderEl(title, wrap) {
  const sec = document.createElement('div');
  sec.className = 'asset-folder';
  const h = document.createElement('h4');
  h.textContent = title;
  const grid = document.createElement('div');
  grid.className = 'asset-grid';
  sec.append(h, grid);
  wrap.appendChild(sec);
  return grid;
}

// 클라우드 에셋 섹션 (연결되어 있을 때만)
function renderCloudAssets(wrap) {
  if (!cloudAssets.length) return;
  const byFolder = {};
  for (const a of cloudAssets) (byFolder[a.folder] = byFolder[a.folder] || []).push(a);
  for (const [folder, list] of Object.entries(byFolder)) {
    const grid = assetFolderEl('☁︎ ' + folder, wrap);
    for (const a of list) {
      const el = assetItemEl(
        a.name.replace(/\.[^.]+$/, ''),
        'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
        async () => {
          try { await useCloudAsset(a); closeDrawers(); }
          catch (_) { $('gh-asset-status').textContent = `${a.name}을(를) 불러오지 못했습니다.`; }
        },
        async () => {
          if (!confirm(`${a.name}을(를) 클라우드에서 삭제할까요?`)) return;
          try {
            await ghDeleteFile(a.path, a.sha, `Delete asset ${a.name}`);
            await dbReq('cloudAssets', 'readwrite', s => s.delete(a.path)).catch(() => {});
            await refreshCloudAssets();
            renderAssetDrawer();
          } catch (_) { $('gh-asset-status').textContent = '삭제하지 못했습니다.'; }
        });
      // 썸네일은 캐시에 있으면 즉시, 없으면 받아서 채운다
      cloudCacheGet(a.path).then(c => {
        if (c && c.b64) el.querySelector('img').src = 'data:image/png;base64,' + c.b64;
      });
      grid.appendChild(el);
    }
  }
}

async function renderAssetDrawer() {
  const wrap = $('asset-list');
  wrap.innerHTML = '';
  renderCloudAssets(wrap);
  await loadAssetIndex(wrap);
}

async function loadAssetIndex(wrap) {
  wrap = wrap || $('asset-list');
  try {
    const res = await fetch('assets/index.json', { cache: 'no-cache' });
    const index = await res.json();
    for (const [folder, files] of Object.entries(index)) {
      const grid = assetFolderEl('📁 ' + folder, wrap);
      for (const file of files) {
        const url = `assets/${folder}/${file}`;
        const name = file.replace(/\.[^.]+$/, '');
        grid.appendChild(assetItemEl(name, url, () => {
          const loader = new Image();
          loader.onload = () => {
            sliceImage(loader, `${folder}/${name}`);
            closeDrawers();
          };
          loader.src = url;
        }));
      }
    }
    if (!Object.keys(index).length && !cloudAssets.length) wrap.textContent = '에셋이 없습니다.';
  } catch (_) {
    if (!cloudAssets.length) wrap.textContent = '에셋 목록을 불러오지 못했습니다.';
  }
}

/* ===== 클라우드 에셋 ===== */
// assets/ 아래에는 이미지가 아닌 파일도 있을 수 있다 (.gitkeep, README.md 등)
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
let cloudAssets = [];   // [{path, folder, name, sha}]

/* ===== 팔레트 PNG 인코더 =====
 * 캔버스의 toDataURL은 항상 32비트 RGBA로 쓴다. 8비트 타일 그래픽은 보통 2~16색이라
 * 팔레트(색 인덱스) PNG로 쓰면 훨씬 작다 — 2색 폰트 시트 기준 19,856 → 2,214바이트.
 * 색이 256개를 넘거나 CompressionStream이 없으면 null을 돌려주고 캔버스 인코딩을 쓴다.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, body) {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

// ImageData → 팔레트 PNG 바이트 (색 256개 초과면 null)
async function encodeIndexedPNG(imgData) {
  const { width: w, height: h, data } = imgData;
  const px32 = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const map = new Map();
  const colors = [];
  const idx = new Uint8Array(w * h);
  for (let i = 0; i < px32.length; i++) {
    const key = px32[i];
    let v = map.get(key);
    if (v === undefined) {
      if (colors.length >= 256) return null;      // 사진 등 → 캔버스 인코딩으로
      v = colors.length;
      map.set(key, v);
      colors.push(key);
    }
    idx[i] = v;
  }
  const n = colors.length;
  const depth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
  const perByte = 8 / depth;
  const stride = Math.ceil(w / perByte);

  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;                            // 필터 없음
    for (let x = 0; x < w; x++) {
      const v = idx[y * w + x];
      if (depth === 8) raw[rowStart + 1 + x] = v;
      else raw[rowStart + 1 + Math.floor(x / perByte)] |= v << (8 - depth * ((x % perByte) + 1));
    }
  }
  const deflated = await zlibDeflate(raw);
  if (!deflated) return null;                     // CompressionStream 미지원

  const plte = new Uint8Array(n * 3);
  const trns = new Uint8Array(n);
  let hasAlpha = false;
  for (let i = 0; i < n; i++) {
    const c = colors[i];                          // 리틀엔디언 RGBA
    plte[i * 3] = c & 0xFF;
    plte[i * 3 + 1] = (c >>> 8) & 0xFF;
    plte[i * 3 + 2] = (c >>> 16) & 0xFF;
    trns[i] = (c >>> 24) & 0xFF;
    if (trns[i] !== 255) hasAlpha = true;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = depth; ihdr[9] = 3;                   // 색 타입 3 = 팔레트

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
  ];
  if (hasAlpha) parts.push(pngChunk('tRNS', trns));
  parts.push(pngChunk('IDAT', deflated), pngChunk('IEND', new Uint8Array(0)));

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// 이미지를 2048px 상한으로 정규화해 PNG base64로 (분절 상한과 동일하게 맞춘다)
async function imageToPngB64(img) {
  const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cc = c.getContext('2d', { willReadFrequently: true });
  cc.imageSmoothingEnabled = false;
  cc.drawImage(img, 0, 0, w, h);
  const canvasB64 = c.toDataURL('image/png').split(',')[1];
  // 팔레트 PNG로 다시 써 보고 더 작은 쪽을 올린다 (타일 그래픽은 보통 크게 줄어든다)
  try {
    const indexed = await encodeIndexedPNG(cc.getImageData(0, 0, w, h));
    if (indexed && indexed.length * 4 / 3 < canvasB64.length) return bytesToB64(indexed);
  } catch (_) { /* 실패하면 캔버스 인코딩 사용 */ }
  return canvasB64;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image'));
    img.src = src;
  });
}

async function cloudCachePut(path, sha, b64) {
  try {
    await dbReq('cloudAssets', 'readwrite', s => s.put({ path, sha, b64 }));
  } catch (_) { /* 용량 초과 등은 무시 — 캐시는 선택적 */ }
}
async function cloudCacheGet(path) {
  try { return await dbReq('cloudAssets', 'readonly', s => s.get(path)); }
  catch (_) { return null; }
}

// 클라우드 에셋 목록 갱신: 온라인이면 트리 API, 아니면 캐시에 있는 것만
async function refreshCloudAssets() {
  if (!ghReady()) { cloudAssets = []; return; }
  try {
    const tree = await ghListTree();
    cloudAssets = tree
      .filter(t => t.path.startsWith('assets/') && IMAGE_RE.test(t.path))
      .map(t => {
        const rest = t.path.slice('assets/'.length);
        const i = rest.lastIndexOf('/');
        return {
          path: t.path, sha: t.sha,
          folder: i >= 0 ? rest.slice(0, i) : '(루트)',
          name: i >= 0 ? rest.slice(i + 1) : rest,
        };
      });
  } catch (_) {
    // 오프라인·인증 실패 → 캐시된 것만 보여준다
    try {
      const rows = (await dbReq('cloudAssets', 'readonly', s => s.getAll())) || [];
      cloudAssets = rows.map(r => {
        const rest = r.path.slice('assets/'.length);
        const i = rest.lastIndexOf('/');
        return {
          path: r.path, sha: r.sha, cached: true,
          folder: i >= 0 ? rest.slice(0, i) : '(루트)',
          name: i >= 0 ? rest.slice(i + 1) : rest,
        };
      });
    } catch (__) { cloudAssets = []; }
  }
}

// 클라우드 에셋 하나를 분절해 소스로 (캐시 우선 → 없으면 내려받아 캐시)
async function useCloudAsset(a) {
  let b64 = null;
  const cached = await cloudCacheGet(a.path);
  if (cached && cached.sha === a.sha) b64 = cached.b64;
  if (!b64) {
    const file = await ghGetFile(a.path);
    if (!file) throw new Error('missing');
    b64 = bytesToB64(file.bytes);
    await cloudCachePut(a.path, file.sha, b64);
  }
  const img = await loadImage('data:image/png;base64,' + b64);
  sliceImage(img, `${a.folder}/${a.name.replace(/\.[^.]+$/, '')}`);
}

$('gh-asset-upload').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  const status = $('gh-asset-status');
  if (!ghReady()) { status.textContent = '먼저 프로젝트 서랍에서 클라우드에 연결하세요.'; return; }
  const folder = ($('gh-asset-folder').value || '').trim().replace(/^\/+|\/+$/g, '') || 'uploads';
  let done = 0;
  for (const f of files) {
    status.textContent = `올리는 중… (${done + 1}/${files.length})`;
    try {
      const url = URL.createObjectURL(f);
      const img = await loadImage(url);
      URL.revokeObjectURL(url);
      const b64 = await imageToPngB64(img);
      const name = f.name.replace(/\.[^.]+$/, '') + '.png';
      const path = `assets/${folder}/${name}`;
      const existing = await ghGetFile(path).catch(() => null);
      const sha = await ghPutFile(path, b64, `Add asset ${name}`, existing ? existing.sha : null);
      await cloudCachePut(path, sha, b64);
      done++;
    } catch (err) {
      status.textContent = err && err.code === 'auth'
        ? '토큰이 거부되었습니다. 권한과 만료일을 확인하세요.'
        : `올리기 실패: ${f.name}`;
      return;
    }
  }
  status.textContent = `${done}장 올렸습니다.`;
  await refreshCloudAssets();
  renderAssetDrawer();
});

let importObjectUrl = null;   // 페이지 넘김 시 재사용하므로 다음 가져오기 전까지 유지

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (importObjectUrl) URL.revokeObjectURL(importObjectUrl);
  importObjectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    sliceImage(img, file.name.replace(/\.[^.]+$/, ''));
    closeDrawers();
  };
  img.src = importObjectUrl;
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

$('layer-link').addEventListener('click', (e) => {
  clearSelection();   // 연동 상태가 바뀌면 진행 중인 선택은 확정
  state.linkLayers = !state.linkLayers;
  e.currentTarget.classList.toggle('active', state.linkLayers);
});

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

/* ===== 내보내기 (⬇︎ → PNG/Aseprite 선택창) ===== */
const exportMenu = $('export-menu');
$('btn-export').addEventListener('click', () => {
  exportMenu.hidden = !exportMenu.hidden;
});
$('export-png').addEventListener('click', () => {
  exportMenu.hidden = true;
  exportPNG();
});
$('export-ase').addEventListener('click', () => {
  exportMenu.hidden = true;
  exportAseprite();
});

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_${String(d.getDate()).padStart(2, '0')}`;
}

function exportPNG() {
  // 1배 원본 해상도 (1픽셀 = 1도트), 파일명은 오늘 날짜
  commitFloating();
  renderDoc();
  const a = document.createElement('a');
  a.href = docCanvas.toDataURL('image/png');
  a.download = (state.projectName || todayStamp()) + '.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ===== Aseprite(.aseprite) 내보내기 =====
 * 파일 스펙: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md
 * BG/스프라이트를 실제 레이어 2장으로, 32bpp RGBA, 8×8 그리드 설정 포함.
 */
function layerToRGBA(cells) {
  const W = state.gridW * TILE, H = state.gridH * TILE;
  const out = new Uint8ClampedArray(W * H * 4);
  const rowBytes = TILE * 4;
  const outRowBytes = W * 4;
  for (let cy = 0; cy < state.gridH; cy++) {
    for (let cx = 0; cx < state.gridW; cx++) {
      const idx = cells[cy * state.gridW + cx];
      if (idx < 0 || idx >= atlas.count) continue;
      const bytes = tileBytes(idx);
      for (let y = 0; y < TILE; y++) {
        out.set(bytes.subarray(y * rowBytes, (y + 1) * rowBytes),
          (cy * TILE + y) * outRowBytes + cx * rowBytes);
      }
    }
  }
  return out;
}

// 단색 레이어(backdrop)용 RGBA 버퍼
function solidRGBA(hex) {
  const W = state.gridW * TILE, H = state.gridH * TILE;
  const out = new Uint8ClampedArray(W * H * 4);
  const [r, g, b] = hexToRGB(hex);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
  }
  return out;
}

async function zlibDeflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;   // 미지원 → raw cel로 대체
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function aseWriter() {
  const parts = [];
  let length = 0;
  const push = (arr) => { parts.push(arr); length += arr.length; };
  const num = (value, byteLen) => {
    const a = new Uint8Array(byteLen);
    for (let i = 0; i < byteLen; i++) a[i] = (value >>> (i * 8)) & 0xff;   // 리틀엔디언
    push(a);
  };
  return {
    u8: (v) => num(v, 1),
    u16: (v) => num(v, 2),
    u32: (v) => num(v, 4),
    i16: (v) => num(v < 0 ? v + 0x10000 : v, 2),
    bytes: push,
    zeros: (n) => push(new Uint8Array(n)),
    size: () => length,
    concat() {
      const out = new Uint8Array(length);
      let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      return out;
    },
  };
}

async function exportAseprite() {
  commitFloating();
  const W = state.gridW * TILE, H = state.gridH * TILE;
  const layers = [];
  if (state.nes.backdropFill) {
    layers.push({ name: 'Backdrop', pixels: solidRGBA(state.nes.backdrop) });
  }
  layers.push(
    { name: 'Background', pixels: layerToRGBA(state.bg) },
    { name: 'Sprite', pixels: layerToRGBA(state.sprite) },
  );
  for (const l of layers) l.zlib = await zlibDeflate(l.pixels);

  // 청크들 먼저 조립
  const chunks = [];
  const addChunk = (type, body) => {
    const w = aseWriter();
    w.u32(body.length + 6);
    w.u16(type);
    w.bytes(body);
    chunks.push(w.concat());
  };
  {   // 색 프로파일 (sRGB)
    const w = aseWriter();
    w.u16(1); w.u16(0); w.u32(0); w.zeros(8);
    addChunk(0x2007, w.concat());
  }
  for (const l of layers) {   // 레이어 청크
    const w = aseWriter();
    w.u16(3);                 // flags: visible | editable
    w.u16(0); w.u16(0);       // type, child level
    w.u16(0); w.u16(0);       // 무시되는 기본 크기
    w.u16(0);                 // blend: normal
    w.u8(255); w.zeros(3);    // opacity + reserved
    const name = new TextEncoder().encode(l.name);
    w.u16(name.length); w.bytes(name);
    addChunk(0x2004, w.concat());
  }
  layers.forEach((l, i) => {  // 셀 청크 (레이어당 1개)
    const w = aseWriter();
    w.u16(i);                 // layer index
    w.i16(0); w.i16(0);       // x, y
    w.u8(255);                // opacity
    w.u16(l.zlib ? 2 : 0);    // cel type: 2=zlib 압축, 0=raw
    w.i16(0); w.zeros(5);     // z-index + reserved
    w.u16(W); w.u16(H);
    w.bytes(l.zlib || l.pixels);
    addChunk(0x2005, w.concat());
  });

  // 프레임 1개
  const frame = aseWriter();
  const chunkBytes = chunks.reduce((s, c) => s + c.length, 0);
  frame.u32(16 + chunkBytes);          // 프레임 크기 (헤더 16 + 청크)
  frame.u16(0xF1FA);                   // 프레임 매직
  frame.u16(chunks.length);            // (구) 청크 수
  frame.u16(100);                      // 프레임 시간(ms)
  frame.zeros(2);
  frame.u32(chunks.length);            // (신) 청크 수
  for (const c of chunks) frame.bytes(c);
  const frameData = frame.concat();

  // 파일 헤더 (128바이트)
  const head = aseWriter();
  head.u32(128 + frameData.length);    // 파일 크기
  head.u16(0xA5E0);                    // 파일 매직
  head.u16(1);                         // 프레임 수
  head.u16(W); head.u16(H);
  head.u16(32);                        // 색 깊이: RGBA
  head.u32(1);                         // flags: 레이어 불투명도 유효
  head.u16(100);                       // (구) 속도
  head.u32(0); head.u32(0);
  head.u8(0); head.zeros(3);           // 투명 인덱스 + 예약
  head.u16(0);                         // 색 수 (RGBA에선 무시)
  head.u8(1); head.u8(1);              // 픽셀 비율 1:1
  head.i16(0); head.i16(0);            // 그리드 원점
  head.u16(TILE); head.u16(TILE);      // 그리드 크기 8×8
  head.zeros(84);

  const blob = new Blob([head.concat(), frameData], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (state.projectName || 'tile') + '.aseprite';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ===== 저장 (IndexedDB) ===== */
const DB_NAME = 'glitch-tile-editor';
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      // 기존 기기는 업그레이드 경로로 들어오므로 스토어마다 존재 여부를 확인한다
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
      // 클라우드에서 받은 에셋 캐시 (오프라인에서도 목록·사용 가능하도록)
      if (!db.objectStoreNames.contains('cloudAssets')) {
        db.createObjectStore('cloudAssets', { keyPath: 'path' });
      }
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

/* ===== GitHub 비공개 리포 = 클라우드 저장소 =====
 * 앱은 공개 리포(Pages)에서 배포되지만, 데이터는 사용자의 별도 비공개 리포에 둔다.
 * 토큰은 이 기기의 IndexedDB에만 저장되며 백업 파일에도 포함되지 않는다.
 *   projects/<이름>.json   작업물
 *   assets/<폴더>/<파일>   에셋
 * 목록은 인덱스 파일 없이 git trees API로 한 번에 받는다(동시 수정 충돌 지점을 없애려고).
 */
let GH_API = 'https://api.github.com';   // 테스트에서 모의 서버로 교체 가능
let ghConfig = null;                     // {owner, repo, token} — 브랜치는 항상 리포 기본값

function ghReady() {
  return !!(ghConfig && ghConfig.token && ghConfig.owner && ghConfig.repo);
}

function ghPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// UTF-8 안전 base64 (한글 파일명·작품명이 들어가므로 btoa 직접 사용 불가)
function utf8ToB64(str) {
  return bytesToB64(new TextEncoder().encode(str));
}
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64ToUtf8(b64) {
  return new TextDecoder().decode(b64ToBytes(b64));
}

async function ghFetch(path, opts = {}) {
  const res = await fetch(GH_API + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${ghConfig.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('auth'), { code: 'auth', status: res.status });
  }
  return res;
}

function ghRepoBase() {
  return `/repos/${encodeURIComponent(ghConfig.owner)}/${encodeURIComponent(ghConfig.repo)}`;
}

// 리포 전체 파일 목록 (blob만). 커밋이 없는 빈 리포는 빈 배열.
async function ghListTree() {
  // 브랜치를 저장해두지 않고 HEAD를 본다 — 리포의 기본 브랜치가 바뀌어도 따라간다
  const res = await ghFetch(`${ghRepoBase()}/git/trees/HEAD?recursive=1`);
  if (res.status === 404 || res.status === 409) return [];   // 빈 리포 / 브랜치 없음
  if (!res.ok) throw new Error('tree ' + res.status);
  const json = await res.json();
  return (json.tree || []).filter(t => t.type === 'blob');
}

// 파일 하나 읽기 → { bytes, sha } (없으면 null)
async function ghGetFile(path) {
  const res = await ghFetch(`${ghRepoBase()}/contents/${ghPath(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('get ' + res.status);
  const json = await res.json();
  // 1MB를 넘으면 Contents API가 내용을 비워 보내므로 blob API로 다시 받는다
  if (!json.content && json.sha) {
    const b = await ghFetch(`${ghRepoBase()}/git/blobs/${json.sha}`);
    if (!b.ok) throw new Error('blob ' + b.status);
    const bj = await b.json();
    return { bytes: b64ToBytes(bj.content), sha: json.sha };
  }
  return { bytes: b64ToBytes(json.content), sha: json.sha };
}

// 파일 쓰기. sha를 넘기면 그 버전 위에만 쓰이고, 다른 기기가 먼저 고쳤으면 conflict.
async function ghPutFile(path, b64, message, sha) {
  const body = { message, content: b64 };
  if (sha) body.sha = sha;
  const res = await ghFetch(`${ghRepoBase()}/contents/${ghPath(path)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409 || res.status === 422) {
    throw Object.assign(new Error('conflict'), { code: 'conflict' });
  }
  if (!res.ok) throw new Error('put ' + res.status);
  const json = await res.json();
  return json.content ? json.content.sha : null;
}

async function ghDeleteFile(path, sha, message) {
  const res = await ghFetch(`${ghRepoBase()}/contents/${ghPath(path)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok && res.status !== 404) throw new Error('delete ' + res.status);
}

async function ghSaveConfig(cfg) {
  ghConfig = cfg;
  await dbReq('kv', 'readwrite', s => s.put({ key: 'gh', ...cfg }));
}
async function ghRestoreConfig() {
  try {
    const row = await dbReq('kv', 'readonly', s => s.get('gh'));
    if (row && row.token) {
      ghConfig = { owner: row.owner, repo: row.repo, token: row.token };
    }
  } catch (_) { /* 무시 */ }
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
      // 옛 저장본에 없는 필드는 기본값으로 채운다 (예: backdropFill)
      if (doc.nes) state.nes = { ...defaultNesState(), ...doc.nes };
      // 마스터 팔레트는 전역(kv 'masterPalette')으로만 관리 — 문서에 저장하지 않음
      if (!palettePanel.hidden) renderPaletteUI();
      state.gridW = doc.gridW;
      state.gridH = doc.gridH;
      state.bg = Int32Array.from(doc.bg);
      state.sprite = Int32Array.from(doc.sprite);
      state.projectName = doc.name || todayStamp();
      state.undoStack = [];
      state.redoStack = [];
      state.sel = null;
      state.floating = null;
      state.brush = null;
      state.source = null;
      state.srcSel = null;
      sourceBitmap = null;
      sourceMeta = null;
      updateSourcePager();
      $('source-name').textContent = '에셋을 선택하세요';
      $('btn-place').hidden = true;
      renderSourcePanel();
      renderBrushPreview();
      updateSelectionBar();
      updateSizeLabel();
      state.dirty = false;
      updateProjectLabel();
      fitView();
      renderAll();
      resolve();
    };
    img.onerror = () => resolve();
    img.src = doc.atlas;
  });
}

function updateProjectLabel() {
  const status = state.projectId == null
    ? '저장 안 됨'
    : (state.dirty ? '변경됨' : '저장됨');
  $('project-name').textContent = `${state.projectName} · ${status}`;
  const info = $('current-info');
  if (info) info.textContent = `현재 캔버스: ${state.projectName} · ${state.gridW}×${state.gridH} · ${status}`;
}

let autosaveTimer = null;
function autosaveSoon() {
  state.dirty = true;
  updateProjectLabel();
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
  state.dirty = false;   // 방금 저장했으므로 (autosaveSoon이 세운 플래그 해제)
  updateProjectLabel();
  refreshSavedList();
  if (ghReady() && ghAutoPush()) cloudPushProject(doc, id);
}

/* ===== 작업물 클라우드 동기화 =====
 * 올리기는 저장할 때 자동, 받기는 항상 명시적으로.
 * 다른 기기가 먼저 고친 경우 sha가 어긋나 conflict가 나고, 그때만 사용자에게 묻는다.
 */
let cloudProjects = [];   // [{name, path, sha}]

function ghAutoPush() {
  const el = $('gh-autopush');
  return !el || el.checked;
}

function cloudProjectPath(name) {
  return `projects/${name}.json`;
}

async function cloudPushProject(doc, localId) {
  const path = cloudProjectPath(doc.name);
  const status = $('gh-status');
  const body = { ...doc };
  delete body.id;                       // 로컬 IndexedDB id는 기기마다 다르므로 보내지 않는다
  const b64 = utf8ToB64(JSON.stringify(body));
  const known = cloudProjects.find(p => p.path === path);
  try {
    let sha = known ? known.sha : null;
    if (!sha) {
      const cur = await ghGetFile(path).catch(() => null);
      // 이 기기가 한 번도 본 적 없는 파일이 이미 있다 = 다른 기기가 같은 이름을 쓴 것.
      // sha를 그대로 써서 올리면 남의 작업이 조용히 사라지므로 반드시 확인한다.
      if (cur && !confirm(
        `클라우드에 이미 "${doc.name}"이(가) 있습니다 (다른 기기에서 만든 것일 수 있음).\n` +
        '확인 = 덮어쓰기, 취소 = 올리지 않기')) {
        if (status) status.textContent = '이름이 겹쳐 올리지 않았습니다 — 이름을 바꿔 저장하세요.';
        return;
      }
      sha = cur ? cur.sha : null;
    }
    const newSha = await ghPutFile(path, b64, `Save ${doc.name}`, sha);
    if (known) known.sha = newSha;
    else cloudProjects.push({ name: doc.name, path, sha: newSha });
    if (status) status.textContent = `연결됨 · ${ghConfig.owner}/${ghConfig.repo} · 방금 올림`;
  } catch (err) {
    if (err && err.code === 'conflict') {
      const ok = confirm(
        `"${doc.name}"이(가) 다른 기기에서 바뀌었습니다.\n확인 = 이 기기 내용으로 덮어쓰기, 취소 = 올리지 않음`);
      if (ok) {
        const cur = await ghGetFile(path).catch(() => null);
        if (cur) {
          try {
            const forced = await ghPutFile(path, b64, `Overwrite ${doc.name}`, cur.sha);
            const k = cloudProjects.find(p => p.path === path);
            if (k) k.sha = forced;
          } catch (_) { /* 무시 */ }
        }
      }
    } else if (status) {
      status.textContent = err && err.code === 'auth'
        ? '토큰이 거부되었습니다 — 권한/만료일 확인'
        : '올리지 못했습니다 (오프라인일 수 있음)';
    }
  }
}

async function refreshCloudProjects() {
  if (!ghReady()) { cloudProjects = []; return; }
  try {
    const tree = await ghListTree();
    cloudProjects = tree
      .filter(t => t.path.startsWith('projects/') && t.path.endsWith('.json'))
      .map(t => ({
        path: t.path, sha: t.sha,
        name: t.path.slice('projects/'.length).replace(/\.json$/, ''),
      }));
  } catch (_) { cloudProjects = []; }
}

// 클라우드 작업물을 받아서 로컬에 저장하고 연다
async function cloudPullProject(p) {
  const file = await ghGetFile(p.path);
  if (!file) throw new Error('missing');
  const doc = JSON.parse(new TextDecoder().decode(file.bytes));
  // id 속성이 남아 있으면 autoIncrement가 동작하지 않으므로 아예 제거한다
  const { id: _drop, ...fresh } = doc;
  const id = await dbReq('projects', 'readwrite', s => s.put(fresh));
  await loadDoc(doc);
  state.projectId = id;
  state.projectName = doc.name;
  updateProjectLabel();
  refreshSavedList();
  autosaveSoon();
}

async function refreshSavedList() {
  const list = $('saved-list');
  list.innerHTML = '';
  let projects = [];
  try {
    projects = (await dbReq('projects', 'readonly', s => s.getAll())) || [];
  } catch (_) { /* 무시 */ }
  projects.sort((a, b) => b.updated - a.updated);
  const localNames = new Set(projects.map(p => p.name));
  for (const p of projects) {
    const li = document.createElement('li');
    const thumb = document.createElement('img');
    thumb.src = p.thumb;
    thumb.width = 56; thumb.height = 42;
    thumb.style.objectFit = 'contain';
    thumb.style.imageRendering = 'pixelated';

    if (p.id === state.projectId) li.classList.add('current');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${p.id === state.projectId ? '● ' : ''}${p.name} (${p.gridW}×${p.gridH})`;

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
  // 클라우드에만 있는 작업물 (아직 이 기기에 없는 것)
  for (const c of cloudProjects) {
    if (localNames.has(c.name)) continue;
    const li = document.createElement('li');
    li.className = 'cloud-only';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `☁︎ ${c.name}`;
    const getBtn = document.createElement('button');
    getBtn.textContent = '받기';
    getBtn.addEventListener('click', async () => {
      getBtn.textContent = '받는 중…';
      try { await cloudPullProject(c); closeDrawers(); }
      catch (_) { getBtn.textContent = '실패'; }
    });
    li.append(name, getBtn);
    list.appendChild(li);
  }
}

/* ===== 전체 백업 (모든 프로젝트 + 현재 캔버스 + 팔레트) ===== */
/* ===== 클라우드 연결 UI ===== */
function updateGhStatus(msg) {
  const el = $('gh-status');
  if (!el) return;
  if (msg) { el.textContent = msg; return; }
  if (!ghReady()) { el.textContent = '연결 안 됨'; return; }
  // 몇 개를 찾았는지 같이 보여준다 — 비어 있으면 원인을 바로 알 수 있다
  el.textContent = `연결됨 · ${ghConfig.owner}/${ghConfig.repo}` +
    ` · 에셋 ${cloudAssets.length}개 · 작업물 ${cloudProjects.length}개`;
}

async function cloudRefreshAll() {
  await Promise.all([refreshCloudProjects(), refreshCloudAssets()]);
  refreshSavedList();
  renderAssetDrawer();
}

$('gh-connect').addEventListener('click', async () => {
  const owner = $('gh-owner').value.trim();
  const repo = $('gh-repo').value.trim();
  const token = $('gh-token').value.trim();
  if (!owner || !repo || !token) { updateGhStatus('계정·리포·토큰을 모두 입력하세요.'); return; }
  updateGhStatus('연결 확인 중…');
  const prev = ghConfig;
  ghConfig = { owner, repo, token };
  try {
    const res = await ghFetch(ghRepoBase());
    if (!res.ok) throw new Error(String(res.status));
    const info = await res.json();
    await ghSaveConfig(ghConfig);
    $('gh-token').value = '';
    updateGhStatus();
    await cloudRefreshAll();
  } catch (err) {
    ghConfig = prev;
    updateGhStatus(err && err.code === 'auth'
      ? '토큰이 거부되었습니다 — Contents 읽기/쓰기 권한과 만료일을 확인하세요.'
      : '리포를 찾지 못했습니다 — 계정/리포 이름을 확인하세요.');
  }
});

$('gh-disconnect').addEventListener('click', async () => {
  ghConfig = null;
  cloudProjects = [];
  cloudAssets = [];
  try { await dbReq('kv', 'readwrite', s => s.delete('gh')); } catch (_) { /* 무시 */ }
  updateGhStatus();
  refreshSavedList();
  renderAssetDrawer();
});

$('gh-pull').addEventListener('click', async () => {
  if (!ghReady()) { updateGhStatus('먼저 연결하세요.'); return; }
  updateGhStatus('목록 받는 중…');
  await cloudRefreshAll();
  updateGhStatus();
});

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
  updateNamingHint();
  updateProjectLabel();
  refreshSavedList();
});
$('project-name').addEventListener('click', () => $('btn-menu').click());
$('btn-quicksave').addEventListener('click', () => saveProject(state.projectName));
$('btn-assets').addEventListener('click', () => {
  $('asset-drawer').classList.remove('hidden');
  renderAssetDrawer();
});
document.querySelectorAll('.btn-close-drawer').forEach(b =>
  b.addEventListener('click', closeDrawers));
document.querySelectorAll('.drawer').forEach(d =>
  d.addEventListener('click', (e) => { if (e.target === d) closeDrawers(); }));

async function nextProjectName(code) {
  const dc = code || dayCode();
  // "SCR XXDD": 앞 두 자리 랜덤, 뒤 두 자리는 만든 날짜(1~366일째)의 36진수.
  // 저장된 프로젝트·현재 이름과 겹치면 앞 두 자리를 다시 뽑는다.
  const taken = new Set([state.projectName]);
  try {
    const projects = (await dbReq('projects', 'readonly', s => s.getAll())) || [];
    for (const p of projects) taken.add(p.name);
  } catch (_) { /* 목록 조회 실패 시 중복 검사 생략 */ }
  // 다른 기기가 만든 이름과도 겹치면 안 된다 (클라우드 목록은 연결 시 받아둔 것)
  for (const c of cloudProjects) taken.add(c.name);
  for (let i = 0; i < 100; i++) {
    const n = randScrName(dc);
    if (!taken.has(n)) return n;
  }
  // 무작위가 계속 겹치면(그날 조합을 거의 다 쓴 경우) 남은 조합을 빠짐없이 훑는다
  for (const a of B36) {
    for (const b of B36) {
      const n = `SCR-${a}${b}${dc}`;
      if (!taken.has(n)) return n;
    }
  }
  // 그날 1,296개를 전부 썼다면 뒤에 번호를 붙인다
  for (let i = 2; i < 10000; i++) {
    const n = `SCR-00${dc}-${i}`;
    if (!taken.has(n)) return n;
  }
  return randScrName(dc);
}

$('btn-new').addEventListener('click', async () => {
  const hasContent = state.bg.some(v => v >= 0) || state.sprite.some(v => v >= 0);
  if (state.dirty && hasContent &&
      !confirm('저장하지 않은 현재 캔버스를 버리고 새로 만들까요?')) return;
  newDoc(32, 24);
  state.projectName = await nextProjectName();
  state.dirty = false;
  updateProjectLabel();
  updateSizeLabel();
  fitView();
  renderAll();
  closeDrawers();
  autosaveSoon();
});
/* ===== 이름 규칙 안내 + 날짜로 이름 짓기 ===== */
function namingHintText(d = new Date()) {
  const doy = dayOfYear(d);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `이름 규칙 SCR-XXDD — XX는 랜덤(A~Z, 0~9), DD는 만든 날짜를 그 해 몇 번째 날인지(1~366) ` +
         `36진수 두 자리로 적은 것. ${iso}는 ${doy}일째라 코드가 ${dayCode(d)} → SCR-XX${dayCode(d)}. ` +
         `아래에서 날짜를 고르면 그 날짜 코드로 안 겹치는 이름을 지어 이름칸에 넣습니다.`;
}

function updateNamingHint(d) {
  const el = $('naming-hint');
  if (el) el.textContent = namingHintText(d);
}

$('name-from-date').addEventListener('click', async () => {
  const v = $('name-date').value;
  const d = v ? new Date(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, Number(v.slice(8, 10))) : new Date();
  if (isNaN(d.getTime())) return;
  $('save-name').value = await nextProjectName(dayCode(d));
  updateNamingHint(d);
});

$('btn-save').addEventListener('click', () => {
  const name = $('save-name').value.trim() || state.projectName || todayStamp();
  saveProject(name);
});

/* ===== 실물 캔버스 맞춤 (치수 → 비율 맞는 타일 수 추천) ===== */
function physRecommend(pw, ph) {
  const ratio = pw / ph;
  const out = [];
  let bracketEnd = 6;      // 세로 타일 수 구간 상한 (~1.45배 간격)
  let best = null;
  for (let h = 4; h <= MAX_GRID; h++) {
    const w = Math.round(h * ratio);
    if (w > MAX_GRID) break;
    if (w >= 1) {
      const err = Math.abs(w / h - ratio) / ratio;
      if (err <= 0.02 && (!best || err < best.err)) best = { w, h, err };
    }
    if (h >= bracketEnd) {
      if (best) out.push(best);
      best = null;
      bracketEnd = Math.ceil(bracketEnd * 1.45);
    }
  }
  if (best) out.push(best);
  return out.slice(0, 9);
}

function renderPhysList() {
  const list = $('phys-list');
  list.innerHTML = '';
  const pw = parseFloat($('phys-w').value);
  const ph = parseFloat($('phys-h').value);
  if (!(pw > 0) || !(ph > 0)) return;
  for (const r of physRecommend(pw, ph)) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'phys-item';
    const mm = pw / r.w;
    btn.textContent =
      `${r.w}×${r.h} 타일 · 1타일≈${mm >= 10 ? Math.round(mm) : mm.toFixed(1)}㎜ · 오차 ${(r.err * 100).toFixed(r.err < 0.001 ? 2 : 1)}%`;
    btn.addEventListener('click', () => {
      resizeGrid(r.w, r.h);
      fitView();
      render();
      closeDrawers();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

let physSaveTimer = null;
function onPhysInput() {
  renderPhysList();
  clearTimeout(physSaveTimer);
  physSaveTimer = setTimeout(() => {
    dbReq('kv', 'readwrite', s => s.put({
      key: 'physSize',
      w: $('phys-w').value,
      h: $('phys-h').value,
    })).catch(() => {});
  }, 400);
}
$('phys-w').addEventListener('input', onPhysInput);
$('phys-h').addEventListener('input', onPhysInput);

async function restorePhysSize() {
  try {
    const row = await dbReq('kv', 'readonly', s => s.get('physSize'));
    if (row) {
      $('phys-w').value = row.w || '';
      $('phys-h').value = row.h || '';
      renderPhysList();
    }
  } catch (_) { /* 무시 */ }
}

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
  await ghRestoreConfig();
  updateGhStatus();
  if (ghConfig) {
    $('gh-owner').value = ghConfig.owner || '';
    $('gh-repo').value = ghConfig.repo || '';
  }
  renderAssetDrawer();
  if (ghReady()) cloudRefreshAll();
  try {
    const row = await dbReq('kv', 'readonly', s => s.get('masterPalette'));
    if (row && row.colors && row.colors.length >= 2) masterPalette = row.colors.slice();
  } catch (_) { /* 무시 */ }
  restorePhysSize();
  restoreStampMode();
  await restoreSrcPanelH();
  const restored = await restoreAutosave();
  if (!restored) {
    state.projectName = await nextProjectName();
    state.dirty = false;
  }
  updateProjectLabel();
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

/* ===== 오류 표시 (기기에서 원인 확인용) ===== */
function showError(msg) {
  let el = document.getElementById('err-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'err-overlay';
    const pre = document.createElement('pre');
    const close = document.createElement('button');
    close.textContent = '닫기';
    close.addEventListener('click', () => el.remove());
    el.append(pre, close);
    document.body.appendChild(el);
  }
  const pre = el.querySelector('pre');
  pre.textContent = (pre.textContent + '\n' + msg).trim().split('\n').slice(-6).join('\n');
}
window.addEventListener('error', (e) => {
  showError(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  showError('비동기 오류: ' + (r && r.message ? r.message : String(r)));
});

/* ===== 테스트/디버그 훅 ===== */
window.__state = () => state;
// 테스트용: GitHub API 베이스를 모의 서버로 바꿔 실제 토큰 없이 검증한다
window.__setGhApi = (base) => { GH_API = base; };
window.__ghConfig = () => ghConfig;
window.__cloud = () => ({ projects: cloudProjects, assets: cloudAssets });
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

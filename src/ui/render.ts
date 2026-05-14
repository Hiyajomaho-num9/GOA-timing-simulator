import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from 'fflate';
import { defaultDualEk86707aConfig, defaultIml7272bConfig, defaultLevelShifterConfig, defaultNoLevelShifterConfig, defaultTpGeneratorConfig, ek86707aSet1OutputCount, type DraftProject, type DualEk86707aConfig, type Edge, type Ek86707aConfig, type Ek86707aInputs, type EkSet1Level, type GpoConfig, type Iml7272bConfig, type LevelShifterConfig, type SignalTrace, type SocProfile, type TpGeneratorConfig } from '../core/types';
import { parseXlsxBuffer, type SocProfileSelection } from '../core/xlsxParser';
import { simulateGpoOutWindow, simulateGpoWindow, simulateProject } from '../core/simulator';
import { formatDuration, formatPcnt } from '../core/time';
import { drawWaveform, type WaveformHitMap, type WaveformView } from './waveformCanvas';

type ViewMode = 'debug' | 'head' | 'tail' | 'frame1' | 'frame120';
type SocProfileChoice = SocProfileSelection;
type EkInputKey = keyof Ek86707aInputs;
type ImlInputKey = keyof Iml7272bConfig['inputs'];
type LevelInputKey = EkInputKey | ImlInputKey;
type LevelInputModel = 'ek' | 'iml';
type DragState =
  | { mode: 'pan'; x: number; start: number; end: number }
  | { mode: 'edge'; x: number; edge: Edge; target: DraggableEdgeTarget; originAt: number; previewAt: number };
type DraggableEdgeTarget = {
  gpo: GpoConfig;
  entry: GpoConfig['entries'][number];
  periodStart: number;
};
const EK_INPUT_KEYS: EkInputKey[] = ['driverTp', 'initTp', 'stv', 'cpv1', 'cpv2', 'rst', 'pol'];
const DUAL_EK_INPUT_KEYS: EkInputKey[] = ['driverTp', 'initTp', 'stv', 'cpv1', 'cpv2', 'ter', 'rst', 'pol'];
const IML_INPUT_KEYS: ImlInputKey[] = ['stvIn1', 'stvIn2', 'clkIn1', 'clkIn2', 'lcIn', 'terminate'];

const state: {
  project: DraftProject;
  sourceFileBuffer?: ArrayBuffer;
  sourceFileName?: string;
  activeTab: string;
  socProfileChoice: SocProfileChoice;
  viewMode: ViewMode;
  view?: WaveformView;
  referenceSignalId?: string;
  referenceEdgeId?: string;
  selectedStartEdge?: string;
  selectedEndEdge?: string;
  selectedGpo?: number;
  message: string;
  hoverEdge?: Edge;
  cursorPoint?: Edge;
  hitMap?: WaveformHitMap;
  drag?: DragState;
  dragMoved: boolean;
  snapEnabled: boolean;
  snapRadius: number;
  extraSignalIds: string[];
  dockCollapsed: boolean;
  manualEkInputKeys: Set<EkInputKey>;
  manualImlInputKeys: Set<ImlInputKey>;
} = {
  project: { gpos: [], levelShifter: defaultLevelShifterConfig(), tpGenerator: defaultTpGeneratorConfig(), measurements: [], patches: [], dirty: false },
  socProfileChoice: 'auto',
  activeTab: 'level',
  viewMode: 'debug',
  message: '等待导入 XLSX',
  dragMoved: false,
  snapEnabled: true,
  snapRadius: 14,
  extraSignalIds: [],
  dockCollapsed: false,
  manualEkInputKeys: new Set<EkInputKey>(),
  manualImlInputKeys: new Set<ImlInputKey>(),
};

export function mountApp(root: HTMLElement): void {
  root.innerHTML = layout();
  bindStaticEvents(root);
  render(root);
}

function layout(): string {
  return `
    <div class="shell">
      <header class="topbar">
        <div class="brandBlock">
          <p id="socEyebrow" class="eyebrow">MT9216 / MT9603 · Rust-ready engine · XLSX native tuning</p>
          <h1>GOA Timing Simulator</h1>
        </div>
        <div id="timebase" class="timebase">未导入</div>
      </header>
      <section class="commandBar">
        <label class="file-picker">导入 XLSX<input id="fileInput" type="file" accept=".xlsx,.xlsm,.xls" /></label>
        <label>SoC Profile <select id="socProfile"><option value="auto">Auto</option><option value="mt9216">MT9216</option><option value="mt9603">MT9603 / MT9633</option></select></label>
        <label>Frame Rate <input id="frameRate" type="number" min="1" step="0.01" value="60" /></label>
        <button id="recalcBtn">重新计算波形</button>
        <button id="exportXlsxBtn">导出 patched XLSX</button>
        <button id="exportPatchBtn">导出 JSON patch</button>
        <button id="exportLsConfigBtn">导出 LS JSON</button>
        <label class="file-picker compact">导入 LS JSON<input id="lsConfigInput" type="file" accept=".json" /></label>
        <button id="exportMeasBtn">导出 measurement CSV</button>
        <button id="exportPngBtn">导出 PNG</button>
        <button id="exportReportBtn">导出 HTML report</button>
        <span id="dirtyBadge" class="badge">clean</span>
      </section>
      <main class="workspace">
        <section class="timelinePane">
          <div class="timelineTop">
            <div>
              <h2>主时间轴</h2>
              <p id="statusLine">等待导入 XLSX</p>
            </div>
            <div class="presetRail" aria-label="preset 快捷视图">
              <button data-view="debug"><span>Preset</span>TP ↔ CK</button>
              <button data-view="head"><span>Preset</span>帧头</button>
              <button data-view="tail"><span>Preset</span>帧尾</button>
              <button data-view="frame1"><span>Preset</span>1 frame</button>
              <button data-view="frame120"><span>Preset</span>120 frame</button>
            </div>
          </div>
          <div class="timelineTools">
            <div class="zoomCluster">
              <button data-zoom="in">放大</button>
              <button data-zoom="out">缩小</button>
            </div>
            <div class="referenceControls">
              <label>参考波形<select id="referenceSignal"></select></label>
              <label>参考边沿<select id="referenceEdge"></select></label>
              <button id="jumpReferenceBtn">跳到参考</button>
            </div>
            <div class="measureAssist">
              <label class="check"><input id="snapToggle" type="checkbox" checked /> 边沿吸附</label>
              <label>吸附半径 <input id="snapRadius" type="number" min="3" max="80" value="14" /></label>
              <div id="edgeCursor" class="edgeCursor">悬停到边沿附近：点击测量，按住拖动生成 patch suggestion</div>
            </div>
            <div class="extraSignals">
              <label>额外 GPO 波形<select id="extraSignalSelect"></select></label>
              <button id="addExtraSignalBtn">加入视图</button>
              <button id="clearExtraSignalsBtn">清空额外</button>
              <div id="extraSignalChips" class="extraSignalChips"></div>
            </div>
          </div>
          <canvas id="waveCanvas"></canvas>
          <div id="warnings" class="warnings"></div>
        </section>
        <section class="inspectorPane">
          <div class="inspectorTitle">
            <div>
              <strong>参数调试台</strong>
              <span>只生成 patch suggestion；精调仍按 XLSX 原生字段修改。</span>
            </div>
            <button id="dockToggleBtn">收起</button>
          </div>
          <nav class="tabs" id="tabs"></nav>
          <div id="tabPanel" class="tabPanel"></div>
        </section>
      </main>
    </div>`;
}

function bindStaticEvents(root: HTMLElement): void {
  root.querySelector<HTMLInputElement>('#fileInput')?.addEventListener('change', async (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const frameRate = Number(root.querySelector<HTMLInputElement>('#frameRate')?.value || 60);
    state.message = `正在解析 ${file.name}`;
    render(root);
    try {
      const sourceFileBuffer = await file.arrayBuffer();
      loadWorkbook(root, sourceFileBuffer, file.name, frameRate, false);
      state.sourceFileBuffer = sourceFileBuffer.slice(0);
      state.sourceFileName = file.name;
      recalc(root);
    } catch (error) {
      state.message = error instanceof Error ? error.message : String(error);
      render(root);
    }
  });
  root.querySelector<HTMLSelectElement>('#socProfile')?.addEventListener('change', (event) => {
    state.socProfileChoice = (event.currentTarget as HTMLSelectElement).value as SocProfileChoice;
    if (!state.sourceFileBuffer || !state.sourceFileName) {
      render(root);
      return;
    }
    try {
      const frameRate = Number(root.querySelector<HTMLInputElement>('#frameRate')?.value || 60);
      loadWorkbook(root, state.sourceFileBuffer, state.sourceFileName, frameRate, true);
      recalc(root);
    } catch (error) {
      state.message = error instanceof Error ? error.message : String(error);
      render(root);
    }
  });
  root.querySelector<HTMLButtonElement>('#recalcBtn')?.addEventListener('click', () => recalc(root));
  root.querySelector<HTMLButtonElement>('#exportXlsxBtn')?.addEventListener('click', exportPatchedXlsx);
  root.querySelector<HTMLButtonElement>('#exportPatchBtn')?.addEventListener('click', exportPatchJson);
  root.querySelector<HTMLButtonElement>('#exportLsConfigBtn')?.addEventListener('click', exportLevelShifterJson);
  root.querySelector<HTMLInputElement>('#lsConfigInput')?.addEventListener('change', async (event) => importLevelShifterJson(root, event.currentTarget as HTMLInputElement));
  root.querySelector<HTMLButtonElement>('#exportMeasBtn')?.addEventListener('click', exportMeasurementCsv);
  root.querySelector<HTMLButtonElement>('#exportPngBtn')?.addEventListener('click', () => exportWaveformPng(root));
  root.querySelector<HTMLButtonElement>('#exportReportBtn')?.addEventListener('click', () => exportHtmlReport(root));
  root.querySelector<HTMLButtonElement>('#dockToggleBtn')?.addEventListener('click', () => {
    state.dockCollapsed = !state.dockCollapsed;
    render(root);
  });
  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      setDefaultView((button.dataset.view as ViewMode | undefined) ?? 'debug');
      render(root);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((button) => {
    button.addEventListener('click', () => {
      zoomView(button.dataset.zoom === 'in' ? 0.5 : 2);
      render(root);
    });
  });
  root.querySelector<HTMLSelectElement>('#referenceSignal')?.addEventListener('change', (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    state.referenceSignalId = value || undefined;
    const signal = signalById(state.referenceSignalId);
    state.referenceEdgeId = signal?.edges[0]?.id;
    if (!centerOnReference()) state.message = '参考波形没有可用边沿';
    render(root);
  });
  root.querySelector<HTMLSelectElement>('#referenceEdge')?.addEventListener('change', (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    state.referenceEdgeId = value || undefined;
    if (!centerOnReference()) state.message = '参考边沿不可用';
    render(root);
  });
  root.querySelector<HTMLButtonElement>('#jumpReferenceBtn')?.addEventListener('click', () => {
    if (!centerOnReference()) state.message = '请选择参考波形和参考边沿';
    render(root);
  });
  root.querySelector<HTMLInputElement>('#snapToggle')?.addEventListener('change', (event) => {
    state.snapEnabled = (event.currentTarget as HTMLInputElement).checked;
    state.hoverEdge = undefined;
    state.cursorPoint = undefined;
    render(root);
  });
  root.querySelector<HTMLInputElement>('#snapRadius')?.addEventListener('change', (event) => {
    const next = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(next)) state.snapRadius = Math.max(3, Math.min(80, next));
    render(root);
  });
  root.querySelector<HTMLButtonElement>('#addExtraSignalBtn')?.addEventListener('click', () => {
    const select = root.querySelector<HTMLSelectElement>('#extraSignalSelect');
    const id = select?.value;
    if (!id) return;
    if (!state.extraSignalIds.includes(id)) state.extraSignalIds.push(id);
    state.message = `已加入额外波形：${signalById(id)?.name ?? id}`;
    render(root);
  });
  root.querySelector<HTMLButtonElement>('#clearExtraSignalsBtn')?.addEventListener('click', () => {
    state.extraSignalIds = [];
    render(root);
  });
  const canvas = root.querySelector<HTMLCanvasElement>('#waveCanvas');
  canvas?.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoomView(event.deltaY < 0 ? 0.8 : 1.25, event.offsetX);
    render(root);
  }, { passive: false });
  canvas?.addEventListener('mousedown', (event) => {
    if (!state.view) return;
    const edge = state.snapEnabled ? nearestEdge(event.offsetX, event.offsetY, state.snapRadius) : undefined;
    const target = edge ? draggableEdgeTarget(edge) : undefined;
    state.drag = edge && target
      ? { mode: 'edge', x: event.clientX, edge, target, originAt: edge.at, previewAt: edge.at }
      : { mode: 'pan', x: event.clientX, start: state.view.start, end: state.view.end };
    state.dragMoved = false;
  });
  window.addEventListener('mouseup', () => {
    if (state.drag?.mode === 'edge' && state.dragMoved) applyEdgeDragPatch(root, state.drag);
    state.drag = undefined;
  });
  window.addEventListener('mousemove', (event) => {
    if (!state.drag || !state.hitMap || !state.project.timing) return;
    const span = state.hitMap.view.end - state.hitMap.view.start;
    const dx = event.clientX - state.drag.x;
    if (Math.abs(dx) > 3) state.dragMoved = true;
    const delta = Math.round((dx / state.hitMap.plotWidth) * span);
    if (state.drag.mode === 'edge') {
      state.drag.previewAt = clampAbsPcnt(state.drag.originAt + delta);
      state.message = edgeDragPreviewText(state.drag);
      renderEdgeCursor(root);
    } else {
      setView(state.drag.start - delta, state.drag.end - delta);
    }
    draw(root);
  });
  canvas?.addEventListener('mousemove', (event) => {
    if (state.drag) return;
    const edge = state.snapEnabled ? nearestEdge(event.offsetX, event.offsetY, state.snapRadius) : undefined;
    const point = state.snapEnabled ? undefined : previewPointAt(event.offsetX, event.offsetY);
    if (state.hoverEdge?.id === edge?.id && state.cursorPoint?.at === point?.at && state.cursorPoint?.signalId === point?.signalId) return;
    state.hoverEdge = edge;
    state.cursorPoint = point;
    renderEdgeCursor(root);
    draw(root);
  });
  canvas?.addEventListener('mouseleave', () => {
    state.hoverEdge = undefined;
    state.cursorPoint = undefined;
    renderEdgeCursor(root);
    draw(root);
  });
  canvas?.addEventListener('click', (event) => {
    if (state.dragMoved) {
      state.dragMoved = false;
      return;
    }
    const edge = state.snapEnabled ? nearestEdge(event.offsetX, event.offsetY, state.snapRadius) : pointAt(event.offsetX, event.offsetY);
    if (!edge) return;
    if (!state.selectedStartEdge || (state.selectedStartEdge && state.selectedEndEdge)) {
      state.selectedStartEdge = edge.id;
      state.selectedEndEdge = undefined;
      state.message = `已选择起点：${edgeLabel(edge)}`;
    } else {
      state.selectedEndEdge = edge.id;
      state.message = `已选择终点：${edgeLabel(edge)}，可在 Measurement 页新增 Tn`;
    }
    state.activeTab = 'measure';
    render(root);
  });
  window.addEventListener('resize', () => draw(root));
}

function render(root: HTMLElement): void {
  renderTimebase(root);
  renderTabs(root);
  renderPanel(root);
  root.querySelector('.workspace')?.classList.toggle('dockCollapsed', state.dockCollapsed);
  const dockToggle = root.querySelector<HTMLButtonElement>('#dockToggleBtn');
  if (dockToggle) dockToggle.textContent = state.dockCollapsed ? '展开' : '收起';
  root.querySelector('#dirtyBadge')!.textContent = state.project.dirty ? 'dirty draft' : 'clean';
  root.querySelector('#dirtyBadge')!.className = `badge ${state.project.dirty ? 'dirty' : ''}`;
  root.querySelector('#statusLine')!.textContent = state.message;
  renderReferenceControls(root);
  renderViewButtons(root);
  renderSnapControls(root);
  renderExtraSignalControls(root);
  renderEdgeCursor(root);
  renderWarnings(root);
  renderSocProfileControl(root);
  draw(root);
}

function loadWorkbook(root: HTMLElement, buffer: ArrayBuffer, fileName: string, frameRate: number, preserveLevelShifter: boolean): void {
  const parsed = parseXlsxBuffer(buffer, fileName, frameRate, state.socProfileChoice);
  const currentLs = preserveLevelShifter ? state.project.levelShifter : defaultLevelShifterForSoc(parsed.soc, state.project.levelShifter);
  const currentTp = preserveLevelShifter ? state.project.tpGenerator ?? defaultTpGeneratorConfig() : defaultTpGeneratorConfig();
  state.project = {
    parsed,
    timing: parsed.timing,
    gpos: structuredCloneGpos(parsed.gpos),
    levelShifter: currentLs,
    tpGenerator: currentTp,
    manualEdges: [],
    measurements: [],
    patches: [],
    dirty: true,
  };
  state.manualEkInputKeys.clear();
  state.manualImlInputKeys.clear();
  state.extraSignalIds = [];
  state.referenceSignalId = undefined;
  state.referenceEdgeId = undefined;
  state.selectedStartEdge = undefined;
  state.selectedEndEdge = undefined;
  state.selectedGpo = parsed.gpos.find((g) => /cpv1/i.test(g.group))?.index ?? parsed.gpos[0]?.index;
  state.message = `已按 ${state.socProfileChoice === 'auto' ? `Auto -> ${parsed.soc.toUpperCase()}` : parsed.soc.toUpperCase()} 解析 ${fileName}`;
  root.querySelector<HTMLInputElement>('#fileInput')!.value = '';
}

function defaultLevelShifterForSoc(soc: SocProfile, current: LevelShifterConfig): LevelShifterConfig {
  if (soc === 'mt9603') return defaultNoLevelShifterConfig();
  if (current.model === 'none') return defaultLevelShifterConfig();
  return current;
}

function renderSocProfileControl(root: HTMLElement): void {
  const select = root.querySelector<HTMLSelectElement>('#socProfile');
  if (!select) return;
  select.value = state.socProfileChoice;
}

function renderTimebase(root: HTMLElement): void {
  const t = state.project.timing;
  const target = root.querySelector('#timebase')!;
  const eyebrow = root.querySelector('#socEyebrow');
  if (!t) {
    target.textContent = '未导入 XLSX';
    if (eyebrow) eyebrow.textContent = 'MT9216 / MT9603 · Rust-ready engine · XLSX native tuning';
    return;
  }
  if (eyebrow) eyebrow.textContent = `${t.soc.toUpperCase()} · ${t.pcntFormula} · XLSX native tuning`;
  target.innerHTML = `
    <b>Htotal</b> ${t.panelHtotal} <span>${t.soc === 'mt9603' ? `pcnt/line=${t.pcntPerLine}` : `reg=${t.htotalRegister}`}</span><br/>
    <b>Vtotal</b> ${t.vtotal} <b>FPS</b> ${t.frameRate}<br/>
    <b>PCNT max</b> ${t.pcntMax}<br/>
    <b>1pcnt</b> ${(t.pcntSeconds * 1e9).toFixed(3)}ns<br/>
    <b>1lcnt</b> ${(t.lcntSeconds * 1e6).toFixed(3)}us <b>frame</b> ${(t.frameSeconds * 1e3).toFixed(3)}ms`;
}

function renderReferenceControls(root: HTMLElement): void {
  const signals = allSignals();
  if (state.referenceSignalId && !signals.some((signal) => signal.id === state.referenceSignalId)) {
    state.referenceSignalId = undefined;
    state.referenceEdgeId = undefined;
  }

  const signalSelect = root.querySelector<HTMLSelectElement>('#referenceSignal');
  const edgeSelect = root.querySelector<HTMLSelectElement>('#referenceEdge');
  if (!signalSelect || !edgeSelect) return;

  signalSelect.disabled = signals.length === 0;
  signalSelect.innerHTML = `<option value="">选择参考波形</option>${signals.map((signal) => `<option value="${htmlAttr(signal.id)}">${htmlText(signal.name)}</option>`).join('')}`;
  signalSelect.value = state.referenceSignalId ?? '';

  const signal = signalById(state.referenceSignalId);
  if (signal && state.referenceEdgeId && !signal.edges.some((edge) => edge.id === state.referenceEdgeId)) state.referenceEdgeId = signal.edges[0]?.id;
  edgeSelect.disabled = !signal || signal.edges.length === 0;
  edgeSelect.innerHTML = `<option value="">选择参考边沿</option>${(signal?.edges ?? []).map((edge) => `<option value="${htmlAttr(edge.id)}">${htmlText(edgeLabel(edge))}</option>`).join('')}`;
  edgeSelect.value = state.referenceEdgeId ?? '';
}

function renderViewButtons(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.viewMode);
  });
}

function viewLabel(view: ViewMode): string {
  if (view === 'debug') return 'TP ↔ CK';
  if (view === 'head') return '帧头';
  if (view === 'tail') return '帧尾';
  if (view === 'frame1') return '1 frame';
  return '120 frame';
}

function renderSnapControls(root: HTMLElement): void {
  const snapToggle = root.querySelector<HTMLInputElement>('#snapToggle');
  const snapRadius = root.querySelector<HTMLInputElement>('#snapRadius');
  if (snapToggle) snapToggle.checked = state.snapEnabled;
  if (snapRadius) snapRadius.value = String(state.snapRadius);
}

function renderExtraSignalControls(root: HTMLElement): void {
  const select = root.querySelector<HTMLSelectElement>('#extraSignalSelect');
  const chips = root.querySelector('#extraSignalChips');
  const addButton = root.querySelector<HTMLButtonElement>('#addExtraSignalBtn');
  const clearButton = root.querySelector<HTMLButtonElement>('#clearExtraSignalsBtn');
  const gpoSignals = state.project.simulation?.gpoSignals ?? [];
  if (!select || !chips || !addButton || !clearButton) return;
  select.disabled = gpoSignals.length === 0;
  addButton.disabled = gpoSignals.length === 0;
  clearButton.disabled = state.extraSignalIds.length === 0;
  select.innerHTML = `<option value="">选择任意 GPO raw/out</option>${gpoSignals.map((signal) => `<option value="${htmlAttr(signal.id)}">${htmlText(signal.name)}</option>`).join('')}`;
  state.extraSignalIds = state.extraSignalIds.filter((id) => Boolean(signalById(id)));
  chips.innerHTML = state.extraSignalIds.length === 0
    ? '<span class="mutedChip">未额外加入 GPO</span>'
    : state.extraSignalIds.map((id) => {
      const signal = signalById(id);
      return `<button class="chip" data-remove-extra-signal="${htmlAttr(id)}">${htmlText(signal?.name ?? id)} ×</button>`;
    }).join('');
  chips.querySelectorAll<HTMLButtonElement>('[data-remove-extra-signal]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.removeExtraSignal;
      state.extraSignalIds = state.extraSignalIds.filter((item) => item !== id);
      render(root);
    });
  });
}

function allSignals(): SignalTrace[] {
  return [...(state.project.simulation?.signals ?? []), ...(state.project.simulation?.gpoSignals ?? [])];
}

function renderEdgeCursor(root: HTMLElement): void {
  const target = root.querySelector('#edgeCursor');
  if (!target) return;
  const nextRole = !state.selectedStartEdge || state.selectedEndEdge ? '起点' : '终点';
  if (state.drag?.mode === 'edge' && state.project.timing) {
    target.textContent = edgeDragPreviewText(state.drag);
    target.className = 'edgeCursor active editing';
    return;
  }
  if (!state.hoverEdge && !state.cursorPoint) {
    target.textContent = state.snapEnabled ? `等待吸附边沿：点击设为${nextRole}；按住边沿拖动生成 patch` : `吸附关闭：移动到波形上，会出现竖光标；点击任意点作为${nextRole}`;
    target.className = 'edgeCursor';
    return;
  }
  if (state.cursorPoint && !state.snapEnabled) {
    target.textContent = `竖光标 ${edgeLabel(state.cursorPoint)}，点击设为${nextRole}`;
    target.className = 'edgeCursor active';
    return;
  }
  const draggable = state.hoverEdge ? draggableEdgeTarget(state.hoverEdge) : undefined;
  target.textContent = draggable
    ? `已吸附 ${edgeLabel(state.hoverEdge)}；${edgePatchPath(draggable)}；点击设为${nextRole}，按住横向拖动改这些 cell`
    : `已吸附 ${edgeLabel(state.hoverEdge)}，点击设为${nextRole}；此边沿不能直接生成 patch`;
  target.className = `edgeCursor active ${draggable ? 'editable' : ''}`;
}

function renderTabs(root: HTMLElement): void {
  const tabs = [
    ['level', 'Level Shifter', 'LS 参数'],
    ['gpio', 'GPIO Timing', 'GPO 原生'],
    ['combin', 'Combin / Mask', '逻辑遮罩'],
    ['measure', 'Measurement', '测量计算'],
  ];
  root.querySelector('#tabs')!.innerHTML = tabs
    .map(([id, label, sub]) => `<button class="${state.activeTab === id ? 'active' : ''}" data-tab="${id}"><span>${sub}</span>${label}</button>`)
    .join('');
  root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeTab = button.dataset.tab ?? 'level';
      render(root);
    });
  });
}

function renderPanel(root: HTMLElement): void {
  const panel = root.querySelector('#tabPanel')!;
  if (state.activeTab === 'mapping') state.activeTab = 'level';
  if (state.activeTab === 'level') panel.innerHTML = levelPanel();
  if (state.activeTab === 'gpio') panel.innerHTML = gpioPanel();
  if (state.activeTab === 'combin') panel.innerHTML = combinPanel();
  if (state.activeTab === 'measure') panel.innerHTML = measurementPanel();
  bindPanelEvents(root);
}

function levelPanel(): string {
  const ls = state.project.levelShifter;
  const mt9603Tp = state.project.timing?.soc === 'mt9603' ? mt9603DriverTpPanel() : '';
  const header = `
    <h2>Level Shifter 参数</h2>
    <section class="panelSection">
      <label class="modelPicker">Level Shifter 方案
        <select id="levelShifterModel">
          <option value="none" ${ls.model === 'none' ? 'selected' : ''}>无 / 仅 SoC GPO</option>
          <option value="single-ek86707a" ${ls.model === 'single-ek86707a' ? 'selected' : ''}>单 EK86707A</option>
          <option value="dual-ek86707a" ${ls.model === 'dual-ek86707a' ? 'selected' : ''}>双 EK86707A</option>
          <option value="single-iml7272b" ${ls.model === 'single-iml7272b' ? 'selected' : ''}>单 iML7272B</option>
        </select>
      </label>
    </section>`;
  if (ls.model === 'none') return `${header}${mt9603Tp}<section class="panelSection"><h3>仅显示 SoC GPO</h3><p class="hint">适合 MT9603/9633 Tconless 初版适配：不生成外部 level shifter 预览，只显示 GPO raw/out、STV/CPV/LC/POL 等原生波形。</p></section>`;
  if (ls.model === 'single-iml7272b') return `${header}${mt9603Tp}${iml7272bPanel(ls)}`;
  const isDualEk = ls.model === 'dual-ek86707a';
  return `
    ${header}
    ${mt9603Tp}
    <section class="panelSection">
      <div class="sectionHead">
        <h3>${isDualEk ? '双 EK86707A 共用参数' : '单 EK86707A 参数'}</h3>
        <span class="sectionMeta">统一按 pin / mode value 调参，配置共用到 CK preview</span>
      </div>
      <div class="ekParamGrid">
        ${ekParamSelect('set1', 'SET1 / CK 输出路', ls.set1, [
          ['high', 'HIGH / 8CK'],
          ['float', 'FLOAT / 4CK'],
          ['gnd', 'GND / 6CK'],
        ], ekParamMeta('set1', ls, isDualEk))}
        ${ekParamSelect('set2', 'SET2 / CK 间隔', String(ls.set2), boolOptions('LOW/FLOAT / 无间隔', 'HIGH / 有间隔'), ekParamMeta('set2', ls, isDualEk))}
        ${ekParamSelect('set3', 'SET3 / 2D-3D 细分', String(ls.set3), boolOptions('LOW / 0', 'HIGH / 1'), ekParamMeta('set3', ls, isDualEk))}
        ${ekParamSelect('dualSto', 'Disa_DualSTO / STO2', String(ls.dualSto), boolOptions('LOW / STO2跟随STI2', 'HIGH / STO2保持VGL1'), ekParamMeta('dualSto', ls, isDualEk))}
        ${ekParamSelect('ocpEnabled', 'OCP_DIS / OCP保护', String(ls.ocpEnabled), boolOptions('LOW/FLOAT / OCP启用', 'HIGH / OCP关闭'), ekParamMeta('ocpEnabled', ls, isDualEk))}
        ${ekParamSelect('ocpSel', 'OCP_SEL', ls.ocpSel, [
          ['float', 'FLOAT / 110mA 单输入'],
          ['0', 'GND / 180mA 单输入'],
          ['1', 'HIGH / CKI1+CKI2 二输入'],
        ], ekParamMeta('ocpSel', ls, isDualEk))}
        ${ekParamSelect('mode1', 'MODE1 / Pre-charge', ls.mode1, [
          ['extra-high', 'Extra High / 3-line pre-charge'],
          ['high', 'High / 1-line pre-charge'],
          ['normal', 'Middle / no pre-charge'],
          ['low', 'Low / 2-line pre-charge'],
        ], ekParamMeta('mode1', ls, isDualEk))}
        ${ekParamSelect('mode2', 'MODE2 / 1-2-4 line on', ls.mode2, [
          ['0', 'LOW / 强制1-line normal'],
          ['1', 'HIGH / 跟SET3决定2/4-line'],
        ], ekParamMeta('mode2', ls, isDualEk))}
      </div>
    </section>
    <section class="panelSection">
      <div class="sectionHead">
        <h3>EK86707A 输入映射</h3>
        <div class="sectionActions">
          <button id="autoDetectEkInputsBtn" type="button">自动识别空位</button>
          <button id="resetEkInputLocksBtn" type="button">重置为自动</button>
        </div>
      </div>
      <div class="mappingGrid">
        ${state.project.timing?.soc === 'mt9603' ? '' : levelInputSelect('ek', 'driverTp', 'Driver_TP', ls.inputs.driverTp)}
        ${levelInputSelect('ek', 'initTp', 'Init_TP', ls.inputs.initTp)}
        ${levelInputSelect('ek', 'stv', 'STV', ls.inputs.stv)}
        ${levelInputSelect('ek', 'cpv1', isDualEk ? 'CPV1 / 奇数 CKI' : 'CPV1 / CKI', ls.inputs.cpv1)}
        ${levelInputSelect('ek', 'cpv2', isDualEk ? 'CPV2 / 偶数 CKI' : 'CPV2 / CKI2 / TER', ls.inputs.cpv2)}
        ${isDualEk ? levelInputSelect('ek', 'ter', 'TER 共用清除', ls.inputs.ter) : ''}
        ${levelInputSelect('ek', 'rst', 'RST', ls.inputs.rst)}
        ${levelInputSelect('ek', 'pol', 'POL', ls.inputs.pol)}
      </div>
    </section>
    <p class="hint">修改后先进入 dirty draft，点击“重新计算波形”后才应用到 CK preview。</p>`;
}

function mt9603DriverTpPanel(): string {
  const tp = state.project.tpGenerator ?? defaultTpGeneratorConfig();
  const timing = state.project.timing;
  const oneLineUs = timing ? timing.lcntSeconds * 1e6 : 0;
  return `
    <section class="panelSection">
      <h3>MT9603 Driver_TP / data_cmd</h3>
      <div class="callout ok">Driver_TP 不从 GPO 生成，也不做 mask；固定从 L0.P2 起跳。宽度/周期支持 300ns、3us，纯数字默认按 us 处理；周期留空则按 1line=${oneLineUs.toFixed(3)}us。</div>
      <div class="formGrid">
        <label>正脉冲宽度 <input data-tp-generator="driverTpWidth" value="${htmlAttr(tp.driverTpWidth)}" placeholder="3 或 300ns" /></label>
        <label>周期 <input data-tp-generator="driverTpPeriod" value="${htmlAttr(tp.driverTpPeriod)}" placeholder="空=1line，或 14.8us" /></label>
        <label>起点 <input value="L0.P2" disabled /></label>
      </div>
    </section>`;
}

function iml7272bPanel(ls: Iml7272bConfig): string {
  return `
    <section class="panelSection">
      <h3>单 iML7272B 参数</h3>
      <div class="callout ok">Reg01h~Reg04h 独立保存在 project/report，不写入 patched XLSX。OCP / FAULT / Slew / DIS_SENSE 第一版只保存，不影响波形。</div>
      <div class="formGrid">
        <label>Reg01h <input data-iml-reg="reg01" value="${hexByte(ls.reg01)}" /></label>
        <label>Reg02h <input data-iml-reg="reg02" value="${hexByte(ls.reg02)}" /></label>
        <label>Reg03h <input data-iml-reg="reg03" value="${hexByte(ls.reg03)}" /></label>
        <label>Reg04h <input data-iml-reg="reg04" value="${hexByte(ls.reg04)}" /></label>
        <label>LC Power ON SET
          <select data-iml-field="lcPower">${imlOptions([[0, 'LC1/LC2 follow VGH'], [1, 'LC1/LC2 follow LVGL'], [2, 'LC1 follow VGH, LC2 follow LVGL'], [3, 'LC1 follow LVGL, LC2 follow VGH']], ls.reg01 & 0x03)}</select>
        </label>
        <label>Power-off POR
          <select data-iml-field="powerOffPor">${imlOptions([[0, 'Follow LVGL'], [1, 'Follow GND naturally']], (ls.reg01 >> 2) & 1)}</select>
        </label>
        <label>2-Line Mode
          <select data-iml-field="twoLineMode">${imlOptions([[0, '2-line mode1'], [1, '2-line mode2']], (ls.reg01 >> 3) & 1)}</select>
        </label>
        <label>HSR Mode
          <select data-iml-field="hsrMode">${imlOptions([[0, 'Normal mode'], [1, 'HSR1'], [2, 'HSR2'], [3, 'HSR2']], (ls.reg01 >> 4) & 0x03)}</select>
        </label>
        <label>CLK Phase
          <select data-iml-field="clkPhase">${imlOptions([[0, '4 phase'], [1, '6 phase'], [2, '8 phase'], [3, '10 phase']], ls.reg04 & 0x03)}</select>
        </label>
        <label>CLK Mode
          <select data-iml-field="clkMode">${imlOptions([[0, '1-Line'], [1, '2-Line']], (ls.reg04 >> 7) & 1)}</select>
        </label>
        <label>CLK Slew Rate
          <select data-iml-field="clkSlew">${imlOptions([[0, '1000V/us'], [1, '700V/us'], [2, '400V/us'], [3, '100V/us']], (ls.reg03 >> 6) & 0x03)}</select>
        </label>
        <label>OCP Blank Time
          <select data-iml-field="ocpBlank">${imlOptions([[0, '2us'], [1, '4us'], [2, '6us'], [3, '8us'], [4, '10us'], [5, '12us'], [6, '14us'], [7, '16us']], ls.reg03 & 0x07)}</select>
        </label>
      </div>
    </section>
    <section class="panelSection">
      <div class="sectionHead">
        <h3>iML7272B 输入映射</h3>
        <div class="sectionActions">
          <button id="autoDetectImlInputsBtn" type="button">自动识别空位</button>
          <button id="resetImlInputLocksBtn" type="button">重置为自动</button>
        </div>
      </div>
      <div class="mappingGrid">
        ${levelInputSelect('iml', 'stvIn1', 'STV_IN1', ls.inputs.stvIn1)}
        ${levelInputSelect('iml', 'stvIn2', 'STV_IN2', ls.inputs.stvIn2)}
        ${levelInputSelect('iml', 'clkIn1', 'CLK_IN1', ls.inputs.clkIn1)}
        ${levelInputSelect('iml', 'clkIn2', 'CLK_IN2', ls.inputs.clkIn2)}
        ${levelInputSelect('iml', 'lcIn', 'LC_IN', ls.inputs.lcIn)}
        ${levelInputSelect('iml', 'terminate', 'Terminate', ls.inputs.terminate)}
      </div>
    </section>
    <p class="hint">输出会生成为 LS STV1 / LS STV2 / LS LC1 / LS LC2 / LS CLK1~CLK10。Terminate rising 第一版只清输出，不清 phase counter。</p>`;
}

function levelInputSelect(model: 'ek', key: EkInputKey, label: string, value?: string): string;
function levelInputSelect(model: 'iml', key: ImlInputKey, label: string, value?: string): string;
function levelInputSelect(model: LevelInputModel, key: LevelInputKey, label: string, value?: string): string {
  const signals = levelShifterInputCandidates();
  const manual = isManualLevelInput(model, key);
  const suggestion = suggestLevelInput(model, key);
  const selectedValue = value ?? (!manual ? suggestion?.id : undefined);
  const savedButMissing = value && !signals.some((signal) => signal.id === value)
    ? [`<option value="${htmlAttr(value)}" selected>当前 XLSX 不存在：${htmlText(value)}</option>`]
    : [];
  const options = [
    `<option value="" ${!selectedValue ? 'selected' : ''}>未映射</option>`,
    ...savedButMissing,
    ...signals.map((signal) => `<option value="${htmlAttr(signal.id)}" ${selectedValue === signal.id ? 'selected' : ''}>${htmlText(signal.name)}</option>`),
  ];
  const displaySignal = signalById(value ?? suggestion?.id);
  const hint = value
    ? `${manual ? '人工选择' : '自动识别'}：${displaySignal?.name ?? value}`
    : manual
      ? '人工锁定：未映射'
    : suggestion
      ? `建议：${suggestion.name}`
      : '未识别：请手动选择';
  return `
    <div class="mappingField ${manual ? 'manual' : 'auto'}">
      <label>${label}<select data-ls-input="${model}:${key}">${options.join('')}</select></label>
      <div class="mappingHint">${htmlText(hint)}</div>
    </div>`;
}

function levelShifterInputCandidates(): SignalTrace[] {
  const seen = new Set<string>();
  const baseSignals = (state.project.simulation?.signals ?? []).filter((signal) => !signal.id.startsWith('ls:') && !/^ck\d+$/i.test(signal.id));
  const gpoSignals = state.project.simulation?.gpoSignals ?? [];
  return [...baseSignals, ...gpoSignals].filter((signal) => {
    if (seen.has(signal.id)) return false;
    seen.add(signal.id);
    return true;
  });
}

function autoFillLevelInputsFromSimulation(): string[] {
  if (isEkConfig(state.project.levelShifter)) return autoFillEkInputsFromSimulation();
  if (state.project.levelShifter.model === 'single-iml7272b') return autoFillImlInputsFromSimulation();
  return [];
}

function autoFillEkInputsFromSimulation(): string[] {
  if (!isEkConfig(state.project.levelShifter)) return [];
  const changed: string[] = [];
  for (const key of ekInputKeysForCurrentSoc()) {
    if (state.manualEkInputKeys.has(key)) continue;
    const current = state.project.levelShifter.inputs[key];
    if (current && signalById(current)) continue;
    const suggested = suggestEkInput(key);
    if (!suggested || suggested.id === current) continue;
    state.project.levelShifter.inputs[key] = suggested.id;
    changed.push(`${ekInputLabel(key)}=${suggested.name}`);
  }
  return changed;
}

function ekInputKeysForCurrentSoc(): EkInputKey[] {
  const keys = state.project.levelShifter.model === 'dual-ek86707a' ? DUAL_EK_INPUT_KEYS : EK_INPUT_KEYS;
  return state.project.timing?.soc === 'mt9603' ? keys.filter((key) => key !== 'driverTp') : keys;
}

function isEkModel(model: LevelShifterConfig['model']): model is 'single-ek86707a' | 'dual-ek86707a' {
  return model === 'single-ek86707a' || model === 'dual-ek86707a';
}

function isEkConfig(config: LevelShifterConfig): config is Ek86707aConfig | DualEk86707aConfig {
  return isEkModel(config.model);
}

function autoFillImlInputsFromSimulation(): string[] {
  if (state.project.levelShifter.model !== 'single-iml7272b') return [];
  const changed: string[] = [];
  for (const key of IML_INPUT_KEYS) {
    if (state.manualImlInputKeys.has(key)) continue;
    const current = state.project.levelShifter.inputs[key];
    if (current && signalById(current)) continue;
    const suggested = suggestImlInput(key);
    if (!suggested || suggested.id === current) continue;
    state.project.levelShifter.inputs[key] = suggested.id;
    changed.push(`${imlInputLabel(key)}=${suggested.name}`);
  }
  return changed;
}

function suggestLevelInput(model: LevelInputModel, key: LevelInputKey): SignalTrace | undefined {
  return model === 'ek' ? suggestEkInput(key as EkInputKey) : suggestImlInput(key as ImlInputKey);
}

function suggestEkInput(key: EkInputKey): SignalTrace | undefined {
  const candidates = levelShifterInputCandidates();
  const byId = (...ids: string[]) => ids.map((id) => signalById(id)).find(Boolean);
  const byRule = (...patterns: RegExp[]) => candidates.find((signal) => {
    const text = signalSearchText(signal);
    return patterns.some((pattern) => pattern.test(text));
  });
  switch (key) {
    case 'driverTp':
      return byId('driver_tp:merge', 'driver_tp:raw') ?? byRule(/\bdriver\s*tp\b/i, /\btp\s*for\s*driver\b/i);
    case 'initTp':
      return byId('init_tp:merge', 'init_tp:raw') ?? byRule(/\binit\s*tp\b/i, /\bint\s*tp\b/i, /\btp\s*for\s*tcon\b/i);
    case 'stv':
      return byId('stv:merge', 'stv:raw') ?? byRule(/\bstv\b/i);
    case 'cpv1':
      return byId('cpv1:merge', 'cpv1:raw') ?? byRule(/\bcpv\s*1\b/i, /\bcvp\s*1\b/i, /\bckv\s*1\b/i);
    case 'cpv2':
      return byId('cpv2:merge', 'cpv2:raw') ?? byRule(/\bcpv\s*2\b/i, /\bcvp\s*2\b/i, /\bckv\s*2\b/i, /\bterminate\b/i, /\bter\b/i);
    case 'ter':
      return byId('ter:manual') ?? byRule(/\bterminate\b/i, /\bterm\b/i, /\bter\b/i);
    case 'rst':
      return byId('rst:manual') ?? byRule(/\brst\b/i, /\breset\b/i);
    case 'pol':
      return byId('pol:merge', 'pol:raw') ?? byRule(/\bpol\b/i);
  }
}

function suggestImlInput(key: ImlInputKey): SignalTrace | undefined {
  const candidates = levelShifterInputCandidates();
  const byId = (...ids: string[]) => ids.map((id) => signalById(id)).find(Boolean);
  const byRule = (...patterns: RegExp[]) => candidates.find((signal) => {
    const text = signalSearchText(signal);
    return patterns.some((pattern) => pattern.test(text));
  });
  switch (key) {
    case 'stvIn1':
      return byId('stv:merge', 'stv:raw') ?? byRule(/\bstv\s*(out|merge)?\b/i, /\bstv1\b/i);
    case 'stvIn2':
      return byRule(/\bstv\s*in\s*2\b/i, /\bstv[_\s-]*2\b/i, /\bstv2\b/i);
    case 'clkIn1':
      return byId('cpv1:merge', 'cpv1:raw') ?? byRule(/\bclk\s*in\s*1\b/i, /\bcpv\s*1\b/i, /\bcvp\s*1\b/i, /\bckv\s*1\b/i);
    case 'clkIn2':
      return byId('cpv2:merge', 'cpv2:raw') ?? byRule(/\bclk\s*in\s*2\b/i, /\bcpv\s*2\b/i, /\bcvp\s*2\b/i, /\bckv\s*2\b/i);
    case 'lcIn':
      return byRule(/\blc\s*in\b/i, /\bvgpin\b/i, /\blc\b/i);
    case 'terminate':
      return byRule(/\bterminate\b/i, /\bterm\b/i, /\bter\b/i);
  }
}

function signalSearchText(signal: SignalTrace): string {
  return `${signal.id} ${signal.name}`.replace(/[_:./-]+/g, ' ');
}

function isManualLevelInput(model: LevelInputModel, key: LevelInputKey): boolean {
  return model === 'ek' ? state.manualEkInputKeys.has(key as EkInputKey) : state.manualImlInputKeys.has(key as ImlInputKey);
}

function ekInputLabel(key: EkInputKey): string {
  return {
    driverTp: 'Driver_TP',
    initTp: 'Init_TP',
    stv: 'STV',
    cpv1: 'CPV1',
    cpv2: 'CPV2/CKI2/TER',
    ter: 'TER',
    rst: 'RST',
    pol: 'POL',
  }[key];
}

function imlInputLabel(key: ImlInputKey): string {
  return {
    stvIn1: 'STV_IN1',
    stvIn2: 'STV_IN2',
    clkIn1: 'CLK_IN1',
    clkIn2: 'CLK_IN2',
    lcIn: 'LC_IN',
    terminate: 'Terminate',
  }[key];
}

function imlOptions(options: Array<[number, string]>, selected: number): string {
  return options.map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${htmlText(label)}</option>`).join('');
}

function boolOptions(lowLabel: string, highLabel: string): Array<[string, string]> {
  return [['false', lowLabel], ['true', highLabel]];
}

function ekParamSelect(key: keyof Ek86707aConfig, label: string, value: string, options: Array<[string, string]>, meta: string): string {
  return `<label class="ekParamCard">
    <span>${htmlText(label)}</span>
    <select data-ls="${htmlAttr(String(key))}">
      ${options.map(([optionValue, optionLabel]) => `<option value="${htmlAttr(optionValue)}" ${String(value) === optionValue ? 'selected' : ''}>${htmlText(optionLabel)}</option>`).join('')}
    </select>
    <small>${htmlText(meta)}</small>
  </label>`;
}

function ekParamMeta(key: keyof Ek86707aConfig, ls: Ek86707aConfig | DualEk86707aConfig, isDualEk: boolean): string {
  const twoInput = ls.ocpSel === '1';
  switch (key) {
    case 'set1':
      return `raw=${ekSet1RawLabel(ls.set1)}；相位数=${ek86707aSet1OutputCount(ls.set1)}，当前预览输出=${ek86707aSet1OutputCount(ls.set1) * (isDualEk ? 2 : 1)}路`;
    case 'set2':
      return twoInput
        ? `raw=${boolRawLabel(ls.set2)}；二输入模式下PDF说明SET2 disabled，预览暂忽略`
        : `raw=${boolRawLabel(ls.set2)}；${ls.set2 ? 'CKO之间插入time interval' : 'CKO之间无time interval'}`;
    case 'set3':
      return `raw=${boolRawLabel(ls.set3)}；${ekLineOnMode(ls)}；由MODE2+SET3组合决定`;
    case 'dualSto':
      return `raw=${boolRawLabel(ls.dualSto)}；${ls.dualSto ? 'STO1跟STI1，STO2保持VGL1' : 'STO1跟STI1，STO2跟STI2'}`;
    case 'ocpEnabled':
      return `raw=${boolRawLabel(ls.ocpEnabled)}；${ls.ocpEnabled ? 'OCP关闭' : 'OCP启用'}，保护动作不参与波形仿真`;
    case 'ocpSel':
      return ls.ocpSel === '1'
        ? 'raw=HIGH；Terminate脚复用CKI2，CPV1/CPV2二输入生成CK'
        : ls.ocpSel === '0'
          ? 'raw=GND；单输入，OCP阈值约180mA，CPV2按TER判定'
          : 'raw=FLOAT；单输入，OCP阈值约110mA，CPV2按TER判定';
    case 'mode1':
      return twoInput
        ? `raw=${ekMode1RawLabel(ls.mode1)}；二输入模式下PDF说明Mode1 disabled，预览暂忽略`
        : `raw=${ekMode1RawLabel(ls.mode1)}；${ekMode1Meaning(ls.mode1)}`;
    case 'mode2':
      return `raw=${ls.mode2}; ${ls.mode2 === '0' ? '强制1-line normal，SET3不改变line-on' : '允许SET3选择2-line/4-line'}`;
    default:
      return '';
  }
}

function boolRawLabel(value: boolean): string {
  return value ? 'HIGH/1' : 'LOW/0';
}

function ekSet1RawLabel(value: EkSet1Level): string {
  if (value === 'high') return 'HIGH';
  if (value === 'float') return 'FLOAT';
  return 'GND';
}

function ekMode1RawLabel(value: Ek86707aConfig['mode1']): string {
  if (value === 'extra-high') return 'ExtraHigh(3~4V)';
  if (value === 'high') return 'High(1.5~2.5V)';
  if (value === 'normal') return 'Middle(0.9~1.4V)';
  return 'Low(0~0.8V)';
}

function ekMode1Meaning(value: Ek86707aConfig['mode1']): string {
  if (value === 'extra-high') return '3-line pre-charge';
  if (value === 'high') return '1-line pre-charge';
  if (value === 'normal') return 'no pre-charge';
  return '2-line pre-charge';
}

function ekLineOnMode(ls: Ek86707aConfig | DualEk86707aConfig): string {
  if (ls.mode2 === '0') return '当前=1-line on normal';
  return ls.set3 ? '当前=2-line on' : '当前=4-line on';
}

function hexByte(value: number): string {
  return `0x${clampByte(value).toString(16).toUpperCase().padStart(2, '0')}`;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(Number.isFinite(value) ? value : 0)));
}

function gpioPanel(): string {
  const gpos = state.project.gpos;
  if (gpos.length === 0) return emptyPanel('导入 XLSX 后显示 GPIO 原生寄存器表。');
  const selected = selectedGpo();
  return `
    <h2>GPIO Timing 参数页</h2>
    ${gpoSelector(gpos)}
    ${selected ? entryTable(selected) : ''}`;
}

function combinPanel(): string {
  const selected = selectedGpo();
  if (!selected) return emptyPanel('导入 XLSX 后显示 Combin / Mask。');
  return `
    <h2>Combin / Mask 参数页</h2>
    ${gpoSelector(state.project.gpos)}
    <div class="formGrid">
      <label>${selected.soc === 'mt9603' ? 'Logic_function' : 'Combin_Type_SEL'} <input data-gpo-field="combinType" type="number" min="0" max="7" value="${selected.combinType}" /></label>
      <label>GPO_Combin_SEL <input data-gpo-field="combinSel" type="number" min="0" max="23" value="${selected.combinSel}" /></label>
      <label>Repeat_mode_SEL <input data-gpo-field="repeatMode" type="number" min="0" max="1" value="${selected.repeatMode}" /></label>
      <label class="check"><input data-gpo-field="maskEnabled" type="checkbox" ${selected.maskEnabled ? 'checked' : ''}/> Mask_region_EN</label>
      <label>Region_VST <input data-gpo-field="regionVst" type="number" value="${selected.regionVst}" /></label>
      <label>Region_VEND <input data-gpo-field="regionVend" type="number" value="${selected.regionVend}" /></label>
      <label>Region_pst <input data-gpo-field="regionPst" type="number" value="${selected.regionPst}" /></label>
      <label>Region_pend <input data-gpo-field="regionPend" type="number" value="${selected.regionPend}" /></label>
      <label>Region_other_Value <input data-gpo-field="regionOtherValue" type="number" min="0" max="1" value="${selected.regionOtherValue}" /></label>
    </div>`;
}

function measurementPanel(): string {
  const edges = allSelectableEdges().slice(0, 3000);
  const nextRole = !state.selectedStartEdge || state.selectedEndEdge ? '起点' : '终点';
  return `
    <h2>Measurement / Calculator</h2>
    <p class="hint">当前等待选择 ${nextRole}。Target 支持 3us / 300ns / 0.02ms / 445pcnt / 2lcnt；不写单位默认 us。</p>
    <div class="measureControls">
      <label>起点 edge ${edgeSelect('startEdge', edges, state.selectedStartEdge)}</label>
      <label>终点 edge ${edgeSelect('endEdge', edges, state.selectedEndEdge)}</label>
      <button id="addMeasurementBtn">新增 Tn</button>
    </div>
    <table><thead><tr><th>ID</th><th>起点</th><th>终点</th><th>实测</th><th>Target</th><th>当前-目标</th><th>操作</th></tr></thead><tbody>
      ${(state.project.simulation?.measurements ?? []).map((m, index) => measurementRow(m, index)).join('')}
    </tbody></table>`;
}

function measurementRow(m: NonNullable<DraftProject['simulation']>['measurements'][number], index: number): string {
  const source = state.project.measurements.find((item) => item.id === m.id);
  return `<tr>
    <td>${m.id}</td>
    <td>${edgeLabel(m.startEdge)}</td>
    <td>${edgeLabel(m.endEdge)}</td>
    <td>${m.deltaPcnt ?? '-'} pcnt<br>${formatDuration(m.seconds)}</td>
    <td><input data-measure-index="${index}" data-measure-field="targetInput" placeholder="3us / 445pcnt" value="${htmlAttr(source?.targetInput ?? formatTargetInput(m.targetSeconds))}" /></td>
    <td>${formatTargetDelta(m)}</td>
    <td><button data-delete-measure="${index}">删除</button></td>
  </tr>`;
}

function edgeSelect(id: string, edges: Edge[], value?: string): string {
  return `<select id="${id}"><option value="">选择 edge</option>${edges.map((e) => `<option value="${e.id}" ${value === e.id ? 'selected' : ''}>${edgeLabel(e)}</option>`).join('')}</select>`;
}

function edgeLabel(edge?: Edge): string {
  if (!edge || !state.project.timing) return '-';
  const action = edge.edge === 'point' ? 'point' : edge.edge;
  return `${edge.signalName} ${action} @ ${formatPcnt(edge.at, state.project.timing.pcntPerLine)}`;
}

function gpoSelector(gpos: GpoConfig[]): string {
  return `<label>GPO 选择 <select id="gpoSelect">${gpos.map((g) => `<option value="${g.index}" ${state.selectedGpo === g.index ? 'selected' : ''}>${g.group}</option>`).join('')}</select></label>`;
}

function entryTable(gpo: GpoConfig): string {
  return `<table><thead><tr><th>entry</th><th>FCNT</th><th>EN</th><th>level</th><th>LCNT</th><th>PCNT</th><th>cell</th></tr></thead><tbody>
    ${gpo.entries.map((e) => `<tr>
      <td>${e.index}</td>
      <td><input data-entry="${e.index}" data-entry-field="fcnt" value="0x${e.fcnt.toString(16).toUpperCase()}" /></td>
      <td>${gpo.entryEncoding === 'split-fields' ? `<input data-entry="${e.index}" data-entry-field="enabled" type="number" min="0" max="1" value="${e.enabled ? 1 : 0}" />` : e.enabled ? '1' : '0'}</td>
      <td>${gpo.entryEncoding === 'split-fields' ? `<input data-entry="${e.index}" data-entry-field="level" type="number" min="0" max="1" value="${e.level}" />` : e.level ? 'HIGH' : 'LOW'}</td>
      <td><input data-entry="${e.index}" data-entry-field="lcnt" type="number" value="${e.lcnt}" ${gpo.repeatMode === 0 && gpo.soc !== 'mt9603' ? 'disabled title="by-line 禁止修改 LCNT"' : ''}/></td>
      <td><input data-entry="${e.index}" data-entry-field="pcnt" type="number" value="${e.pcnt}" /></td>
      <td>${e.cells.enable?.address ?? '-'} / ${e.cells.level?.address ?? '-'} / ${e.cells.fcnt?.address ?? '-'} / ${e.cells.lcnt?.address ?? '-'} / ${e.cells.pcnt?.address ?? '-'}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function emptyPanel(message: string): string {
  return `<div class="empty">${message}</div>`;
}

function bindPanelEvents(root: HTMLElement): void {
  root.querySelector<HTMLSelectElement>('#levelShifterModel')?.addEventListener('change', (event) => {
    const model = (event.currentTarget as HTMLSelectElement).value as LevelShifterConfig['model'];
    state.project.levelShifter = model === 'single-iml7272b'
      ? defaultIml7272bConfig()
      : model === 'dual-ek86707a'
        ? defaultDualEk86707aConfig()
        : model === 'none'
          ? defaultNoLevelShifterConfig()
          : defaultLevelShifterConfig();
    state.referenceSignalId = undefined;
    state.referenceEdgeId = undefined;
    state.extraSignalIds = [];
    state.manualEkInputKeys.clear();
    state.manualImlInputKeys.clear();
    markDirty(root);
  });
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-ls]').forEach((input) => {
    if (!isEkConfig(state.project.levelShifter)) return;
    const ls = state.project.levelShifter;
    const key = input.dataset.ls! as keyof Ek86707aConfig;
    if (input instanceof HTMLSelectElement) input.value = String(ls[key]);
    input.addEventListener('change', () => {
      if (!isEkConfig(state.project.levelShifter)) return;
      const current = state.project.levelShifter as unknown as Record<string, unknown>;
      current[key] = parseEkParamValue(key, input.value);
      if (key === 'set1') current.outputCount = ek86707aSet1OutputCount(current.set1 as EkSet1Level);
      markDirty(root);
    });
  });
  root.querySelectorAll<HTMLInputElement>('[data-tp-generator]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.tpGenerator as keyof TpGeneratorConfig;
      const current = state.project.tpGenerator ?? defaultTpGeneratorConfig();
      state.project.tpGenerator = { ...current, [key]: input.value };
      markDirty(root);
    });
  });
  root.querySelectorAll<HTMLInputElement>('[data-iml-reg]').forEach((input) => {
    input.addEventListener('change', () => updateImlReg(root, input));
  });
  root.querySelectorAll<HTMLSelectElement>('[data-iml-field]').forEach((select) => {
    select.addEventListener('change', () => updateImlField(root, select));
  });
  root.querySelectorAll<HTMLSelectElement>('[data-ls-input]').forEach((select) => {
    select.addEventListener('change', () => updateLevelInput(root, select));
  });
  root.querySelector<HTMLButtonElement>('#autoDetectEkInputsBtn')?.addEventListener('click', () => {
    if (!isEkConfig(state.project.levelShifter)) return;
    if (!state.project.timing) {
      state.message = '请先导入 XLSX，再自动识别 EK 输入映射';
      render(root);
      return;
    }
    if (!state.project.simulation) state.project.simulation = simulateProject(state.project);
    const changed = autoFillEkInputsFromSimulation();
    state.message = changed.length ? `已自动识别：${changed.join('，')}` : '没有新的空位可自动识别';
    state.project.dirty = changed.length > 0;
    if (changed.length) recalc(root);
    else render(root);
  });
  root.querySelector<HTMLButtonElement>('#resetEkInputLocksBtn')?.addEventListener('click', () => {
    if (!isEkConfig(state.project.levelShifter)) return;
    state.project.levelShifter.inputs = {};
    state.manualEkInputKeys.clear();
    markDirty(root);
    recalc(root);
  });
  root.querySelector<HTMLButtonElement>('#autoDetectImlInputsBtn')?.addEventListener('click', () => {
    if (state.project.levelShifter.model !== 'single-iml7272b') return;
    if (!state.project.timing) {
      state.message = '请先导入 XLSX，再自动识别 iML 输入映射';
      render(root);
      return;
    }
    if (!state.project.simulation) state.project.simulation = simulateProject(state.project);
    const changed = autoFillImlInputsFromSimulation();
    state.message = changed.length ? `已自动识别：${changed.join('，')}` : '没有新的空位可自动识别';
    state.project.dirty = changed.length > 0;
    if (changed.length) recalc(root);
    else render(root);
  });
  root.querySelector<HTMLButtonElement>('#resetImlInputLocksBtn')?.addEventListener('click', () => {
    if (state.project.levelShifter.model !== 'single-iml7272b') return;
    state.project.levelShifter.inputs = {};
    state.manualImlInputKeys.clear();
    markDirty(root);
    recalc(root);
  });
  root.querySelector<HTMLSelectElement>('#gpoSelect')?.addEventListener('change', (event) => {
    state.selectedGpo = Number((event.currentTarget as HTMLSelectElement).value);
    render(root);
  });
  root.querySelectorAll<HTMLInputElement>('[data-entry]').forEach((input) => input.addEventListener('change', () => updateEntry(root, input)));
  root.querySelectorAll<HTMLInputElement>('[data-gpo-field]').forEach((input) => input.addEventListener('change', () => updateGpoField(root, input)));
  root.querySelector<HTMLSelectElement>('#startEdge')?.addEventListener('change', (event) => { state.selectedStartEdge = (event.currentTarget as HTMLSelectElement).value; });
  root.querySelector<HTMLSelectElement>('#endEdge')?.addEventListener('change', (event) => { state.selectedEndEdge = (event.currentTarget as HTMLSelectElement).value; });
  root.querySelectorAll<HTMLInputElement>('[data-measure-field]').forEach((input) => input.addEventListener('change', () => updateMeasurementField(root, input)));
  root.querySelectorAll<HTMLButtonElement>('[data-delete-measure]').forEach((button) => button.addEventListener('click', () => {
    const index = Number(button.dataset.deleteMeasure);
    state.project.measurements.splice(index, 1);
    recalc(root);
  }));
  root.querySelector<HTMLButtonElement>('#addMeasurementBtn')?.addEventListener('click', () => {
    if (!state.selectedStartEdge || !state.selectedEndEdge) return;
    const id = `T${state.project.measurements.length + 1}`;
    state.project.measurements.push({ id, startEdgeId: state.selectedStartEdge, endEdgeId: state.selectedEndEdge });
    markDirty(root);
    recalc(root);
  });
}

function updateImlReg(root: HTMLElement, input: HTMLInputElement): void {
  if (state.project.levelShifter.model !== 'single-iml7272b') return;
  const key = input.dataset.imlReg as keyof Pick<Iml7272bConfig, 'reg01' | 'reg02' | 'reg03' | 'reg04'>;
  state.project.levelShifter[key] = parseByte(input.value, state.project.levelShifter[key]);
  markDirty(root);
}

function parseEkParamValue(key: keyof Ek86707aConfig, value: string): unknown {
  if (key === 'set2' || key === 'set3' || key === 'dualSto' || key === 'ocpEnabled') return value === 'true';
  return value;
}

function updateImlField(root: HTMLElement, select: HTMLSelectElement): void {
  if (state.project.levelShifter.model !== 'single-iml7272b') return;
  const ls = state.project.levelShifter;
  const value = clampByte(Number(select.value));
  switch (select.dataset.imlField) {
    case 'lcPower':
      ls.reg01 = setBits(ls.reg01, 0, 0x03, value);
      break;
    case 'powerOffPor':
      ls.reg01 = setBits(ls.reg01, 2, 0x01, value);
      break;
    case 'twoLineMode':
      ls.reg01 = setBits(ls.reg01, 3, 0x01, value);
      break;
    case 'hsrMode':
      ls.reg01 = setBits(ls.reg01, 4, 0x03, value);
      break;
    case 'clkPhase':
      ls.reg04 = setBits(ls.reg04, 0, 0x03, value);
      break;
    case 'clkMode':
      ls.reg04 = setBits(ls.reg04, 7, 0x01, value);
      break;
    case 'clkSlew':
      ls.reg03 = setBits(ls.reg03, 6, 0x03, value);
      break;
    case 'ocpBlank':
      ls.reg03 = setBits(ls.reg03, 0, 0x07, value);
      break;
  }
  markDirty(root);
}

function updateLevelInput(root: HTMLElement, select: HTMLSelectElement): void {
  const [model, key] = String(select.dataset.lsInput ?? '').split(':') as [LevelInputModel, LevelInputKey];
  const value = select.value || undefined;
  if (model === 'ek') {
    if (!isEkConfig(state.project.levelShifter)) return;
    const ekKey = key as EkInputKey;
    state.manualEkInputKeys.add(ekKey);
    state.project.levelShifter.inputs[ekKey] = value;
  } else {
    if (state.project.levelShifter.model !== 'single-iml7272b') return;
    const imlKey = key as ImlInputKey;
    state.manualImlInputKeys.add(imlKey);
    state.project.levelShifter.inputs[imlKey] = value;
  }
  markDirty(root);
}

function parseByte(value: string, fallback: number): number {
  const text = value.trim().toLowerCase();
  if (!text) return clampByte(fallback);
  const next = text.startsWith('0x') ? Number.parseInt(text, 16) : Number(text);
  return Number.isFinite(next) ? clampByte(next) : clampByte(fallback);
}

function setBits(value: number, shift: number, mask: number, bits: number): number {
  return clampByte((value & ~(mask << shift)) | ((bits & mask) << shift));
}

function updateMeasurementField(root: HTMLElement, input: HTMLInputElement): void {
  const index = Number(input.dataset.measureIndex);
  const measurement = state.project.measurements[index];
  if (!measurement) return;
  measurement.targetInput = input.value.trim();
  measurement.targetSeconds = parseTargetSeconds(measurement.targetInput, state.project.timing);
  recalc(root);
}

function updateEntry(root: HTMLElement, input: HTMLInputElement): void {
  const gpo = selectedGpo();
  if (!gpo) return;
  const entry = gpo.entries.find((e) => e.index === Number(input.dataset.entry));
  if (!entry) return;
  const field = input.dataset.entryField as 'enabled' | 'level' | 'fcnt' | 'lcnt' | 'pcnt';
  const oldValue = entry[field];
  const newValue = input.value.trim().toLowerCase().startsWith('0x') ? Number.parseInt(input.value, 16) : Number(input.value);
  if (!Number.isFinite(newValue)) return;
  if (field === 'pcnt' && state.project.timing && newValue > state.project.timing.pcntMax) {
    alert(`PCNT=${newValue} 超过当前限制=${state.project.timing.pcntMax}`);
    input.value = String(oldValue);
    return;
  }
  if (field === 'lcnt' && gpo.repeatMode === 0 && gpo.soc !== 'mt9603') {
    alert('Repeat_mode_SEL=0(by line) 不允许修改 LCNT');
    input.value = String(oldValue);
    return;
  }
  if (field === 'enabled') entry.enabled = newValue === 1;
  else if (field === 'level') entry.level = newValue ? 1 : 0;
  else entry[field] = newValue;
  if (field === 'fcnt') {
    if (gpo.entryEncoding === 'packed-fcnt') {
      entry.enabled = Boolean(entry.fcnt & 0x8000);
      entry.level = entry.fcnt & 0x4000 ? 1 : 0;
      entry.frameCount = entry.fcnt & 0xff;
    } else {
      entry.frameCount = entry.fcnt;
    }
  }
  addPatch(gpo, field, entry.index, oldValue, newValue);
  markDirty(root);
}

function applyEdgeDragPatch(root: HTMLElement, drag: Extract<DragState, { mode: 'edge' }>): void {
  const t = state.project.timing;
  if (!t) return;
  const { gpo, entry } = drag.target;
  const { nextLcnt, nextPcnt } = edgeDragNextPosition(drag);
  const oldLcnt = entry.lcnt;
  const oldPcnt = entry.pcnt;
  if (nextPcnt > t.pcntMax) {
    state.message = `拖动结果 PCNT=${nextPcnt} 超过当前限制 ${t.pcntMax}，未生成 patch`;
    render(root);
    return;
  }
  if (gpo.repeatMode === 0 && gpo.soc !== 'mt9603' && nextLcnt !== entry.lcnt) {
    state.message = 'by-line 模式不允许通过拖拽修改 LCNT；请只在同一行内横向移动 PCNT';
    render(root);
    return;
  }
  if (nextLcnt === oldLcnt && nextPcnt === oldPcnt) {
    state.message = '拖动距离没有改变 entry 位置';
    render(root);
    return;
  }
  if (nextLcnt !== oldLcnt) {
    entry.lcnt = nextLcnt;
    addPatch(gpo, 'lcnt', entry.index, oldLcnt, nextLcnt);
  }
  if (nextPcnt !== oldPcnt) {
    entry.pcnt = nextPcnt;
    addPatch(gpo, 'pcnt', entry.index, oldPcnt, nextPcnt);
  }
  state.selectedGpo = gpo.index;
  state.activeTab = 'gpio';
  state.project.dirty = true;
  state.message = `已生成 patch suggestion：${edgePatchPath(drag.target)}；${formatPcnt(drag.originAt, t.pcntPerLine)} → ${formatPcnt(drag.previewAt, t.pcntPerLine)}。点击“重新计算波形”后预览结果。`;
  render(root);
}

function edgeDragNextPosition(drag: Extract<DragState, { mode: 'edge' }>): { nextLcnt: number; nextPcnt: number } {
  const t = state.project.timing;
  if (!t) return { nextLcnt: drag.target.entry.lcnt, nextPcnt: drag.target.entry.pcnt };
  const nextAbsInPeriod = Math.max(0, drag.previewAt - drag.target.periodStart);
  return {
    nextLcnt: Math.floor(nextAbsInPeriod / t.pcntPerLine),
    nextPcnt: nextAbsInPeriod % t.pcntPerLine,
  };
}

function edgeDragPreviewText(drag: Extract<DragState, { mode: 'edge' }>): string {
  const t = state.project.timing;
  if (!t) return '';
  const { nextLcnt, nextPcnt } = edgeDragNextPosition(drag);
  const lcntChange = nextLcnt === drag.target.entry.lcnt ? '' : ` LCNT ${drag.target.entry.lcnt}->${nextLcnt}`;
  const pcntChange = nextPcnt === drag.target.entry.pcnt ? '' : ` PCNT ${drag.target.entry.pcnt}->${nextPcnt}`;
  return `${edgePatchPath(drag.target)}；${formatPcnt(drag.originAt, t.pcntPerLine)} → ${formatPcnt(drag.previewAt, t.pcntPerLine)}；将写${lcntChange || ''}${pcntChange || ''}；松开生成 patch suggestion`;
}

function edgePatchPath(target: DraggableEdgeTarget): string {
  const entry = target.entry;
  const lcntCell = entry.cells.lcnt?.address ?? '-';
  const pcntCell = entry.cells.pcnt?.address ?? '-';
  return `GPIO > ${target.gpo.group} > entry${entry.index} > LCNT ${lcntCell} / PCNT ${pcntCell}`;
}

function updateGpoField(root: HTMLElement, input: HTMLInputElement): void {
  const gpo = selectedGpo();
  if (!gpo) return;
  const key = input.dataset.gpoField as keyof GpoConfig;
  const oldValue = gpo[key] as unknown;
  const next = input.type === 'checkbox' ? input.checked : Number(input.value);
  (gpo as unknown as Record<string, unknown>)[key] = next;
  const cellName = gpoFieldCellName(gpo, String(key));
  state.project.patches.push({ sheet: 'GPIO', cell: gpo.cells[cellName]?.address ?? '-', group: gpo.group, name: cellName, oldValue: oldValue as string | number | null, newValue: next as string | number | null });
  markDirty(root);
}

function gpoFieldCellName(gpo: GpoConfig, key: string): string {
  const map: Record<string, string> = {
    combinType: gpo.soc === 'mt9603' ? 'Logic_function' : 'Combin_Type_SEL',
    combinSel: 'GPO_Combin_SEL',
    repeatMode: 'Repeat_mode_SEL',
    maskEnabled: 'Mask_region_EN',
    regionVst: 'Region_VST',
    regionVend: 'Region_VEND',
    regionPst: 'Region_pst',
    regionPend: 'Region_pend',
    regionOtherValue: 'Region_other_Value',
  };
  return map[key] ?? key;
}

function addPatch(gpo: GpoConfig, field: 'enabled' | 'level' | 'fcnt' | 'lcnt' | 'pcnt', entryIndex: number, oldValue: number | boolean, newValue: number): void {
  const entry = gpo.entries.find((e) => e.index === entryIndex);
  const cellKey = field === 'enabled' ? 'enable' : field;
  const cell = entry?.cells[cellKey];
  const normalizedOld = typeof oldValue === 'boolean' ? (oldValue ? 1 : 0) : oldValue;
  state.project.patches.push({ sheet: 'GPIO', cell: cell?.address ?? '-', group: gpo.group, name: `entry${entryIndex}_${field.toUpperCase()}`, oldValue: normalizedOld, newValue });
}

function markDirty(root: HTMLElement): void {
  state.project.dirty = true;
  state.message = '参数已修改，等待重新计算波形';
  render(root);
}

function recalc(root: HTMLElement): void {
  if (!state.project.timing) {
    state.message = '请先导入 XLSX';
    render(root);
    return;
  }
  try {
    state.project.simulation = simulateProject(state.project);
    const autoMapped = autoFillLevelInputsFromSimulation();
    if (autoMapped.length > 0) state.project.simulation = simulateProject(state.project);
    state.project.dirty = false;
    state.message = autoMapped.length > 0 ? `波形已重新计算，自动识别：${autoMapped.join('，')}` : '波形已重新计算';
    if (state.referenceSignalId && centerOnReference()) {
      state.message = '波形已重新计算，并已跳到参考边沿';
    } else {
      setDefaultView(state.viewMode);
    }
  } catch (error) {
    state.message = error instanceof Error ? error.message : String(error);
  }
  render(root);
}

function setDefaultView(kind: ViewMode): void {
  const t = state.project.timing;
  const sim = state.project.simulation;
  if (!t || !sim) return;
  state.viewMode = kind;
  if (kind !== 'frame1' && kind !== 'frame120' && state.referenceSignalId && centerOnReference()) return;
  const linePcnt = t.pcntPerLine;
  const framePcnt = linePcnt * t.vtotal;
  const span = linePcnt * 6;
  const findEdge = (token: string) => sim.signals.find((s) => s.id.includes(token))?.edges[0]?.at;
  const findLastEdge = (token: string) => {
    const edges = sim.signals.filter((s) => s.id.includes(token)).flatMap((s) => s.edges);
    return edges.at(-1)?.at;
  };
  const isIml7272b = state.project.levelShifter.model === 'single-iml7272b';
  const noLs = state.project.levelShifter.model === 'none';
  let center = isIml7272b
    ? findEdge('driver_tp') ?? findEdge('init_tp') ?? findImlInputEdge('clkIn1') ?? findImlInputEdge('clkIn2') ?? findEdge('ls:clk') ?? findEdge('ls:stv1') ?? 0
    : noLs
      ? findEdge('cpv1') ?? findEdge('cpv2') ?? findEdge('stv') ?? 0
      : findEdge('driver_tp') ?? findEdge('init_tp') ?? findEdge('cpv1') ?? 0;
  if (kind === 'head') center = isIml7272b ? findEdge('ls:stv1') ?? findImlInputEdge('stvIn1') ?? findEdge('ls:clk') ?? center : findEdge('stv') ?? center;
  if (kind === 'tail') center = isIml7272b ? findLastEdge('ls:clk') ?? Math.max(0, linePcnt * (t.vtotal - 6)) : findLastEdge('ck') ?? findEdge('cpv2') ?? Math.max(0, linePcnt * (t.vtotal - 6));
  if (kind === 'frame1') {
    state.view = { start: 0, end: framePcnt };
    return;
  }
  if (kind === 'frame120') {
    state.view = { start: 0, end: framePcnt * 120 };
    return;
  }
  state.view = { start: Math.max(0, center - span), end: Math.min(framePcnt, center + span) };
}

function findImlInputEdge(key: keyof Iml7272bConfig['inputs']): number | undefined {
  if (state.project.levelShifter.model !== 'single-iml7272b') return undefined;
  return signalById(state.project.levelShifter.inputs[key])?.edges[0]?.at;
}

function centerOnReference(): boolean {
  const t = state.project.timing;
  const edge = selectedReferenceEdge();
  if (!t || !edge) return false;
  const span = t.pcntPerLine * 6;
  setView(edge.at - span, edge.at + span);
  return true;
}

function zoomView(factor: number, anchorX?: number): void {
  const t = state.project.timing;
  const hit = state.hitMap;
  if (!t || !state.view) return;
  const total = viewTotalPcnt();
  const span = state.view.end - state.view.start;
  const ratio = hit && anchorX !== undefined ? Math.max(0, Math.min(1, (anchorX - hit.plotLeft) / hit.plotWidth)) : 0.5;
  const anchor = state.view.start + span * ratio;
  const nextSpan = Math.max(20, Math.min(total, Math.round(span * factor)));
  setView(Math.round(anchor - nextSpan * ratio), Math.round(anchor + nextSpan * (1 - ratio)));
}

function setView(start: number, end: number): void {
  const t = state.project.timing;
  if (!t) return;
  const total = viewTotalPcnt();
  const span = Math.max(20, end - start);
  let s = Math.max(0, Math.min(total - span, start));
  let e = s + span;
  if (e > total) {
    e = total;
    s = Math.max(0, e - span);
  }
  state.view = { start: Math.round(s), end: Math.round(e) };
}

function viewTotalPcnt(): number {
  const t = state.project.timing;
  if (!t) return 0;
  return t.pcntPerLine * t.vtotal * (state.viewMode === 'frame120' ? 120 : 1);
}

function clampAbsPcnt(at: number): number {
  const total = viewTotalPcnt();
  return Math.max(0, Math.min(total, Math.round(at)));
}

function draggableEdgeTarget(edge: Edge | undefined): DraggableEdgeTarget | undefined {
  const t = state.project.timing;
  if (!edge || !t || edge.gpoIndex === undefined || edge.edge === 'point') return undefined;
  const gpo = state.project.gpos.find((item) => item.index === edge.gpoIndex);
  if (!gpo) return undefined;
  const total = viewTotalPcnt();
  const periodTotal = gpo.repeatMode === 1
    ? Math.max(1, gpo.repeatCount + 1) * t.pcntPerLine * t.vtotal
    : Math.max(1, gpo.repeatCount + 1) * t.pcntPerLine;
  const periodStart = Math.floor(edge.at / periodTotal) * periodTotal;
  const edgeInPeriod = edge.at - periodStart;
  let best: { entry: GpoConfig['entries'][number]; distance: number } | undefined;
  for (const entry of gpo.entries.filter((item) => item.enabled && item.level === edge.level)) {
    const entryAt = gpo.repeatMode === 1
      ? entry.frameCount * t.pcntPerLine * t.vtotal + entry.lcnt * t.pcntPerLine + entry.pcnt
      : entry.lcnt * t.pcntPerLine + entry.pcnt;
    const distance = Math.abs(entryAt - edgeInPeriod);
    if (distance <= 1 && (!best || distance < best.distance)) best = { entry, distance };
  }
  if (!best) return undefined;
  if (periodStart + periodTotal > total + periodTotal) return undefined;
  return { gpo, entry: best.entry, periodStart };
}

function nearestEdge(x: number, y: number, radius = 8): Edge | undefined {
  const hit = state.hitMap;
  if (!hit) return undefined;
  let best: { edge: Edge; dist: number } | undefined;
  for (const edge of hit.edges) {
    const verticalGap = y < edge.y1 ? edge.y1 - y : y > edge.y2 ? y - edge.y2 : 0;
    if (verticalGap > Math.max(8, radius * 0.8)) continue;
    const dx = Math.abs(edge.x - x);
    const dist = Math.hypot(dx, verticalGap);
    if (dist <= radius && (!best || dist < best.dist)) best = { edge, dist };
  }
  return best?.edge;
}

function previewPointAt(x: number, y: number): Edge | undefined {
  const hit = state.hitMap;
  const timing = state.project.timing;
  if (!hit || !timing) return undefined;
  if (x < hit.plotLeft || x > hit.plotLeft + hit.plotWidth) return undefined;
  const row = hit.rows.find((item) => y >= item.y1 && y <= item.y2);
  if (!row) return undefined;
  const total = viewTotalPcnt();
  const span = hit.view.end - hit.view.start;
  const at = Math.max(0, Math.min(total, Math.round(hit.view.start + ((x - hit.plotLeft) / hit.plotWidth) * span)));
  const level = levelAt(row.signal, at);
  return {
    id: `preview:${row.signal.id}@${at}`,
    signalId: row.signal.id,
    signalName: row.signal.name,
    at,
    edge: 'point',
    level,
    source: 'manual-point',
    gpoIndex: row.signal.sourceGpo,
  };
}

function pointAt(x: number, y: number): Edge | undefined {
  const preview = previewPointAt(x, y);
  if (!preview) return undefined;
  const edge: Edge = { ...preview, id: `manual:${preview.signalId}@${preview.at}:${Date.now()}` };
  state.project.manualEdges = [...(state.project.manualEdges ?? []), edge].slice(-200);
  return edge;
}

function levelAt(signal: SignalTrace, at: number): 0 | 1 {
  return signal.segments.find((segment) => segment.start <= at && segment.end > at)?.level ?? 0;
}

function renderWarnings(root: HTMLElement): void {
  const warnings = state.project.simulation?.warnings ?? [];
  root.querySelector('#warnings')!.innerHTML = warnings.slice(0, 6).map((w) => `<div>${w}</div>`).join('');
}

function draw(root: HTMLElement): void {
  const canvas = root.querySelector<HTMLCanvasElement>('#waveCanvas');
  if (!canvas) return;
  state.hitMap = drawWaveform(canvas, visibleSignalsForMode(), state.project.timing, state.view, {
    hoverEdgeId: state.hoverEdge?.id,
    cursorAt: state.snapEnabled ? undefined : state.cursorPoint?.at,
    cursorSignalName: state.cursorPoint?.signalName,
    dragPreviewAt: state.drag?.mode === 'edge' ? state.drag.previewAt : undefined,
    dragPreviewLabel: state.drag?.mode === 'edge' && state.project.timing ? `${state.drag.target.gpo.group} entry${state.drag.target.entry.index} ${formatPcnt(state.drag.previewAt, state.project.timing.pcntPerLine)}` : undefined,
    showPulseCount: state.viewMode === 'frame1' || state.viewMode === 'frame120',
    selectedStartEdgeId: state.selectedStartEdge,
    selectedEndEdgeId: state.selectedEndEdge,
  });
  canvas.classList.toggle('snap-ready', Boolean(state.hoverEdge));
  canvas.classList.toggle('snap-off', !state.snapEnabled);
}

function overviewSignal(signal: SignalTrace, maxSegments = 3000): SignalTrace {
  if (!state.project.timing || signal.segments.length <= maxSegments) return signal;
  const total = viewTotalPcnt();
  const bin = Math.max(1, Math.ceil(total / maxSegments));
  const reduced: SignalTrace['segments'] = [];
  let cursor = 0;
  let index = 0;
  while (cursor < total) {
    const end = Math.min(total, cursor + bin);
    let active = false;
    while (index < signal.segments.length && signal.segments[index].end <= cursor) index += 1;
    for (let j = index; j < signal.segments.length && signal.segments[j].start < end; j += 1) {
      if (signal.segments[j].level === 1 && signal.segments[j].end > cursor) {
        active = true;
        break;
      }
    }
    reduced.push({ start: cursor, end, level: active ? 1 : 0, source: `${signal.sourceGpo ?? signal.id}:overview` });
    cursor = end;
  }
  return {
    ...signal,
    segments: mergeSegments(reduced),
    edges: [],
    note: '120frame overview 降载显示；放大或切到 1frame 可看精确边沿',
  };
}

function mergeSegments(segments: SignalTrace['segments']): SignalTrace['segments'] {
  const merged: SignalTrace['segments'] = [];
  for (const segment of segments) {
    const prev = merged[merged.length - 1];
    if (prev && prev.end === segment.start && prev.level === segment.level && prev.source === segment.source) prev.end = segment.end;
    else merged.push({ ...segment });
  }
  return merged;
}

function visibleSignalsForMode(): SignalTrace[] {
  const signals = state.project.simulation?.signals ?? [];
  if (signals.length === 0) return [];
  const ordered = orderedSignals(signals);
  const byId = new Map([...ordered, ...(state.project.simulation?.gpoSignals ?? [])].map((signal) => [signal.id, signal]));
  const result: SignalTrace[] = [];
  const isIml7272b = state.project.levelShifter.model === 'single-iml7272b';
  const push = (id: string) => {
    const signal = byId.get(id);
    if (signal && !result.some((item) => item.id === signal.id)) result.push(signal);
  };
  const pushCks = () => ordered.filter((signal) => isClockOutput(signal.id)).forEach((signal) => push(signal.id));
  const pushImlInputs = () => {
    if (state.project.levelShifter.model !== 'single-iml7272b') return;
    Object.values(state.project.levelShifter.inputs).forEach((id) => { if (id) push(id); });
  };
  const pushImlHeadInputs = () => {
    if (state.project.levelShifter.model !== 'single-iml7272b') return;
    [
      state.project.levelShifter.inputs.stvIn1,
      state.project.levelShifter.inputs.stvIn2,
      state.project.levelShifter.inputs.lcIn,
      state.project.levelShifter.inputs.clkIn1,
      state.project.levelShifter.inputs.clkIn2,
      state.project.levelShifter.inputs.terminate,
    ].forEach((id) => { if (id) push(id); });
  };
  const pushTpCkDebugBase = () => {
    [
      'driver_tp:raw',
      'driver_tp:source',
      'driver_tp:merge',
      'init_tp:raw',
      'init_tp:source',
      'init_tp:merge',
      'cpv1:raw',
      'cpv1:source',
      'cpv1:merge',
      'cpv2:raw',
      'cpv2:source',
      'cpv2:merge',
    ].forEach(push);
  };
  const pushImlClockInputsAfterBase = () => {
    if (state.project.levelShifter.model !== 'single-iml7272b') return;
    [state.project.levelShifter.inputs.clkIn1, state.project.levelShifter.inputs.clkIn2, state.project.levelShifter.inputs.terminate].forEach((id) => { if (id) push(id); });
  };
  const pushImlOutputs = () => {
    ['ls:stv1', 'ls:stv2', 'ls:lc1', 'ls:lc2'].forEach(push);
    pushCks();
  };

  if (state.viewMode === 'debug') {
    if (state.project.levelShifter.model === 'none') {
      pushTpCkDebugBase();
      return addExtraSignals(pinReference(result.length > 0 ? result : ordered));
    }
    if (isIml7272b) {
      pushTpCkDebugBase();
      pushImlClockInputsAfterBase();
      push('ls:clk1');
      return addExtraSignals(pinReference(result.length > 0 ? result : ordered));
    }
    pushTpCkDebugBase();
    push('ck1');
    return addExtraSignals(pinReference(result.length > 0 ? result : ordered));
  }

  if (state.viewMode === 'head') {
    if (state.project.levelShifter.model === 'none') {
      ['stv:merge', 'cpv1:merge', 'cpv2:merge', 'lc:merge', 'pol:merge', 'rst:manual'].forEach(push);
      return addExtraSignals(pinReference(result.length > 0 ? result : ordered));
    }
    if (isIml7272b) {
      pushImlHeadInputs();
      pushImlOutputs();
      ['rst:manual', 'pol:merge'].forEach(push);
      return addExtraSignals(pinReference(result.length > 0 ? result : ordered));
    }
    ['driver_tp:merge', 'init_tp:merge', 'stv:merge', 'cpv1:merge', 'cpv2:merge'].forEach(push);
    pushCks();
    ['rst:manual', 'pol:merge'].forEach(push);
    return addExtraSignals(pinReference(result.length > 0 ? result : ordered));
  }

  if (state.viewMode === 'tail') {
    if (state.project.levelShifter.model === 'none') {
      ['cpv1:merge', 'cpv2:merge', 'lc:merge', 'pol:merge', 'rst:manual'].forEach(push);
      return addExtraSignals(pinReference(result.length > 0 ? result : ordered));
    }
    if (isIml7272b) {
      pushCks();
      if (state.project.levelShifter.model === 'single-iml7272b' && state.project.levelShifter.inputs.terminate) push(state.project.levelShifter.inputs.terminate);
      ['rst:manual'].forEach(push);
      return addExtraSignals(pinReference(result.length > 0 ? result : ordered));
    }
    pushCks();
    if (state.project.levelShifter.model === 'dual-ek86707a') push('ter:manual');
    else push('cpv2:merge');
    push('rst:manual');
    return addExtraSignals(pinReference(result.length > 0 ? result : ordered));
  }

  if (state.viewMode === 'frame120') {
    return addExtraSignals(pinReference(multiFrameSignals(120)));
  }

  if (isIml7272b) {
    pushImlOutputs();
    ['pol:merge'].forEach(push);
    return addExtraSignals(pinReference(result.length > 0 ? result : ordered.filter((signal) => isClockOutput(signal.id))));
  }
  if (state.project.levelShifter.model === 'none') {
    ['stv:merge', 'cpv1:merge', 'cpv2:merge', 'lc:merge', 'pol:merge'].forEach(push);
    return addExtraSignals(pinReference(result.length > 0 ? result : ordered));
  }
  ['stv:merge'].forEach(push);
  pushCks();
  ['pol:merge'].forEach(push);
  return addExtraSignals(pinReference(result.length > 0 ? result : ordered.filter((signal) => isClockOutput(signal.id))));
}

function pinReference(signals: SignalTrace[]): SignalTrace[] {
  const reference = state.referenceSignalId ? signalById(state.referenceSignalId) : undefined;
  if (!reference) return signals;
  return [reference, ...signals.filter((signal) => signal.id !== reference.id)];
}

function addExtraSignals(signals: SignalTrace[]): SignalTrace[] {
  const extras = state.extraSignalIds
    .map((id) => state.viewMode === 'frame120' ? overviewSignalOrBase(multiFrameSignalById(id, 120)) : signalById(id))
    .filter((signal): signal is SignalTrace => Boolean(signal));
  return [...signals, ...extras.filter((signal) => !signals.some((item) => item.id === signal.id))];
}

function overviewSignalOrBase(signal: SignalTrace | undefined): SignalTrace | undefined {
  return signal ? overviewSignal(signal) : undefined;
}

function multiFrameSignals(frames: number): SignalTrace[] {
  const baseIds = ['stv:merge', 'pol:merge'];
  const signals = baseIds
    .map((id) => overviewSignalOrBase(multiFrameSignalById(id, frames)))
    .filter((signal): signal is SignalTrace => Boolean(signal));
  const lcSignals = state.project.gpos
    .filter((gpo) => /(^|[_\s-])(lc|vgpin)/i.test(gpo.group))
    .map((gpo) => overviewSignalOrBase(multiFrameSignalById(`gpo:${gpo.index}:merge`, frames)))
    .filter((signal): signal is SignalTrace => Boolean(signal));
  return [...signals, ...lcSignals.filter((signal) => !signals.some((item) => item.id === signal.id))];
}

function multiFrameSignalById(id: string, frames: number): SignalTrace | undefined {
  const base = signalById(id);
  const timing = state.project.timing;
  if (!base || !timing) return undefined;
  const gpoIndex = base.sourceGpo;
  if (gpoIndex === undefined || base.kind === 'ck') return base;
  const gpo = state.project.gpos.find((item) => item.index === gpoIndex);
  if (!gpo) return base;
  const own = id.endsWith(':raw')
    ? simulateGpoWindow(gpo, timing, false, frames)
    : simulateGpoOutWindow(gpo, state.project.gpos, timing, false, frames);
  const signal: SignalTrace = {
    ...base,
    segments: own,
    edges: edgesForSignal(base, own),
    summary: pulseSummary(own, timing, gpo),
  };
  return signal;
}

function edgesForSignal(base: SignalTrace, segments: SignalTrace['segments']): Edge[] {
  const edges: Edge[] = [];
  let prevLevel: 0 | 1 = 0;
  for (const segment of segments) {
    if (segment.start > 0 && segment.level !== prevLevel) {
      edges.push({
        id: `${base.id}@${segment.start}:${segment.level}`,
        signalId: base.id,
        signalName: base.name,
        at: segment.start,
        edge: segment.level ? 'rising' : 'falling',
        level: segment.level,
        source: segment.source,
        gpoIndex: base.sourceGpo,
      });
    }
    prevLevel = segment.level;
  }
  return edges;
}

function pulseSummary(segments: SignalTrace['segments'], timing: DraftProject['timing'], gpo?: GpoConfig): string {
  if (!timing) return '';
  const frameTotal = timing.pcntPerLine * timing.vtotal;
  if (gpo?.repeatMode === 1) {
    const entries = gpo.entries
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        at: entry.frameCount * frameTotal + entry.lcnt * timing.pcntPerLine + entry.pcnt,
        level: entry.level,
      }))
      .sort((a, b) => a.at - b.at);
    const period = Math.max(1, gpo.repeatCount + 1) * frameTotal;
    const rising = entries.find((entry, index) => entry.level === 1 && entries[(index + entries.length - 1) % entries.length]?.level === 0);
    if (rising) {
      const falling = entries.find((entry) => entry.level === 0 && entry.at > rising.at) ?? entries.find((entry) => entry.level === 0);
      const widthPcnt = falling ? (falling.at > rising.at ? falling.at - rising.at : period - rising.at + falling.at) : period;
      return `W=${formatDuration(widthPcnt * timing.pcntSeconds)} T=${formatDuration(period * timing.pcntSeconds)}`;
    }
  }
  const highs = segments.filter((segment) => segment.level === 1);
  if (highs.length === 0) return 'W=0';
  const firstWidth = (highs[0].end - highs[0].start) * timing.pcntSeconds;
  const period = highs.length > 1 ? (highs[1].start - highs[0].start) * timing.pcntSeconds : undefined;
  return `W=${formatDuration(firstWidth)}${period ? ` T=${formatDuration(period)}` : ''}`;
}

function orderedSignals(signals: SignalTrace[]): SignalTrace[] {
  const byId = new Map(signals.map((signal) => [signal.id, signal]));
  const result: SignalTrace[] = [];
  const push = (id: string) => {
    const signal = byId.get(id);
    if (signal && !result.some((item) => item.id === signal.id)) result.push(signal);
  };
  [
    'driver_tp:raw',
    'driver_tp:source',
    'driver_tp:merge',
    'init_tp:raw',
    'init_tp:source',
    'init_tp:merge',
    'stv:raw',
    'stv:merge',
    'cpv1:raw',
    'cpv1:source',
    'cpv1:merge',
    'cpv2:raw',
    'cpv2:source',
    'cpv2:merge',
    'ter:manual',
    'lc:raw',
    'lc:merge',
    'pol:raw',
    'pol:merge',
    'rst:manual',
    'ls:stv1',
    'ls:stv2',
    'ls:lc1',
    'ls:lc2',
  ].forEach(push);
  signals
    .filter((signal) => isClockOutput(signal.id))
    .sort((a, b) => clockOutputIndex(a.id) - clockOutputIndex(b.id))
    .forEach((signal) => push(signal.id));
  for (const signal of signals) push(signal.id);
  return result;
}

function isClockOutput(id: string): boolean {
  return /^ck\d+$/i.test(id) || /^ls:clk\d+$/i.test(id);
}

function clockOutputIndex(id: string): number {
  const match = id.match(/(\d+)$/);
  return match ? Number(match[1]) : 999;
}

function signalById(id: string | undefined): SignalTrace | undefined {
  if (!id) return undefined;
  return allSignals().find((signal) => signal.id === id);
}

function allSelectableEdges(): Edge[] {
  return [...(state.project.manualEdges ?? []), ...visibleSignalsForMode().flatMap((signal) => signal.edges)];
}

function parseTargetSeconds(value: string | undefined, timing: DraftProject['timing']): number | undefined {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return undefined;
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*(ns|us|µs|ms|s|pcnt|lcnt)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? 'us';
  if (unit === 'ns') return amount * 1e-9;
  if (unit === 'us' || unit === 'µs') return amount * 1e-6;
  if (unit === 'ms') return amount * 1e-3;
  if (unit === 's') return amount;
  if (unit === 'pcnt') return timing ? amount * timing.pcntSeconds : undefined;
  if (unit === 'lcnt') return timing ? amount * timing.lcntSeconds : undefined;
  return undefined;
}

function formatTargetInput(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  return `${(seconds * 1e6).toFixed(3)}us`;
}

function formatTargetDelta(m: NonNullable<DraftProject['simulation']>['measurements'][number]): string {
  if (m.targetSeconds === undefined) return '未设置 target';
  if (m.errorSeconds === undefined || m.errorPcnt === undefined) return '-';
  const sign = m.errorSeconds >= 0 ? '多' : '少';
  const absPcnt = Math.abs(m.errorPcnt);
  const lcnt = state.project.timing ? Math.trunc(absPcnt / state.project.timing.pcntPerLine) : 0;
  const pcnt = state.project.timing ? absPcnt % state.project.timing.pcntPerLine : absPcnt;
  return `${sign} ${formatDuration(Math.abs(m.errorSeconds))}<br>${m.errorPcnt >= 0 ? '+' : '-'}${absPcnt} pcnt (${m.errorPcnt >= 0 ? '+' : '-'}${lcnt}lcnt ${pcnt}pcnt)`;
}

function selectedReferenceEdge(): Edge | undefined {
  const signal = signalById(state.referenceSignalId);
  if (!signal) return undefined;
  let edge = signal.edges.find((item) => item.id === state.referenceEdgeId);
  if (!edge) {
    edge = signal.edges[0];
    state.referenceEdgeId = edge?.id;
  }
  return edge;
}

function selectedGpo(): GpoConfig | undefined {
  return state.project.gpos.find((g) => g.index === state.selectedGpo) ?? state.project.gpos[0];
}

function structuredCloneGpos(gpos: GpoConfig[]): GpoConfig[] {
  return JSON.parse(JSON.stringify(gpos)) as GpoConfig[];
}

function exportPatchedXlsx(): void {
  const parsed = state.project.parsed;
  if (!parsed || !state.sourceFileBuffer) return;
  if (!/\.xlsx$/i.test(state.sourceFileName ?? parsed.fileName)) {
    alert('patched XLSX 只支持原始 .xlsx。xls/xlsm 不会重写整份文件，请导出 JSON patch 后用外部工具精确写入。');
    return;
  }
  if (state.project.patches.length === 0) {
    alert('当前没有 patch suggestion。');
    return;
  }
  try {
    const out = patchXlsxZip(state.sourceFileBuffer, state.project.patches);
    const baseName = parsed.fileName.replace(/\.(xlsx|xlsm|xls)$/i, '');
    download(`${baseName}.patched.xlsx`, out, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
  }
}

function patchXlsxZip(source: ArrayBuffer, patches: DraftProject['patches']): Uint8Array {
  const zip = unzipSync(new Uint8Array(source));
  const sheetPaths = sheetXmlPaths(zip);
  const grouped = new Map<string, DraftProject['patches']>();
  for (const patch of patches) {
    if (patch.cell === '-') continue;
    const list = grouped.get(patch.sheet) ?? [];
    list.push(patch);
    grouped.set(patch.sheet, list);
  }
  for (const [sheetName, sheetPatches] of grouped) {
    const path = sheetPaths.get(sheetName);
    if (!path) throw new Error(`找不到 sheet XML：${sheetName}`);
    const current = zip[path];
    if (!current) throw new Error(`XLSX 内缺少 ${path}`);
    let xml = strFromU8(current);
    for (const patch of sheetPatches) {
      xml = patchSheetCellXml(xml, patch.cell, patch.newValue);
    }
    zip[path] = strToU8(xml);
  }
  return zipSync(zip);
}

function sheetXmlPaths(zip: Unzipped): Map<string, string> {
  const workbookXml = zip['xl/workbook.xml'];
  const relsXml = zip['xl/_rels/workbook.xml.rels'];
  if (!workbookXml || !relsXml) throw new Error('XLSX 缺少 workbook.xml 或 workbook.xml.rels。');
  const workbook = strFromU8(workbookXml);
  const rels = strFromU8(relsXml);
  const ridToTarget = new Map<string, string>();
  for (const rel of rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*>/g)) {
    ridToTarget.set(xmlDecode(rel[1]), xmlDecode(rel[2]));
  }
  const result = new Map<string, string>();
  for (const sheet of workbook.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*\/?>/g)) {
    const name = xmlDecode(sheet[1]);
    const rid = xmlDecode(sheet[2]);
    const target = ridToTarget.get(rid);
    if (!target) continue;
    const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    result.set(name, normalized.replace(/\/+/g, '/'));
  }
  return result;
}

function patchSheetCellXml(xml: string, cell: string, value: string | number | null): string {
  const escapedCell = escapeRegExp(cell);
  const cellRe = new RegExp(`<c\\\\b([^>]*)\\\\br="${escapedCell}"([^>]*)>([\\\\s\\\\S]*?)<\\\\/c>`);
  const match = xml.match(cellRe);
  const cellXml = makeCellXml(cell, value);
  if (!match) return insertCellXml(xml, cell, cellXml);
  return xml.replace(cellRe, cellXml);
}

function makeCellXml(cell: string, value: string | number | null): string {
  if (typeof value === 'number') return `<c r="${cell}"><v>${value}</v></c>`;
  if (value === null || value === undefined) return `<c r="${cell}"/>`;
  return `<c r="${cell}" t="inlineStr"><is><t>${xmlEncode(String(value))}</t></is></c>`;
}

function insertCellXml(xml: string, cell: string, cellXml: string): string {
  const rowNumber = Number(cell.match(/\d+/)?.[0] ?? 0);
  if (!rowNumber) throw new Error(`无效 cell 地址：${cell}`);
  const rowRe = new RegExp(`(<row\\\\b[^>]*\\\\br="${rowNumber}"[^>]*>)([\\\\s\\\\S]*?)(<\\\\/row>)`);
  const rowMatch = xml.match(rowRe);
  if (!rowMatch) throw new Error(`sheet XML 中找不到 row ${rowNumber}，为避免破坏格式，已拒绝插入新行。`);
  return xml.replace(rowRe, (_whole, open: string, body: string, close: string) => `${open}${insertCellInRow(body, cell, cellXml)}${close}`);
}

function insertCellInRow(rowBody: string, cell: string, cellXml: string): string {
  const target = cellAddressOrder(cell);
  const cells = [...rowBody.matchAll(/<c\b[^>]*\br="([^"]+)"[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)];
  for (const existing of cells) {
    if (cellAddressOrder(existing[1]) > target) {
      const index = existing.index ?? 0;
      return `${rowBody.slice(0, index)}${cellXml}${rowBody.slice(index)}`;
    }
  }
  return `${rowBody}${cellXml}`;
}

function exportPatchJson(): void {
  download(`goa-patch-${Date.now()}.json`, JSON.stringify(state.project.patches, null, 2), 'application/json');
}

function exportLevelShifterJson(): void {
  const payload = {
    version: 1,
    levelShifter: levelShifterReportState(),
    tpGenerator: state.project.tpGenerator ?? defaultTpGeneratorConfig(),
  };
  download(`goa-level-shifter-${Date.now()}.json`, JSON.stringify(payload, null, 2), 'application/json');
}

async function importLevelShifterJson(root: HTMLElement, input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text()) as { levelShifter?: unknown };
    const parsed = parseLevelShifterConfig(payload.levelShifter ?? payload);
    if (!parsed) throw new Error('LS JSON 格式不对：需要 model=single-ek86707a 或 single-iml7272b。');
    state.project.levelShifter = parsed;
    state.project.tpGenerator = parseTpGeneratorConfig((payload as { tpGenerator?: unknown }).tpGenerator);
    state.referenceSignalId = undefined;
    state.referenceEdgeId = undefined;
    state.extraSignalIds = [];
    state.manualEkInputKeys.clear();
    state.manualImlInputKeys.clear();
    markDirty(root);
  } catch (error) {
    state.message = error instanceof Error ? error.message : String(error);
    render(root);
  }
}

function parseLevelShifterConfig(value: unknown): LevelShifterConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  if (source.model === 'single-iml7272b') {
    const defaults = defaultIml7272bConfig();
    const rawInputs = source.inputs && typeof source.inputs === 'object' ? source.inputs as Record<string, unknown> : {};
    return {
      model: 'single-iml7272b',
      reg01: parseConfigByte(source.reg01, defaults.reg01),
      reg02: parseConfigByte(source.reg02, defaults.reg02),
      reg03: parseConfigByte(source.reg03, defaults.reg03),
      reg04: parseConfigByte(source.reg04, defaults.reg04),
      inputs: {
        stvIn1: stringOrUndefined(rawInputs.stvIn1),
        stvIn2: stringOrUndefined(rawInputs.stvIn2),
        clkIn1: stringOrUndefined(rawInputs.clkIn1),
        clkIn2: stringOrUndefined(rawInputs.clkIn2),
        lcIn: stringOrUndefined(rawInputs.lcIn),
        terminate: stringOrUndefined(rawInputs.terminate),
      },
    };
  }
  if (source.model === 'single-ek86707a' || source.model === 'dual-ek86707a') {
    const defaults = source.model === 'dual-ek86707a' ? defaultDualEk86707aConfig() : defaultLevelShifterConfig();
    const rawInputs = source.inputs && typeof source.inputs === 'object' ? source.inputs as Record<string, unknown> : {};
    const set1 = parseEkSet1Level(source.set1, defaults.set1);
    return {
      model: source.model,
      set1,
      set2: Boolean(source.set2 ?? defaults.set2),
      set3: Boolean(source.set3 ?? defaults.set3),
      dualSto: Boolean(source.dualSto ?? defaults.dualSto),
      ocpEnabled: Boolean(source.ocpEnabled ?? defaults.ocpEnabled),
      ocpSel: source.ocpSel === '0' || source.ocpSel === '1' || source.ocpSel === 'float' ? source.ocpSel : defaults.ocpSel,
      mode1: source.mode1 === 'high' || source.mode1 === 'normal' || source.mode1 === 'extra-high' || source.mode1 === 'low' ? source.mode1 : defaults.mode1,
      mode2: source.mode2 === '1' ? '1' : defaults.mode2,
      outputCount: ek86707aSet1OutputCount(set1),
      inputs: {
        driverTp: stringOrUndefined(rawInputs.driverTp),
        initTp: stringOrUndefined(rawInputs.initTp),
        stv: stringOrUndefined(rawInputs.stv),
        cpv1: stringOrUndefined(rawInputs.cpv1),
        cpv2: stringOrUndefined(rawInputs.cpv2),
        ter: stringOrUndefined(rawInputs.ter),
        rst: stringOrUndefined(rawInputs.rst),
        pol: stringOrUndefined(rawInputs.pol),
      },
    };
  }
  return undefined;
}

function parseTpGeneratorConfig(value: unknown): TpGeneratorConfig {
  const defaults = defaultTpGeneratorConfig();
  if (!value || typeof value !== 'object') return defaults;
  const source = value as Record<string, unknown>;
  return {
    driverTpWidth: typeof source.driverTpWidth === 'string' ? source.driverTpWidth : defaults.driverTpWidth,
    driverTpPeriod: typeof source.driverTpPeriod === 'string' ? source.driverTpPeriod : defaults.driverTpPeriod,
  };
}

function parseEkSet1Level(value: unknown, fallback: EkSet1Level): EkSet1Level {
  if (value === 'high' || value === 'float' || value === 'gnd') return value;
  if (typeof value === 'boolean') return value ? 'high' : 'gnd';
  if (value === 1 || value === '1') return 'high';
  if (value === 0 || value === '0') return 'gnd';
  return fallback;
}

function parseConfigByte(value: unknown, fallback: number): number {
  if (typeof value === 'number') return clampByte(value);
  if (typeof value === 'string') return parseByte(value, fallback);
  return clampByte(fallback);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function exportMeasurementCsv(): void {
  const rows = [['ID', 'Start', 'End', 'Delta PCNT', 'Time seconds', 'Target seconds', 'Error seconds']];
  for (const m of state.project.simulation?.measurements ?? []) {
    rows.push([m.id, edgeLabel(m.startEdge), edgeLabel(m.endEdge), String(m.deltaPcnt ?? ''), String(m.seconds ?? ''), String(m.targetSeconds ?? ''), String(m.errorSeconds ?? '')]);
  }
  download(`goa-measurements-${Date.now()}.csv`, rows.map((row) => row.map(csvCell).join(',')).join('\n'), 'text/csv');
}

function exportWaveformPng(root: HTMLElement): void {
  const canvas = root.querySelector<HTMLCanvasElement>('#waveCanvas');
  if (!canvas) return;
  const link = document.createElement('a');
  link.download = `goa-waveform-${Date.now()}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function exportHtmlReport(root: HTMLElement): void {
  const canvas = root.querySelector<HTMLCanvasElement>('#waveCanvas');
  const image = canvas?.toDataURL('image/png') ?? '';
  const timing = state.project.timing;
  const measurements = state.project.simulation?.measurements ?? [];
  const warnings = state.project.simulation?.warnings ?? [];
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>GOA Timing Report</title>
  <style>
    body { margin: 0; padding: 28px; background: #08111e; color: #dbe7f7; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    h1 { margin: 0 0 14px; font: 700 30px Georgia, serif; letter-spacing: -0.04em; }
    .card { border: 1px solid #29364a; background: #0d1726; padding: 16px; margin: 14px 0; }
    img { max-width: 100%; border: 1px solid #29364a; background: #060b13; }
    table { width: 100%; border-collapse: collapse; }
    td, th { border: 1px solid #29364a; padding: 8px; text-align: left; }
    th { background: #142238; }
    .muted { color: #8da1bb; }
  </style>
</head>
<body>
  <h1>GOA Timing Report</h1>
  <div class="card">
    <div>文件：${htmlText(state.project.parsed?.fileName ?? '-')}</div>
    <div>视图：${htmlText(viewLabel(state.viewMode))}</div>
    <div>时间基准：${timing ? `SoC=${timing.soc}, Htotal=${timing.panelHtotal}, pcnt/line=${timing.pcntPerLine}, Vtotal=${timing.vtotal}, FPS=${timing.frameRate}, 1pcnt=${(timing.pcntSeconds * 1e9).toFixed(3)}ns` : '-'}</div>
    <pre>${htmlText(JSON.stringify(levelShifterReportState(), null, 2))}</pre>
  </div>
  <div class="card"><img src="${image}" alt="waveform" /></div>
  <div class="card">
    <h2>Measurement</h2>
    <table><thead><tr><th>ID</th><th>Start</th><th>End</th><th>Delta</th><th>Target</th><th>当前-目标</th></tr></thead><tbody>
      ${measurements.map((m) => `<tr><td>${htmlText(m.id)}</td><td>${htmlText(edgeLabel(m.startEdge))}</td><td>${htmlText(edgeLabel(m.endEdge))}</td><td>${m.deltaPcnt ?? '-'} pcnt / ${htmlText(formatDuration(m.seconds))}</td><td>${htmlText(formatDuration(m.targetSeconds))}</td><td>${safeBreaks(formatTargetDelta(m))}</td></tr>`).join('')}
    </tbody></table>
  </div>
  <div class="card">
    <h2>Warnings</h2>
    ${warnings.length ? warnings.map((warning) => `<div>${htmlText(warning)}</div>`).join('') : '<div class="muted">无</div>'}
  </div>
</body>
</html>`;
  download(`goa-report-${Date.now()}.html`, html, 'text/html');
}

function levelShifterReportState(): unknown {
  const ls = state.project.levelShifter;
  if (ls.model === 'single-iml7272b') {
    return {
      model: ls.model,
      reg01: hexByte(ls.reg01),
      reg02: hexByte(ls.reg02),
      reg03: hexByte(ls.reg03),
      reg04: hexByte(ls.reg04),
      inputs: ls.inputs,
    };
  }
  if (isEkConfig(ls)) return { ...ls, outputCount: ek86707aSet1OutputCount(ls.set1) * (ls.model === 'dual-ek86707a' ? 2 : 1) };
  return ls;
}

function safeBreaks(value: string): string {
  return htmlText(value).replaceAll('&lt;br&gt;', '<br>');
}

function cellAddressOrder(cell: string): number {
  const match = cell.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  let col = 0;
  for (const ch of match[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  return Number(match[2]) * 100000 + col;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function xmlEncode(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function xmlDecode(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function download(name: string, content: string | Uint8Array, type: string): void {
  const part = typeof content === 'string' ? content : content.slice().buffer as ArrayBuffer;
  const blob = new Blob([part], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function htmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function htmlAttr(value: string): string {
  return htmlText(value).replaceAll('"', '&quot;');
}

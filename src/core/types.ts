import type * as XLSX from 'xlsx';

export type LogicLevel = 0 | 1;
export type RepeatMode = 0 | 1;
export type CombinType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type OcpSel = 'float' | '0' | '1';
export type SocProfile = 'mt9216' | 'mt9603' | 'unknown';
export type EntryEncoding = 'packed-fcnt' | 'split-fields';

export type CellRef = {
  sheet: string;
  address: string;
  row: number;
  col: number;
};

export type SheetRow = {
  sheet: string;
  row: number;
  group: string;
  name: string;
  value: string | number | null;
  valueCell: CellRef;
};

export type TimingBase = {
  soc: SocProfile;
  htotalRegister: number;
  panelHtotal: number;
  panelMinHtotal?: number;
  panelMinVtotal?: number;
  panelDclk?: number;
  pcntPerLine: number;
  pcntMax: number;
  htotal: number;
  vtotal: number;
  frameRate: number;
  pcntSeconds: number;
  lcntSeconds: number;
  frameSeconds: number;
  pcntFormula: string;
};

export type GpoEntry = {
  index: number;
  fcnt: number;
  lcnt: number;
  pcnt: number;
  enabled: boolean;
  level: LogicLevel;
  frameCount: number;
  cells: Partial<Record<'enable' | 'level' | 'fcnt' | 'lcnt' | 'pcnt', CellRef>>;
};

export type GpoConfig = {
  index: number;
  soc: SocProfile;
  entryEncoding: EntryEncoding;
  code: string;
  group: string;
  label: string;
  combinType: CombinType;
  combinSel: number;
  maskEnabled: boolean;
  regionVst: number;
  regionVend: number;
  regionPst: number;
  regionPend: number;
  regionOtherValue: LogicLevel;
  repeatCount: number;
  repeatMode: RepeatMode;
  lineRepeatStartpoint: number;
  perFrameInv: boolean;
  frameCntReset: boolean;
  entries: GpoEntry[];
  rows: SheetRow[];
  cells: Partial<Record<string, CellRef>>;
};

export type Segment = {
  start: number;
  end: number;
  level: LogicLevel;
  source?: string;
};

export type Edge = {
  id: string;
  signalId: string;
  signalName: string;
  at: number;
  edge: 'rising' | 'falling' | 'point';
  level: LogicLevel;
  source?: string;
  gpoIndex?: number;
  entryIndex?: number;
};

export type SignalTrace = {
  id: string;
  name: string;
  kind: 'raw' | 'source' | 'merge' | 'ck' | 'manual' | 'summary';
  segments: Segment[];
  edges: Edge[];
  color?: string;
  sourceGpo?: number;
  readonly?: boolean;
  note?: string;
  summary?: string;
};

export type SignalFamily = {
  id: 'stv' | 'cpv1' | 'cpv2' | 'driver_tp' | 'init_tp' | 'pol' | string;
  label: string;
  rawGpo?: number;
  sourceGpo?: number;
  mergeSignalId?: string;
  rawSignalId?: string;
  sourceSignalId?: string;
};

export type TerCpv2Inference = {
  role: 'CPV2' | 'TER' | 'ERROR' | 'UNKNOWN';
  severity: 'ok' | 'warn' | 'error';
  message: string;
};

export type LevelShifterModel = 'none' | 'single-ek86707a' | 'dual-ek86707a' | 'single-iml7272b';
export type SignalRef = string;
export type EkSet1Level = 'high' | 'float' | 'gnd';

export type NoLevelShifterConfig = {
  model: 'none';
};

export type Ek86707aInputs = {
  driverTp?: SignalRef;
  initTp?: SignalRef;
  stv?: SignalRef;
  cpv1?: SignalRef;
  cpv2?: SignalRef;
  ter?: SignalRef;
  rst?: SignalRef;
  pol?: SignalRef;
};

export type Ek86707aCommonConfig = {
  set1: EkSet1Level;
  set2: boolean;
  set3: boolean;
  dualSto: boolean;
  ocpEnabled: boolean;
  ocpSel: OcpSel;
  mode1: 'extra-high' | 'high' | 'normal';
  mode2: '0' | '1';
  outputCount: number;
  inputs: Ek86707aInputs;
};

export type Ek86707aConfig = Ek86707aCommonConfig & {
  model: 'single-ek86707a';
};

export type DualEk86707aConfig = Ek86707aCommonConfig & {
  model: 'dual-ek86707a';
};

export function ek86707aSet1OutputCount(set1: EkSet1Level): 4 | 6 | 8 {
  if (set1 === 'float') return 4;
  if (set1 === 'gnd') return 6;
  return 8;
}

export type Iml7272bConfig = {
  model: 'single-iml7272b';
  reg01: number;
  reg02: number;
  reg03: number;
  reg04: number;
  inputs: {
    stvIn1?: SignalRef;
    stvIn2?: SignalRef;
    clkIn1?: SignalRef;
    clkIn2?: SignalRef;
    lcIn?: SignalRef;
    terminate?: SignalRef;
  };
};

export type LevelShifterConfig = NoLevelShifterConfig | Ek86707aConfig | DualEk86707aConfig | Iml7272bConfig;

export type TpGeneratorConfig = {
  driverTpWidth: string;
  driverTpPeriod: string;
};

export type Measurement = {
  id: string;
  startEdgeId: string;
  endEdgeId: string;
  targetSeconds?: number;
  targetInput?: string;
  notes?: string;
};

export type MeasurementResult = Measurement & {
  startEdge?: Edge;
  endEdge?: Edge;
  deltaPcnt?: number;
  seconds?: number;
  errorSeconds?: number;
  errorPcnt?: number;
  errorLcnt?: number;
  errorRemainderPcnt?: number;
};

export type PatchItem = {
  sheet: string;
  cell: string;
  group: string;
  name: string;
  oldValue: string | number | null;
  newValue: string | number | null;
};

export type ParsedWorkbook = {
  workbook: XLSX.WorkBook;
  fileName: string;
  soc: SocProfile;
  timing: TimingBase;
  gpioRows: SheetRow[];
  gpos: GpoConfig[];
};

export type SimulationResult = {
  timing: TimingBase;
  signals: SignalTrace[];
  gpoSignals: SignalTrace[];
  families: SignalFamily[];
  inference: TerCpv2Inference;
  measurements: MeasurementResult[];
  warnings: string[];
};

export type DraftProject = {
  parsed?: ParsedWorkbook;
  timing?: TimingBase;
  gpos: GpoConfig[];
  levelShifter: LevelShifterConfig;
  tpGenerator?: TpGeneratorConfig;
  rstGpo?: number;
  manualEdges?: Edge[];
  measurements: Measurement[];
  patches: PatchItem[];
  dirty: boolean;
  simulation?: SimulationResult;
};

export const defaultTpGeneratorConfig = (): TpGeneratorConfig => ({
  driverTpWidth: '3',
  driverTpPeriod: '',
});

export const defaultNoLevelShifterConfig = (): NoLevelShifterConfig => ({
  model: 'none',
});

export const defaultLevelShifterConfig = (): Ek86707aConfig => ({
  model: 'single-ek86707a',
  set1: 'high',
  set2: false,
  set3: false,
  dualSto: false,
  ocpEnabled: false,
  ocpSel: 'float',
  mode1: 'extra-high',
  mode2: '0',
  outputCount: 8,
  inputs: {},
});

export const defaultDualEk86707aConfig = (): DualEk86707aConfig => ({
  ...defaultLevelShifterConfig(),
  model: 'dual-ek86707a',
  inputs: {},
});

export const defaultIml7272bConfig = (): Iml7272bConfig => ({
  model: 'single-iml7272b',
  reg01: 0x00,
  reg02: 0x44,
  reg03: 0x4b,
  reg04: 0x83,
  inputs: {},
});

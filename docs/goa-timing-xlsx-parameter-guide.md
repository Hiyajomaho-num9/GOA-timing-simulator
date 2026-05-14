# GOA Timing — XLSX 参数指南

本文覆盖 Simulator 会解析的 `Panel`、`GPIO`、Level Shifter 映射和 patch 字段。不涉及开机流程、U-Boot、PMIC 或画质参数。

## 总原则

- 一切以 XLSX 寄存器值为准，不用 panel PDF 的 V-total/H-total 反推。
- 波形统一换算成一维绝对 `pcnt`：`absolute = LCNT × pcntPerLine + PCNT`。
- Entry 是电平切换点，不是边沿触发。切换后保持到下一个 entry；周期边界不会自动归零。
- `raw` = 该 GPO 自身 entry + per-frame invert + mask 之后的结果。
- `out` = raw 经 combin 逻辑融合后的最终 SoC 输出。厂商命名里的 `xxx-merge` 通常是 combin 辅助 GPO，不等同最终输出。
- 建议导入 `.xlsx`。`.xls/.xlsm` 可尝试读取，但 patched 写回只支持原始 `.xlsx`。

## 时间基准

### MT9216

| 参数 | 含义 |
| --- | --- |
| `PanelHTotal` | 实际 `Htotal = PanelHTotal + 1`，即 `pcntPerLine`。 |
| `PanelVTotal` | 帧总行数，直接参与时间计算。 |
| `frameRate` | UI 输入，默认 60Hz。`1 frame = 1 / frameRate`。 |
| `1 pcnt` | `1 / (Htotal × Vtotal × frameRate)`，MT9216 典型值约 6.7ns。 |
| `PCNT max` | `pcntPerLine - 1`，entry PCNT 超限会报。 |

### MT9603 / MT9633

MT9603 一行 PCNT 按半行计数，和 MT9216 不同。

| 参数 | 含义 |
| --- | --- |
| `PanelHTotal` | 直接使用，不额外 +1。 |
| `pcntPerLine` | `floor(PanelHTotal / 2)`。 |
| `1 pcnt` | `1 / (pcntPerLine × Vtotal × frameRate)`。 |
| `PCNT max` | `min(floor(PanelMinHTotal/2 - 1), floor(PanelHTotal/2 - 9))`。缺 `PanelMinHTotal` 时用 `PanelHTotal` 兜底。 |
| `PanelDCLK` | 保留，不反推时间。以 XLSX H/V total + UI FPS 为准。 |

## XLSX Sheet 读取位置

| Sheet | 读取内容 | Value 列 |
| --- | --- | --- |
| `Panel` | `PanelHTotal`、`PanelVTotal`、`PanelMinHTotal`、`PanelMinVTotal`、`PanelDCLK` | D 列 |
| `GPIO` | GPO timing、combin、mask、entry | K 列 |
| `Main` / `Version` | SoC 自动识别：文件名或 sheet 含 `9603`/`9633`/`cmpi`/`tconless` 判为 MT9603，否则 MT9216 | — |

GPO group 支持 `GPO0`~`GPO9` 和 `GPOA`~`GPOF`。"GPOx_y Common setting" 行跳过，不仿真。

## GPO 公共参数

| 参数 | 值 | 行为 |
| --- | --- | --- |
| `Repeat_mode_SEL` | `0` / `1` | `0` = by-line（逐行重复），`1` = by-frame（整帧周期）。 |
| `Repeat_Count_num` | 整数 | 周期计数，实际周期 = `Repeat_Count_num + 1`。by-line 下是行数，by-frame 下是帧数。 |
| `Line_repeat_Startpoint` | 整数 | 已读入、可 patch，仿真暂不启用。 |
| `Frame_CNTreset` | `0` / `1` | 同上。 |
| `gpoX_per_frame_inv` | `0` / `1` | 每帧反相。entry 生成基波后、mask 前执行。 |

## Entry 参数

Entry 决定 GPO 在某个时刻切到 HIGH 或 LOW。每个 GPO 可以有多个 entry，按 index、时间、周期模式排序后生成方波。

### MT9216 packed FCNT

| Bit | 名称 | 含义 |
| --- | --- | --- |
| `15` | `Entry_EN` | `1` 启用。 |
| `14` | `Trigger_Value` | `1` = HIGH，`0` = LOW。 |
| `13..8` | — | 保留。 |
| `7..0` | `Frame_cnt` | by-frame 下该 entry 在 repeat 周期内第几帧生效（0~255）。 |

by-frame 下的触发位置：

```
entry_abs = Frame_cnt × frameTotal + LCNT × pcntPerLine + PCNT
frameTotal = Vtotal × pcntPerLine
periodFrames = Repeat_Count_num + 1
```

- `Frame_cnt` 控制第几帧，`LCNT` 控制该帧第几行，`PCNT` 控制行内第几个 pcnt。
- 微调几 μs/ns：改 `PCNT` 或 `LCNT`。
- 改 POL/LC 多帧信号的帧相位：改 `Frame_cnt`。+1 晚 1 frame（60Hz 下约 16.7ms），-1 早 1 frame。

**跨帧信号注意**：`Frame_cnt` 调的是单个 entry 的触发帧，不是整条波形平移。LOW entry 和 HIGH entry 都 +1 frame 时，frame 0 到第一个 entry 之间会继承上一周期末尾电平，可能出现 wrap-around 高电平。改完必须检查周期首尾衔接。

by-line 下 `Frame_cnt` 低 8 位仍能从 FCNT 解出，但波形由 `LCNT/PCNT` + line repeat 规则决定，不要拿它当每行脉冲的主调参量。

| 参数 | 含义 |
| --- | --- |
| `entryN_cmd0_FCNT` | packed entry 控制字。例：`0x8000` = 启用拉 LOW，`0xC078` = 启用且在 frame 120 拉 HIGH。 |
| `entryN_cmd1_LCNT` | 行偏移。by-frame 是帧内行位置；MT9216 by-line 下不改。 |
| `entryN_cmd2_PCNT` | 行内 PCNT 偏移，必须小于 PCNT max。 |

### MT9603 split fields

MT9603 把 enable、电平、frame count 拆成独立字段。

| 参数 | 含义 |
| --- | --- |
| `entryN_enable` | `1` 启用。 |
| `entryN_Trigger_Value` | `1` = HIGH，`0` = LOW。 |
| `entryN_cmd0_*` | `Frame_cnt`。 |
| `entryN_cmd1_*` | `LCNT`。PCNT/line 逻辑和 MT9216 不同，别套用。 |
| `entryN_cmd2_*` | `PCNT`，必须满足 MT9603 的 PCNT max。 |

## by-line 与 by-frame

| 模式 | 行为 | 适用场景 |
| --- | --- | --- |
| by-line (`Repeat_mode_SEL=0`) | 每行按 `line % (Repeat_Count_num+1)` 选 entry 的 LCNT，行尾电平 carry 到下行首。 | CPV/CK 行循环脉冲。 |
| by-frame (`Repeat_mode_SEL=1`) | Entry 定位用 `Frame_cnt × frameTotal + LCNT × pcntPerLine + PCNT`，周期 = `Repeat_Count_num+1` 帧。 | POL、LC、TER 帧周期信号。 |

## Mask

Mask 这里最容易误判。当前按示波器确认后的规则理解：`Region_VST/VEND` 和 `Region_pst/pend` 合成的是**每帧一个绝对 gate 窗口**，不是“每一行都检查一次 H 区间”的矩形 mask。

`Mask_region_EN=1` 时：

```text
gate_start = L(Region_VST).P(Region_pst)
gate_end   = L(Region_VEND).P(Region_pend)
```

- gate 内：entry 生成的原波形透传。
- gate 外：强制 `Region_other_Value`。
- `Region_pst` 是 gate 起点边沿的 PCNT 偏移。
- `Region_pend` 是 gate 终点边沿的 PCNT 偏移。
- 它们不是每一行的 H-mask 起点/终点。

所以 `Region_VST=24, Region_VEND=1108, Region_pst=0, Region_pend=500` 的意思是：每帧从 `L24.P0` 开始放行，到 `L1108.P500` 结束放行。不是“行 24~1108 内每一行只放行 P0~P500”。

当前工具里如果 `gate_end <= gate_start`，这个 mask 没有有效窗口，输出会被 `Region_other_Value` 覆盖，并给 warning。不要把 `VST>=VEND` 或 `pst>=pend` 当成自动禁用某个方向；除非后续有示波器证据证明某颗 SoC/某个模式存在这种特殊旁路。

| 参数 | 含义 |
| --- | --- |
| `Mask_region_EN` | `1` 启用 mask gate。 |
| `Region_VST` | gate 起点行。 |
| `Region_pst` | gate 起点 PCNT 偏移。 |
| `Region_VEND` | gate 终点行。 |
| `Region_pend` | gate 终点 PCNT 偏移。 |
| `Region_other_Value` | gate 外强制电平，常见 `0`（拉 LOW）。 |

**实例**：

```
GPO6: VST=24, VEND=1108, pst=0, pend=500
→ L24.P0 到 L1108.P500 之间透传；窗口外强制 LOW

GPO7: VST=22, VEND=1104, pst=2000, pend=2000
→ L22.P2000 到 L1104.P2000 之间透传；不是禁用 H 方向

GPO3 (ST425): VST=24, VEND=20, pst=0, pend=930
→ gate_end <= gate_start，无有效 gate；当前工具会输出 Region_other_Value 并报警
```

## Combin / Logic

Combin 把当前 GPO 和另一个 GPO 做逻辑融合。CPV1、CPV2、Driver_TP、Init_TP 常用 "raw GPO + xxx-merge + out" 结构。

| 参数 | 含义 |
| --- | --- |
| `Combin_Type_SEL` | MT9216 combin 类型。 |
| `Logic_function` | MT9603 或兼容别名，等同 `Combin_Type_SEL`。 |
| `GPO_Combin_SEL` | 参与 combin 的另一个 GPO index。 |

Combin type 编码：

| Type | 输出 |
| --- | --- |
| `0` | 本 GPO 直通，不合并 |
| `1` | `own AND other` |
| `2` | `own OR other` |
| `3` | `own XOR other`（CPV merge 常见） |
| `4` | `NOT own` |
| `5` | 强制 HIGH |
| `6` | 强制 LOW |
| `7` | `other` 优先，否则 `own` |

注意：`GPO7_CPV1-merge` 只是 CPV1 的辅助波形，最终给 Level Shifter 的信号看 CPV1 的 `out`。

## 信号识别

| 信号 | 识别可靠度 | 备注 |
| --- | --- | --- |
| `STV` | 高 | 命名通常明确。 |
| `CPV1` | 高 | 有 CPV1-merge 时看 combin_sel 后的 out。 |
| `CPV2` | 中 | 可能复用为 TER，需结合 LS 模式和 repeat mode。 |
| `Driver_TP` | 中 | MT9216 由 GPO 控制；MT9603 由 data_cmd 生成，不从 GPO 识别。 |
| `Init_TP` | 中 | "for tcon" 通常是 raw，"merge" 是 combine 后引脚。 |
| `POL` | 中 | 多帧周期，常 packed FCNT。 |
| `LC` | 中 | 正脉宽 >100 frame 的信号，全帧视图看周期和占空比更直观。 |
| `RST` | 低 | 命名不稳定，让用户手动选。 |
| `TER` | 低~中 | 一进多出时可能由 CPV2 复用，UI 显式确认。 |

## CPV2 / TER 判定（EK86707A）

| 条件 | 判定 |
| --- | --- |
| `CPV2 Repeat_mode=0 && OCP_SEL=1` | CPV2 / CKI2（二进多出） |
| `CPV2 Repeat_mode=1 && OCP_SEL!=1` | TER（帧刷新脚） |
| `CPV2 Repeat_mode=1 && OCP_SEL=1` | 冲突，报错 |
| `CPV2 Repeat_mode=0 && OCP_SEL!=1` | 未知，提示确认 |

iML7272B 输入由用户手动映射。

## Level Shifter

### 单 EK86707A

| 参数 | 含义 |
| --- | --- |
| `SET1` | 输出路数：`high`=8CK，`float`=4CK，`gnd`=6CK。 |
| `SET2` / `SET3` | 模式配置，后续扩展。 |
| `DUALSTO` | STO 模式，保存但不参与 CK 生成。 |
| `OCP_EN` | OCP 使能，保存但不模拟保护行为。 |
| `OCP_SEL` | `1` 时进入 CPV1/CPV2 二进多出判定。 |
| `MODE1` | 默认 `extra-high`，预览按已确认逻辑生成。 |
| `MODE2` | 保存，后续扩展。 |
| 输入映射 | `Driver_TP`、`Init_TP`、`STV`、`CPV1`、`CPV2`、`TER`、`RST`、`POL`。EK86707A 无 STV2。 |

### 双 EK86707A

两颗共用同一套 SET/OCP/MODE 配置。CPV1 驱动奇数 CK，CPV2 驱动偶数 CK，TER 同时清两颗输出。

### 单 iML7272B / iML7272BK

| 参数 | 含义 |
| --- | --- |
| `Reg01h~Reg04h` | 独立 LS 配置，保存在 project/report JSON，不写入 patched XLSX。 |
| `STV_IN1/IN2` | 直通输入脉冲。 |
| `CLK_IN1/IN2` | 1-line 下 CK 正脉宽 = CLK_IN1 rise → CLK_IN2 rise，CK 间隔看 CLK_IN1 周期。 |
| `LC_IN` | 按 REG01H LC power 位映射输出。 |
| `Terminate` | 上升沿清输出，不清 phase counter。 |
| 保护/Slew/DIS_SENSE | 可配可存，不影响波形。 |

## MT9603 Driver_TP

MT9603 的 Driver_TP 不由 GPO timing 控制，而是 data_cmd 侧生成。工具不提示"Driver_TP 未映射"，也不对它做 GPO mask。

| UI 参数 | 含义 |
| --- | --- |
| `Driver_TP width` | 正脉宽，支持 ns/us/ms/s，默认 3μs。 |
| `Driver_TP period` | 周期，默认 1 line。 |
| 起点 | 固定 `L0.P2`。 |

## Patch / 导出

| 操作 | 行为 |
| --- | --- |
| Patch suggestion | 拖拽 edge 或改参数生成建议，不直接覆盖原 XLSX。 |
| 导出 JSON patch | cell 级修改清单，适合人工 review。 |
| 导出 patched XLSX | 仅在原 `.xlsx` 的 zip/xml 内替换指定 cell，不重建整个 workbook。 |
| `.xls` / `.xlsm` | 不支持直接写，先转 `.xlsx` 或用 JSON patch。 |
| LS JSON | 保存 Level Shifter 配置，iML7272B Reg01h~04h 不写入 patched XLSX。 |

## 调参顺序

1. **先对齐 TP 和 CK1**：面板行扫描过来后 TP 必须按特性间隔打开子像素锁，否则画面直接异常。
2. **移相位不改 entry 结构**：只调 PCNT/LCNT 或通过 patch suggestion 精改已有 cell，别删 entry。
3. **CPV1/CPV2 异常**：先查 Combin_Type_SEL / Logic_function 是否启用 → GPO_Combin_SEL 是否指向辅助 GPO → mask gate 是否裁掉了有效区。
4. **Mask 异常**：用 `L(VST).P(pst)` 到 `L(VEND).P(pend)` 画出每帧绝对窗口，别按每行 H-mask 理解。
5. **POL/LC**：长周期信号看全帧视图，关注周期、正脉宽和与 STV 的间距。
6. **Measurement**：输入 target，工具显示"当前比目标差多少 us/ns、等价多少 pcnt/lcnt"，方便回写寄存器。

## 快速查错

| 现象 | 查什么 |
| --- | --- |
| CPV1/CPV2 out 为空 | entry 是否启用、mask gate 范围、combin source 是否存在、CPV2/TER 模式是否冲突。 |
| TP entry2/entry3 被吞 | 先画 `L(VST).P(pst)` 到 `L(VEND).P(pend)` 的绝对 gate；entry 不在 gate 内会被 `Region_other_Value` 强制拉低。不要只看 entry 的 PCNT 是否落在 `pst~pend`。 |
| 全帧视图卡 | 少开 TP/CPV raw/source，优先看 STV/POL/LC/LS CK。 |
| patched XLSX 导入 MsPanel 异常 | 确认是 cell 级 patch，不是第三方库重生成的 workbook。 |
| MT9603 TP 对不上 GPO | Driver_TP 不是 GPO 控制，去 LS 页调 synthetic TP width/period。 |

## 附录 A：GPIO 字段解析表

| 字段模式 | 写入位置 | 说明 |
| --- | --- | --- |
| `Combin_Type_SEL` | `gpo.combinType` | MT9216 combin 类型。 |
| `Logic_function` | `gpo.combinType` | 兼容别名。 |
| `GPO_Combin_SEL` | `gpo.combinSel` | combin source GPO index。 |
| `Mask_region_EN` | `gpo.maskEnabled` | |
| `Region_VST` | `gpo.regionVst` | |
| `Region_pst` | `gpo.regionPst` | |
| `Region_VEND` | `gpo.regionVend` | |
| `Region_pend` | `gpo.regionPend` | |
| `Region_other_Value` | `gpo.regionOtherValue` | |
| `Repeat_Count_num` | `gpo.repeatCount` | 仿真按 +1 周期处理。 |
| `Repeat_mode_SEL` | `gpo.repeatMode` | |
| `Line_repeat_Startpoint` | `gpo.lineRepeatStartpoint` | 已读入可 patch，仿真暂不启用。 |
| `gpoX_per_frame_inv` | `gpo.perFrameInv` | entry 后、mask 前执行。 |
| `Frame_CNTreset` | `gpo.frameCntReset` | 同上暂不启用。 |
| `entryN_enable` | `entry.enabled` | MT9603 用。MT9216 packed FCNT 下不以它为准。 |
| `entryN_Trigger_Value` | `entry.level` | MT9603 用。MT9216 看 FCNT bit14。 |
| `entryN_cmd0_*` | `entry.fcnt` / `entry.frameCount` | |
| `entryN_cmd1_*` | `entry.lcnt` | |
| `entryN_cmd2_*` | `entry.pcnt` | |

## 附录 B：Panel 字段

| 字段 | 用途 |
| --- | --- |
| `PanelHTotal` | MT9216 用 +1 后作 Htotal；MT9603 用于半行 PCNT。 |
| `PanelVTotal` | 每帧总行数。 |
| `PanelMinHTotal` | MT9603 限制 PCNT max。 |
| `PanelMinVTotal` | 保留，不参与波形生成。 |
| `PanelDCLK` | 保留，不反推时间。 |
| `PanelMaxHTotal/MaxVTotal/MaxDCLK` | 不参与 GOA timing。 |
| `Hsync/Vsync start/end`、`HFDE/VFDE`、`Hde/Vde dummy` | display timing / DE 区域，不驱动 GPO 方波。 |
| `OutTimingMode`、`PanelLinkType`、`Dual Port` | 输出链路配置，不参与 GPO timing。 |
| `Fmodulation`、`SSC`、`LPLL_SET` | 时钟/调制，不参与 GOA waveform。 |

## 附录 C：不参与仿真的 GPIO 字段

这些字段在 XLSX 中存在，但当前版本不接入波形计算。

| 字段族 | 猜测用途 | 状态 |
| --- | --- | --- |
| `GPOx_PS`、`ps_*` | power sequence / pin state | 不做 |
| `PAD_TCONx -> GPOx` | pad 绑定 | 仅供人工参考 |
| `PAD_LOCK` | pad lock | 不做 |
| `gpo_bitmap`、`gpo_ch_cken_bitmap` | 通道 bitmap / clock enable | 不做 |
| `gpo_bypass_en` | 旁路控制 | 不做 |
| `gpo_oen` | output enable | 不做，默认有效 |
| `gpo_no_signal*` | no-signal 自动门控 | 不做 |
| `gpo_reference_sync_sel` | 同步源选择 | 不做 |
| `gpo_repeat_fcnt_clr*` | repeat frame counter 清除 | 不做 |
| `gpo_sw_para_update*` | 软件参数更新触发 | 不做 |
| `gpo_status*`、`gpo_cnt_read_*` | 状态/计数读取 | 不做 |
| `gpo_vdb_en*` | VDB 使能 | 不做 |
| `gpo_sec_toggle*` | second toggle | 不做 |
| `zone_*` | zone timing / 分区延迟 | 不做（后续 MT9603 候选） |
| 厂商专有字段（如 BOE 28S_4Frame_POL_Period） | 项目定制 | 不做 |

## 附录 D：调参优先改什么

| 目标 | 优先改 | 别先动 |
| --- | --- | --- |
| 平移脉冲 | `entryN_cmd2_PCNT`，必要时看 `entryN_cmd1_LCNT` | 别删 entry 或改 entry 数量 |
| 改 POL/LC 帧周期 | `entryN_cmd0_FCNT` 的 frame count、`Repeat_Count_num` | 别用 panel PDF Vtotal 硬换算 |
| 修 CPV merge | `Combin_Type_SEL`、`GPO_Combin_SEL`、参与 GPO 的 entry | 别按 GPO 名字猜 source |
| 修 TP 被遮 | `Mask_region_EN`、`VST/VEND`、`pst/pend`、`Region_other_Value` | 先确认 entry 绝对位置是否落在 gate 内 |
| MT9603 Driver_TP | LS 页 synthetic `Driver_TP width/period` | 别在 GPO 表里找不存在的映射 |
| EK86707A 输出路数 | `SET1`：`high/float/gnd` | 别只改 UI outputCount |

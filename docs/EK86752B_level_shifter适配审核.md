# EK86752B Level Shifter 适配审核草案

本文基于 `EK86752B-1.0-DEC-2025.pdf` 的文字表格和时序图重新整理，目标是先确认适配逻辑，再进入代码实现。

## 结论先行

EK86752B 不能按 EK86707A 的 strap 脚逻辑套用。它更接近 iML7272B 的“寄存器配置 + 输入映射 + 模式表驱动”方案，但 CK 输出规则更复杂。

第一版建议新增 `单 EK86752B` Level Shifter 方案：

| 模块 | 处理方式 |
|---|---|
| 配置 UI | 人话参数和原始 Reg hex 同步显示。 |
| 输入映射 | 自动识别候选 GPO，允许人工覆盖。 |
| CK 模拟 | 按 PDF 图谱建立 2-input / 4-input / phase / double / reverse / 120Hz 模式表。 |
| STV/RESET/LC | 按输入直接 level shift，LC 按 `HSR` 规则处理。 |
| Terminate | 只在 2CPV 模式有效，按 `TERM_MODE` 处理。 |
| OCP/Slew/UVLO/MTP | 第一版保存配置并提示，不影响波形。 |
| patched XLSX | 不写 EK86752B 寄存器到 XLSX，LS 配置独立保存到 LS JSON / project report。 |

## 规格书理解

### 芯片定位

EK86752B 是 19 通道 GOA level shifter，输出包括：

| 输出 | 数量 | 说明 |
|---|---:|---|
| `CLKOUT1~CLKOUT12` | 12 | GOA CK 输出。 |
| `STVOUT1~STVOUT2` | 2 | STV level shift 输出。 |
| `RESETOUT` | 1 | RESET level shift 输出。 |
| `LCOUT1~LCOUT2` | 2 | LC 输出。 |
| `DISCH1~DISCH2` | 2 | 放电输出。 |

低压侧输入主要来自 TCON / SoC GPO，高压侧输出给 Panel GOA。

### 输入管脚

| Pin | 名称 | 适配含义 |
|---:|---|---|
| 1 | `STV1` | `STVOUT1` 输入。 |
| 2 | `STV2` | `STVOUT2` 输入，也可参与 4CPV 分组控制。 |
| 3 | `LCIN1` | LC 输入 1。 |
| 4 | `LCIN2/CPV3` | 复用脚：2-input LC 双输入时为 `LCIN2`，4-input CK 模式时为 `CPV3`。 |
| 5 | `Terminate/CPV4` | 复用脚：2-input CK 模式时为 `Terminate`，4-input CK 模式时为 `CPV4`。 |
| 6 | `RESET` | `RESETOUT` 输入。 |
| 39 | `CPV1` | CK 拉高触发输入，或 4-input odd group 拉高输入。 |
| 40 | `CPV2` | CK 拉低触发输入，或 4-input odd group 拉低输入。 |
| 34 | `XAO` | sense 输入，第一版只保存阈值，不参与波形。 |
| 36/37 | `SDA/SCL` | I2C 配置，不从 XLSX 直接推波形。 |

## 核心寄存器

第一版 UI 要把这些寄存器按人话参数显示，同时保留原始 hex。

| Reg | Bit | 字段 | 波形影响 |
|---|---|---|---|
| `0x03` | `bit0` | `CPV12_F2X` | 影响 CPV1/CPV2 使用单边沿还是双边沿推进 CK。 |
| `0x04` | `bit7` | `EN_120HZ` | 与 `DOUBLE=1` 联动，改变 CK 成对关系。 |
| `0x04` | `bit5` | `DUMMY_CLK` | 插入 dummy CK，第一版建议只提示，暂不强行模拟。 |
| `0x04` | `bit3` | `REVERSE` | CK 输出顺序反向。 |
| `0x04` | `bit2` | `DOUBLE` | CK 成对输出。 |
| `0x06` | `bit7` | `CLK_FALL_EDGE` | CPV2/CPV4 用 rising 还是 falling 触发 CK 下降沿。 |
| `0x06` | `bit2` | `RESETO_RESET` | `RESETOUT` 是否把所有 CK 清到 VGL2。 |
| `0x06` | `bit1` | `STV2_RESET` | `STVOUT2` 是否把所有 CK 清到 VGL2。 |
| `0x06` | `bit0` | `CPVX_SEL` | 选择 2-input 还是 4-input CK 控制。 |
| `0x07` | `bit7` | `TERM_MODE` | 2CPV 模式下 Terminate 是否直接拉低 CK。 |
| `0x07` | `bit6` | `STV12_CLK_CTRL` | 4CPV 模式下 STV1/STV2 分别控制奇偶 CK group。 |
| `0x08` | `bit7` | `LS_EN` | 关闭时输出禁用。 |
| `0x08` | `bit6..4` | `HSR` | 决定 2-input/4-input 以及 LC 输入模式。 |
| `0x09` | `bit7..0` | `STV/DISCH/RESETO_DIS` | 禁用态输出 VGH/VGL2/HiZ。 |
| `0x0A` | `bit7..4` | `CLK_DIS/LC_DIS` | 禁用态输出 VGH/VGL2/HiZ。 |
| `0x0A` | `bit3..1` | `LC_INI_STATE` | 上电初态，第一版只保存。 |
| `0x0B` | `bit6` | `STV1_RESET` | `STV1 rising` 是否清所有 CK。 |
| `0x0B` | `bit5..3` | `CH_MODE` | 4/6/8/10/12 phase 输出选择。 |

OCP、Slew、UVLO、A0、MTP 相关寄存器需要 UI 保存，但第一版不用于波形模拟。

## CK 输出逻辑

### 2-input 模式

判定条件：

```text
CPVX_SEL = 0
并且 HSR = 000 或 001
```

输入含义：

```text
CPV1      -> CK 拉高触发源
CPV2      -> CK 拉低触发源
Terminate -> 清输出 / 阻断本轮 CK
```

基础相位推进：

```text
STV1 rising 后进入一轮 CK phase

CPV1 edge[0]  -> CLKOUT1 high
CPV2 edge[0]  -> CLKOUT1 low
CPV1 edge[1]  -> CLKOUT2 high
CPV2 edge[1]  -> CLKOUT2 low
CPV1 edge[2]  -> CLKOUT3 high
CPV2 edge[2]  -> CLKOUT3 low
...
```

ASCII 示意：

```text
2-input / normal / forward

CPV1 edge :  ↑      ↑      ↑      ↑
CPV2 edge :     ↓      ↓      ↓      ↓
             |---|  |---|  |---|  |---|
CLKOUT1   ___████________________________
CLKOUT2   _______████____________________
CLKOUT3   ____________████_______________
CLKOUT4   _________________████__________
```

`CPV12_F2X=0` 时，CPV1 只取 rising 推进 high，CPV2 的 low event 由 `0x06[7] CLK_FALL_EDGE` 决定：`0` 取 CPV2 falling，`1` 取 CPV2 rising。

`CPV12_F2X=1` 时，CPV1 的 rising/falling 都可作为 high phase；CPV2 的 rising/falling 都可作为 low phase，依次推进 CLKOUT1~12。

### 4-input 模式

判定条件：

```text
CPVX_SEL = 1
或 HSR = 010..111
```

输入含义：

```text
CPV1 -> CLKOUT1/3/5/7/9/11 high
CPV2 -> CLKOUT1/3/5/7/9/11 low
CPV3 -> CLKOUT2/4/6/8/10/12 high
CPV4 -> CLKOUT2/4/6/8/10/12 low
```

ASCII 示意：

```text
4-input / normal / forward

Odd group:
CPV1 edge -> CK1 high -> CK3 high -> CK5 high ...
CPV2 edge -> CK1 low  -> CK3 low  -> CK5 low  ...

Even group:
CPV3 edge -> CK2 high -> CK4 high -> CK6 high ...
CPV4 edge -> CK2 low  -> CK4 low  -> CK6 low  ...

CLKOUT1   ___████________________________
CLKOUT2   _____████______________________
CLKOUT3   _______████____________________
CLKOUT4   _________████__________________
```

`STV12_CLK_CTRL=1` 时，4CPV 模式进一步拆成：

```text
STV1 + CPV1/CPV2 -> 控制 CLKOUT1/3/5/7/9/11
STV2 + CPV3/CPV4 -> 控制 CLKOUT2/4/6/8/10/12
```

如果没有映射 `STV2`，但开启了 `STV12_CLK_CTRL=1`，偶数 CK 应该提示缺输入并保持低。

### CH_MODE phase 数

| `CH_MODE` | 输出 phase |
|---|---:|
| `000` | 4 phase |
| `001` | 6 phase |
| `010` | 8 phase |
| `011` | 10 phase |
| `100` | 12 phase |
| `101` | 12 phase |
| `110` | 12 phase |
| `111` | 12 phase |

注意：`phase` 是参与时序的输出通道数，不等同于 UI 必须只显示这些通道。主时序可以显示 active CK，调试视图可以允许用户额外加入任意 `CLKOUTx`。

## DOUBLE / EN_120HZ / REVERSE

### DOUBLE

`DOUBLE=1` 时，一个逻辑 phase 会同时映射到两个物理 CK。

普通 double：

| phase | 输出 pair |
|---:|---|
| 1 | `CLK1 = CLK2` |
| 2 | `CLK3 = CLK4` |
| 3 | `CLK5 = CLK6` |
| 4 | `CLK7 = CLK8` |
| 5 | `CLK9 = CLK10` |
| 6 | `CLK11 = CLK12` |

ASCII：

```text
DOUBLE=1

logic phase1 -> CLK1 + CLK2
logic phase2 -> CLK3 + CLK4
logic phase3 -> CLK5 + CLK6

CLKOUT1   ___████________________
CLKOUT2   ___████________________
CLKOUT3   _______████____________
CLKOUT4   _______████____________
```

### EN_120HZ

`EN_120HZ=1` 必须和 `DOUBLE=1` 一起看，输出配对不是普通 `1=2, 3=4`，而是跨位配对。

| phase | 支持情况 | 输出 pair |
|---:|---|---|
| 4 phase | 支持 | `CLK1=CLK3`, `CLK2=CLK4` |
| 6 phase | PDF 标注 NOT SUPPORT | 第一版直接报警。 |
| 8 phase | 支持 | `CLK1=CLK3`, `CLK2=CLK4`, `CLK5=CLK7`, `CLK6=CLK8` |
| 10 phase | PDF 标注 NOT SUPPORT | 第一版直接报警。 |
| 12 phase | 支持 | `CLK1=CLK3`, `CLK2=CLK4`, `CLK5=CLK7`, `CLK6=CLK8`, `CLK9=CLK11`, `CLK10=CLK12` |

ASCII：

```text
EN_120HZ=1 + DOUBLE=1 + 8 phase

logic phase1 -> CLK1 + CLK3
logic phase2 -> CLK2 + CLK4
logic phase3 -> CLK5 + CLK7
logic phase4 -> CLK6 + CLK8
```

### REVERSE

`REVERSE=1` 时，phase 顺序反向。

实现上不要改输入边沿，只改输出序列：

```text
forward 4 phase : [CLK1, CLK2, CLK3, CLK4]
reverse 4 phase : [CLK4, CLK3, CLK2, CLK1]
```

如果 `DOUBLE=1` 或 `EN_120HZ=1`，先得到逻辑 pair 表，再反向 pair 顺序。

## Terminate 理解

Terminate 只在 2CPV 模式有效，也就是 pin5 不是 `CPV4` 时有效。

规格书给出的语义：

```text
Terminate rising 会让 CLKOUT1~12 拉低，并且下一次 STV1 之前，CPV1 不能再继续触发 CK toggle。
如果 Terminate 没被触发，下一次 STV1 rising 也可以 terminate 本轮 CK。
```

`TERM_MODE`：

| `TERM_MODE` | 行为 |
|---|---|
| `0` | Terminate rising 直接把 CK 拉到 VGL2。 |
| `1` | Terminate rising 不直接拉低 CK。 |

我对 `TERM_MODE=1` 的第一版处理建议：

```text
TERM_MODE=0: clear CK + inhibit until next STV1
TERM_MODE=1: 不强制 clear CK，但仍然标记 inhibit until next STV1，并在 UI 提示该点需要示波器确认
```

原因：文字描述强调 Terminate 会阻断后续 CPV1，表格只说 `TERM_MODE=1` 不拉低 CK，没有明确说是否取消 inhibit。这里不能偷猜。

## LC 输出逻辑

`HSR` 决定 LC 输入方式：

| `HSR` | 模式 | LC 逻辑 |
|---|---|---|
| `000` | 2-input CK + LC 1-input 2-output | `LCOUT1` 跟随 `LCIN1`，`LCOUT2` 为 `LCIN1` 反相。 |
| `001` | 2-input CK + LC 2-input 2-output | `LCOUT1` 跟随 `LCIN1`，`LCOUT2` 跟随 `LCIN2`。 |
| `010..111` | 4-input CK + LC 1-input 2-output | `LCOUT1` 跟随 `LCIN1`，`LCOUT2` 为 `LCIN1` 反相；pin4 改作 `CPV3`。 |

这里要注意 pin4：

```text
HSR=001    -> pin4 是 LCIN2
HSR=010..111 -> pin4 是 CPV3，不再是 LCIN2
```

## UI 适配手段

### Level Shifter 选择

新增方案：

```text
无 LS
单 EK86707A
双 EK86707A
单 iML7272B
单 EK86752B
```

后续如果有双 EK86752B，再单独协商，不提前硬写。

### EK86752B 参数页

参考 iML7272B 的风格，但字段更多。建议分区：

| 区域 | 内容 |
|---|---|
| 基本寄存器 | `Reg03h/04h/06h/07h/08h/09h/0Ah/0Bh` hex 输入。 |
| 人话 CK 参数 | 2/4 input、phase、double、120Hz、reverse、fall edge、dummy。 |
| 输入映射 | `STV1/STV2/RESET/CPV1/CPV2/CPV3/CPV4/Terminate/LCIN1/LCIN2`。 |
| LC 参数 | HSR、LC 输入模式、LC disable、LC initial state。 |
| 保护/电气参数 | OCP、Slew、UVLO、A0、XAO，保存但不影响波形。 |
| 风险提示 | 不支持组合、缺映射、复用脚冲突。 |

### 输入映射自动识别

自动识别只做候选，不做强制猜测。

建议匹配规则：

| LS 输入 | 自动候选关键词 |
|---|---|
| `STV1` | `STV`, `STV1` |
| `STV2` | `STV2` |
| `RESET` | `RST`, `RESET`, `RESETO` |
| `CPV1` | `CPV1`, `CKI1` |
| `CPV2` | `CPV2`, `CKI2`, `TER` 候选需降权 |
| `CPV3` | `CPV3`, `CKI3` |
| `CPV4` | `CPV4`, `CKI4`, `TERMINATE` 候选需按模式判断 |
| `Terminate` | `TER`, `TERM`, `TERMINATE` |
| `LCIN1` | `LC`, `LCIN1` |
| `LCIN2` | `LCIN2` |

复用脚要按模式过滤：

```text
2-input 模式：显示 LCIN2/Terminate 映射，不显示 CPV3/CPV4 必填
4-input 模式：显示 CPV3/CPV4 映射，不显示 Terminate 必填
```

## 波形模拟实现方案

### 第一层：输入波形

所有输入先从 SoC GPO 的 `out` 波形拿：

```text
STV1_IN
STV2_IN
RESET_IN
CPV1_IN
CPV2_IN
CPV3_IN
CPV4_IN
TERM_IN
LCIN1_IN
LCIN2_IN
```

如果输入缺失，不生成假波形，只提示：

```text
EK86752B: CPV3 未映射，4-input even group 输出保持 LOW。
```

### 第二层：边沿事件

把输入波形转换成 edge list：

```text
rising(signal)
falling(signal)
both(signal)
```

`CLK_FALL_EDGE` 决定 low event：

```text
2CPV + CPV12_F2X=0 + CLK_FALL_EDGE=0 -> CPV2 falling 触发 CK low
2CPV + CPV12_F2X=0 + CLK_FALL_EDGE=1 -> CPV2 rising 触发 CK low
2CPV + CPV12_F2X=1 -> CPV2 rising/falling 都触发 CK low
4CPV -> CPV2/CPV4 falling/rising 按 CLK_FALL_EDGE 触发 CK low
```

`CPV12_F2X` 决定 high event：

```text
CPV12_F2X=0 -> CPV1 rising 触发 high phase
CPV12_F2X=1 -> CPV1 rising/falling 都触发 high phase
```

### 第三层：输出序列表

生成输出 group：

```text
phaseCount = decode(CH_MODE)
baseSequence = [CLK1..CLK{phaseCount}]
if REVERSE=1: reverse(baseSequence)
if DOUBLE=1: applyPairing(baseSequence)
if EN_120HZ=1: apply120HzPairing(baseSequence)
```

注意顺序建议：

```text
先按 phaseCount 取 active CK
再按 DOUBLE / EN_120HZ 生成 pair
最后按 REVERSE 反转逻辑 phase 顺序
```

这个顺序需要你审核。如果示波器表现是先 reverse physical CK 再 pair，需要调整。

### 第四层：状态机

2-input normal 状态机：

```text
on STV1 rising:
  phaseIndex = 0
  inhibited = false
  如果 STV1_RESET=1: all CK = LOW

on CPV1 highEvent:
  if inhibited: ignore
  targets = sequence[phaseIndex]
  set targets HIGH

on CPV2 lowEvent:
  targets = sequence[phaseIndex]
  set targets LOW
  phaseIndex++

on Terminate rising:
  if TERM_MODE=0: all CK = LOW
  inhibited = true
```

4-input normal 状态机：

```text
oddIndex = 0
evenIndex = 0

on STV1 rising:
  oddIndex = 0
  if STV1_RESET=1: all CK = LOW

on STV2 rising:
  evenIndex = 0
  if STV2_RESET=1: all CK = LOW

on CPV1 highEvent: set oddSequence[oddIndex] HIGH
on CPV2 lowEvent : set oddSequence[oddIndex] LOW, oddIndex++

on CPV3 highEvent: set evenSequence[evenIndex] HIGH
on CPV4 lowEvent : set evenSequence[evenIndex] LOW, evenIndex++
```

如果 `STV12_CLK_CTRL=0`，4CPV 模式按全局 STV1 起始；如果为 1，则奇偶 group 分别看 STV1/STV2。

## 预设视图建议

沿用当前主时间轴 + preset 快捷视图。

| Preset | EK86752B 显示建议 |
|---|---|
| `TP ↔ CK` | 只显示用户选的 TP + `LS CLKOUT1`，不要把 12 路 CK 全塞进去。 |
| `帧头` | `Driver_TP/Init_TP/STVOUT1/STVOUT2/CPV1/CPV2/CPV3/CPV4/CLKOUT1..active`，按模式过滤。 |
| `帧尾` | `CLKOUT1..active/Terminate/RESETOUT`。4-input 模式没有 Terminate。 |
| `1 frame` | 重点显示 `STVOUT1/STVOUT2/LCOUT1/LCOUT2/POL(SoC)/CLKOUT1..active`。 |
| `120 frame` | 重点看 LC/POL 周期、STV 间距，不默认显示所有 CPV raw。 |

## 第一版明确不做的内容

这些不是不重要，而是直接模拟会引入假逻辑：

| 项 | 第一版处理 |
|---|---|
| `DUMMY_CLK` 精确插入位置 | 先保存并提示，等你用示波器或实板确认后再完整模拟。 |
| `DISCH1/DISCH2` 输出时序 | 先保存 disable/OCP 配置，不生成假波形。 |
| `AUTO_PULSE` | 上电流程相关，不和 GOA timing 混在一起。 |
| `LC_INI_STATE` | 上电初态，只保存，不影响正常帧内波形。 |
| OCP fault 行为 | 不模拟 IC latch，只做参数保存。 |
| MTP 写入流程 | 不写 XLSX，只导出 LS JSON / report；以后可加 I2C init table。 |

## 必须加的错误提示

| 条件 | 提示 |
|---|---|
| `EN_120HZ=1 && DOUBLE=0` | `EN_120HZ 需要 DOUBLE=1 才符合 PDF 图谱。` |
| `EN_120HZ=1 && CH_MODE=6/10 phase` | `PDF 标注 6/10 phase NOT SUPPORT。` |
| `CPVX_SEL=0 && HSR=010..111` | `CPVX_SEL 和 HSR 的 2/4 input 语义冲突。` |
| `CPVX_SEL=1 && HSR=000/001` | `CPVX_SEL 选择 4-input，但 HSR 仍是 2-input LC/CK 组合。` |
| 4-input 模式缺 `CPV3/CPV4` | `偶数 CK group 无法生成。` |
| `STV12_CLK_CTRL=1` 缺 `STV2` | `偶数 CK group 无 STV2 起点。` |
| `LS_EN=0` | `Level shifter output disabled，所有输出不应按正常波形显示。` |
| `CLK_DIS/LC_DIS/STV*_DIS` 非默认 | `存在强制 VGH/VGL2/HiZ 禁用态，波形需按禁用态处理。` |

## 需要你审核的点

1. `REVERSE` 的实现顺序：我是按“先生成 pair，再反向 phase 顺序”理解。
2. `TERM_MODE=1`：我建议“不拉低 CK，但仍 inhibit 到下一次 STV1”，这个需要你确认。
3. `DUMMY_CLK`：第一版是否接受只保存并提示，不参与波形。
4. `DISCH1/DISCH2`：第一版是否只保存配置，不画输出。
5. `HSR=001`：我理解为 `LCOUT1` 跟随 `LCIN1`，`LCOUT2` 跟随 `LCIN2`。
6. `TP ↔ CK` preset：我建议只显示 `LS CLKOUT1`，保持和之前 7272B/EK86707A 的调试习惯一致。

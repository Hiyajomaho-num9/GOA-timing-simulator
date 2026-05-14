# ADR-0002：iML7272B 可配置 Level Shifter 适配边界

## 状态

已接受。

## 背景

iML7272B 不是简单的 SoC GPIO 输出放大器。它有内部 timing generator，通过 `CLK_IN1/CLK_IN2` condensed clock、`STV_IN1/STV_IN2`、`LC_IN`、`Terminate` 和 `Reg01h~Reg04h` 派生 `LS CLK1~CLK10 / STV1~STV2 / LC1~LC2 / DIS_*` 输出。

PDF 的 timing diagram 是图谱形式，没有完整公式。适配目标不是为某一个项目写死参数，而是在 UI 的 Level Shifter 区让用户自由选择参数。

## 决策

1. `Reg01h~Reg04h` 作为 Level Shifter 独立配置保存，不写入 patched XLSX。
2. UI 显示“人话参数 + 原始 Reg hex 同步显示”。
3. 第一版只模拟和 GPO timing 相关的正常工作态，不模拟开机/掉电流程；开机还需要和 U-Boot/PMIC 同步，不能仅靠 XLSX 模拟。
4. `Terminate rising` 第一版只清输出，不重置 phase counter。
5. `CLK_IN1/CLK_IN2 -> LS CLKx` 第一版按 PDF 图谱建模式表，不硬写自以为通用的公式。
6. `STV1/STV2` 始终直接跟随 `STV_IN1/STV_IN2` 输入脉冲。
7. `LC1/LC2` 按 `LC_IN + REG01H[1:0]` 做正常运行态 level mapping，不做 power-on 2us 提前量。
8. `STV_IN1 / STV_IN2 / CLK_IN1 / CLK_IN2 / LC_IN / Terminate` 都允许用户从任意 SoC `GPO raw/out` 或已识别信号中选择；自动识别只作为候选，不强绑定。
9. Level shifter 输出命名为 `LS STV1 / LS CLK1 ... LS CLK10 / LS LC1 / LS LC2`，和 SoC `GPO raw/merge/out` 分开。
10. `OCP / FAULT / Slew / DIS_SENSE` 第一版可配置、可保存、可导出，但不影响时序波形。
11. Level Shifter UI 必须支持多个型号可选，第一批为 `single-ek86707a` 和 `single-iml7272b`。

## 后果

- XLSX patch 只处理 SoC GPIO timing，不混入 iML7272B I2C/NVM 参数。
- Project JSON / HTML report 才保存 iML7272B Level Shifter 配置。
- iML7272B 的波形输出可以随用户参数实时重新计算，但不声称覆盖 power sequence、OCP、FAULT 物理行为。

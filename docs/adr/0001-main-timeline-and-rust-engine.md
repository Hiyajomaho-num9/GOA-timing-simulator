# ADR-0001：主时间轴 UI 与 Rust Engine 扩展路线

## 状态

已接受。

## 背景

120 frame 叠加 TP/GPO 后，当前 TypeScript 全量 segment/edge 模型会生成数百万段，导致计算、绘图和 hit-test 都变慢。

当前 benchmark 基线：

```text
120frame selected total: 6700.67ms
segments=3380654
edges=3379562
```

用户目标不是追求示波器级刷新率，而是调试时不卡手。

## 决策

1. UI 改成“主时间轴 + preset 快捷视图”。
2. 当前旧版本源码先存档，便于对照和回退。
3. 参数区采用底部可收起调试台，不长期抢占波形面积。
4. Measurement 同时显示在波形交互和列表中。
5. 点击/拖动 edge 只生成 patch suggestion，不直接写寄存器。
6. 额外 GPO 只显示用户选择的那一层，不自动展开 raw/merge/out 三层。
7. 120 frame 默认关注 POL、LC、STV 的周期和间距；其他信号由用户按需加入。
8. Rust 作为后续 engine 扩展方向，但不一次性迁移全部 MT9216 逻辑。
9. 双 EK86707A 暂不实现，后续需要和用户单独协商级联和 pin mapping。
10. 增加 PNG 和 HTML report 导出。

## 影响

短期：

- 保留当前 TypeScript 仿真语义，降低回归风险。
- UI 更接近现代调试台，减少参数区占屏。
- 120 frame 额外 GPO 先用 overview 降载，避免全量 edge 卡死。

中期：

- 抽出查询式 waveform engine。
- Web 前端只请求当前视窗数据。
- Rust/WASM 逐步接管纯计算。

长期：

- Rust engine 可以同时服务 WASM 和 CLI benchmark。
- 更容易做 XLSX 回归测试、批量对比和性能基线。

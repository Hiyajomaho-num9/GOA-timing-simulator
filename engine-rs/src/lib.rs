//! GOA timing engine core.
//!
//! 这个 crate 先只承载稳定的纯计算 seam：时间基准、FCNT 解码、窗口查询类型。
//! 当前 TypeScript 仿真逻辑不会一次性迁入，后续按模块逐步替换为 WASM adapter。

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TimingBase {
    pub htotal_register: u32,
    pub htotal: u32,
    pub vtotal: u32,
    pub frame_rate: f64,
    pub pcnt_seconds: f64,
    pub lcnt_seconds: f64,
    pub frame_seconds: f64,
}

impl TimingBase {
    pub fn new(htotal_register: u32, vtotal: u32, frame_rate: f64) -> Self {
        let htotal = htotal_register + 1;
        let pcnt_seconds = 1.0 / (htotal as f64 * vtotal as f64 * frame_rate);
        Self {
            htotal_register,
            htotal,
            vtotal,
            frame_rate,
            pcnt_seconds,
            lcnt_seconds: pcnt_seconds * htotal as f64,
            frame_seconds: 1.0 / frame_rate,
        }
    }

    pub fn abs_pcnt(&self, lcnt: u32, pcnt: u32) -> u64 {
        lcnt as u64 * self.htotal as u64 + pcnt as u64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedFcnt {
    pub enabled: bool,
    pub level: LogicLevel,
    pub frame_count: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogicLevel {
    Low,
    High,
}

pub fn decode_fcnt(value: u16) -> DecodedFcnt {
    DecodedFcnt {
        enabled: value & 0x8000 != 0,
        level: if value & 0x4000 != 0 { LogicLevel::High } else { LogicLevel::Low },
        frame_count: (value & 0x00ff) as u8,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryMode {
    Exact,
    Overview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignalQuery {
    pub start_pcnt: u64,
    pub end_pcnt: u64,
    pub pixel_width: u32,
    pub mode: QueryMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrawableSegment {
    pub signal_index: u16,
    pub start_pcnt: u64,
    pub end_pcnt: u64,
    pub level: LogicLevel,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timing_base_uses_register_plus_one() {
        let timing = TimingBase::new(2170, 1140, 60.0);
        assert_eq!(timing.htotal, 2171);
        assert!((timing.pcnt_seconds * 1e9 - 6.734).abs() < 0.01);
        assert!((timing.lcnt_seconds * 1e6 - 14.620).abs() < 0.01);
    }

    #[test]
    fn fcnt_decodes_entry_enable_level_and_frame_count() {
        assert_eq!(
            decode_fcnt(0x8001),
            DecodedFcnt { enabled: true, level: LogicLevel::Low, frame_count: 1 },
        );
        assert_eq!(
            decode_fcnt(0xC078),
            DecodedFcnt { enabled: true, level: LogicLevel::High, frame_count: 120 },
        );
        assert_eq!(
            decode_fcnt(0x4078),
            DecodedFcnt { enabled: false, level: LogicLevel::High, frame_count: 120 },
        );
    }
}

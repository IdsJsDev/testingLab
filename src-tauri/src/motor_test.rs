use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotorTestProfile {
    pub throttle_channel: u8,
    pub minimum_pwm: u16,
    pub maximum_pwm: u16,
    pub emergency_current_a: f32,
    pub maximum_run_seconds: f32,
}

impl MotorTestProfile {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=8).contains(&self.throttle_channel) {
            return Err("Канал газа должен быть от 1 до 8".to_owned());
        }
        if !(800..=2200).contains(&self.minimum_pwm)
            || !(800..=2200).contains(&self.maximum_pwm)
            || self.minimum_pwm >= self.maximum_pwm
        {
            return Err(
                "PWM должен находиться в диапазоне 800…2200, минимум ниже максимума".to_owned(),
            );
        }
        if !self.emergency_current_a.is_finite() || self.emergency_current_a <= 0.0 {
            return Err("Аварийный ток должен быть положительным числом".to_owned());
        }
        if !self.maximum_run_seconds.is_finite()
            || self.maximum_run_seconds <= 0.0
            || self.maximum_run_seconds > 10.0
        {
            return Err("Один моторный запуск должен длиться от 0 до 10 секунд".to_owned());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RcMaxAdjustment {
    Keep,
    Increase,
    Decrease,
}

pub fn rc_max_adjustment(measured_a: f32, target_a: f32, tolerance_a: f32) -> RcMaxAdjustment {
    if measured_a > target_a + tolerance_a {
        RcMaxAdjustment::Decrease
    } else if measured_a < target_a - tolerance_a {
        RcMaxAdjustment::Increase
    } else {
        RcMaxAdjustment::Keep
    }
}

pub fn calibrated_amp_per_volt(
    old_value: f32,
    reference_current_a: f32,
    controller_current_a: f32,
) -> Result<f32, String> {
    if !old_value.is_finite()
        || !reference_current_a.is_finite()
        || !controller_current_a.is_finite()
        || old_value <= 0.0
        || reference_current_a <= 0.0
        || controller_current_a <= 0.0
    {
        return Err("Для калибровки нужны положительные конечные значения".to_owned());
    }
    let value = old_value * reference_current_a / controller_current_a;
    if !value.is_finite() || value <= 0.0 {
        return Err("Расчёт BATT_AMP_PERVLT дал недопустимое значение".to_owned());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_safe_profile_bounds() {
        let profile = MotorTestProfile {
            throttle_channel: 1,
            minimum_pwm: 1000,
            maximum_pwm: 1900,
            emergency_current_a: 180.0,
            maximum_run_seconds: 3.0,
        };
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn rejects_unbounded_run() {
        let profile = MotorTestProfile {
            throttle_channel: 1,
            minimum_pwm: 1000,
            maximum_pwm: 1900,
            emergency_current_a: 180.0,
            maximum_run_seconds: 20.0,
        };
        assert!(profile.validate().is_err());
    }

    #[test]
    fn selects_rc_max_direction() {
        assert_eq!(
            rc_max_adjustment(165.0, 160.0, 3.0),
            RcMaxAdjustment::Decrease
        );
        assert_eq!(
            rc_max_adjustment(155.0, 160.0, 3.0),
            RcMaxAdjustment::Increase
        );
        assert_eq!(rc_max_adjustment(161.0, 160.0, 3.0), RcMaxAdjustment::Keep);
    }

    #[test]
    fn calculates_single_point_current_scale() {
        assert_eq!(calibrated_amp_per_volt(40.0, 20.0, 16.0), Ok(50.0));
        assert!(calibrated_amp_per_volt(40.0, 20.0, 0.0).is_err());
    }
}

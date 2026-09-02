use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    application: &'static str,
    version: &'static str,
    state: &'static str,
}

impl CoreStatus {
    pub fn disconnected() -> Self {
        Self {
            application: "UAV Test Station",
            version: env!("CARGO_PKG_VERSION"),
            state: "disconnected",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CoreStatus;

    #[test]
    fn initial_state_is_disconnected() {
        let status = CoreStatus::disconnected();

        assert_eq!(status.state, "disconnected");
    }
}

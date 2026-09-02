use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterFileEntry {
    pub name: String,
    pub value: f32,
}

pub fn format_mission_planner(entries: &[ParameterFileEntry]) -> String {
    let mut entries = entries.to_vec();
    entries.sort_by(|left, right| {
        let left_parts: Vec<_> = left.name.split('_').collect();
        let right_parts: Vec<_> = right.name.split('_').collect();
        left_parts.cmp(&right_parts)
    });

    entries
        .into_iter()
        .map(|entry| format!("{},{}", entry.name, format_value(entry.value)))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

pub fn parse_mission_planner(contents: &str) -> Result<Vec<ParameterFileEntry>, String> {
    let mut entries = Vec::new();
    for (index, raw_line) in contents.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (name, value) = line
            .split_once(',')
            .ok_or_else(|| format!("Строка {}: ожидается формат ИМЯ,ЗНАЧЕНИЕ", index + 1))?;
        let name = name.trim();
        if name.is_empty()
            || name.len() > 16
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err(format!("Строка {}: некорректное имя параметра", index + 1));
        }
        let value = value
            .trim()
            .parse::<f32>()
            .map_err(|_| format!("Строка {}: некорректное значение", index + 1))?;
        if !value.is_finite() {
            return Err(format!(
                "Строка {}: значение должно быть конечным",
                index + 1
            ));
        }
        entries.push(ParameterFileEntry {
            name: name.to_owned(),
            value,
        });
    }
    if entries.is_empty() {
        return Err("Файл не содержит параметров".to_owned());
    }
    Ok(entries)
}

pub fn save(path: &Path, entries: &[ParameterFileEntry]) -> Result<(), String> {
    fs::write(path, format_mission_planner(entries))
        .map_err(|error| format!("Не удалось сохранить {}: {error}", path.display()))
}

pub fn load(path: &Path) -> Result<Vec<ParameterFileEntry>, String> {
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
    parse_mission_planner(&contents)
}

fn format_value(value: f32) -> String {
    let fixed = format!("{value:.6}");
    let trimmed = fixed.trim_end_matches('0').trim_end_matches('.');
    if trimmed == "-0" {
        "0".to_owned()
    } else {
        trimmed.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{ParameterFileEntry, format_mission_planner, parse_mission_planner};

    #[test]
    fn writes_mission_planner_format() {
        let output = format_mission_planner(&[
            ParameterFileEntry {
                name: "B_TEST".into(),
                value: 1.25,
            },
            ParameterFileEntry {
                name: "A_TEST".into(),
                value: 2.0,
            },
        ]);
        assert_eq!(output, "A_TEST,2\nB_TEST,1.25\n");
    }

    #[test]
    fn reads_comments_and_values() {
        let entries = parse_mission_planner("# backup\nA_TEST,2\nB_TEST,-1.25\n").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].value, -1.25);
    }
}

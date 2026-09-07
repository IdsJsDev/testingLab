use std::path::{Component, Path, PathBuf};

use tauri::{AppHandle, Manager};

fn reports_directory(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            let directory = parent.join("Reports");
            if std::fs::create_dir_all(&directory).is_ok() {
                return Ok(directory);
            }
        }
    }
    let directory = app
        .path()
        .document_dir()
        .map_err(|error| format!("Не удалось определить папку «Документы»: {error}"))?
        .join("UAV Test Station")
        .join("Reports");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Не удалось создать папку отчётов: {error}"))?;
    Ok(directory)
}

fn report_path(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    let path = Path::new(file_name);
    if path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        return Err("Некорректное имя отчёта".to_owned());
    }
    Ok(reports_directory(app)?.join(path))
}

pub fn save(app: &AppHandle, file_name: &str, contents: &str) -> Result<(), String> {
    let path = report_path(app, file_name)?;
    std::fs::write(&path, contents)
        .map_err(|error| format!("Не удалось сохранить отчёт {}: {error}", path.display()))
}

pub fn list(app: &AppHandle) -> Result<Vec<String>, String> {
    let directory = reports_directory(app)?;
    let mut files = std::fs::read_dir(&directory)
        .map_err(|error| format!("Не удалось прочитать папку отчётов: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            (path
                .extension()
                .is_some_and(|extension| extension == "json"))
            .then(|| entry.file_name().to_string_lossy().into_owned())
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| right.cmp(left));
    Ok(files)
}

pub fn load(app: &AppHandle, file_name: &str) -> Result<String, String> {
    let path = report_path(app, file_name)?;
    std::fs::read_to_string(&path)
        .map_err(|error| format!("Не удалось прочитать отчёт {}: {error}", path.display()))
}

pub fn delete(app: &AppHandle, file_name: &str) -> Result<(), String> {
    let path = report_path(app, file_name)?;
    std::fs::remove_file(&path)
        .map_err(|error| format!("Не удалось удалить отчёт {}: {error}", path.display()))
}

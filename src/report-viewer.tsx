import { confirm } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "preact/hooks";

type ReportEntry = {
  blockId: string;
  label: string;
  status: "running" | "passed" | "warning" | "failed" | "skipped";
  message: string;
};
type RunReport = {
  format: "uav-test-station-report";
  version: 1;
  id: string;
  scenarioName: string;
  serialNumber?: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "warning" | "failed" | "cancelled";
  entries: ReportEntry[];
};
type StoredReport = { fileName: string; report: RunReport };
const statusLabel = {
  passed: "Успешно",
  warning: "Требуется проверка",
  failed: "Ошибка",
  cancelled: "Отменено",
} as const;

export function ReportViewer() {
  const [reports, setReports] = useState<StoredReport[]>([]);
  const [selected, setSelected] = useState<StoredReport | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setError(null);
    try {
      const fileNames = await invoke<string[]>("list_run_reports");
      const loaded = await Promise.all(
        fileNames.map(async (fileName) => ({
          fileName,
          report: JSON.parse(await invoke<string>("load_run_report", { fileName })) as RunReport,
        })),
      );
      const valid = loaded.filter((item) => item.report.format === "uav-test-station-report");
      setReports(valid);
      setSelected(
        (current) => valid.find((item) => item.fileName === current?.fileName) ?? valid[0] ?? null,
      );
    } catch (value) {
      setError(String(value).replace(/^Error: /, ""));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query
      ? reports.filter((item) =>
          `${item.report.scenarioName} ${item.report.serialNumber ?? ""}`
            .toLowerCase()
            .includes(query),
        )
      : reports;
  }, [reports, search]);
  const remove = async (fileName: string) => {
    if (
      !(await confirm("Удалить этот отчёт? Файл будет удалён с диска.", {
        title: "Удаление отчёта",
        kind: "warning",
      }))
    )
      return;
    await invoke("delete_run_report", { fileName });
    await refresh();
  };
  return (
    <>
      <section class="hero compact-hero">
        <p class="eyebrow">История запусков</p>
        <h1>Отчёты</h1>
        <p class="hero-copy">
          Сохранённые результаты сценариев находятся в папке Reports рядом с приложением.
        </p>
      </section>
      <section class="reports-layout">
        <aside class="report-list">
          <div class="report-list-actions">
            <input
              value={search}
              placeholder="Сценарий или серийный номер"
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
            <button type="button" onClick={() => void refresh()}>
              Обновить
            </button>
          </div>
          {error && <p class="scenario-errors">{error}</p>}
          <div class="report-list-content">
            {filtered.length ? (
              filtered.map((item) => (
                <button
                  type="button"
                  class={`report-item ${selected?.fileName === item.fileName ? "active" : ""}`}
                  onClick={() => setSelected(item)}
                >
                  <strong>{item.report.scenarioName}</strong>
                  <span>{new Date(item.report.finishedAt).toLocaleString("ru-RU")}</span>
                  <small>{item.report.serialNumber || "Без серийного номера"}</small>
                  <em class={item.report.status}>{statusLabel[item.report.status]}</em>
                </button>
              ))
            ) : (
              <p class="muted">Отчётов пока нет.</p>
            )}
          </div>
        </aside>
        <article class="report-details">
          {selected ? (
            <>
              <div class="report-details-heading">
                <div>
                  <p class="eyebrow">{statusLabel[selected.report.status]}</p>
                  <h2>{selected.report.scenarioName}</h2>
                </div>
                <button
                  type="button"
                  class="danger-button"
                  onClick={() => void remove(selected.fileName)}
                >
                  Удалить
                </button>
              </div>
              <dl class="report-meta">
                <div>
                  <dt>Серийный номер</dt>
                  <dd>{selected.report.serialNumber || "Не указан"}</dd>
                </div>
                <div>
                  <dt>Начало</dt>
                  <dd>{new Date(selected.report.startedAt).toLocaleString("ru-RU")}</dd>
                </div>
                <div>
                  <dt>Завершение</dt>
                  <dd>{new Date(selected.report.finishedAt).toLocaleString("ru-RU")}</dd>
                </div>
              </dl>
              <div class="report-entries">
                {selected.report.entries.map((entry) => (
                  <div class={`run-entry ${entry.status}`}>
                    <span>
                      {entry.status === "passed"
                        ? "✓"
                        : entry.status === "warning"
                          ? "!"
                          : entry.status === "skipped"
                            ? "—"
                            : "×"}
                    </span>
                    <div>
                      <strong>{entry.label}</strong>
                      <p>{entry.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p class="muted">Выберите отчёт в списке.</p>
          )}
        </article>
      </section>
    </>
  );
}

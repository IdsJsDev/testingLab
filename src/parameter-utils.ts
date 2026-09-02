export type ParameterValue = {
  name: string;
  value: number;
  parameterType: string;
  index: number;
};

export type ParameterFileEntry = { name: string; value: number };

export type ParameterDifference = ParameterFileEntry & {
  currentValue?: number;
  selected: boolean;
};

export type ParameterWriteStatus = {
  active: boolean;
  total: number;
  completed: number;
  failed: number;
  currentName?: string;
  lastError?: string;
};

export function groupParameters(items: ParameterValue[], search: string) {
  const normalizedSearch = search.trim().toLowerCase();
  return Object.entries(
    items
      .filter((parameter) => parameter.name.toLowerCase().includes(normalizedSearch))
      .reduce<Record<string, ParameterValue[]>>((groups, parameter) => {
        const prefix = parameter.name.split("_")[0].replace(/\d+$/, "") || "OTHER";
        (groups[prefix] ??= []).push(parameter);
        return groups;
      }, {}),
  ).sort(([left], [right]) => left.localeCompare(right));
}

export function compareParameters(
  fileEntries: ParameterFileEntry[],
  currentParameters: ParameterValue[],
): ParameterDifference[] {
  const current = new Map(currentParameters.map((item) => [item.name, item.value]));
  return fileEntries
    .filter(
      (entry) =>
        current.get(entry.name) === undefined ||
        Math.abs((current.get(entry.name) ?? 0) - entry.value) > 0.00001,
    )
    .map((entry) => ({
      ...entry,
      currentValue: current.get(entry.name),
      selected: false,
    }));
}

export function isWriteFinished(status: ParameterWriteStatus) {
  return !status.active && status.total > 0 && status.completed + status.failed >= status.total;
}

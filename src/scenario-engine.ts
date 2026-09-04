export type ScenarioContext = {
  controllerConnected: boolean;
  controllerName?: string;
  armed?: boolean;
  controllerStatusText?: string;
  rcChannels?: number[];
  servo1OutputPwm?: number;
  controllerCurrentA?: number;
  ammeterConnected: boolean;
  ammeterCurrentA?: number;
  parameters: Array<{ name: string; value: number }>;
};

export type ScenarioBlock =
  | { id: string; type: "requireController" }
  | { id: string; type: "requireAmmeter" }
  | { id: string; type: "requireDisarmed" }
  | { id: string; type: "parameterEquals"; name: string; expected: number; tolerance: number }
  | { id: string; type: "currentInRange"; minimum: number; maximum: number }
  | { id: string; type: "wait"; seconds: number }
  | {
      id: string;
      type: "sound";
      repeats: number;
      intervalSeconds: number;
    }
  | { id: string; type: "operatorConfirmation"; message: string }
  | { id: string; type: "resultMessage"; message: string }
  | { id: string; type: "prepareMotorTest"; maximumIdleCurrentA: number }
  | { id: string; type: "armController"; force: boolean }
  | { id: string; type: "disarmController" }
  | {
      id: string;
      type: "checkMotorRotation";
      throttlePercent: number;
      durationSeconds: number;
      emergencyCurrentA: number;
      confirmation: string;
    }
  | {
      id: string;
      type: "measureMaximumCurrent";
      durationSeconds: number;
      settlingSeconds: number;
      emergencyCurrentA: number;
    }
  | {
      id: string;
      type: "findCurrentLoad";
      targetCurrentA: number;
      toleranceA: number;
      startThrottlePercent: number;
      throttleStepPercent: number;
      maximumThrottlePercent: number;
      pulseDurationSeconds: number;
      holdDurationSeconds: number;
      cooldownSeconds: number;
      emergencyCurrentA: number;
    }
  | {
      id: string;
      type: "tuneRcMaxByCurrent";
      parameterName: string;
      targetCurrentA: number;
      toleranceA: number;
      emergencyCurrentA: number;
      maximumAttempts: number;
      cooldownSeconds: number;
    }
  | {
      id: string;
      type: "calibrateControllerCurrent";
      parameterName: string;
      targetCurrentA: number;
      targetToleranceA: number;
      comparisonToleranceA: number;
      maximumDurationSeconds: number;
      emergencyCurrentA: number;
    };

export type BlockType = ScenarioBlock["type"];

export type BlockDefinition = {
  type: BlockType;
  label: string;
  description: string;
  create: (id: string) => ScenarioBlock;
};

export const blockCatalog: BlockDefinition[] = [
  {
    type: "requireController",
    label: "Проверить контроллер",
    description: "Требует активного подключения полётного контроллера.",
    create: (id) => ({ id, type: "requireController" }),
  },
  {
    type: "requireDisarmed",
    label: "Проверить DISARM",
    description: "Проверяет, что контроллер сообщает безопасное состояние DISARM.",
    create: (id) => ({ id, type: "requireDisarmed" }),
  },
  {
    type: "requireAmmeter",
    label: "Проверить амперметр",
    description: "Требует активного подключения эталонного амперметра.",
    create: (id) => ({ id, type: "requireAmmeter" }),
  },
  {
    type: "parameterEquals",
    label: "Сравнить параметр",
    description: "Сравнивает загруженный параметр контроллера с ожидаемым значением.",
    create: (id) => ({
      id,
      type: "parameterEquals",
      name: "BATT_MONITOR",
      expected: 4,
      tolerance: 0,
    }),
  },
  {
    type: "currentInRange",
    label: "Проверить ток",
    description: "Проверяет, входит ли показание амперметра в диапазон.",
    create: (id) => ({ id, type: "currentInRange", minimum: -0.2, maximum: 0.2 }),
  },
  {
    type: "wait",
    label: "Ожидать",
    description: "Приостанавливает сценарий на заданное число секунд.",
    create: (id) => ({ id, type: "wait", seconds: 1 }),
  },
  {
    type: "sound",
    label: "Подать звук",
    description: "Подаёт звуковой сигнал через динамик компьютера.",
    create: (id) => ({
      id,
      type: "sound",
      repeats: 1,
      intervalSeconds: 1,
    }),
  },
  {
    type: "operatorConfirmation",
    label: "Подтверждение оператора",
    description: "Останавливает выполнение до явного подтверждения.",
    create: (id) => ({ id, type: "operatorConfirmation", message: "Стенд подготовлен к проверке" }),
  },
  {
    type: "resultMessage",
    label: "Добавить результат",
    description: "Добавляет произвольную строку в протокол выполнения.",
    create: (id) => ({ id, type: "resultMessage", message: "Проверка завершена" }),
  },
  {
    type: "prepareMotorTest",
    label: "Проверить контроллер, амперметр и ток покоя",
    description:
      "Проверяет подключения полётного контроллера и амперметра, а также допустимый ток покоя перед замером двигателя.",
    create: (id) => ({ id, type: "prepareMotorTest", maximumIdleCurrentA: 1 }),
  },
  {
    type: "armController",
    label: "Выполнить ARM",
    description: "Переводит контроллер в ARM и проверяет состояние по heartbeat.",
    create: (id) => ({ id, type: "armController", force: false }),
  },
  {
    type: "disarmController",
    label: "Выполнить DISARM",
    description: "Останавливает двигатель и переводит контроллер в DISARM.",
    create: (id) => ({ id, type: "disarmController" }),
  },
  {
    type: "checkMotorRotation",
    label: "Проверить направление вращения",
    description: "Кратковременно запускает двигатель на малом газе и запрашивает подтверждение.",
    create: (id) => ({
      id,
      type: "checkMotorRotation",
      throttlePercent: 10,
      durationSeconds: 2,
      emergencyCurrentA: 40,
      confirmation: "Пропеллер вращается в правильном направлении?",
    }),
  },
  {
    type: "findCurrentLoad",
    label: "Найти нагрузку по току",
    description: "Короткими импульсами повышает газ и ищет заданный ток внешнего амперметра.",
    create: (id) => ({
      id,
      type: "findCurrentLoad",
      targetCurrentA: 20,
      toleranceA: 2,
      startThrottlePercent: 28,
      throttleStepPercent: 2,
      maximumThrottlePercent: 65,
      pulseDurationSeconds: 1,
      holdDurationSeconds: 2,
      cooldownSeconds: 0.5,
      emergencyCurrentA: 35,
    }),
  },
  {
    type: "measureMaximumCurrent",
    label: "Измерить максимальный ток",
    description: "Коротко подаёт полный газ и фиксирует средний и пиковый внешний ток.",
    create: (id) => ({
      id,
      type: "measureMaximumCurrent",
      durationSeconds: 2,
      settlingSeconds: 0.5,
      emergencyCurrentA: 250,
    }),
  },
  {
    type: "tuneRcMaxByCurrent",
    label: "Настроить RC1_MAX по току",
    description: "Ограниченно корректирует RC1_MAX до заданного максимального тока.",
    create: (id) => ({
      id,
      type: "tuneRcMaxByCurrent",
      parameterName: "RC1_MAX",
      targetCurrentA: 160,
      toleranceA: 3,
      emergencyCurrentA: 250,
      maximumAttempts: 6,
      cooldownSeconds: 5,
    }),
  },
  {
    type: "calibrateControllerCurrent",
    label: "Откалибровать ток контроллера",
    description: "Находит нагрузку 20 А и один раз корректирует BATT_AMP_PERVLT под нагрузкой.",
    create: (id) => ({
      id,
      type: "calibrateControllerCurrent",
      parameterName: "BATT_AMP_PERVLT",
      targetCurrentA: 20,
      targetToleranceA: 2,
      comparisonToleranceA: 1,
      maximumDurationSeconds: 2,
      emergencyCurrentA: 35,
    }),
  },
];

export function blockLabel(block: ScenarioBlock) {
  return blockCatalog.find((item) => item.type === block.type)?.label ?? block.type;
}

export function validateScenario(name: string, blocks: ScenarioBlock[]): string[] {
  const errors: string[] = [];
  if (!name.trim()) errors.push("Укажите название сценария");
  if (!blocks.length) errors.push("Добавьте хотя бы один блок");
  blocks.forEach((block, index) => {
    const prefix = `Блок ${index + 1}`;
    if (block.type === "parameterEquals") {
      if (!block.name.trim()) errors.push(`${prefix}: укажите имя параметра`);
      if (![block.expected, block.tolerance].every(Number.isFinite) || block.tolerance < 0)
        errors.push(`${prefix}: значение и допуск должны быть корректными числами`);
    } else if (block.type === "currentInRange") {
      if (![block.minimum, block.maximum].every(Number.isFinite) || block.minimum > block.maximum)
        errors.push(`${prefix}: некорректный диапазон тока`);
    } else if (block.type === "wait") {
      if (!Number.isFinite(block.seconds) || block.seconds < 0 || block.seconds > 300)
        errors.push(`${prefix}: ожидание должно быть от 0 до 300 секунд`);
    } else if (block.type === "sound") {
      if (!Number.isInteger(block.repeats) || block.repeats < 1 || block.repeats > 20)
        errors.push(`${prefix}: число звуков должно быть от 1 до 20`);
      if (
        !Number.isFinite(block.intervalSeconds) ||
        block.intervalSeconds < 0 ||
        block.intervalSeconds > 60
      )
        errors.push(`${prefix}: интервал должен быть от 0 до 60 секунд`);
    } else if (
      (block.type === "operatorConfirmation" || block.type === "resultMessage") &&
      !block.message.trim()
    ) {
      errors.push(`${prefix}: текст не может быть пустым`);
    } else if (block.type === "prepareMotorTest") {
      if (!Number.isFinite(block.maximumIdleCurrentA) || block.maximumIdleCurrentA < 0)
        errors.push(`${prefix}: укажите допустимый ток покоя`);
    } else if (block.type === "checkMotorRotation") {
      if (block.throttlePercent <= 0 || block.throttlePercent > 30)
        errors.push(`${prefix}: малый газ должен быть от 1 до 30%`);
      if (
        block.durationSeconds < 0.5 ||
        block.durationSeconds > 5 ||
        Math.abs(block.durationSeconds * 2 - Math.round(block.durationSeconds * 2)) > 1e-6
      )
        errors.push(`${prefix}: запуск должен длиться от 0,5 до 5 секунд с шагом 0,5 секунды`);
      if (!Number.isFinite(block.emergencyCurrentA) || block.emergencyCurrentA <= 0)
        errors.push(`${prefix}: укажите положительный аварийный ток`);
      if (!block.confirmation.trim()) errors.push(`${prefix}: укажите текст подтверждения`);
    } else if (block.type === "measureMaximumCurrent") {
      if (block.durationSeconds <= 0 || block.durationSeconds > 5)
        errors.push(`${prefix}: полный газ должен длиться от 0 до 5 секунд`);
      if (block.settlingSeconds < 0 || block.settlingSeconds >= block.durationSeconds)
        errors.push(`${prefix}: некорректное время стабилизации`);
      if (block.emergencyCurrentA <= 0) errors.push(`${prefix}: укажите аварийный ток`);
    } else if (block.type === "findCurrentLoad") {
      if (block.targetCurrentA <= 0 || block.toleranceA < 0)
        errors.push(`${prefix}: некорректная цель или допуск тока`);
      if (
        block.startThrottlePercent < 1 ||
        block.maximumThrottlePercent > 70 ||
        block.startThrottlePercent >= block.maximumThrottlePercent ||
        block.throttleStepPercent <= 0
      )
        errors.push(`${prefix}: газ должен возрастать в пределах 1…70% диапазона RC`);
      if (
        block.pulseDurationSeconds < 0.5 ||
        block.pulseDurationSeconds > 5 ||
        Math.abs(block.pulseDurationSeconds * 2 - Math.round(block.pulseDurationSeconds * 2)) >
          1e-6
      )
        errors.push(`${prefix}: импульс должен быть от 0,5 до 5 секунд с шагом 0,5`);
      if (
        block.cooldownSeconds < 0.5 ||
        block.cooldownSeconds > 5 ||
        Math.abs(block.cooldownSeconds * 2 - Math.round(block.cooldownSeconds * 2)) > 1e-6
      )
        errors.push(`${prefix}: пауза должна быть от 0,5 до 5 секунд с шагом 0,5`);
      if (
        !Number.isFinite(block.holdDurationSeconds) ||
        block.holdDurationSeconds < 0.5 ||
        block.holdDurationSeconds > 5 ||
        Math.abs(block.holdDurationSeconds * 2 - Math.round(block.holdDurationSeconds * 2)) >
          1e-6
      )
        errors.push(`${prefix}: удержание должно быть от 0,5 до 5 секунд с шагом 0,5`);
      if (block.emergencyCurrentA <= block.targetCurrentA + block.toleranceA)
        errors.push(`${prefix}: аварийный ток должен быть выше целевого диапазона`);
    } else if (block.type === "tuneRcMaxByCurrent") {
      if (!block.parameterName.trim()) errors.push(`${prefix}: укажите параметр RC MAX`);
      if (block.targetCurrentA <= 0 || block.toleranceA < 0)
        errors.push(`${prefix}: некорректная цель или допуск тока`);
      if (block.emergencyCurrentA <= block.targetCurrentA)
        errors.push(`${prefix}: аварийный ток должен быть выше целевого`);
      if (
        !Number.isInteger(block.maximumAttempts) ||
        block.maximumAttempts < 1 ||
        block.maximumAttempts > 10
      )
        errors.push(`${prefix}: число попыток должно быть от 1 до 10`);
      if (block.cooldownSeconds < 0 || block.cooldownSeconds > 300)
        errors.push(`${prefix}: пауза должна быть от 0 до 300 секунд`);
    } else if (block.type === "calibrateControllerCurrent") {
      if (!block.parameterName.trim()) errors.push(`${prefix}: укажите параметр масштаба`);
      if (block.targetCurrentA <= 0 || block.targetToleranceA < 0 || block.comparisonToleranceA < 0)
        errors.push(`${prefix}: некорректные токи или допуски`);
      if (block.maximumDurationSeconds < 0.5 || block.maximumDurationSeconds > 5)
        errors.push(`${prefix}: длительность должна быть от 0,5 до 5 секунд`);
      if (block.emergencyCurrentA <= block.targetCurrentA)
        errors.push(`${prefix}: аварийный ток должен быть выше целевого`);
    }
  });
  return errors;
}

export function evaluateImmediateBlock(block: ScenarioBlock, context: ScenarioContext): string {
  switch (block.type) {
    case "requireController":
      if (!context.controllerConnected) throw new Error("Полётный контроллер не подключён");
      return `Контроллер подключён${context.controllerName ? ` — ${context.controllerName}` : ""}`;
    case "requireAmmeter":
      if (!context.ammeterConnected) throw new Error("Амперметр не подключён");
      return "Амперметр подключён";
    case "requireDisarmed":
      if (!context.controllerConnected) throw new Error("Полётный контроллер не подключён");
      if (context.armed === undefined) throw new Error("Состояние ARM/DISARM ещё не получено");
      if (context.armed) throw new Error("Контроллер находится в состоянии ARM");
      return "Контроллер находится в состоянии DISARM";
    case "parameterEquals": {
      const parameter = context.parameters.find((item) => item.name === block.name.trim());
      if (!parameter) throw new Error(`Параметр ${block.name.trim()} не загружен`);
      return evaluateParameterValue(block, parameter.value);
    }
    case "currentInRange":
      if (context.ammeterCurrentA === undefined)
        throw new Error("Нет актуального показания амперметра");
      if (context.ammeterCurrentA < block.minimum || context.ammeterCurrentA > block.maximum)
        throw new Error(
          `Ток ${context.ammeterCurrentA.toFixed(3)} A вне диапазона ${block.minimum}…${block.maximum} A`,
        );
      return `Ток ${context.ammeterCurrentA.toFixed(3)} A входит в диапазон ${block.minimum}…${block.maximum} A`;
    case "resultMessage":
      return block.message.trim();
    default:
      throw new Error("Блок требует асинхронного исполнения");
  }
}

export function evaluateParameterValue(
  block: Extract<ScenarioBlock, { type: "parameterEquals" }>,
  actual: number,
) {
  if (Math.abs(actual - block.expected) > block.tolerance)
    throw new Error(
      `Параметр ${block.name.trim()}: актуальное значение ${actual}, ожидалось ${block.expected} ± ${block.tolerance}`,
    );
  return `${block.name.trim()}: актуальное значение ${actual}, ожидалось ${block.expected} ± ${block.tolerance}`;
}

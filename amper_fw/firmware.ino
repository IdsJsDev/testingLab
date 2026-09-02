/*
 * =====================================================================
 *  Ampermetr — Firmware for Arduino (Mateksys HCS-150A Hall Current Sensor)
 * =====================================================================
 *
 *  Платформа : Arduino Uno / Nano / Mega (любая AVR с 1 КБ EEPROM)
 *  Датчик    : Mateksys HCS-150A (0-150A, 20 мВ/А, выход 0-3.3 В) — пин A0
 *  Протокол  : UART 9600 8N1
 *      Постоянный поток (раз в ~100 мс):
 *          DATA:<amps>:<volts>\n
 *      Команды (ASCII, заканчиваются '\n'):
 *          CAL:CLEAR\n                  — стереть все точки калибровки
 *          CAL:ADD:<amps>:<volts>\n     — добавить точку (клещи, датчик)
 *          CAL:LIST\n                   — выдать все точки калибровки
 *          CAL:COUNT\n                  — выдать количество точек
 *      PING\n                       — ответить PONG
 *      RAW\n                         — вывести сырые значения АЦП (отладка)
 *
 *  Алгоритм:
 *      - Усреднение 100 отсчётов АЦП для подавления шума.
 *      - Кусочно-линейная интерполяция между калибровочными точками.
 *      - Линейная экстраполяция за пределами диапазона.
 *      - Хранение точек в EEPROM с Magic Key 0xDEADBEEF.
 *      - Авто-сортировка точек по возрастанию напряжения.
 *      - Максимум 20 точек.
 *
 *  Автор : Ampermetr project
 *  Лицензия: MIT
 * =====================================================================
 */

#include <EEPROM.h>

/* ------------------------------------------------------------------ */
/*  Конфигурация                                                      */
/* ------------------------------------------------------------------ */

#define SENSOR_PIN          A0          // Аналоговый вход датчика WCS1500
#define BAUD_RATE           9600        // Скорость UART
#define ADC_REF_VOLTAGE     5.0f        // Опорное напряжение АЦП (5 В)
#define ADC_MAX_COUNTS      1023.0f     // Разрешение 10-битного АЦП

#define AVG_SAMPLES         100         // Кол-во отсчётов для усреднения
#define DATA_PERIOD_MS      100         // Период выдачи DATA:...

#define MAX_POINTS          20          // Максимум калибровочных точек
#define MAGIC_KEY           0x4D415445  // Ключ целостности EEPROM ("MATE" в hex, обновили для Mateksys HCS-150A)

/*
 * Размер EEPROM = 4 (magic) + 1 (count) + MAX_POINTS * 8 (point) = 165 байт.
 * На Uno/Nano доступно 1024 байта — хватает с запасом.
 */
#define EEPROM_ADDR_MAGIC   0           // 4 байта
#define EEPROM_ADDR_COUNT   4           // 1 байт
#define EEPROM_ADDR_POINTS  5           // MAX_POINTS * 8 байт
#define POINT_SIZE          8           // sizeof(Point) = 4+4 = 8 байт

/* ------------------------------------------------------------------ */
/*  Структуры данных                                                  */
/* ------------------------------------------------------------------ */

struct Point {
    float volts;  // Напряжение на выходе датчика (В)
    float amps;   // Соответствующий ток (А), измеренный клещами
};

/* ------------------------------------------------------------------ */
/*  Глобальные переменные                                             */
/* ------------------------------------------------------------------ */

Point  calPoints[MAX_POINTS];   // Калибровочные точки (отсортированы по volts)
uint8_t calCount = 0;           // Текущее число точек

unsigned long lastDataMs = 0;   // Метка времени последней выдачи DATA
char     rxBuffer[64];          // Буфер приёма команд
uint8_t  rxIndex = 0;           // Индекс в буфере приёма

/* ------------------------------------------------------------------ */
/*  Прототипы                                                         */
/* ------------------------------------------------------------------ */

void     loadCalibration();
void     saveCalibration();
void     initDefaultCalibration();
void     clearCalibration();
void     addCalibrationPoint(float amps, float volts);
void     sortCalibration();
float    voltsToAmps(float v);
float    readAverageVolts();
void     sendDataLine();
void     sendPointsList();
void     processCommand(char* cmd);
void     sendResponse(const char* msg);
void     sendResponse(const __FlashStringHelper* msg);

/* ================================================================== */
/*  setup                                                             */
/* ================================================================== */

void setup() {
    Serial.begin(BAUD_RATE);
    pinMode(SENSOR_PIN, INPUT);

    loadCalibration();                     // Загрузить или инициализировать EEPROM

    sendResponse(F("READY"));
}

/* ================================================================== */
/*  loop                                                              */
/* ================================================================== */

void loop() {

    /* ---- 1. Чтение команд из UART (неблокирующее) ---- */
    while (Serial.available() > 0) {
        char c = (char)Serial.read();

        if (c == '\n' || c == '\r') {
            if (rxIndex > 0) {
                rxBuffer[rxIndex] = '\0';
                // Очистим случайные \r/\n пробелы с конца
                while (rxIndex > 0 && (rxBuffer[rxIndex - 1] == '\r' || rxBuffer[rxIndex - 1] == '\n' || rxBuffer[rxIndex - 1] == ' ')) {
                    rxBuffer[--rxIndex] = '\0';
                }
                if (rxIndex > 0) {
                    processCommand(rxBuffer);
                }
                rxIndex = 0;
            }
        } else if (rxIndex < sizeof(rxBuffer) - 1) {
            rxBuffer[rxIndex++] = c;
        }
    }

    /* ---- 2. Периодическая отправка DATA:... (каждые 100 мс) ---- */
    unsigned long now = millis();
    if (now - lastDataMs >= DATA_PERIOD_MS) {
        lastDataMs = now;
        sendDataLine();
    }
}

/* ================================================================== */
/*  Работа с EEPROM                                                   */
/* ================================================================== */

/*
 *  Загрузить калибровку из EEPROM.
 *  Если Magic Key не совпадает — инициализировать базовыми 2 точками.
 */
void loadCalibration() {
    uint32_t magic = 0;
    EEPROM.get(EEPROM_ADDR_MAGIC, magic);

    if (magic != MAGIC_KEY) {
        // EEPROM либо пуст, либо повреждён — инициализируем
        initDefaultCalibration();
        saveCalibration();
        return;
    }

    EEPROM.get(EEPROM_ADDR_COUNT, calCount);
    if (calCount > MAX_POINTS) calCount = 0;

    for (uint8_t i = 0; i < calCount; i++) {
        int addr = EEPROM_ADDR_POINTS + i * POINT_SIZE;
        EEPROM.get(addr, calPoints[i]);
    }
    sortCalibration();
}

/*
 *  Сохранить калибровку в EEPROM.
 *  Сначала стираем область, затем пишем Magic Key + count + точки.
 */
void saveCalibration() {
    // Очистим область данных на всякий случай (count + точки)
    for (int addr = EEPROM_ADDR_COUNT; addr < EEPROM_ADDR_POINTS + MAX_POINTS * POINT_SIZE; addr++) {
        EEPROM.update(addr, 0xFF);
    }
    // Запись
    EEPROM.put(EEPROM_ADDR_MAGIC, (uint32_t)MAGIC_KEY);
    EEPROM.put(EEPROM_ADDR_COUNT, calCount);
    for (uint8_t i = 0; i < calCount; i++) {
        int addr = EEPROM_ADDR_POINTS + i * POINT_SIZE;
        EEPROM.put(addr, calPoints[i]);
    }
}

/*
 *  Базовая 2-точечная калибровка по умолчанию.
 *  Подобрана под датчик Mateksys HCS-150A:
 *  0 А  → 0.00 В
 *  150 А → 3.00 В (чуствительность 20 мВ/А)
 *  Пользователь может дополнительно откалибровать по клещам через GUI.
 */
void initDefaultCalibration() {
    calCount = 2;
    calPoints[0] = { 0.00f,   0.0f };   // 0 А   → 0.00 В
    calPoints[1] = { 3.00f, 150.0f };   // 150 А → 3.00 В (20 мВ/А = 50 А/В)
    sortCalibration();
}

/*
 *  Полная очистка калибровки + переход к дефолтной.
 *  (Команда CAL:CLEAR — оставляем дефолтную, чтобы устройство
 *  сразу начало выдавать осмысленные значения.)
 */
void clearCalibration() {
    initDefaultCalibration();
    saveCalibration();
}

/* ================================================================== */
/*  Логика калибровки                                                 */
/* ================================================================== */

/*
 *  Добавить новую точку (amps, volts). Если точек уже MAX_POINTS —
 *  отвергаем команду. После добавления массив пересортируется
 *  по возрастанию volts и сохраняется в EEPROM.
 */
void addCalibrationPoint(float amps, float volts) {
    if (calCount >= MAX_POINTS) {
        sendResponse(F("ERR:TABLE_FULL"));
        return;
    }
    calPoints[calCount].amps  = amps;
    calPoints[calCount].volts = volts;
    calCount++;
    sortCalibration();
    saveCalibration();

    // Подтверждение
    char buf[48];
    snprintf(buf, sizeof(buf), "OK:ADD:%d", (int)calCount);
    sendResponse(buf);
}

/*
 *  Удалить точку по индексу (0-based).
 */
void removeCalibrationPoint(uint8_t index) {
    if (index >= calCount) {
        sendResponse(F("ERR:INDEX"));
        return;
    }
    for (uint8_t i = index; i < calCount - 1; i++) {
        calPoints[i] = calPoints[i + 1];
    }
    calCount--;
    saveCalibration();

    char buf[48];
    snprintf(buf, sizeof(buf), "OK:DEL:%d", (int)calCount);
    sendResponse(buf);
}

/*
 *  Сортировка пузырьком по возрастанию volts.
 *  Для 15 элементов — более чем достаточно.
 */
void sortCalibration() {
    for (uint8_t i = 0; i < calCount; i++) {
        for (uint8_t j = i + 1; j < calCount; j++) {
            if (calPoints[j].volts < calPoints[i].volts) {
                Point tmp = calPoints[i];
                calPoints[i] = calPoints[j];
                calPoints[j] = tmp;
            }
        }
    }
}

/* ================================================================== */
/*  Перевод напряжения → ток                                         */
/* ================================================================== */

/*
 *  Кусочно-линейная интерполяция по калибровочной таблице.
 *  - volts <  V[0]  → экстраполяция по первым двум точкам
 *  - volts >  V[n-1]→ экстраполяция по последним двум точкам
 *  - иначе         → линейная интерполяция между соседями
 */
float voltsToAmps(float v) {
    if (calCount == 0) {
        return 0.0f;
    }
    if (calCount == 1) {
        return calPoints[0].amps;
    }

    float result = 0.0f;

    // Ниже минимальной — экстраполяция
    if (v <= calPoints[0].volts) {
        float dv = calPoints[1].volts - calPoints[0].volts;
        if (dv == 0.0f) return calPoints[0].amps;
        float slope = (calPoints[1].amps - calPoints[0].amps) / dv;
        result = calPoints[0].amps + slope * (v - calPoints[0].volts);
    }
    // Выше максимальной — экстраполяция
    else if (v >= calPoints[calCount - 1].volts) {
        float dv = calPoints[calCount - 1].volts - calPoints[calCount - 2].volts;
        if (dv == 0.0f) return calPoints[calCount - 1].amps;
        float slope = (calPoints[calCount - 1].amps - calPoints[calCount - 2].amps) / dv;
        result = calPoints[calCount - 1].amps + slope * (v - calPoints[calCount - 1].volts);
    }
    // Внутри диапазона — бинарный поиск соседа
    else {
        uint8_t lo = 0, hi = calCount - 1;
        while (hi - lo > 1) {
            uint8_t mid = (lo + hi) / 2;
            if (calPoints[mid].volts <= v) lo = mid;
            else                          hi = mid;
        }
        float dv = calPoints[hi].volts - calPoints[lo].volts;
        if (dv == 0.0f) return calPoints[lo].amps;
        float slope = (calPoints[hi].amps - calPoints[lo].amps) / dv;
        result = calPoints[lo].amps + slope * (v - calPoints[lo].volts);
    }

    // Нет инверсии — ток не может быть отрицательным
    if (result < 0.0f) result = 0.0f;
    return result;
}

/* ================================================================== */
/*  АЦП                                                               */
/* ================================================================== */

/*
 *  Считать AVG_SAMPLES отсчётов АЦП и вернуть среднее напряжение.
 *  Используем плавающее накопление для точности.
 */
float readAverageVolts() {
    long sum = 0;
    for (uint8_t i = 0; i < AVG_SAMPLES; i++) {
        sum += analogRead(SENSOR_PIN);
    }
    float avgCounts = (float)sum / (float)AVG_SAMPLES;
    return avgCounts * (ADC_REF_VOLTAGE / ADC_MAX_COUNTS);
}

/* ================================================================== */
/*  Выдача данных                                                     */
/* ================================================================== */

void sendDataLine() {
    float v = readAverageVolts();
    float a = voltsToAmps(v);

    // Запрет отрицательных токов (нет инверсии)
    if (a < 0.0f) a = 0.0f;

    // Формат: DATA:<amps>:<volts>\n
    char buf[48];
    char vStr[12];
    char aStr[12];
    dtostrf(a, 0, 3, aStr);
    dtostrf(v, 0, 3, vStr);
    snprintf(buf, sizeof(buf), "DATA:%s:%s", aStr, vStr);
    Serial.print(buf);
    Serial.print('\n');
}

void sendPointsList() {
    // Формат: POINTS:<count>:<v0>:<a0>:<v1>:<a1>:...
    // Пишем напрямую в Serial без промежуточного буфера: при 15 точках
    // строка занимает ~210 байт и не помещалась в прежний буфер 128 байт,
    // что обрезало данные и вызывало переполнение стека.
    Serial.print(F("POINTS:"));
    Serial.print((int)calCount);
    for (uint8_t i = 0; i < calCount; i++) {
        char vStr[12];
        char aStr[12];
        dtostrf(calPoints[i].volts, 0, 3, vStr);
        dtostrf(calPoints[i].amps, 0, 3, aStr);
        Serial.print(':');
        Serial.print(vStr);
        Serial.print(':');
        Serial.print(aStr);
    }
    Serial.print('\n');
}

/* ================================================================== */
/*  Разбор команд                                                     */
/* ================================================================== */

/*
 *  Разбор входной команды. Поддерживаемые команды:
 *      CAL:CLEAR
 *      CAL:ADD:<amps>:<volts>
 *      CAL:LIST
 *      CAL:COUNT
 *      PING
 */
void processCommand(char* cmd) {
    // Копия строки, т.к. strtok модифицирует её
    char buf[64];
    strncpy(buf, cmd, sizeof(buf) - 1);
    buf[sizeof(buf) - 1] = '\0';

    // PING → PONG
    if (strncmp(buf, "PING", 4) == 0 && (buf[4] == '\0' || buf[4] == ':')) {
        sendResponse(F("PONG"));
        return;
    }

    // RAW → вывести сырые АЦП для отладки
    if (strncmp(buf, "RAW", 3) == 0 && (buf[3] == '\0' || buf[3] == ':')) {
        long sum = 0;
        for (uint8_t i = 0; i < AVG_SAMPLES; i++) {
            sum += analogRead(SENSOR_PIN);
        }
        float avgCounts = (float)sum / (float)AVG_SAMPLES;
        float v = avgCounts * (ADC_REF_VOLTAGE / ADC_MAX_COUNTS);
        char out[64];
        char cntStr[12];
        char vStr[12];
        dtostrf(avgCounts, 0, 1, cntStr);
        dtostrf(v, 0, 4, vStr);
        snprintf(out, sizeof(out), "RAW:%s:%s", cntStr, vStr);
        sendResponse(out);
        return;
    }

    // CAL:...
    if (strncmp(buf, "CAL:", 4) == 0) {
        char* sub = buf + 4;

        // CAL:CLEAR
        if (strncmp(sub, "CLEAR", 5) == 0 && (sub[5] == '\0' || sub[5] == ':')) {
            clearCalibration();
            sendResponse(F("OK:CLEAR"));
            return;
        }

        // CAL:ADD:<amps>:<volts>
        if (strncmp(sub, "ADD:", 4) == 0) {
            char* p = sub + 4;
            char* colon = strchr(p, ':');
            if (!colon) {
                sendResponse(F("ERR:FORMAT"));
                return;
            }
            *colon = '\0';
            float amps  = atof(p);
            float volts = atof(colon + 1);
            addCalibrationPoint(amps, volts);
            return;
        }

        // CAL:DEL:<index>
        if (strncmp(sub, "DEL:", 4) == 0) {
            uint8_t idx = (uint8_t)atoi(sub + 4);
            removeCalibrationPoint(idx);
            return;
        }

        // CAL:LIST
        if (strncmp(sub, "LIST", 4) == 0) {
            sendPointsList();
            return;
        }

        // CAL:COUNT
        if (strncmp(sub, "COUNT", 5) == 0 && (sub[5] == '\0' || sub[5] == ':')) {
            char b[24];
            snprintf(b, sizeof(b), "COUNT:%d", (int)calCount);
            sendResponse(b);
            return;
        }

        sendResponse(F("ERR:UNKNOWN_CAL"));
        return;
    }

    sendResponse(F("ERR:UNKNOWN_CMD"));
}

void sendResponse(const char* msg) {
    Serial.print(msg);
    Serial.print('\n');
}

void sendResponse(const __FlashStringHelper* msg) {
    Serial.print(msg);
    Serial.print('\n');
}

# UAV Test & Calibration Station

Черновой проект десктопного приложения для автоматизированного тестирования и настройки БПЛА на базе ArduPilot.

Приложение должно подключаться к полётному контроллеру по MAVLink, управлять стендовыми испытаниями, получать измерения от внешних эталонных датчиков, сравнивать их с телеметрией контроллера и безопасно предлагать или применять изменения параметров.

## Статус

Проект находится на стадии начальной реализации. Создан и проверен каркас Tauri 2 + Rust + Preact/Vite. Документы в каталоге `docs/` являются рабочими и будут уточняться по мере проверки оборудования и сценариев использования.

## Разработка

Требуется Node.js, npm и актуальный Rust toolchain.

```shell
npm install
npm run tauri dev
```

Проверки и release-сборка без создания установочного пакета:

```shell
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --no-bundle
```

Frontend находится в `src/`, нативная часть и Tauri-конфигурация — в `src-tauri/`.

## Документы

- [Концепция продукта](docs/01-product-concept.md)
- [Архитектура](docs/02-architecture.md)
- [Сценарии испытаний](docs/03-test-scripting.md)
- [Калибровка тока](docs/04-current-calibration.md)
- [Безопасность](docs/05-safety.md)
- [План MVP и открытые вопросы](docs/06-mvp-roadmap.md)
- [Технологический стек и сборка](docs/07-technology-stack.md)
- [Подключения и управляющий канал](docs/08-connectivity-and-control.md)
- [Пошаговый план разработки](docs/09-development-plan.md)

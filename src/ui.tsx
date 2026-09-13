import type { ComponentChildren, JSX } from "preact";

type InputProps = JSX.InputHTMLAttributes<HTMLInputElement>;
type SelectProps = JSX.SelectHTMLAttributes<HTMLSelectElement> & {
  children: ComponentChildren;
};
type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ComponentChildren;
  tone?: "default" | "primary" | "danger";
};

function classNames(...values: unknown[]) {
  return values
    .filter((value): value is string => typeof value === "string" && Boolean(value))
    .join(" ");
}

/** Базовое поле ввода в едином визуальном стиле приложения. */
export function UiInput({ class: className, ...props }: InputProps) {
  return <input class={classNames("ui-control", className)} {...props} />;
}

/** Базовый выпадающий список в едином визуальном стиле приложения. */
export function UiSelect({ class: className, children, ...props }: SelectProps) {
  return (
    <select class={classNames("ui-control", className)} {...props}>
      {children}
    </select>
  );
}

/** Базовая кнопка: цвет передаётся семантически, а не локальными стилями. */
export function UiButton({ class: className, children, tone = "default", ...props }: ButtonProps) {
  return (
    <button class={classNames("ui-button", `ui-button-${tone}`, className)} {...props}>
      {children}
    </button>
  );
}

/** Стандартная поверхность для карточек и панелей. */
export function UiPanel({
  class: className,
  children,
}: {
  class?: string;
  children: ComponentChildren;
}) {
  return <section class={classNames("ui-panel", className)}>{children}</section>;
}

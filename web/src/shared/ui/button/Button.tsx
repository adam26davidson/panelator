import { Link, type LinkProps } from "@tanstack/react-router";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary";

const LOOKS: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "border-border-strong bg-transparent text-text hover:bg-raised",
};

function look(variant: ButtonVariant): string {
  return `inline-flex min-h-tap cursor-pointer items-center justify-center rounded-sm border-(length:--line) px-6 font-semibold leading-tight no-underline ${LOOKS[variant]}`;
}

/** A `button` in the primary or secondary look, 44px tall. */
export function Button({
  variant,
  children,
  ...rest
}: { variant: ButtonVariant; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  return (
    <button type="button" className={look(variant)} {...rest}>
      {children}
    </button>
  );
}

/** A router link in the same two looks. */
export function ButtonLink(props: {
  variant: ButtonVariant;
  to: LinkProps["to"];
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Link to={props.to} onClick={props.onClick} className={look(props.variant)}>
      {props.children}
    </Link>
  );
}

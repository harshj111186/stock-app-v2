"use client";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEscape } from "@/lib/hooks";

// Styled, promise-based replacement for window.confirm() / window.prompt().
//
// The audit found 13 native confirm/prompt call sites (browser chrome inside
// a premium UI, and Users entered a NEW PASSWORD through a cleartext
// prompt()). One hook now serves them all:
//
//   const { confirm, confirmDialog } = useConfirm();
//   ...
//   const ok = await confirm({ title: "Reverse this transaction?", danger: true });
//   if (!ok) return;
//   ...
//   return <>{page}{confirmDialog}</>;
//
// With `input`, resolves the typed string (or null on cancel):
//   const pwd = await confirm({ title: "Reset password", input: { label: "New password", type: "password" } });
export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  input?: {
    label: string;
    placeholder?: string;
    type?: "text" | "password";
    initial?: string;
    // Return an error string to block confirm, null/undefined to allow.
    validate?: (value: string) => string | null | undefined;
  };
};

type ActiveDialog = ConfirmOptions & { resolve: (v: boolean | string | null) => void };

export function useConfirm() {
  const [active, setActive] = useState<ActiveDialog | null>(null);
  const [value, setValue] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean | string | null> => {
    return new Promise((resolve) => {
      setValue(opts.input?.initial ?? "");
      setInputError(null);
      setActive({ ...opts, resolve });
    });
  }, []);

  const close = useCallback((result: boolean | string | null) => {
    setActive((cur) => {
      cur?.resolve(result);
      return null;
    });
  }, []);

  const cancel = useCallback(() => close(active?.input ? null : false), [active, close]);
  useEscape(!!active, cancel);

  const submit = () => {
    if (!active) return;
    if (active.input) {
      const err = active.input.validate?.(value);
      if (err) { setInputError(err); inputRef.current?.focus(); return; }
      close(value);
    } else {
      close(true);
    }
  };

  const confirmDialog = active ? (
    <div
      className="fixed inset-0 z-[70] bg-black/50 dark:bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={active.title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}
    >
      <div className="w-full sm:max-w-sm bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-lg animate-slide-up">
        <div className="px-5 pt-4 pb-1 flex items-start gap-3">
          {active.danger && (
            <span className="mt-0.5 w-8 h-8 shrink-0 rounded-full bg-rose-500/10 flex items-center justify-center">
              <AlertTriangle className="w-4 h-4 text-rose-500" />
            </span>
          )}
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold">{active.title}</h2>
            {active.body && (
              <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{active.body}</div>
            )}
          </div>
          <button
            type="button"
            onClick={cancel}
            aria-label="Close"
            className="-m-1 p-2 min-w-9 min-h-9 flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {active.input && (
          <div className="px-5 pt-3">
            <label className="block text-[11px] uppercase tracking-wider text-zinc-500 font-medium mb-1.5">
              {active.input.label}
            </label>
            <input
              ref={inputRef}
              autoFocus
              type={active.input.type ?? "text"}
              value={value}
              placeholder={active.input.placeholder}
              onChange={(e) => { setValue(e.target.value); setInputError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-cyan-500"
            />
            {inputError && (
              <div className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">{inputError}</div>
            )}
          </div>
        )}

        <div
          className="px-5 py-4 flex items-center justify-end gap-2"
          style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <button
            type="button"
            onClick={cancel}
            className="px-3.5 py-2 min-h-11 sm:min-h-0 text-sm text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md"
          >
            {active.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            autoFocus={!active.input}
            onClick={submit}
            className={cn(
              "px-3.5 py-2 min-h-11 sm:min-h-0 rounded-md text-sm font-medium text-white",
              active.danger ? "bg-rose-600 hover:bg-rose-500" : "bg-cyan-500 hover:bg-cyan-400"
            )}
          >
            {active.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, confirmDialog };
}

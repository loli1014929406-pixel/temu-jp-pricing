import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

type FieldProps = {
  label: string;
  children: ReactNode;
};

export function Field({ label, children }: FieldProps) {
  return (
    <label className="grid gap-2 text-sm text-slate-700">
      <span className="font-semibold">{label}</span>
      {children}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-inner outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15 disabled:bg-slate-100 disabled:text-slate-500"
    />
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className="min-h-24 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-inner outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/15 disabled:bg-slate-100 disabled:text-slate-500"
    />
  );
}

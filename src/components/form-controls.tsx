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
      className="h-10 w-full min-w-0 rounded-lg border border-line bg-white px-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-accent focus:ring-2 focus:ring-black/10 disabled:bg-[#f1f1f1] disabled:text-slate-500"
    />
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className="min-h-24 w-full min-w-0 rounded-lg border border-line bg-white px-3 py-2.5 text-sm outline-none transition placeholder:text-slate-400 focus:border-accent focus:ring-2 focus:ring-black/10 disabled:bg-[#f1f1f1] disabled:text-slate-500"
    />
  );
}

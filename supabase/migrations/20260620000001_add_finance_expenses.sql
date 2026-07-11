-- Enable the moddatetime extension if not exists
CREATE EXTENSION IF NOT EXISTS moddatetime SCHEMA extensions;

-- Create finance_expenses table
CREATE TABLE public.finance_expenses (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expense_date date NOT NULL,
  category text NOT NULL,
  amount_rmb numeric(12,2) NOT NULL DEFAULT 0,
  remark text,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT finance_expenses_pkey PRIMARY KEY (id)
);

-- Set up RLS
ALTER TABLE public.finance_expenses ENABLE ROW LEVEL SECURITY;

-- Allow users to manage their own expenses
CREATE POLICY "Users can manage their own expenses" ON public.finance_expenses
  FOR ALL USING (auth.uid() = user_id);

-- Create updated_at trigger
CREATE TRIGGER handle_updated_at BEFORE UPDATE ON public.finance_expenses
  FOR EACH ROW EXECUTE PROCEDURE extensions.moddatetime('updated_at');

-- Index for querying by date and user
CREATE INDEX idx_finance_expenses_user_date ON public.finance_expenses(user_id, expense_date);

-- Grant permissions to Supabase API roles
GRANT ALL ON TABLE public.finance_expenses TO anon;
GRANT ALL ON TABLE public.finance_expenses TO authenticated;
GRANT ALL ON TABLE public.finance_expenses TO service_role;

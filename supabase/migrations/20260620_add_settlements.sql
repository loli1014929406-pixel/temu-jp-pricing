-- Enable the moddatetime extension if not exists
CREATE EXTENSION IF NOT EXISTS moddatetime SCHEMA extensions;

-- Create finance_settlement_files table
CREATE TABLE public.finance_settlement_files (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  date_range_start text NOT NULL,
  date_range_end text NOT NULL,
  total_sales_revenue numeric(12,2) NOT NULL DEFAULT 0,
  total_freight_revenue numeric(12,2) NOT NULL DEFAULT 0,
  total_revenue numeric(12,2) NOT NULL DEFAULT 0,
  record_count integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT finance_settlement_files_pkey PRIMARY KEY (id)
);

-- Create finance_settlement_records table
CREATE TABLE public.finance_settlement_records (
  id uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES public.finance_settlement_files(id) ON DELETE CASCADE,
  po_number text NOT NULL,
  sku_id text NOT NULL,
  sku_name text NOT NULL,
  sku_code text NOT NULL,
  quantity integer NOT NULL DEFAULT 0,
  declared_price numeric(12,2) NOT NULL DEFAULT 0,
  is_promotion_price boolean NOT NULL DEFAULT false,
  currency text NOT NULL DEFAULT 'CNY',
  sales_revenue numeric(12,2) NOT NULL DEFAULT 0,
  sales_discount_deducted numeric(12,2) NOT NULL DEFAULT 0,
  sales_reversal numeric(12,2) NOT NULL DEFAULT 0,
  freight_revenue numeric(12,2) NOT NULL DEFAULT 0,
  freight_discount_deducted numeric(12,2) NOT NULL DEFAULT 0,
  freight_reversal numeric(12,2) NOT NULL DEFAULT 0,
  total_revenue numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT finance_settlement_records_pkey PRIMARY KEY (id)
);

-- Set up RLS for files
ALTER TABLE public.finance_settlement_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage their own settlement files" ON public.finance_settlement_files
  FOR ALL USING (auth.uid() = user_id);

-- Set up RLS for records
ALTER TABLE public.finance_settlement_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage their own settlement records" ON public.finance_settlement_records
  FOR ALL USING (auth.uid() = user_id);

-- Create updated_at triggers
CREATE TRIGGER handle_updated_at_files BEFORE UPDATE ON public.finance_settlement_files
  FOR EACH ROW EXECUTE PROCEDURE extensions.moddatetime('updated_at');

CREATE TRIGGER handle_updated_at_records BEFORE UPDATE ON public.finance_settlement_records
  FOR EACH ROW EXECUTE PROCEDURE extensions.moddatetime('updated_at');

-- Indexes
CREATE INDEX idx_finance_settlement_files_user ON public.finance_settlement_files(user_id);
CREATE INDEX idx_finance_settlement_records_file ON public.finance_settlement_records(file_id);
CREATE INDEX idx_finance_settlement_records_po ON public.finance_settlement_records(po_number);
CREATE INDEX idx_finance_settlement_records_sku ON public.finance_settlement_records(sku_code);

-- Grant permissions to Supabase API roles
GRANT ALL ON TABLE public.finance_settlement_files TO anon;
GRANT ALL ON TABLE public.finance_settlement_files TO authenticated;
GRANT ALL ON TABLE public.finance_settlement_files TO service_role;

GRANT ALL ON TABLE public.finance_settlement_records TO anon;
GRANT ALL ON TABLE public.finance_settlement_records TO authenticated;
GRANT ALL ON TABLE public.finance_settlement_records TO service_role;

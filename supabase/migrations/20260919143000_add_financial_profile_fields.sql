alter table public.kyc_applications
  add column if not exists employment_status text,
  add column if not exists source_of_funds text,
  add column if not exists expected_monthly_volume text,
  add column if not exists bank_country text,
  add column if not exists bank_name text,
  add column if not exists bank_account_holder text,
  add column if not exists bank_account_number text,
  add column if not exists bank_iban text,
  add column if not exists bank_swift_bic text;

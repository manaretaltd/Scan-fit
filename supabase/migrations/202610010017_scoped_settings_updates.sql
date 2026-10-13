begin;

-- Hosted Supabase rejects UPDATE statements without a WHERE clause. These
-- settings tables each contain one row, identified by their checked boolean PK.
-- Keep existing validation, permissions, RLS and audit triggers unchanged.
create or replace function public.configure_finance(requirement text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.has_permission('staff.manage') then raise exception 'Access denied';end if;
 update public.finance_settings set manufacturer_requirement=requirement where id=true;
end $$;

create or replace function public.save_company_settings(payload jsonb,verified boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.has_permission('company.manage') then raise exception 'Access denied';end if;
 if jsonb_typeof(payload)<>'object' or length(payload::text)>20000 or payload->>'currency'<>'GBP' then raise exception 'Invalid company settings. GBP is currently supported';end if;
 if verified and not public.company_valid(payload) then raise exception 'Invoice settings are incomplete. Complete Company Settings before issuing this invoice.';end if;
 if (payload->>'default_vat_rate')::numeric not between 0 and 100 then raise exception 'Invalid default VAT rate';end if;
 update public.company_settings set details=payload,verified_by=case when verified then auth.uid() end,verified_at=case when verified then now() end,updated_at=now() where id=true;
end $$;

create or replace function public.configure_media(settings jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.has_permission('staff.manage') then raise exception 'Permission denied';end if;
 if length(coalesce(settings->>'manufacturer_name',''))>200 or length(coalesce(settings->>'manufacturer_email',''))>254 then raise exception 'Contact too long';end if;
 update public.media_settings set manufacturer_name=coalesce(settings->>'manufacturer_name',''),manufacturer_email=coalesce(settings->>'manufacturer_email',''),image_limit=(settings->>'image_limit')::bigint,pdf_limit=(settings->>'pdf_limit')::bigint,video_limit=(settings->>'video_limit')::bigint where id=true;
end $$;

commit;

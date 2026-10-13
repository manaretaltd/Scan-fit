begin;
insert into public.role_permissions values('administrator','invoices.issue'),('finance','invoices.issue'),('administrator','company.manage');
create table public.company_settings(id boolean primary key default true check(id),details jsonb not null default '{"legal_name":"Manareta Ltd","currency":"GBP","invoice_prefix":"MAN-INV","vat_registered":null,"default_vat_rate":"0","default_vat_applicable":false}',verified_by uuid references public.users(id),verified_at timestamptz,updated_at timestamptz not null default now());
insert into public.company_settings default values;
alter table public.company_settings enable row level security;
revoke all on public.company_settings from anon,authenticated;
grant select on public.company_settings to authenticated;
create policy company_read on public.company_settings for select to authenticated using(public.has_permission('finance.read'));
create trigger audit_company_settings after update on public.company_settings for each row execute function public.audit_change();
create function public.company_valid(d jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(length(trim(d->>'legal_name'))>0 and length(trim(d->>'address'))>0 and length(trim(d->>'company_number'))>0 and length(trim(d->>'registration_country'))>0 and length(trim(d->>'email'))>0 and d->>'currency'='GBP' and d->>'invoice_prefix' ~ '^[A-Z][A-Z0-9-]{1,19}$' and d->>'vat_registered' in ('true','false') and (d->>'vat_registered'='false' or regexp_replace(d->>'vat_number','[[:space:]]','','g') ~ '^(GB)?[0-9]{9}([0-9]{3})?$'),false);
$$;
create function public.save_company_settings(payload jsonb,verified boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.has_permission('company.manage') then raise exception 'Access denied';end if;
 if jsonb_typeof(payload)<>'object' or length(payload::text)>20000 or payload->>'currency'<>'GBP' then raise exception 'Invalid company settings. GBP is currently supported';end if;
 if verified and not public.company_valid(payload) then raise exception 'Invoice settings are incomplete. Complete Company Settings before issuing this invoice.';end if;
 if (payload->>'default_vat_rate')::numeric not between 0 and 100 then raise exception 'Invalid default VAT rate';end if;
 update public.company_settings set details=payload,verified_by=case when verified then auth.uid() end,verified_at=case when verified then now() end,updated_at=now();
end $$;
create table public.invoice_counters(year integer primary key,last_number bigint not null);
revoke all on public.invoice_counters from anon,authenticated;
alter table public.invoice_counters enable row level security;
create table public.invoices(
 id uuid primary key default gen_random_uuid(),invoice_number text not null unique,order_id uuid not null references public.orders(id),customer_id uuid not null references public.customers(id),
 invoice_date date not null,supply_date date not null,due_date date,status text not null default 'Draft' check(status in ('Draft','Issued','Partially Paid','Paid','Cancelled','Credited')),currency text not null check(currency='GBP'),
 subtotal_net numeric(14,2) not null,discount_total numeric(14,2) not null,vat_total numeric(14,2) not null,gross_total numeric(14,2) not null,amount_paid numeric(14,2) not null,amount_due numeric(14,2) not null,
 snapshot jsonb not null,created_by uuid not null references public.users(id),created_at timestamptz not null default now(),issued_at timestamptz,pdf_storage_path text unique,pdf_sha256 text,notes text not null default '',replaces_invoice_id uuid references public.invoices(id),cancel_reason text not null default ''
);
create unique index one_active_order_invoice on public.invoices(order_id) where status not in ('Cancelled','Credited');
alter table public.invoices enable row level security;
revoke all on public.invoices from anon,authenticated;
grant select on public.invoices to authenticated;
create policy invoices_read on public.invoices for select to authenticated using(public.has_permission('finance.read') and public.can_read_order(order_id));
create trigger audit_invoices after insert or update on public.invoices for each row execute function public.audit_order_change();
alter table public.payments add column invoice_id uuid references public.invoices(id);
create function public.invoice_preview(target uuid,supplied date,pay_by date,note text default '') returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare o public.orders;c public.customers;company public.company_settings;billing jsonb;lines jsonb;result jsonb;
begin
 if not public.has_permission('invoices.issue') or not public.can_read_order(target) then raise exception 'Access denied';end if;
 select * into o from public.orders where id=target;if not found or o.status='Draft' then raise exception 'Confirm the order before generating an invoice';end if;
 if supplied is null or not isfinite(supplied) or (pay_by is not null and not isfinite(pay_by)) or length(note)>2000 then raise exception 'Enter valid supply/due dates and notes';end if;
 select * into c from public.customers where id=o.customer_id;
 select * into company from public.company_settings;
 select to_jsonb(a) into billing from public.customer_addresses a where a.customer_id=c.id and kind='Practice';
 select coalesce(jsonb_agg(x.line order by x.sort),'[]') into lines from (
 select case kind when 'Loupe' then 1 when 'Light' then 2 else 3 end sort,jsonb_build_object('id',id,'description',description,'sku',sku,'kind',kind,'quantity',quantity,'unit_price',unit_price::text,'subtotal',subtotal::text,'discount',discount_amount::text,'net',(subtotal-discount_amount)::text,'vat_applicable',vat_applicable,'vat_rate',vat_rate::text,'vat',vat_amount::text,'total',total::text) line from public.order_items where order_id=target
 union all select 4,jsonb_build_object('id',id,'description',description,'sku','','kind',category,'quantity',1,'unit_price',amount::text,'subtotal',amount::text,'discount','0','net',amount::text,'vat_applicable',vat_applicable,'vat_rate',vat_rate::text,'vat',vat_amount::text,'total',total::text) from public.order_charges where order_id=target
 ) x;
 result=jsonb_build_object('order_id',o.id,'order_number',o.order_number,'order_version',o.version,'customer_id',c.id,'customer_name',concat_ws(' ',c.first_name,c.last_name),'practice',c.practice_name,'billing_address',billing,'company',company.details,'company_verified',company.verified_at is not null,'company_version',company.updated_at,'invoice_date',current_date,'supply_date',supplied,'due_date',pay_by,'currency','GBP','lines',lines,'subtotal',o.subtotal::text,'discount',o.discount_total::text,'net',(o.subtotal-o.discount_total)::text,'vat',o.vat_total::text,'total',o.total::text,'payments',o.amount_paid::text,'refunds',o.refunds_total::text,'net_received',o.net_received::text,'balance',o.balance::text,'notes',note);
 return jsonb_build_object('snapshot',result,'fingerprint',md5(result::text));
end $$;
create function public.reserve_invoice(target uuid,supplied date,pay_by date,note text,expected text) returns uuid language plpgsql security definer set search_path='' as $$
declare preview jsonb;s jsonb;company public.company_settings;invoice uuid;seq bigint;yr integer;
begin
 if not public.has_permission('invoices.issue') or not public.can_read_order(target) then raise exception 'Access denied';end if;
 perform 1 from public.orders where id=target for update;
 select id into invoice from public.invoices where order_id=target and status not in ('Cancelled','Credited');
 if found then return invoice;end if;
 select * into company from public.company_settings for share;
 if company.verified_at is null or not public.company_valid(company.details) then raise exception 'Invoice settings are incomplete. Complete Company Settings before issuing this invoice.';end if;
 preview=public.invoice_preview(target,supplied,pay_by,note);s=preview->'snapshot';
 if expected is distinct from preview->>'fingerprint' then raise exception 'Invoice data changed. Review the invoice again before issuing';end if;
 if coalesce(length(trim(s->'billing_address'->>'line1')),0)=0 or coalesce(length(trim(s->'billing_address'->>'country')),0)=0 then raise exception 'Enter a customer billing address before issuing';end if;
 if company.details->>'vat_registered'='false' and (s->>'vat')::numeric<>0 then raise exception 'VAT is charged but Company Settings say not VAT registered. Correct the order VAT before issuing';end if;
 yr=extract(year from current_date);
 insert into public.invoice_counters values(yr,1) on conflict(year) do update set last_number=invoice_counters.last_number+1 returning last_number into seq;
 insert into public.invoices(invoice_number,order_id,customer_id,invoice_date,supply_date,due_date,currency,subtotal_net,discount_total,vat_total,gross_total,amount_paid,amount_due,snapshot,created_by,notes)
 values((company.details->>'invoice_prefix')||'-'||yr||'-'||lpad(seq::text,greatest(4,length(seq::text)),'0'),target,(s->>'customer_id')::uuid,current_date,supplied,pay_by,'GBP',(s->>'net')::numeric,(s->>'discount')::numeric,(s->>'vat')::numeric,(s->>'total')::numeric,(s->>'net_received')::numeric,(s->>'balance')::numeric,s,auth.uid(),note) returning id into invoice;
 return invoice;
end $$;
-- PDF upload/finalisation are server-only. Client roles cannot upload arbitrary authoritative PDFs.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('invoices','invoices',false,10485760,array['application/pdf']),('company-assets','company-assets',false,2097152,array['image/png','image/jpeg']);
create policy invoice_pdf_read on storage.objects for select to authenticated using(bucket_id='invoices' and exists(select 1 from public.invoices i where i.pdf_storage_path=name and i.issued_at is not null));
create policy company_assets_read on storage.objects for select to authenticated using(bucket_id='company-assets' and public.has_permission('finance.read'));
create function public.finalize_invoice(target uuid,actor uuid,path text,sha text) returns void language plpgsql security definer set search_path='' as $$
declare i public.invoices;o public.orders;
begin
 select * into i from public.invoices where id=target;
 perform 1 from public.orders where id=i.order_id for update;
 select * into i from public.invoices where id=target for update;
 if not found then raise exception 'Invoice missing';end if;
 if not exists(select 1 from public.users u join public.role_permissions p on p.role=u.role where u.id=actor and u.active and p.permission='invoices.issue') then raise exception 'Access denied';end if;
 if i.issued_at is not null then return;end if;
 if i.status<>'Draft' or path<>i.id::text||'/invoice.pdf' or sha !~ '^[0-9a-f]{64}$' or not exists(select 1 from storage.objects where bucket_id='invoices' and name=path) then raise exception 'Invoice PDF not ready';end if;
 select * into o from public.orders where id=i.order_id for update;
 update public.invoices set issued_at=now(),pdf_storage_path=path,pdf_sha256=sha,amount_paid=o.net_received,amount_due=gross_total-o.net_received,status=case when o.net_received>=gross_total then 'Paid' when o.net_received>0 then 'Partially Paid' else 'Issued' end where id=target;
 -- Identity-only link; no financial receipt is duplicated or changed.
 update public.payments set invoice_id=target where order_id=i.order_id and invoice_id is null;
 insert into public.order_events(order_id,kind,description,audience,user_id) values(i.order_id,'Invoice issued',i.invoice_number,'finance',actor);
 insert into public.audit_logs(user_id,action,entity_type,entity_id,new_value) values(actor,'INVOICE_ISSUED','invoices',target,jsonb_build_object('invoice_number',i.invoice_number,'pdf_sha256',sha));
end $$;
-- Preserve immutable financial content while allowing the system to attach invoice identity.
create or replace function public.payment_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then if old.status<>'Pending' then raise exception 'Recorded transactions cannot be deleted; record a refund';end if;return old;end if;
 if tg_op='UPDATE' and old.status<>'Pending' and (to_jsonb(new)-'status'-'invoice_id') is distinct from (to_jsonb(old)-'status'-'invoice_id') then raise exception 'Recorded transactions are immutable';end if;
 if tg_op='INSERT' then
 select customer_id into new.customer_id from public.orders where id=new.order_id;
 new.created_by=coalesce(new.created_by,auth.uid());new.paid_at=coalesce(new.paid_at,new.payment_date::timestamptz);
 select id into new.invoice_id from public.invoices where order_id=new.order_id and issued_at is not null and status not in ('Cancelled','Credited');
 end if;
 if not isfinite(new.payment_date) or not isfinite(new.paid_at) or new.amount<>round(new.amount,2) or length(new.reference)>200 or length(new.notes)>1000 then raise exception 'Invalid payment';end if;
 return new;
end $$;
create function public.sync_invoice_settlement() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.invoices set amount_paid=new.net_received,amount_due=gross_total-new.net_received,status=case when new.net_received>=gross_total then 'Paid' when new.net_received>0 then 'Partially Paid' else 'Issued' end where order_id=new.id and issued_at is not null and status not in ('Cancelled','Credited') and (amount_paid is distinct from new.net_received or amount_due is distinct from gross_total-new.net_received);
 return new;
end $$;
create trigger sync_invoice_settlement after update of net_received on public.orders for each row execute function public.sync_invoice_settlement();
alter function public.finance_operation(uuid,text,jsonb,uuid) rename to finance_operation_phase5;
revoke all on function public.finance_operation_phase5(uuid,text,jsonb,uuid) from public,anon,authenticated;
create function public.finance_operation(target uuid,operation text,payload jsonb,request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.can_read_order(target) then raise exception 'Open a permitted confirmed order';end if;
 if not public.has_permission(case operation when 'refund' then 'finance.refund' when 'discount' then 'finance.discount' when 'charge' then 'finance.discount' else 'orders.pay' end) then raise exception 'Access denied';end if;
 perform 1 from public.orders where id=target for update;
 if operation in ('discount','charge') and exists(select 1 from public.invoices where order_id=target and status not in ('Cancelled','Credited')) then raise exception 'Invoice financial snapshot is locked. Cancel an unissued draft, or arrange a credit note/replacement for an issued invoice';end if;
 return public.finance_operation_phase5(target,operation,payload,request_id);
end $$;
create function public.cancel_invoice_draft(target uuid,reason text) returns void language plpgsql security definer set search_path='' as $$
declare i public.invoices;
begin
 select * into i from public.invoices where id=target;
 if not public.has_permission('invoices.issue') or not public.can_read_order(i.order_id) or length(trim(reason)) not between 1 and 1000 then raise exception 'Access denied or reason missing';end if;
 perform 1 from public.orders where id=i.order_id for update;
 update public.invoices set status='Cancelled',cancel_reason=reason where id=target and status='Draft' and issued_at is null;
 if not found then raise exception 'Only an unissued draft can be cancelled';end if;
 perform public.order_event(i.order_id,'Invoice draft cancelled',i.invoice_number||': '||reason,'finance');
end $$;
revoke all on function public.company_valid(jsonb),public.save_company_settings(jsonb,boolean),public.invoice_preview(uuid,date,date,text),public.reserve_invoice(uuid,date,date,text,text),public.finalize_invoice(uuid,uuid,text,text),public.sync_invoice_settlement(),public.finance_operation(uuid,text,jsonb,uuid),public.cancel_invoice_draft(uuid,text) from public,anon,authenticated;
grant execute on function public.company_valid(jsonb),public.save_company_settings(jsonb,boolean),public.invoice_preview(uuid,date,date,text),public.reserve_invoice(uuid,date,date,text,text),public.finance_operation(uuid,text,jsonb,uuid),public.cancel_invoice_draft(uuid,text) to authenticated;
grant execute on function public.finalize_invoice(uuid,uuid,text,text) to service_role;
commit;

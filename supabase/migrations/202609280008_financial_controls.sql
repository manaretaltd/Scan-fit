begin;
insert into public.role_permissions values
('administrator','finance.read'),('sales','finance.read'),('finance','finance.read'),
('administrator','finance.discount'),('sales','finance.discount'),('finance','finance.discount'),
('administrator','finance.refund'),('finance','finance.refund'),
('administrator','finance.overpay'),('finance','finance.overpay'),
('administrator','system.health');
alter table public.products add column default_vat_rate numeric(5,2) not null default 0 check(default_vat_rate between 0 and 100),add column default_vat_applicable boolean not null default true;
create table public.finance_settings(id boolean primary key default true check(id),manufacturer_requirement text not null default 'deposit' check(manufacturer_requirement in ('none','deposit','full')));
insert into public.finance_settings default values;
alter table public.finance_settings enable row level security;
revoke all on public.finance_settings from anon,authenticated;
grant select on public.finance_settings to authenticated;
create policy finance_settings_read on public.finance_settings for select to authenticated using(public.has_permission('orders.manage') or public.has_permission('finance.read'));
alter table public.orders add column refunds_total numeric(14,2) not null default 0,add column net_received numeric(14,2) not null default 0,
 add column payment_status text not null default 'Unpaid',add column deposit_type text not null default 'none' check(deposit_type in ('none','fixed','percent')),
 add column deposit_value numeric(12,2) not null default 0 check(deposit_value>=0),add column required_deposit numeric(14,2) not null default 0,
 add column deposit_received numeric(14,2) not null default 0,add column deposit_outstanding numeric(14,2) not null default 0,add column deposit_satisfied boolean not null default true;
alter table public.payments add column customer_id uuid references public.customers(id),add column status text not null default 'Completed' check(status in ('Pending','Completed','Failed','Partially Refunded','Refunded')),
 add column paid_at timestamptz,add column created_by uuid references public.users(id);
update public.payments p set customer_id=o.customer_id,paid_at=p.payment_date::timestamptz,created_by=p.received_by from public.orders o where o.id=p.order_id;
alter table public.payments alter column customer_id set not null,alter column paid_at set not null,alter column created_by set not null;
alter table public.order_items add column discounted_at timestamptz,add column vat_applicable boolean not null default true;
update public.order_items set discounted_at=o.created_at from public.orders o where o.id=order_id and discount_amount>0;
create table public.refunds(id uuid primary key,order_id uuid not null references public.orders(id) on delete restrict,payment_id uuid not null references public.payments(id) on delete restrict,
 amount numeric(12,2) not null check(amount>0 and amount<=1000000),refund_date timestamptz not null check(isfinite(refund_date)),reason text not null check(length(trim(reason)) between 1 and 1000),reference text not null default '' check(length(reference)<=200),notes text not null default '' check(length(notes)<=1000),authorised_by uuid not null references public.users(id),created_at timestamptz not null default now());
create table public.order_charges(id uuid primary key,order_id uuid not null references public.orders(id) on delete restrict,category text not null check(category in ('Prescription','Other')),description text not null check(length(trim(description)) between 1 and 200),amount numeric(12,2) not null check(amount>0 and amount<=1000000),vat_applicable boolean not null default true,vat_rate numeric(5,2) not null check(vat_rate between 0 and 100),vat_amount numeric(14,2) not null,total numeric(14,2) not null,created_by uuid not null references public.users(id),created_at timestamptz not null default now());
create table public.order_finance(order_id uuid primary key references public.orders(id) on delete restrict,required boolean not null default false,provider text not null default '' check(length(provider)<=200),amount_financed numeric(12,2) not null default 0 check(amount_financed between 0 and 1000000),customer_deposit numeric(12,2) not null default 0 check(customer_deposit between 0 and 1000000),application_date date check(isfinite(application_date)),reference text not null default '' check(length(reference)<=200),status text not null default 'Not Started' check(status in ('Not Started','Application Sent','Pending','Approved','Declined','Completed')),approval_date date check(isfinite(approval_date)),notes text not null default '' check(length(notes)<=10000),updated_by uuid not null references public.users(id),updated_at timestamptz not null default now());
create table public.finance_requests(id uuid primary key,order_id uuid not null references public.orders(id),operation text not null,created_by uuid not null references public.users(id),created_at timestamptz not null default now());
do $$ declare t text;begin foreach t in array array['refunds','order_charges','order_finance','finance_requests'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('create policy financial_read on public.%I for select to authenticated using(public.has_permission(''finance.read'') and public.can_read_order(order_id))',t);
 execute format('create trigger audit_%I after insert or update or delete on public.%I for each row execute function public.audit_order_change()',t,t);
 end loop;end $$;
create trigger audit_finance_settings after update on public.finance_settings for each row execute function public.audit_change();
create function public.payment_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then if old.status<>'Pending' then raise exception 'Recorded transactions cannot be deleted; record a refund';end if;return old;end if;
 if tg_op='UPDATE' and old.status<>'Pending' and (to_jsonb(new)-'status') is distinct from (to_jsonb(old)-'status') then raise exception 'Recorded transactions are immutable';end if;
 if tg_op='INSERT' then
 select customer_id into new.customer_id from public.orders where id=new.order_id;
 new.created_by=coalesce(new.created_by,auth.uid());new.paid_at=coalesce(new.paid_at,new.payment_date::timestamptz);
 end if;
 if not isfinite(new.payment_date) or not isfinite(new.paid_at) or new.amount<>round(new.amount,2) or length(new.reference)>200 or length(new.notes)>1000 then raise exception 'Invalid payment';end if;
 return new;
end $$;
create trigger payment_guard before insert or update or delete on public.payments for each row execute function public.payment_guard();
create function public.recalculate_finance(target uuid) returns void language plpgsql security definer set search_path='' as $$
declare o public.orders;paid numeric;returned numeric;gross numeric;needed numeric;net numeric;
begin
 select * into o from public.orders where id=target for update;
 select coalesce(sum(amount),0) into paid from public.payments where order_id=target and status in ('Completed','Partially Refunded','Refunded');
 select coalesce(sum(amount),0) into returned from public.refunds where order_id=target;
 select coalesce(sum(total),0) into gross from public.order_items where order_id=target;
 gross=gross+(select coalesce(sum(total),0) from public.order_charges where order_id=target);
 needed=case o.deposit_type when 'none' then 0 when 'fixed' then o.deposit_value else round(gross*o.deposit_value/100,2) end;
 if needed>gross or (o.deposit_type='percent' and o.deposit_value>100) then raise exception 'Deposit cannot exceed order value';end if;
 net=paid-returned;
 update public.orders set subtotal=(select coalesce(sum(subtotal),0) from public.order_items where order_id=target)+(select coalesce(sum(amount),0) from public.order_charges where order_id=target),
 discount_total=(select coalesce(sum(discount_amount),0) from public.order_items where order_id=target),
 vat_total=(select coalesce(sum(vat_amount),0) from public.order_items where order_id=target)+(select coalesce(sum(vat_amount),0) from public.order_charges where order_id=target),
 total=gross,amount_paid=paid,refunds_total=returned,net_received=net,balance=gross-net,required_deposit=needed,deposit_received=least(needed,greatest(net,0)),deposit_outstanding=greatest(needed-net,0),deposit_satisfied=net>=needed,
 payment_status=case when returned>0 and net=0 then 'Refunded' when returned>0 then 'Partially Refunded' when net>=gross and gross>0 then 'Paid' when net=0 then 'Unpaid' when needed>0 and net>=needed then 'Deposit Paid' else 'Partially Paid' end where id=target;
 update public.payments p set status=case when r.amount>=p.amount then 'Refunded' else 'Partially Refunded' end from (select payment_id,sum(amount) amount from public.refunds where order_id=target group by payment_id) r where p.id=r.payment_id and p.status is distinct from case when r.amount>=p.amount then 'Refunded' else 'Partially Refunded' end;
end $$;
create function public.finance_operation(target uuid,operation text,payload jsonb,request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.orders;p public.payments;line public.order_items;n numeric;discount numeric;rate numeric;tax numeric;s text;required_permission text;existing public.finance_requests;
begin
 if request_id is null or jsonb_typeof(payload)<>'object' then raise exception 'Invalid request';end if;
 select * into o from public.orders where id=target for update;
 if not found or o.status='Draft' or not public.can_read_order(target) then raise exception 'Open a permitted confirmed order';end if;
 required_permission=case operation when 'refund' then 'finance.refund' when 'discount' then 'finance.discount' when 'charge' then 'finance.discount' else 'orders.pay' end;
 if not public.has_permission(required_permission) then raise exception 'Access denied';end if;
 select * into existing from public.finance_requests where id=request_id;
 if found then if existing.order_id<>target or existing.operation<>operation or existing.created_by<>auth.uid() then raise exception 'Request conflict';end if;return jsonb_build_object('id',request_id);end if;
 if operation in ('payment','refund','charge') then
 n=(payload->>'amount')::numeric;if n is null or n<=0 or n>1000000 or n<>round(n,2) then raise exception 'Enter a positive amount in whole pennies';end if;
 end if;
 if operation='payment' then
 s=coalesce(payload->>'status','Completed');if s not in ('Pending','Completed','Failed') then raise exception 'Invalid payment status';end if;
 if s='Completed' and n>o.balance and not (public.has_permission('finance.overpay') and coalesce((payload->>'confirm_overpayment')::boolean,false)) then raise exception 'Payment exceeds balance; overpayment requires authorised explicit confirmation';end if;
 insert into public.payments(id,order_id,payment_date,paid_at,amount,method,reference,status,received_by,notes,created_by) values(request_id,target,(payload->>'payment_date')::date,coalesce(nullif(payload->>'paid_at','')::timestamptz,(payload->>'payment_date')::timestamptz),n,payload->>'method',coalesce(payload->>'reference',''),s,auth.uid(),coalesce(payload->>'notes',''),auth.uid());
 elsif operation='payment_status' then
 select * into p from public.payments where id=(payload->>'payment_id')::uuid and order_id=target for update;
 s=payload->>'status';if not found or p.status<>'Pending' or s not in ('Completed','Failed') then raise exception 'Only pending payments may complete or fail';end if;
 if s='Completed' and p.amount>o.balance and not(public.has_permission('finance.overpay') and coalesce((payload->>'confirm_overpayment')::boolean,false)) then raise exception 'Payment exceeds balance; overpayment requires authorised explicit confirmation';end if;
 update public.payments set status=s where id=p.id;
 elsif operation='refund' then
 select * into p from public.payments where id=(payload->>'payment_id')::uuid and order_id=target for update;
 if not found or p.status not in ('Completed','Partially Refunded') or n>p.amount-(select coalesce(sum(amount),0) from public.refunds where payment_id=p.id) then raise exception 'Refund exceeds the original payment remaining amount';end if;
 insert into public.refunds(id,order_id,payment_id,amount,refund_date,reason,reference,notes,authorised_by) values(request_id,target,p.id,n,(payload->>'refund_date')::timestamptz,payload->>'reason',coalesce(payload->>'reference',''),coalesce(payload->>'notes',''),auth.uid());
 elsif operation='deposit' then
 n=(payload->>'value')::numeric;if n is null or n<0 or n>1000000 or n<>round(n,2) then raise exception 'Invalid deposit';end if;
 update public.orders set deposit_type=payload->>'type',deposit_value=n where id=target;
 elsif operation='discount' then
 select * into line from public.order_items where id=(payload->>'item_id')::uuid and order_id=target for update;
 if not found then raise exception 'Line not found';end if;
 n=(payload->>'value')::numeric;rate=(payload->>'vat_rate')::numeric;
 if n is null or n<0 or n>1000000 or n<>round(n,2) or rate is null or rate<0 or rate>100 or rate<>round(rate,2) then raise exception 'Invalid discount or VAT';end if;
 discount=case payload->>'type' when 'none' then 0 when 'fixed' then n when 'percent' then round(line.subtotal*n/100,2) else null end;
 if discount is null or discount>line.subtotal or (payload->>'type'='percent' and n>100) or length(trim(coalesce(payload->>'reason','')))=0 then raise exception 'Enter a valid discount and authorisation reason';end if;
 tax=case when coalesce((payload->>'vat_applicable')::boolean,true) then round((line.subtotal-discount)*rate/100,2) else 0 end;
 update public.order_items set discount_type=payload->>'type',discount_value=n,discount_reason=payload->>'reason',discount_amount=discount,authorised_by=auth.uid(),discounted_at=now(),vat_applicable=coalesce((payload->>'vat_applicable')::boolean,true),vat_rate=rate,vat_amount=tax,total=line.subtotal-discount+tax where id=line.id;
 elsif operation='charge' then
 rate=(payload->>'vat_rate')::numeric;if rate is null or rate<0 or rate>100 or rate<>round(rate,2) then raise exception 'Invalid VAT';end if;
 tax=case when coalesce((payload->>'vat_applicable')::boolean,true) then round(n*rate/100,2) else 0 end;
 insert into public.order_charges values(request_id,target,payload->>'category',payload->>'description',n,coalesce((payload->>'vat_applicable')::boolean,true),rate,tax,n+tax,auth.uid(),now());
 elsif operation='finance' then
 if (payload->>'amount_financed')::numeric<0 or (payload->>'customer_deposit')::numeric<0 or (payload->>'amount_financed')::numeric<>round((payload->>'amount_financed')::numeric,2) or (payload->>'customer_deposit')::numeric<>round((payload->>'customer_deposit')::numeric,2) then raise exception 'Invalid finance amount';end if;
 insert into public.order_finance(order_id,required,provider,amount_financed,customer_deposit,application_date,reference,status,approval_date,notes,updated_by)
 values(target,(payload->>'required')::boolean,coalesce(payload->>'provider',''),(payload->>'amount_financed')::numeric,(payload->>'customer_deposit')::numeric,nullif(payload->>'application_date','')::date,coalesce(payload->>'reference',''),payload->>'status',nullif(payload->>'approval_date','')::date,coalesce(payload->>'notes',''),auth.uid())
 on conflict(order_id) do update set required=excluded.required,provider=excluded.provider,amount_financed=excluded.amount_financed,customer_deposit=excluded.customer_deposit,application_date=excluded.application_date,reference=excluded.reference,status=excluded.status,approval_date=excluded.approval_date,notes=excluded.notes,updated_by=auth.uid(),updated_at=now();
 else raise exception 'Unknown financial operation';end if;
 perform public.recalculate_finance(target);
 update public.orders set version=version+1,updated_at=now() where id=target;
 insert into public.finance_requests(id,order_id,operation,created_by) values(request_id,target,operation,auth.uid());
 perform public.order_event(target,'Finance: '||operation,case operation when 'refund' then 'Refund recorded: GBP '||n when 'payment' then 'Payment recorded: GBP '||n else 'Financial details updated: '||operation end,'finance');
 return jsonb_build_object('id',request_id);
end $$;
-- Central guard also covers the existing order-detail action endpoint.
alter function public.operate_order(uuid,text,jsonb,uuid) rename to operate_order_internal;
revoke all on function public.operate_order_internal(uuid,text,jsonb,uuid) from public,anon,authenticated;
create function public.operate_order(target uuid,operation text,payload jsonb,request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.orders;rule text;
begin
 if operation='payment' then return public.finance_operation(target,'payment',payload,request_id);end if;
 if operation='status' and payload->>'status' in ('Submitted to Manufacturer','In Production','QC','Shipped to UK','Received in UK','Customer Delivery','Fitting','Aftercare','Closed') then
 select * into o from public.orders where id=target for update;
 select manufacturer_requirement into rule from public.finance_settings;
 if o.status in ('Order Confirmed','Ready for Manufacturer') and ((rule='deposit' and not o.deposit_satisfied) or (rule='full' and o.balance>0)) then raise exception 'Required payment or deposit must be received before manufacturer submission';end if;
 end if;
 return public.operate_order_internal(target,operation,payload,request_id);
end $$;
create function public.configure_finance(requirement text) returns void language plpgsql security definer set search_path='' as $$
begin if not public.has_permission('staff.manage') then raise exception 'Access denied';end if;update public.finance_settings set manufacturer_requirement=requirement;end $$;
revoke all on function public.payment_guard(),public.recalculate_finance(uuid),public.finance_operation(uuid,text,jsonb,uuid),public.operate_order(uuid,text,jsonb,uuid),public.configure_finance(text) from public,anon,authenticated;
grant execute on function public.finance_operation(uuid,text,jsonb,uuid),public.operate_order(uuid,text,jsonb,uuid),public.configure_finance(text) to authenticated;

-- Targeted extension of the existing wizard; completed payments are never deleted.
create or replace function public.save_order_internal(p_id uuid,p_payload jsonb,p_expected_version integer,p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare existing public.orders; saved public.orders; m jsonb; rx jsonb; item jsonb; pay jsonb;
 product public.products; cfg jsonb; key text; net numeric; discount numeric; tax numeric; price numeric; qty integer;
 prior_lines jsonb; cid uuid; new_order boolean; line_count integer; loupe_count integer;
begin
 if not public.has_permission('orders.write') then raise exception 'Access denied'; end if;
 if p_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid order'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into existing from public.orders where id=p_id for update;
 new_order=not found;
 if not new_order and existing.status<>'Draft' then
 if p_confirm then return jsonb_build_object('id',existing.id,'version',existing.version,'order_number',existing.order_number,'status',existing.status); end if;
 raise exception 'Confirmed orders cannot be edited';
 end if;
 if (new_order and p_expected_version is distinct from 0) or (not new_order and existing.version is distinct from p_expected_version) then raise exception 'This draft changed in another session. Reload before saving.'; end if;
 cid=(p_payload->>'customer_id')::uuid;
 if not exists(select 1 from public.customers where id=cid) then raise exception 'Choose an existing customer'; end if;
 if not new_order and cid<>existing.customer_id then raise exception 'A saved order cannot be moved to another customer'; end if;
 if new_order then
 insert into public.orders(id,customer_id,created_by) values(p_id,cid,auth.uid());
 insert into public.activities(customer_id,order_id,type,description,user_id) values(cid,p_id,'Order created','Created draft order',auth.uid());
 end if;
 m=p_payload->'measurements'; rx=p_payload->'prescription';
 if m is null or rx is null then raise exception 'Missing measurement or prescription data'; end if;
 insert into public.measurements(order_id,right_bd,left_bd,working_distance,notes)
 values(p_id,(m->>'right_bd')::numeric,(m->>'left_bd')::numeric,(m->>'working_distance')::numeric,coalesce(m->>'notes',''))
 on conflict(order_id) do update set right_bd=excluded.right_bd,left_bd=excluded.left_bd,working_distance=excluded.working_distance,notes=excluded.notes;
 perform public.validate_order_eye(coalesce(rx->'right_eye','{}'),false);
 perform public.validate_order_eye(coalesce(rx->'left_eye','{}'),false);
 if not (rx->>'required')::boolean and exists(select 1 from public.order_files where order_id=p_id) then raise exception 'Remove prescription attachments before selecting No'; end if;
 insert into public.prescriptions(order_id,required,right_eye,left_eye,prescription_date,provider,notes)
 values(p_id,(rx->>'required')::boolean,case when (rx->>'required')::boolean then rx->'right_eye' else '{}' end,
 case when (rx->>'required')::boolean then rx->'left_eye' else '{}' end,
 case when (rx->>'required')::boolean then nullif(rx->>'prescription_date','')::date end,
 case when (rx->>'required')::boolean then coalesce(rx->>'provider','') else '' end,
 case when (rx->>'required')::boolean then coalesce(rx->>'notes','') else '' end)
 on conflict(order_id) do update set required=excluded.required,right_eye=excluded.right_eye,left_eye=excluded.left_eye,prescription_date=excluded.prescription_date,provider=excluded.provider,notes=excluded.notes;
 if jsonb_typeof(p_payload->'items')<>'array' or jsonb_array_length(p_payload->'items')>50 then raise exception 'Invalid order items'; end if;
 select coalesce(jsonb_object_agg(id,to_jsonb(i)),'{}') into prior_lines from public.order_items i where order_id=p_id;
 delete from public.order_items where order_id=p_id;
 for item in select * from jsonb_array_elements(p_payload->'items') loop
 select * into product from public.products where id=(item->>'product_id')::uuid and active;
 if not found then raise exception 'Product is unavailable'; end if;
 cfg=coalesce(item->'configuration','{}');
 if jsonb_typeof(cfg)<>'object' then raise exception 'Invalid configuration'; end if;
 if product.kind='Loupe' then
 foreach key in array array['magnification','frame','frame_colour'] loop
 if coalesce(cfg->>key,'')<>'' and not coalesce((product.options->key)?(cfg->>key),false) then raise exception 'Invalid % for %',key,product.name; end if;
 if p_confirm and coalesce(cfg->>key,'')='' then raise exception 'Complete the loupe configuration'; end if;
 end loop;
 if nullif(cfg->>'working_distance','') is not null then
 if (cfg->>'working_distance')::numeric not between 350 and 550 or (cfg->>'working_distance')::numeric<>trunc((cfg->>'working_distance')::numeric) then raise exception 'Working distance must be 350–550 mm';end if;
 cfg=jsonb_set(cfg,'{working_distance}',to_jsonb((cfg->>'working_distance')::numeric));
 elsif p_confirm then raise exception 'Complete working distance';end if;
 if length(coalesce(cfg->>'manufacturer_instructions',''))>10000 then raise exception 'Manufacturer instructions too long'; end if;
 end if;
 price=(item->>'unit_price')::numeric; qty=(item->>'quantity')::integer;
 if price is null or price<0 or price>1000000 or price<>round(price,2) or (item->>'quantity')::numeric<>qty or qty<1 or qty>100 then raise exception 'Invalid price or quantity'; end if;
 net=price*qty;
 if (item->>'discount_value')::numeric<0 or (item->>'discount_value')::numeric<>round((item->>'discount_value')::numeric,2) then raise exception 'Invalid discount'; end if;
 discount=case item->>'discount_type' when 'none' then 0 when 'fixed' then (item->>'discount_value')::numeric when 'percent' then round(net*(item->>'discount_value')::numeric/100,2) else null end;
 if discount is null or discount>net or ((item->>'discount_type')='percent' and (item->>'discount_value')::numeric>100) then raise exception 'Discount exceeds line value'; end if;
 if discount>0 and length(trim(coalesce(item->>'discount_reason','')))=0 then raise exception 'Enter a discount reason'; end if;
 if (item->>'vat_rate')::numeric<>round((item->>'vat_rate')::numeric,2) then raise exception 'VAT uses at most two decimal places'; end if;
 if discount>0 and not public.has_permission('finance.discount') then raise exception 'Discount authorisation required';end if;
 tax=case when coalesce((item->>'vat_applicable')::boolean,true) then round((net-discount)*(item->>'vat_rate')::numeric/100,2) else 0 end;
 insert into public.order_items(id,order_id,product_id,sku,description,kind,configuration,quantity,unit_price,discount_type,discount_value,discount_reason,authorised_by,discounted_at,vat_applicable,vat_rate,subtotal,discount_amount,vat_amount,total)
 values((item->>'id')::uuid,p_id,product.id,product.sku,product.name,product.kind,cfg,qty,price,item->>'discount_type',(item->>'discount_value')::numeric,coalesce(item->>'discount_reason',''),case when discount>0 then case when (prior_lines->(item->>'id')->>'discount_type')=item->>'discount_type' and (prior_lines->(item->>'id')->>'discount_value')::numeric=(item->>'discount_value')::numeric and (prior_lines->(item->>'id')->>'discount_reason')=coalesce(item->>'discount_reason','') then (prior_lines->(item->>'id')->>'authorised_by')::uuid else auth.uid() end end,case when discount>0 then case when (prior_lines->(item->>'id')->>'discount_type')=item->>'discount_type' and (prior_lines->(item->>'id')->>'discount_value')::numeric=(item->>'discount_value')::numeric and (prior_lines->(item->>'id')->>'discount_reason')=coalesce(item->>'discount_reason','') then coalesce((prior_lines->(item->>'id')->>'discounted_at')::timestamptz,now()) else now() end end,coalesce((item->>'vat_applicable')::boolean,true),(item->>'vat_rate')::numeric,net,discount,tax,net-discount+tax);
 end loop;
 if jsonb_typeof(p_payload->'payments')<>'array' or jsonb_array_length(p_payload->'payments')>50 then raise exception 'Invalid payments'; end if;
 if exists(select 1 from public.payments p where p.order_id=p_id and p.status<>'Pending' and not exists(select 1 from jsonb_array_elements(p_payload->'payments') x where (x->>'id')::uuid=p.id)) then raise exception 'Recorded payments must be retained';end if;
 delete from public.payments p where p.order_id=p_id and p.status='Pending' and not exists(select 1 from jsonb_array_elements(p_payload->'payments') x where (x->>'id')::uuid=p.id);
 for pay in select * from jsonb_array_elements(p_payload->'payments') loop
 if not public.has_permission('orders.pay') or exists(select 1 from public.payments where id=(pay->>'id')::uuid and order_id<>p_id) then raise exception 'Payment access denied';end if;
 if (pay->>'amount')::numeric<>round((pay->>'amount')::numeric,2) then raise exception 'Payments must use whole pennies'; end if;
 insert into public.payments(id,order_id,payment_date,amount,method,reference,notes,received_by,status)
 values((pay->>'id')::uuid,p_id,(pay->>'payment_date')::date,(pay->>'amount')::numeric,pay->>'method',coalesce(pay->>'reference',''),coalesce(pay->>'notes',''),auth.uid(),'Completed')
 on conflict(id) do update set amount=excluded.amount,method=excluded.method,payment_date=excluded.payment_date,reference=excluded.reference,notes=excluded.notes,status=case when payments.status='Pending' then excluded.status else payments.status end;
 end loop;
 update public.orders set
 current_step=(p_payload->>'current_step')::integer,version=case when new_order then 1 else existing.version+1 end,updated_at=now(),
 subtotal=(select coalesce(sum(subtotal),0) from public.order_items where order_id=p_id),
 discount_total=(select coalesce(sum(discount_amount),0) from public.order_items where order_id=p_id),
 vat_total=(select coalesce(sum(vat_amount),0) from public.order_items where order_id=p_id),
 total=(select coalesce(sum(total),0) from public.order_items where order_id=p_id),
 amount_paid=(select coalesce(sum(amount),0) from public.payments where order_id=p_id) where id=p_id;
 update public.orders set balance=total-amount_paid where id=p_id returning * into saved;
 if saved.balance<0 then raise exception 'Payments exceed the order total'; end if;
 if p_confirm then
 if m->>'right_bd' is null or m->>'left_bd' is null or m->>'working_distance' is null then raise exception 'Complete the measurements'; end if;
 select count(*),count(*) filter(where kind='Loupe') into line_count,loupe_count from public.order_items where order_id=p_id;
 if line_count=0 or loupe_count<>1 then raise exception 'Select exactly one loupe'; end if;
 if exists(select 1 from public.order_items where order_id=p_id and unit_price<=0) then raise exception 'Enter a verified price for every item'; end if;
 if (rx->>'required')::boolean and not exists(select 1 from public.order_files f join storage.objects obj on obj.bucket_id='order-prescriptions' and obj.name=f.storage_path where f.order_id=p_id) then raise exception 'Upload a prescription image or PDF before confirming the order'; end if;
 update public.orders set status='Order Confirmed',confirmed_at=now(),confirmed_by=auth.uid(),current_step=7 where id=p_id returning * into saved;
 insert into public.activities(customer_id,order_id,type,description,user_id) values(cid,p_id,'Order confirmed','Confirmed order EO-'||saved.order_number,auth.uid());
 end if;
 return jsonb_build_object('id',saved.id,'version',saved.version,'order_number',saved.order_number,'status',saved.status);
end $$;

-- Strict validation for new/changed measurements, preserving historical confirmed values.
create function public.working_distance_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' and new.working_distance is not distinct from old.working_distance then return new;end if;
 if new.working_distance is not null and (new.working_distance not between 350 and 550 or new.working_distance<>trunc(new.working_distance)) then raise exception 'Working distance must be 350–550 mm';end if;
 return new;
end $$;
create trigger working_distance_guard before insert or update on public.measurements for each row execute function public.working_distance_guard();
revoke all on function public.working_distance_guard() from public,anon,authenticated;
-- Existing numeric configuration strings become actual JSON numbers; historical text remains readable.
update public.order_items set configuration=jsonb_set(configuration,'{working_distance}',to_jsonb((configuration->>'working_distance')::numeric)) where configuration->>'working_distance' ~ '^[0-9]+([.][0-9]+)?$';
create or replace function public.save_order(p_id uuid,p_payload jsonb,p_expected_version integer,p_confirm boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.has_permission('orders.write') then raise exception 'Access denied';end if;
 if exists(select 1 from public.orders where id=p_id) and not public.can_read_order(p_id) then raise exception 'Access denied';end if;
 result=public.save_order_internal(p_id,p_payload,p_expected_version,p_confirm);
 perform public.recalculate_finance(p_id);
 return result;
end $$;
create function public.order_financial_summary(target uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('order',to_jsonb(o),
 'product_value',(select coalesce(sum(subtotal),0) from public.order_items where order_id=o.id and kind='Loupe'),
 'accessories',(select coalesce(sum(subtotal),0) from public.order_items where order_id=o.id and kind<>'Loupe'),
 'prescription_charges',(select coalesce(sum(amount),0) from public.order_charges where order_id=o.id and category='Prescription'),
 'other_charges',(select coalesce(sum(amount),0) from public.order_charges where order_id=o.id and category='Other'),
 'net',o.subtotal-o.discount_total,
 'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by paid_at desc),'[]') from public.payments p where order_id=o.id),
 'refunds',(select coalesce(jsonb_agg(to_jsonb(r) order by refund_date desc),'[]') from public.refunds r where order_id=o.id),
 'charges',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.order_charges c where order_id=o.id),
 'finance',(select to_jsonb(f) from public.order_finance f where order_id=o.id))
 from public.orders o where id=target and public.has_permission('finance.read') and public.can_read_order(o.id); $$;
create function public.customer_financial_summary(target uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('lifetime_value',coalesce(sum(total),0),'payments',coalesce(sum(amount_paid),0),'refunds',coalesce(sum(refunds_total),0),'outstanding',coalesce(sum(balance),0),'paid_orders',count(*) filter(where balance<=0),'open_balances',count(*) filter(where balance>0)) from public.orders where customer_id=target and status<>'Draft' and public.has_permission('finance.read') and public.can_read_order(id); $$;
create function public.search_payments(filters jsonb default '{}') returns jsonb language plpgsql stable set search_path='' as $$
declare result jsonb;page integer;
begin
 if not public.has_permission('finance.read') then raise exception 'Access denied';end if;
 page=greatest(1,least(coalesce((filters->>'page')::integer,1),100000));
 with matches as (
 select p.*,c.first_name||' '||c.last_name customer_name,c.assigned_to,o.order_number,u.full_name received_name,count(*) over() total_count
 from public.payments p join public.orders o on o.id=p.order_id join public.customers c on c.id=p.customer_id join public.users u on u.id=p.received_by
 where public.can_read_order(o.id)
 and (coalesce(filters->>'q','')='' or c.first_name||' '||c.last_name||' '||p.reference||' EO-'||o.order_number ilike '%'||(filters->>'q')||'%')
 and (nullif(filters->>'customer','') is null or p.customer_id=(filters->>'customer')::uuid)
 and (nullif(filters->>'sales','') is null or c.assigned_to=(filters->>'sales')::uuid)
 and (nullif(filters->>'method','') is null or p.method=filters->>'method')
 and (nullif(filters->>'status','') is null or p.status=filters->>'status')
 and (nullif(filters->>'from','') is null or p.payment_date>=(filters->>'from')::date)
 and (nullif(filters->>'to','') is null or p.payment_date<=(filters->>'to')::date)
 order by p.paid_at desc,p.id limit 50 offset (page-1)*50)
 select coalesce(jsonb_agg(to_jsonb(matches)),'[]') into result from matches;
 return result;
end $$;
revoke all on function public.order_financial_summary(uuid),public.customer_financial_summary(uuid),public.search_payments(jsonb) from public,anon,authenticated;
grant execute on function public.order_financial_summary(uuid),public.customer_financial_summary(uuid),public.search_payments(jsonb) to authenticated;
-- Backfill derived totals using actual transaction data.
do $$ declare r record;begin for r in select id from public.orders loop perform public.recalculate_finance(r.id);end loop;end $$;
commit;

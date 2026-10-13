begin;
insert into public.role_permissions(role,permission) values
('administrator','orders.manage'),('sales','orders.manage'),('operations','orders.manage'),
('administrator','orders.pay'),('sales','orders.pay'),('finance','orders.pay'),
('administrator','orders.manufacturer'),('sales','orders.manufacturer');
alter table public.orders drop constraint orders_status_check;
do $$ declare r record; begin
 for r in select conname from pg_constraint where conrelid='public.orders'::regclass and contype='c' and pg_get_constraintdef(oid) like '%confirmed_at%' loop
 execute format('alter table public.orders drop constraint %I',r.conname); end loop;
end $$;
alter table public.orders add constraint orders_status_check check(status in ('Draft','Order Confirmed','Ready for Manufacturer','Submitted to Manufacturer','In Production','QC','Shipped to UK','Received in UK','Customer Delivery','Fitting','Aftercare','Closed'));
alter table public.orders add constraint orders_confirmation_check check((status='Draft' and confirmed_at is null and confirmed_by is null) or (status<>'Draft' and confirmed_at is not null and confirmed_by is not null));
alter table public.orders add column manufacturer_reference text not null default '' check(length(manufacturer_reference)<=200), add column expected_completion_date date;
alter table public.measurements add column measurement_date date, add column measured_by uuid references public.users(id);
alter table public.tasks add column order_id uuid references public.orders(id) on delete cascade;
create index tasks_order_idx on public.tasks(order_id,due_date);
alter table public.payments add column created_at timestamptz not null default now();
create or replace function public.can_read_order(target uuid) returns boolean language sql stable security definer set search_path='' as $$
select exists(select 1 from public.orders o where o.id=target and (public.has_permission('orders.read') or (o.status<>'Draft' and public.has_permission('orders.confirmed.read')))); $$;
create table public.order_events (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete cascade,
 kind text not null,description text not null check(length(description)<=10000),audience text not null default 'operational' check(audience in ('operational','clinical','finance')),
 user_id uuid references public.users(id),created_at timestamptz not null default now()
);
create table public.order_status_history (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete cascade,
 from_status text,to_status text not null,reason text not null default '',user_id uuid references public.users(id),created_at timestamptz not null default now()
);
create table public.order_aftercare (
 order_id uuid primary key references public.orders(id) on delete cascade,
 delivery_confirmed boolean not null default false,fitting_date date,fitting_completed boolean not null default false,
 fit_satisfactory boolean,adjustment_required boolean not null default false,adjustment_notes text not null default '' check(length(adjustment_notes)<=10000),
 return_to_manufacturer boolean not null default false,warranty_case boolean not null default false,
 warranty_status text not null default 'Not opened' check(warranty_status in ('Not opened','Open','In review','Resolved','Declined')),
 resolution_date date,updated_at timestamptz not null default now(),updated_by uuid references public.users(id)
);
create table public.manufacturer_packs (
 id uuid primary key,order_id uuid not null references public.orders(id) on delete cascade,
 prepared_by uuid not null references public.users(id),created_at timestamptz not null default now(),
 instructions text not null default '' check(length(instructions)<=10000),file_ids uuid[] not null default '{}',snapshot jsonb not null
);
create function public.order_event(target uuid,kind text,description text,audience text default 'operational') returns void language sql security definer set search_path='' as $$
insert into public.order_events(order_id,kind,description,audience,user_id) values(target,kind,description,audience,auth.uid()); $$;
do $$ declare t text; begin foreach t in array array['order_events','order_status_history','order_aftercare','manufacturer_packs'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
 execute format('create trigger audit_%I after insert or update or delete on public.%I for each row execute function public.audit_order_change()',t,t);
 end loop;end $$;
create policy events_read on public.order_events for select to authenticated using(public.can_read_order(order_id) and (audience='operational' or (audience='clinical' and public.has_permission('orders.clinical')) or (audience='finance' and public.has_permission('orders.read'))));
create policy status_read on public.order_status_history for select to authenticated using(public.can_read_order(order_id));
create policy aftercare_read on public.order_aftercare for select to authenticated using(public.can_read_order(order_id) and public.has_permission('orders.manage'));
create policy packs_read on public.manufacturer_packs for select to authenticated using(public.can_read_order(order_id) and public.has_permission('orders.manufacturer'));
create policy order_tasks_read on public.tasks for select to authenticated using(order_id is not null and public.can_read_order(order_id) and public.has_permission('orders.manage'));
-- Existing customer task routes can still complete order tasks; this trigger records every change.
create function public.task_order_event() returns trigger language plpgsql security definer set search_path='' as $$
begin
if new.order_id is not null then
 if not exists(select 1 from public.orders where id=new.order_id and customer_id=new.customer_id) then raise exception 'Task customer does not match order'; end if;
 perform public.order_event(new.order_id,'Follow-up',case when tg_op='INSERT' then 'Created: ' when new.completed then 'Completed: ' else 'Updated: ' end||new.title);
end if;return new;end $$;
create trigger order_task_event after insert or update on public.tasks for each row execute function public.task_order_event();
create function public.activity_order_event() returns trigger language plpgsql security definer set search_path='' as $$
begin if new.order_id is not null then
perform public.order_event(new.order_id,new.type,new.description,case when new.type='File uploaded' then 'clinical' else 'operational' end);end if;return new;end $$;
create trigger order_activity_event after insert on public.activities for each row execute function public.activity_order_event();
insert into public.order_events(order_id,kind,description,user_id,created_at,audience)
select order_id,type,description,user_id,created_at,case when type='File uploaded' then 'clinical' else 'operational' end from public.activities where order_id is not null;
insert into public.order_status_history(order_id,to_status,user_id,created_at) select id,'Order Confirmed',confirmed_by,confirmed_at from public.orders where confirmed_at is not null;
insert into public.order_events(order_id,kind,description,audience,user_id,created_at) select p.order_id,'Payment','Payment received: GBP '||p.amount,'finance',p.received_by,o.confirmed_at from public.payments p join public.orders o on o.id=p.order_id where o.confirmed_at is not null;
create function public.track_order_confirmation() returns trigger language plpgsql security definer set search_path='' as $$
begin if old.status='Draft' and new.status='Order Confirmed' then insert into public.order_status_history(order_id,from_status,to_status,user_id) values(new.id,old.status,new.status,auth.uid()); insert into public.order_events(order_id,kind,description,audience,user_id) select new.id,'Payment','Payment received: GBP '||p.amount,'finance',p.received_by from public.payments p where p.order_id=new.id; end if;return new;end $$;
create trigger order_confirmation_history after update on public.orders for each row execute function public.track_order_confirmation();

alter table public.order_files drop constraint order_files_category_check;
alter table public.order_files add constraint order_files_category_check check(category in ('Measurements','Prescription','Manufacturer','Finance','Shipping','Delivery','Aftercare','Warranty','Other'));
alter table public.order_files drop constraint order_files_mime_type_check;
alter table public.order_files add constraint order_files_mime_type_check check(mime_type in ('application/pdf','image/jpeg','image/png','image/webp','video/mp4','video/webm'));
alter table public.order_files add column storage_bucket text not null default 'order-prescriptions' check(storage_bucket in ('order-prescriptions','order-attachments'));
create function public.can_access_order_category(target uuid,category text) returns boolean language sql stable security definer set search_path='' as $$
select public.can_read_order(target) and case when category in ('Prescription','Measurements') then public.has_permission('orders.clinical') when category='Finance' then public.has_permission('orders.read') else public.has_permission('orders.manage') end; $$;
drop policy order_files_read on public.order_files;
create policy order_files_read on public.order_files for select to authenticated using(public.can_access_order_category(order_id,category));
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('order-attachments','order-attachments',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp','video/mp4','video/webm']);
create policy hub_object_insert on storage.objects for insert to authenticated with check(bucket_id='order-attachments' and exists(select 1 from public.orders o where o.id::text=(storage.foldername(name))[1] and o.status<>'Draft' and public.can_read_order(o.id) and (public.has_permission('orders.manage') or public.has_permission('orders.pay'))));
create policy hub_object_read on storage.objects for select to authenticated using(bucket_id='order-attachments' and exists(select 1 from public.order_files f where f.storage_path=name and f.storage_bucket=bucket_id and public.can_access_order_category(f.order_id,f.category)));
create policy hub_object_cleanup on storage.objects for delete to authenticated using(bucket_id='order-attachments' and owner_id=auth.uid()::text and not exists(select 1 from public.order_files f where f.storage_path=name and f.storage_bucket=bucket_id));

create function public.operate_order(target uuid,operation text,payload jsonb,request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.orders; result_id uuid; old_status text; stage text; actor uuid; amount numeric; ids uuid[]; snap jsonb; task public.tasks; f public.order_files;
begin
if request_id is null or jsonb_typeof(payload)<>'object' then raise exception 'Invalid request';end if;
select * into o from public.orders where id=target for update;
if not found or not public.can_read_order(target) or o.status='Draft' then raise exception 'Open a confirmed order';end if;
if operation='payment' then
 if not public.has_permission('orders.pay') then raise exception 'Access denied';end if;
 if exists(select 1 from public.payments where id=request_id and order_id=target) then return jsonb_build_object('id',request_id);end if;
 amount=(payload->>'amount')::numeric;
 if amount is null or amount<=0 or amount<>round(amount,2) or amount>o.balance then raise exception 'Payment must be positive, in whole pennies and no more than the balance';end if;
 insert into public.payments(id,order_id,payment_date,amount,method,reference,notes,received_by) values(request_id,target,(payload->>'payment_date')::date,amount,payload->>'method',coalesce(payload->>'reference',''),coalesce(payload->>'notes',''),auth.uid());
 update public.orders set amount_paid=amount_paid+amount,balance=balance-amount,version=version+1,updated_at=now() where id=target;
 perform public.order_event(target,'Payment','Payment received: GBP '||amount,'finance');
 return jsonb_build_object('id',request_id);
end if;
if operation='file' then
 if not public.can_access_order_category(target,payload->>'category') or not (public.has_permission('orders.manage') or (payload->>'category'='Finance' and public.has_permission('orders.pay'))) then raise exception 'Access denied';end if;
 if exists(select 1 from public.order_files where id=request_id and order_id=target) then return jsonb_build_object('id',request_id);end if;
 if not exists(select 1 from storage.objects where bucket_id='order-attachments' and name=payload->>'path' and owner_id=auth.uid()::text) then raise exception 'Uploaded object not found';end if;
 insert into public.order_files(id,order_id,filename,mime_type,size_bytes,storage_path,storage_bucket,category,uploaded_by) values(request_id,target,payload->>'filename',payload->>'mime_type',(payload->>'size_bytes')::bigint,payload->>'path','order-attachments',payload->>'category',auth.uid()) returning * into f;
 perform public.order_event(target,'File uploaded',f.category||': '||f.filename,case when f.category='Finance' then 'finance' when f.category in ('Measurements','Prescription') then 'clinical' else 'operational' end);
 return to_jsonb(f);
end if;
if not public.has_permission('orders.manage') then raise exception 'Access denied';end if;
if operation='status' then
 stage=payload->>'status';
 if stage=o.status then return '{}'::jsonb;end if;
 if stage is null or stage in ('Draft','Order Confirmed') then raise exception 'Choose an operational status';end if;
 if coalesce(payload->>'expected_status','')<>o.status then raise exception 'Status changed in another session. Reload.';end if;
 if length(trim(coalesce(payload->>'reason','')))=0 then raise exception 'Enter a status update or shipping note';end if;
 update public.orders set status=stage,version=version+1,updated_at=now() where id=target;
 insert into public.order_status_history(order_id,from_status,to_status,reason,user_id) values(target,o.status,stage,payload->>'reason',auth.uid());
 perform public.order_event(target,'Status changed',o.status||' → '||stage||': '||(payload->>'reason'));
elsif operation='note' then
 if length(trim(coalesce(payload->>'note','')))=0 then raise exception 'Enter a note';end if;
 insert into public.order_events(id,order_id,kind,description,user_id) values(request_id,target,'Note',payload->>'note',auth.uid()) on conflict(id) do nothing;
elsif operation='followup' then
 actor=(payload->>'assigned_to')::uuid;
 if not exists(select 1 from public.users where id=actor and active) then raise exception 'Choose an active staff member';end if;
 insert into public.tasks(id,order_id,customer_id,title,description,assigned_to,due_date,priority,created_by) values(request_id,target,o.customer_id,payload->>'title',coalesce(payload->>'description',''),actor,(payload->>'due_date')::date,payload->>'priority',auth.uid()) on conflict(id) do nothing;
elsif operation='complete' then
 update public.tasks set completed=(payload->>'completed')::boolean where id=(payload->>'task_id')::uuid and order_id=target;
 if not found then raise exception 'Follow-up not found';end if;
elsif operation='details' then
 update public.orders set manufacturer_reference=coalesce(payload->>'manufacturer_reference',''),expected_completion_date=nullif(payload->>'expected_completion_date','')::date,version=version+1,updated_at=now() where id=target;
 perform public.order_event(target,'Order updated','Manufacturer reference or expected completion date updated');
elsif operation='measurement' then
 if not public.has_permission('orders.clinical') then raise exception 'Access denied';end if;
 actor=nullif(payload->>'measured_by','')::uuid;
 if actor is not null and not exists(select 1 from public.users where id=actor and active) then raise exception 'Choose active staff';end if;
 update public.measurements set measurement_date=nullif(payload->>'measurement_date','')::date,measured_by=actor where order_id=target;
 perform public.order_event(target,'Measurements','Measurement date and measurer updated','clinical');
elsif operation='aftercare' then
 insert into public.order_aftercare(order_id) values(target) on conflict do nothing;
 update public.order_aftercare set delivery_confirmed=coalesce((payload->>'delivery_confirmed')::boolean,false),fitting_date=nullif(payload->>'fitting_date','')::date,
 fitting_completed=coalesce((payload->>'fitting_completed')::boolean,false),fit_satisfactory=nullif(payload->>'fit_satisfactory','')::boolean,
 adjustment_required=coalesce((payload->>'adjustment_required')::boolean,false),adjustment_notes=coalesce(payload->>'adjustment_notes',''),
 return_to_manufacturer=coalesce((payload->>'return_to_manufacturer')::boolean,false),warranty_case=coalesce((payload->>'warranty_case')::boolean,false),
 warranty_status=payload->>'warranty_status',resolution_date=nullif(payload->>'resolution_date','')::date,updated_at=now(),updated_by=auth.uid() where order_id=target;
 perform public.order_event(target,'Aftercare','Delivery, fitting or warranty details updated');
elsif operation='manufacturer' then
 if not public.has_permission('orders.manufacturer') then raise exception 'Access denied';end if;
 if exists(select 1 from public.manufacturer_packs where id=request_id and order_id=target) then return jsonb_build_object('id',request_id);end if;
 select coalesce(array_agg(value::uuid),'{}') into ids from jsonb_array_elements_text(coalesce(payload->'file_ids','[]'));
 if cardinality(ids)>30 then raise exception 'Choose no more than 30 attachments';end if;
 if exists(select 1 from unnest(ids) i where not exists(select 1 from public.order_files where id=i and order_id=target and category in ('Measurements','Prescription','Manufacturer') and mime_type in ('application/pdf','image/jpeg','image/png','image/webp'))) then raise exception 'Only measurement, prescription and manufacturer images/PDFs are allowed';end if;
 -- Explicit allowlist: never serialize order totals, payments, price fields or CRM notes.
 select jsonb_build_object('order_number',o.order_number,'manufacturer_reference',o.manufacturer_reference,'expected_completion_date',o.expected_completion_date,
 'customer',(select jsonb_build_object('name',first_name||' '||last_name,'practice',practice_name) from public.customers where id=o.customer_id),
 'measurements',(select to_jsonb(m)-'order_id' from public.measurements m where order_id=target),
 'prescription',(select to_jsonb(p)-'order_id' from public.prescriptions p where order_id=target),
 'items',(select coalesce(jsonb_agg(jsonb_build_object('sku',sku,'description',description,'kind',kind,'quantity',quantity,'configuration',configuration)),'[]') from public.order_items where order_id=target)) into snap;
 insert into public.manufacturer_packs(id,order_id,prepared_by,instructions,file_ids,snapshot) values(request_id,target,auth.uid(),coalesce(payload->>'instructions',''),ids,snap);
 perform public.order_event(target,'Manufacturer','Manufacturer pack prepared; not emailed');
else raise exception 'Unknown operation';end if;
return jsonb_build_object('id',request_id);
end $$;
revoke all on function public.order_event(uuid,text,text,text),public.task_order_event(),public.activity_order_event(),public.track_order_confirmation(),public.can_access_order_category(uuid,text),public.operate_order(uuid,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.can_access_order_category(uuid,text),public.operate_order(uuid,text,jsonb,uuid) to authenticated;
-- Preserve wizard immutability throughout the operational lifecycle.
create or replace function public.save_order(p_id uuid,p_payload jsonb,p_expected_version integer,p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare existing public.orders; saved public.orders; m jsonb; rx jsonb; item jsonb; pay jsonb;
 product public.products; cfg jsonb; key text; net numeric; discount numeric; tax numeric; price numeric; qty integer;
 cid uuid; new_order boolean; line_count integer; loupe_count integer;
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
 delete from public.order_items where order_id=p_id;
 for item in select * from jsonb_array_elements(p_payload->'items') loop
 select * into product from public.products where id=(item->>'product_id')::uuid and active;
 if not found then raise exception 'Product is unavailable'; end if;
 cfg=coalesce(item->'configuration','{}');
 if jsonb_typeof(cfg)<>'object' then raise exception 'Invalid configuration'; end if;
 if product.kind='Loupe' then
 foreach key in array array['magnification','frame','frame_colour','working_distance'] loop
 if coalesce(cfg->>key,'')<>'' and not coalesce((product.options->key)?(cfg->>key),false) then raise exception 'Invalid % for %',key,product.name; end if;
 if p_confirm and coalesce(cfg->>key,'')='' then raise exception 'Complete the loupe configuration'; end if;
 end loop;
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
 tax=round((net-discount)*(item->>'vat_rate')::numeric/100,2);
 insert into public.order_items(id,order_id,product_id,sku,description,kind,configuration,quantity,unit_price,discount_type,discount_value,discount_reason,authorised_by,vat_rate,subtotal,discount_amount,vat_amount,total)
 values((item->>'id')::uuid,p_id,product.id,product.sku,product.name,product.kind,cfg,qty,price,item->>'discount_type',(item->>'discount_value')::numeric,coalesce(item->>'discount_reason',''),case when discount>0 then auth.uid() end,(item->>'vat_rate')::numeric,net,discount,tax,net-discount+tax);
 end loop;
 if jsonb_typeof(p_payload->'payments')<>'array' or jsonb_array_length(p_payload->'payments')>50 then raise exception 'Invalid payments'; end if;
 delete from public.payments where order_id=p_id;
 for pay in select * from jsonb_array_elements(p_payload->'payments') loop
 if (pay->>'amount')::numeric<>round((pay->>'amount')::numeric,2) then raise exception 'Payments must use whole pennies'; end if;
 insert into public.payments(id,order_id,payment_date,amount,method,reference,notes,received_by)
 values((pay->>'id')::uuid,p_id,(pay->>'payment_date')::date,(pay->>'amount')::numeric,pay->>'method',coalesce(pay->>'reference',''),coalesce(pay->>'notes',''),auth.uid());
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


commit;

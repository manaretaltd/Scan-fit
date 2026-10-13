begin;
insert into public.role_permissions(role,permission) values
 ('administrator','orders.read'),('administrator','orders.write'),('administrator','orders.clinical'),
 ('sales','orders.read'),('sales','orders.write'),('sales','orders.clinical'),
 ('finance','orders.read'),('operations','orders.confirmed.read');
create table public.products (
 id uuid primary key default gen_random_uuid(), sku text not null unique, name text not null,
 kind text not null check(kind in ('Loupe','Light','Battery','Charger','Accessory')),
 options jsonb not null default '{}', active boolean not null default true,
 provisional boolean not null default true, created_at timestamptz not null default now()
);
-- Starter options are illustrative, not a verified manufacturer catalogue. No assumed prices.
insert into public.products(sku,name,kind,options)
select 'LOUPE-'||model,model,'Loupe',
 '{"magnification":["3.0x","3.5x","4.0x"],"frame":["Standard","Sport"],"frame_colour":["Black","Silver"],"working_distance":["350","400","450","500"]}'::jsonb
from unnest(array['EL','ET','ST','SL']) model;
insert into public.products(sku,name,kind) values ('LIGHT-STARTER','LED light','Light'),('BATTERY-STARTER','Rechargeable battery','Battery'),('CHARGER-STARTER','Battery charger','Charger'),('CASE-STARTER','Protective case','Accessory');
create table public.orders (
 id uuid primary key, order_number bigint generated always as identity unique,
 customer_id uuid not null references public.customers(id) on delete restrict,
 status text not null default 'Draft' check(status in ('Draft','Order Confirmed')),
 current_step integer not null default 1 check(current_step between 1 and 7),
 version integer not null default 1, created_by uuid not null references public.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 confirmed_at timestamptz, confirmed_by uuid references public.users(id),
 subtotal numeric(14,2) not null default 0, discount_total numeric(14,2) not null default 0,
 vat_total numeric(14,2) not null default 0,total numeric(14,2) not null default 0,
 amount_paid numeric(14,2) not null default 0,balance numeric(14,2) not null default 0,
 check((status='Draft' and confirmed_at is null and confirmed_by is null) or
 (status='Order Confirmed' and confirmed_at is not null and confirmed_by is not null))
);
create index orders_customer_idx on public.orders(customer_id,created_at desc);
create index orders_status_idx on public.orders(status,created_at desc);
create table public.measurements (
 order_id uuid primary key references public.orders(id) on delete cascade,
 right_bd numeric(6,2) check(right_bd>0 and right_bd<=100), left_bd numeric(6,2) check(left_bd>0 and left_bd<=100),
 total_bd numeric(7,2) generated always as (right_bd+left_bd) stored,
 working_distance numeric(6,1) check(working_distance>0 and working_distance<=2000),
 notes text not null default '' check(length(notes)<=10000)
);
create table public.prescriptions (
 order_id uuid primary key references public.orders(id) on delete cascade, required boolean not null default false,
 right_eye jsonb not null default '{}',left_eye jsonb not null default '{}',
 prescription_date date,provider text not null default '',notes text not null default '' check(length(notes)<=10000)
);
create table public.order_items (
 id uuid primary key, order_id uuid not null references public.orders(id) on delete cascade,
 product_id uuid not null references public.products(id),sku text not null,description text not null,kind text not null,
 configuration jsonb not null default '{}', quantity integer not null check(quantity between 1 and 100),
 unit_price numeric(12,2) not null check(unit_price between 0 and 1000000),
 discount_type text not null check(discount_type in ('none','fixed','percent')),
 discount_value numeric(12,2) not null check(discount_value>=0), discount_reason text not null default '',
 authorised_by uuid references public.users(id),vat_rate numeric(5,2) not null check(vat_rate between 0 and 100),
 subtotal numeric(14,2) not null,discount_amount numeric(14,2) not null,vat_amount numeric(14,2) not null,total numeric(14,2) not null,
 unique(order_id,product_id)
);
create index order_items_order_idx on public.order_items(order_id);
create table public.payments (
 id uuid primary key,order_id uuid not null references public.orders(id) on delete cascade,
 payment_date date not null, amount numeric(12,2) not null check(amount>0 and amount<=1000000),
 method text not null check(method in ('Card','Bank Transfer','Cash','Payment Link','Finance','Other')),
 reference text not null default '',notes text not null default '',received_by uuid not null references public.users(id)
);
create index payments_order_idx on public.payments(order_id);
create table public.order_files (
 id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id) on delete cascade,
 filename text not null check(length(filename) between 1 and 200),
 mime_type text not null check(mime_type in ('application/pdf','image/jpeg','image/png','image/webp')),
 size_bytes bigint not null check(size_bytes between 1 and 10485760),
 storage_path text not null unique,category text not null default 'Prescription' check(category='Prescription'),
 uploaded_by uuid not null references public.users(id),created_at timestamptz not null default now(),
 check(storage_path like order_id::text||'/%')
);
create index order_files_order_idx on public.order_files(order_id);
alter table public.activities add column order_id uuid references public.orders(id) on delete set null;
alter table public.activities drop constraint activities_type_check;
alter table public.activities add constraint activities_type_check check(type in ('Call','Email','WhatsApp','SMS','Demo','Meeting','Note','Follow-up','File uploaded','Order created','Order confirmed'));
-- Clinical data has narrower access than financial and order summaries.
create function public.can_read_order(target uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.orders o where o.id=target and (public.has_permission('orders.read') or (o.status='Order Confirmed' and public.has_permission('orders.confirmed.read'))));
$$;
create function public.order_is_draft(target uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.has_permission('orders.write') and exists(select 1 from public.orders where id=target and status='Draft');
$$;
create function public.audit_order_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.audit_logs(user_id,action,entity_type,entity_id,previous_value,new_value)
 values(auth.uid(),tg_op,tg_table_name,coalesce(to_jsonb(new)->>'id',to_jsonb(old)->>'id',to_jsonb(new)->>'order_id',to_jsonb(old)->>'order_id'),
 case when tg_op<>'INSERT' then to_jsonb(old) end,case when tg_op<>'DELETE' then to_jsonb(new) end);
 return coalesce(new,old);
end $$;
do $$ declare t text; begin
 foreach t in array array['products','orders','measurements','prescriptions','order_items','payments','order_files'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('create trigger audit_%I after insert or update or delete on public.%I for each row execute function public.audit_order_change()',t,t);
 end loop;
end $$;
create policy products_read on public.products for select to authenticated using(public.has_permission('customers.read'));
create policy orders_read on public.orders for select to authenticated using(public.can_read_order(id));
create policy items_read on public.order_items for select to authenticated using(public.can_read_order(order_id));
create policy payments_read on public.payments for select to authenticated using(public.has_permission('orders.read'));
create policy measurements_read on public.measurements for select to authenticated using(public.can_read_order(order_id) and public.has_permission('orders.clinical'));
create policy prescriptions_read on public.prescriptions for select to authenticated using(public.can_read_order(order_id) and public.has_permission('orders.clinical'));
create policy order_files_read on public.order_files for select to authenticated using(public.can_read_order(order_id) and public.has_permission('orders.clinical'));
revoke all on sequence public.orders_order_number_seq from anon,authenticated;

create function public.validate_order_eye(eye jsonb,complete boolean) returns void language plpgsql set search_path='' as $$
declare k text; v numeric;
begin
 if jsonb_typeof(eye)<>'object' then raise exception 'Invalid eye fields'; end if;
 foreach k in array array['sphere','cylinder','axis','add','prism'] loop
 if eye->>k is not null then
 v=(eye->>k)::numeric;
 if v='NaN'::numeric or abs(v)>(case when k='axis' then 180 when k in ('add','prism') then 20 else 30 end)
 or (k in ('axis','add','prism') and v<0) or (k='axis' and v<>trunc(v)) then raise exception 'Invalid prescription %',k; end if;
 end if;
 end loop;
 if complete and (eye->>'sphere' is null or eye->>'cylinder' is null or (coalesce((eye->>'cylinder')::numeric,0)<>0 and eye->>'axis' is null)) then raise exception 'Complete both eyes before confirmation'; end if;
end $$;

create function public.save_order(p_id uuid,p_payload jsonb,p_expected_version integer,p_confirm boolean default false)
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
 if not new_order and existing.status='Order Confirmed' then
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
 perform public.validate_order_eye(coalesce(rx->'right_eye','{}'),p_confirm and (rx->>'required')::boolean);
 perform public.validate_order_eye(coalesce(rx->'left_eye','{}'),p_confirm and (rx->>'required')::boolean);
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
 if (rx->>'required')::boolean and (nullif(rx->>'prescription_date','') is null or length(trim(coalesce(rx->>'provider','')))=0) then raise exception 'Enter the prescription date and provider'; end if;
 update public.orders set status='Order Confirmed',confirmed_at=now(),confirmed_by=auth.uid(),current_step=7 where id=p_id returning * into saved;
 insert into public.activities(customer_id,order_id,type,description,user_id) values(cid,p_id,'Order confirmed','Confirmed order EO-'||saved.order_number,auth.uid());
 end if;
 return jsonb_build_object('id',saved.id,'version',saved.version,'order_number',saved.order_number,'status',saved.status);
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('order-prescriptions','order-prescriptions',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp']);
create policy prescription_object_read on storage.objects for select to authenticated using(bucket_id='order-prescriptions' and public.has_permission('orders.clinical') and exists(select 1 from public.orders where id::text=(storage.foldername(name))[1] and public.can_read_order(id)));
create policy prescription_object_insert on storage.objects for insert to authenticated with check(bucket_id='order-prescriptions' and exists(select 1 from public.orders where id::text=(storage.foldername(name))[1] and public.order_is_draft(id)));
create policy prescription_object_cleanup on storage.objects for delete to authenticated using(bucket_id='order-prescriptions' and owner_id=auth.uid()::text and public.has_permission('orders.write') and not exists(select 1 from public.order_files f where f.storage_path=name));

create function public.register_order_file(target uuid,path text,label text,mime text,bytes bigint,expected_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.orders; f public.order_files;
begin
 if not public.has_permission('orders.write') then raise exception 'Access denied'; end if;
 select * into o from public.orders where id=target for update;
 if not found or o.status<>'Draft' then raise exception 'Only draft orders accept attachments'; end if;
 if o.version is distinct from expected_version then raise exception 'Draft changed. Reload before uploading.'; end if;
 if not exists(select 1 from public.prescriptions where order_id=target and required) then raise exception 'Enable prescription before uploading'; end if;
 if not exists(select 1 from storage.objects where bucket_id='order-prescriptions' and name=path and owner_id=auth.uid()::text) then raise exception 'Uploaded object not found'; end if;
 insert into public.order_files(order_id,filename,mime_type,size_bytes,storage_path,uploaded_by) values(target,label,mime,bytes,path,auth.uid()) returning * into f;
 update public.orders set version=version+1,updated_at=now() where id=target;
 insert into public.activities(customer_id,order_id,type,description,user_id) values(o.customer_id,target,'File uploaded','Attached prescription document',auth.uid());
 return to_jsonb(f);
end $$;
create function public.remove_order_file(target uuid,expected_version integer) returns text language plpgsql security definer set search_path='' as $$
declare f public.order_files;
begin
 if not public.has_permission('orders.write') then raise exception 'Access denied'; end if;
 select * into f from public.order_files where id=target;
 if not found then raise exception 'File not found'; end if;
 perform 1 from public.orders where id=f.order_id and status='Draft' and version=expected_version for update;
 if not found then raise exception 'Confirmed attachments cannot be removed'; end if;
 delete from public.order_files where id=target;
 update public.orders set version=version+1,updated_at=now() where id=f.order_id;
 return f.storage_path;
end $$;
revoke all on function public.audit_order_change(),public.validate_order_eye(jsonb,boolean),public.can_read_order(uuid),public.order_is_draft(uuid),public.save_order(uuid,jsonb,integer,boolean),public.register_order_file(uuid,text,text,text,bigint,integer),public.remove_order_file(uuid,integer) from public,anon,authenticated;
grant execute on function public.can_read_order(uuid),public.order_is_draft(uuid),public.save_order(uuid,jsonb,integer,boolean),public.register_order_file(uuid,text,text,text,bigint,integer),public.remove_order_file(uuid,integer) to authenticated;
commit;

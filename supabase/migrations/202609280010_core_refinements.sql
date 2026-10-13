begin;
alter table public.users add column removed_at timestamptz,add column removed_by uuid references public.users(id),add constraint removed_user_inactive check(removed_at is null or not active);
create function public.remove_staff(target uuid,confirmed boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.has_permission('staff.manage') or confirmed is distinct from true then raise exception 'Administrator confirmation required';end if;
 perform pg_advisory_xact_lock(829317);
 if target=auth.uid() then raise exception 'You cannot remove yourself';end if;
 if not exists(select 1 from public.users where id=target) then raise exception 'User not found';end if;
 if exists(select 1 from public.users where id=target and active and role='administrator') and (select count(*) from public.users where active and role='administrator')<=1 then raise exception 'Keep an active administrator';end if;
 update public.users set active=false,removed_at=coalesce(removed_at,now()),removed_by=auth.uid() where id=target;
 insert into public.audit_logs(entity_type,entity_id,action,user_id,new_value) values('users',target,'USER_REMOVED',auth.uid(),jsonb_build_object('access_revoked',true,'history_preserved',true));
end $$;
revoke all on function public.remove_staff(uuid,boolean) from public,anon,authenticated;
grant execute on function public.remove_staff(uuid,boolean) to authenticated;
alter table public.customers add column delivery_address_same_as_customer boolean not null default false;
alter table public.customer_addresses add column county text not null default '' check(length(county)<=100);
create or replace function public.save_customer(payload jsonb,addresses jsonb,customer_id uuid default null,allow_duplicate boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare saved_id uuid; matches jsonb; a jsonb;
begin
 if not public.has_permission('crm.write') then raise exception 'Access denied'; end if;
 if customer_id is null and not allow_duplicate then
 select jsonb_agg(jsonb_build_object('id',c.id,'first_name',c.first_name,'last_name',c.last_name,'practice_name',c.practice_name,'customer_number',c.customer_number)) into matches
 from public.customers c where
 (nullif(trim(payload->>'email'),'') is not null and lower(trim(c.email))=lower(trim(payload->>'email'))) or
 (nullif(public.normalize_phone(payload->>'mobile'),'') is not null and public.normalize_phone(c.mobile)=public.normalize_phone(payload->>'mobile')) or
 (lower(trim(c.first_name))=lower(trim(payload->>'first_name')) and lower(trim(c.last_name))=lower(trim(payload->>'last_name')) and lower(trim(c.practice_name))=lower(trim(payload->>'practice_name')));
 if matches is not null then return jsonb_build_object('duplicates',matches); end if;
 end if;
 if customer_id is null then
 insert into public.customers(first_name,last_name) values(payload->>'first_name',payload->>'last_name') returning id into saved_id;
 else saved_id=customer_id;
 end if;
 update public.customers set first_name=payload->>'first_name',last_name=payload->>'last_name',email=coalesce(payload->>'email',''),
 mobile=coalesce(payload->>'mobile',''),alternative_phone=coalesce(payload->>'alternative_phone',''),profession=coalesce(payload->>'profession',''),
 job_title=coalesce(payload->>'job_title',''),gdc_number=coalesce(payload->>'gdc_number',''),practice_name=coalesce(payload->>'practice_name',''),
 practice_telephone=coalesce(payload->>'practice_telephone',''),assigned_to=nullif(payload->>'assigned_to','')::uuid,
 lead_source=nullif(payload->>'lead_source',''),status=(payload->>'status')::public.customer_status,
 preferred_contact=payload->>'preferred_contact',notes=coalesce(payload->>'notes',''),delivery_address_same_as_customer=coalesce((payload->>'delivery_address_same_as_customer')::boolean,false) where id=saved_id;
 if not found then raise exception 'Customer not found or access denied'; end if;
 delete from public.customer_addresses ca where ca.customer_id=saved_id;
 for a in select * from jsonb_array_elements(addresses) loop
 if coalesce((payload->>'delivery_address_same_as_customer')::boolean,false) and a->>'kind'='Delivery' then continue;end if;
 insert into public.customer_addresses(customer_id,kind,line1,line2,city,postcode,country,county)
 values(saved_id,a->>'kind',a->>'line1',coalesce(a->>'line2',''),coalesce(a->>'city',''),coalesce(a->>'postcode',''),coalesce(a->>'country','United Kingdom'),coalesce(a->>'county',''));
 end loop;
 return jsonb_build_object('id',saved_id);
end $$;

-- New light has its own SKU; existing historic LED product/lines are preserved.
insert into public.products(sku,name,kind,options,default_vat_rate,default_vat_applicable) values('LIGHT-WIRELESS','Wireless Dental Light','Light','{}',0,true);
alter table public.orders add column order_date date,add column manufacturing_expected_from date,add column manufacturing_expected_to date,add column manufacturing_override_reason text not null default '',add column manufacturing_overridden_by uuid references public.users(id),add column manufacturing_overridden_at timestamptz;
update public.orders set order_date=(confirmed_at at time zone 'Europe/London')::date,manufacturing_expected_from=(confirmed_at at time zone 'Europe/London')::date+42,manufacturing_expected_to=coalesce(expected_completion_date,(confirmed_at at time zone 'Europe/London')::date+56),expected_completion_date=coalesce(expected_completion_date,(confirmed_at at time zone 'Europe/London')::date+56) where confirmed_at is not null;
create function public.manufacturing_window() returns trigger language plpgsql set search_path='' as $$
begin
 if new.confirmed_at is not null and old.confirmed_at is null then
 new.order_date=coalesce(new.order_date,(new.confirmed_at at time zone 'Europe/London')::date);
 new.manufacturing_expected_from=new.order_date+42;new.manufacturing_expected_to=new.order_date+56;new.expected_completion_date=new.manufacturing_expected_to;
 elsif new.expected_completion_date is distinct from old.expected_completion_date and new.manufacturing_expected_to is not distinct from old.manufacturing_expected_to then
 raise exception 'Use the manufacturing window action with an override reason';
 end if;
 return new;
end $$;
create trigger manufacturing_window before update on public.orders for each row execute function public.manufacturing_window();
create function public.set_manufacturing_window(target uuid,from_date date,to_date date,reason text,new_order_date date default null) returns void language plpgsql security definer set search_path='' as $$
declare o public.orders;
begin
 if not public.has_permission('orders.manage') or not exists(select 1 from public.users where id=auth.uid() and active and role in ('administrator','operations')) or not public.can_read_order(target) then raise exception 'Access denied';end if;
 select * into o from public.orders where id=target for update;
 if o.confirmed_at is null then raise exception 'Confirm the order first';end if;
 if length(trim(coalesce(reason,''))) not between 1 and 1000 then raise exception 'Enter an override reason';end if;
 if new_order_date is not null then
 if o.status not in ('Order Confirmed','Ready for Manufacturer') or not isfinite(new_order_date) then raise exception 'Order date can only change before manufacturing submission';end if;
 from_date=new_order_date+42;to_date=new_order_date+56;
 end if;
 if from_date is null or to_date is null or not isfinite(from_date) or not isfinite(to_date) or from_date>to_date then raise exception 'Enter a valid date window';end if;
 update public.orders set order_date=coalesce(new_order_date,order_date),manufacturing_expected_from=from_date,manufacturing_expected_to=to_date,expected_completion_date=to_date,manufacturing_override_reason=reason,manufacturing_overridden_by=auth.uid(),manufacturing_overridden_at=now(),version=version+1 where id=target;
 perform public.order_event(target,'Manufacturing window updated',reason,'operational');
end $$;
revoke all on function public.manufacturing_window(),public.set_manufacturing_window(uuid,date,date,text,date) from public,anon,authenticated;
grant execute on function public.set_manufacturing_window(uuid,date,date,text,date) to authenticated;
create or replace function public.operate_order_internal(target uuid,operation text,payload jsonb,request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
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
 update public.orders set manufacturer_reference=coalesce(payload->>'manufacturer_reference',''),expected_completion_date=case when payload ? 'expected_completion_date' then nullif(payload->>'expected_completion_date','')::date else expected_completion_date end,version=version+1,updated_at=now() where id=target;
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
create or replace function public.order_financial_summary(target uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('order',to_jsonb(o),
 'product_value',(select coalesce(sum(subtotal),0) from public.order_items where order_id=o.id and kind='Loupe'),
 'lights',(select coalesce(sum(subtotal),0) from public.order_items where order_id=o.id and kind='Light'),
 'accessories',(select coalesce(sum(subtotal),0) from public.order_items where order_id=o.id and kind not in ('Loupe','Light')),
 'prescription_charges',(select coalesce(sum(amount),0) from public.order_charges where order_id=o.id and category='Prescription'),
 'other_charges',(select coalesce(sum(amount),0) from public.order_charges where order_id=o.id and category='Other'),
 'net',o.subtotal-o.discount_total,
 'payments',(select coalesce(jsonb_agg(to_jsonb(p) order by paid_at desc),'[]') from public.payments p where order_id=o.id),
 'refunds',(select coalesce(jsonb_agg(to_jsonb(r) order by refund_date desc),'[]') from public.refunds r where order_id=o.id),
 'charges',(select coalesce(jsonb_agg(to_jsonb(c)),'[]') from public.order_charges c where order_id=o.id),
 'finance',(select to_jsonb(f) from public.order_finance f where order_id=o.id))
 from public.orders o where id=target and public.has_permission('finance.read') and public.can_read_order(o.id); $$;

create function public.purge_unused_staff(target uuid,confirmed boolean) returns void language plpgsql security definer set search_path='' as $$
declare person public.users;r record;dependent boolean;
begin
 if not public.has_permission('staff.manage') or confirmed is distinct from true or target=auth.uid() then raise exception 'Administrator confirmation required';end if;
 perform pg_advisory_xact_lock(829317);
 select * into person from public.users where id=target for update;
 if not found or person.active or person.removed_at is null then raise exception 'Remove access first';end if;
 if exists(select 1 from auth.users where id=target and last_sign_in_at is not null) or exists(select 1 from public.audit_logs where user_id=target) then raise exception 'This user has history and must be retained as Removed / Inactive';end if;
 for r in select n.nspname schema_name,c.relname table_name,a.attname column_name from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum=any(k.conkey) where k.contype='f' and k.confrelid='public.users'::regclass loop
 if r.schema_name='public' and r.table_name='staff_profiles' and r.column_name='id' then continue;end if;
 execute format('select exists(select 1 from %I.%I where %I=$1)',r.schema_name,r.table_name,r.column_name) into dependent using target;
 if dependent then raise exception 'This user has historical dependencies and must be retained as Removed / Inactive';end if;
 end loop;
 insert into public.audit_logs(user_id,action,entity_type,entity_id,previous_value,new_value) values(auth.uid(),'UNUSED_USER_PURGED','users',target,to_jsonb(person),jsonb_build_object('historical_identity',person.full_name,'auth_cleanup_required',true));
 delete from public.staff_profiles where id=target;
 delete from public.users where id=target;
end $$;
revoke all on function public.purge_unused_staff(uuid,boolean) from public,anon,authenticated;
grant execute on function public.purge_unused_staff(uuid,boolean) to authenticated;
-- Historical assignments remain visible; new assignments require active staff.
create function public.active_customer_assignment() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.assigned_to is not null and (tg_op='INSERT' or new.assigned_to is distinct from old.assigned_to) and not exists(select 1 from public.users where id=new.assigned_to and active and removed_at is null) then raise exception 'Choose an active staff member';end if;
 return new;
end $$;
create trigger active_customer_assignment before insert or update on public.customers for each row execute function public.active_customer_assignment();
commit;

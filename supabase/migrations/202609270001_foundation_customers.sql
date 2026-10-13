begin;
create type public.staff_role as enum ('administrator','sales','operations','finance');
create type public.customer_status as enum ('Lead','Prospect','Customer','Inactive');
create table public.users (
 id uuid primary key references auth.users(id) on delete restrict,
 full_name text not null check (length(full_name) between 1 and 150),
 role public.staff_role not null default 'sales', active boolean not null default false,
 created_at timestamptz not null default now()
);
create table public.role_permissions (
 role public.staff_role not null, permission text not null, primary key(role,permission)
);
insert into public.role_permissions values
 ('administrator','customers.read'),('administrator','crm.write'),('administrator','crm.read'),('administrator','staff.manage'),('administrator','audit.read'),
 ('sales','customers.read'),('sales','crm.read'),('sales','crm.write'),
 ('operations','customers.read'),('finance','customers.read');
create function public.has_permission(p_permission text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.users u join public.role_permissions p on p.role=u.role
 where u.id=auth.uid() and u.active and p.permission=p_permission);
$$;
create function public.provision_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.users(id,full_name) values(new.id,coalesce(nullif(left(new.raw_user_meta_data->>'full_name',150),''),left(new.email,150),'New staff member'));
 return new;
end $$;
create trigger provision_staff after insert on auth.users for each row execute function public.provision_user();
-- Provision existing auth accounts without silently granting access.
insert into public.users(id,full_name) select id,coalesce(nullif(left(raw_user_meta_data->>'full_name',150),''),left(email,150),'New staff member') from auth.users on conflict do nothing;
create table public.lead_sources (name text primary key, active boolean not null default true);
insert into public.lead_sources(name) values ('Website'),('Instagram'),('Facebook'),('Dental Show'),('Referral'),('Sales Representative'),('Existing Customer'),('University'),('Direct Enquiry'),('Other');
create function public.normalize_phone(value text) returns text language sql immutable set search_path='' as $$
 select regexp_replace(regexp_replace(regexp_replace(coalesce(value,''),'[^0-9]','','g'),'^0044','0'),'^44','0');
$$;
create table public.customers (
 id uuid primary key default gen_random_uuid(),
 customer_number bigint generated always as identity unique,
 first_name text not null check(length(trim(first_name)) between 1 and 100),
 last_name text not null check(length(trim(last_name)) between 1 and 100),
 email text not null default '' check(length(email)<=254), mobile text not null default '' check(length(mobile)<=40),
 alternative_phone text not null default '', profession text not null default '', job_title text not null default '',
 gdc_number text not null default '', practice_name text not null default '', practice_telephone text not null default '',
 assigned_to uuid references public.users(id), lead_source text references public.lead_sources(name),
 status public.customer_status not null default 'Lead',
 preferred_contact text not null default 'Email' check(preferred_contact in ('Email','Phone','SMS','WhatsApp')),
 notes text not null default '' check(length(notes)<=10000),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index customers_name_idx on public.customers(lower(last_name),lower(first_name));
create index customers_email_idx on public.customers(lower(trim(email)));
create index customers_mobile_idx on public.customers(public.normalize_phone(mobile));
create index customers_status_idx on public.customers(status,created_at desc);
create index customers_assigned_idx on public.customers(assigned_to);
create table public.customer_addresses (
 id uuid primary key default gen_random_uuid(), customer_id uuid not null references public.customers(id) on delete cascade,
 kind text not null check(kind in ('Practice','Delivery')), line1 text not null check(length(trim(line1)) between 1 and 200),
 line2 text not null default '', city text not null default '', postcode text not null default '', country text not null default 'United Kingdom',
 unique(customer_id,kind)
);
create table public.activities (
 id uuid primary key default gen_random_uuid(), customer_id uuid not null references public.customers(id) on delete cascade,
 type text not null check(type in ('Call','Email','WhatsApp','SMS','Demo','Meeting','Note','Follow-up','File uploaded')),
 description text not null check(length(trim(description)) between 1 and 10000),
 user_id uuid not null default auth.uid() references public.users(id), created_at timestamptz not null default now()
);
create index activities_customer_idx on public.activities(customer_id,created_at desc);
create table public.tasks (
 id uuid primary key default gen_random_uuid(), customer_id uuid not null references public.customers(id) on delete cascade,
 title text not null check(length(trim(title)) between 1 and 200), description text not null default '' check(length(description)<=10000),
 assigned_to uuid not null references public.users(id), due_date date not null,
 priority text not null default 'Medium' check(priority in ('Low','Medium','High')),
 completed boolean not null default false, created_by uuid not null default auth.uid() references public.users(id),
 created_at timestamptz not null default now()
);
create index tasks_customer_idx on public.tasks(customer_id,due_date);
create index tasks_due_idx on public.tasks(due_date) where not completed;
create table public.files (
 id uuid primary key default gen_random_uuid(), customer_id uuid not null references public.customers(id) on delete cascade,
 filename text not null check(length(filename) between 1 and 200), mime_type text not null,
 size_bytes bigint not null check(size_bytes between 1 and 10485760),
 category text not null check(category in ('Customer','Other')),
 description text not null default '' check(length(description)<=1000),
 storage_path text not null unique, internal boolean not null default true check(internal),
 uploaded_by uuid not null default auth.uid() references public.users(id), created_at timestamptz not null default now(),
 check(storage_path like customer_id::text || '/%')
);
create index files_customer_idx on public.files(customer_id,created_at desc);
create table public.audit_logs (
 id bigint generated always as identity primary key, user_id uuid, action text not null, entity_type text not null,
 entity_id text not null, created_at timestamptz not null default now(), previous_value jsonb, new_value jsonb
);
create function public.audit_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.audit_logs(user_id,action,entity_type,entity_id,previous_value,new_value)
 values(auth.uid(),tg_op,tg_table_name,coalesce(to_jsonb(new)->>'id',to_jsonb(old)->>'id',to_jsonb(new)->>'name',to_jsonb(old)->>'name'),
 case when tg_op<>'INSERT' then to_jsonb(old) end,case when tg_op<>'DELETE' then to_jsonb(new) end);
 return coalesce(new,old);
end $$;
create function public.touch_customer() returns trigger language plpgsql set search_path='' as $$
begin new.updated_at=now(); return new; end $$;
create trigger customer_updated before update on public.customers for each row execute function public.touch_customer();
do $$ declare t text; begin
 foreach t in array array['users','customers','customer_addresses','activities','tasks','files','lead_sources'] loop
 execute format('create trigger audit_%I after insert or update or delete on public.%I for each row execute function public.audit_change()',t,t);
 end loop;
end $$;
-- File registration and its timeline entry commit together.
create function public.record_file_activity() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.activities(customer_id,type,description,user_id)
 values(new.customer_id,'File uploaded','Uploaded '||new.filename,new.uploaded_by);
 return new;
end $$;
revoke all on function public.record_file_activity() from public,anon,authenticated;
create trigger file_activity after insert on public.files for each row execute function public.record_file_activity();
-- RLS is the authority: checks are repeated on every query, including deactivated sessions.
alter table public.users enable row level security;
alter table public.role_permissions enable row level security;
alter table public.lead_sources enable row level security;
alter table public.customers enable row level security;
alter table public.customer_addresses enable row level security;
alter table public.activities enable row level security;
alter table public.tasks enable row level security;
alter table public.files enable row level security;
alter table public.audit_logs enable row level security;
create policy staff_read on public.users for select to authenticated using(id=auth.uid() or public.has_permission('customers.read'));
create policy permissions_read on public.role_permissions for select to authenticated using(public.has_permission('customers.read'));
create policy sources_read on public.lead_sources for select to authenticated using(public.has_permission('customers.read'));
create policy audit_read on public.audit_logs for select to authenticated using(public.has_permission('audit.read'));
create policy customers_read on public.customers for select to authenticated using(public.has_permission('customers.read'));
create policy customers_insert on public.customers for insert to authenticated with check(public.has_permission('crm.write'));
create policy customers_update on public.customers for update to authenticated using(public.has_permission('crm.write')) with check(public.has_permission('crm.write'));
create policy addresses_read on public.customer_addresses for select to authenticated using(public.has_permission('customers.read'));
create policy addresses_write on public.customer_addresses for all to authenticated using(public.has_permission('crm.write')) with check(public.has_permission('crm.write'));
create policy activities_read on public.activities for select to authenticated using(public.has_permission('crm.read'));
create policy activities_insert on public.activities for insert to authenticated with check(public.has_permission('crm.write') and user_id=auth.uid());
create policy tasks_read on public.tasks for select to authenticated using(public.has_permission('crm.read'));
create policy tasks_insert on public.tasks for insert to authenticated with check(public.has_permission('crm.write') and created_by=auth.uid());
create policy tasks_update on public.tasks for update to authenticated using(public.has_permission('crm.write')) with check(public.has_permission('crm.write'));
create policy files_read on public.files for select to authenticated using(public.has_permission('crm.read'));
create policy files_insert on public.files for insert to authenticated with check(public.has_permission('crm.write') and uploaded_by=auth.uid());
-- Restrict column updates so task authors cannot be forged. Staff changes use a guarded RPC.
revoke all on public.users,public.role_permissions,public.lead_sources,public.customers,public.customer_addresses,public.activities,public.tasks,public.files,public.audit_logs from anon,authenticated;
grant usage on schema public to authenticated;
grant select on public.users,public.role_permissions,public.lead_sources,public.audit_logs to authenticated;
grant select,insert,update on public.customers to authenticated;
grant select,insert,update,delete on public.customer_addresses to authenticated;
grant select,insert on public.activities,public.files to authenticated;
grant select,insert on public.tasks to authenticated;
grant update(completed) on public.tasks to authenticated;
revoke all on sequence public.customers_customer_number_seq,public.audit_logs_id_seq from anon,authenticated;
grant usage,select on sequence public.customers_customer_number_seq to authenticated;
create function public.update_staff(target uuid,new_role public.staff_role,is_active boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.has_permission('staff.manage') then raise exception 'Access denied'; end if;
 perform pg_advisory_xact_lock(829317);
 if target=auth.uid() then raise exception 'You cannot change your own access'; end if;
 update public.users set role=new_role,active=is_active where id=target;
 if not found then raise exception 'Staff member not found'; end if;
end $$;
-- Atomic customer + address save. The caller still operates under RLS.
create function public.save_customer(payload jsonb,addresses jsonb,customer_id uuid default null,allow_duplicate boolean default false)
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
 preferred_contact=payload->>'preferred_contact',notes=coalesce(payload->>'notes','') where id=saved_id;
 if not found then raise exception 'Customer not found or access denied'; end if;
 delete from public.customer_addresses ca where ca.customer_id=saved_id;
 for a in select * from jsonb_array_elements(addresses) loop
 insert into public.customer_addresses(customer_id,kind,line1,line2,city,postcode,country)
 values(saved_id,a->>'kind',a->>'line1',coalesce(a->>'line2',''),coalesce(a->>'city',''),coalesce(a->>'postcode',''),coalesce(a->>'country','United Kingdom'));
 end loop;
 return jsonb_build_object('id',saved_id);
end $$;
-- Database-driven search avoids concatenating user input into PostgREST filters.
create function public.search_customers(term text default '',status_filter text default '',assignee uuid default null,sort_key text default 'newest',page_number integer default 1)
returns table(id uuid,customer_number bigint,first_name text,last_name text,email text,mobile text,practice_name text,status public.customer_status,assigned_to uuid,total_count bigint)
language sql stable security invoker set search_path='' as $$
 select c.id,c.customer_number,c.first_name,c.last_name,c.email,c.mobile,c.practice_name,c.status,c.assigned_to,count(*) over()
 from public.customers c where (status_filter='' or c.status::text=status_filter) and (assignee is null or c.assigned_to=assignee)
 and (term='' or position(lower(term) in lower(concat_ws(' ',c.first_name,c.last_name,c.email,c.mobile,c.practice_name,'ES-'||c.customer_number)))>0
 or (length(public.normalize_phone(term))>=3 and position(public.normalize_phone(term) in public.normalize_phone(c.mobile))>0))
 order by case when sort_key='name' then lower(c.last_name||c.first_name) end asc,
 case when sort_key='oldest' then c.created_at end asc,c.created_at desc,c.id
 limit 20 offset (greatest(1,least(page_number,100000))-1)*20;
$$;
revoke all on function public.provision_user(),public.audit_change(),public.touch_customer() from public,anon,authenticated;
revoke all on function public.has_permission(text),public.update_staff(uuid,public.staff_role,boolean),public.save_customer(jsonb,jsonb,uuid,boolean),public.search_customers(text,text,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.has_permission(text),public.update_staff(uuid,public.staff_role,boolean),public.save_customer(jsonb,jsonb,uuid,boolean),public.search_customers(text,text,uuid,text,integer) to authenticated;
-- Private basic documents/photos; no public object URLs and no general-purpose HTML/SVG uploads.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('customer-files','customer-files',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp']);
create policy customer_objects_read on storage.objects for select to authenticated using(
 bucket_id='customer-files' and public.has_permission('crm.read') and exists(select 1 from public.customers c where c.id::text=(storage.foldername(name))[1]));
create policy customer_objects_insert on storage.objects for insert to authenticated with check(
 bucket_id='customer-files' and public.has_permission('crm.write') and exists(select 1 from public.customers c where c.id::text=(storage.foldername(name))[1]));
-- Allows cleanup if metadata insertion fails, without permitting deletion of registered documents.
create policy customer_objects_cleanup on storage.objects for delete to authenticated using(
 bucket_id='customer-files' and public.has_permission('crm.write') and owner_id=auth.uid()::text
 and not exists(select 1 from public.files f where f.storage_path=name));
commit;

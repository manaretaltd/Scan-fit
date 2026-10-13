begin;
-- Keep private contact/account metadata separate from the shared staff directory.
create table public.staff_profiles (
 id uuid primary key references public.users(id) on delete restrict,
 first_name text not null default '' check(length(first_name)<=70),
 last_name text not null default '' check(length(last_name)<=70),
 email text not null default '', mobile text not null default '' check(length(mobile)<=40),
 created_by uuid references public.users(id), last_login timestamptz,
 invitation_sent_at timestamptz
);
alter table public.staff_profiles enable row level security;
revoke all on public.staff_profiles from anon,authenticated;
grant select on public.staff_profiles to authenticated;
create policy profiles_read on public.staff_profiles for select to authenticated
 using(public.has_permission('staff.manage') or (id=auth.uid() and exists(select 1 from public.users where id=auth.uid() and active)));
insert into public.staff_profiles(id,first_name,last_name,email,last_login)
 select u.id,left(split_part(u.full_name,' ',1),70),left(case when strpos(u.full_name,' ')>0 then substr(u.full_name,strpos(u.full_name,' ')+1) else '' end,70),coalesce(a.email,''),a.last_sign_in_at from public.users u join auth.users a on a.id=u.id;
create trigger audit_staff_profiles after insert or update on public.staff_profiles for each row execute function public.audit_change();
create or replace function public.provision_user() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.users(id,full_name) values(new.id,coalesce(nullif(left(new.raw_user_meta_data->>'full_name',150),''),left(new.email,150),'New staff member'));
 insert into public.staff_profiles(id,email) values(new.id,coalesce(new.email,''));
 return new;
end $$;
-- Read only selected Auth fields. Never copy password hashes, tokens or raw metadata to CRM logs.
create function public.sync_staff_auth() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.staff_profiles set email=coalesce(new.email,''),last_login=new.last_sign_in_at where id=new.id and (email is distinct from coalesce(new.email,'') or last_login is distinct from new.last_sign_in_at);
 if new.encrypted_password is distinct from old.encrypted_password then
 insert into public.audit_logs(user_id,action,entity_type,entity_id) values(new.id,'PASSWORD_CHANGED','staff_auth',new.id::text);
 end if;
 if new.last_sign_in_at is distinct from old.last_sign_in_at and new.last_sign_in_at is not null then
 insert into public.audit_logs(user_id,action,entity_type,entity_id,new_value) values(new.id,'LOGIN','staff_auth',new.id::text,jsonb_build_object('at',new.last_sign_in_at));
 end if;
 return new;
end $$;
create trigger staff_auth_sync after update of email,last_sign_in_at,encrypted_password on auth.users for each row execute function public.sync_staff_auth();
create function public.edit_staff(target uuid,first_name text,last_name text,mobile text,new_role public.staff_role,is_active boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(829317);
 if not public.has_permission('staff.manage') then raise exception 'Access denied'; end if;
 if length(trim(first_name)) not between 1 and 70 or length(trim(last_name)) not between 1 and 70 or length(mobile)>40 then raise exception 'Invalid staff details';end if;
 if target=auth.uid() and exists(select 1 from public.users where id=target and (role<>new_role or active<>is_active)) then raise exception 'You cannot change your own access';end if;
 update public.users set full_name=trim(first_name)||' '||trim(last_name),role=new_role,active=is_active where id=target;
 if not found then raise exception 'Staff member not found';end if;
 update public.staff_profiles p set first_name=trim(edit_staff.first_name),last_name=trim(edit_staff.last_name),mobile=edit_staff.mobile where id=target;
end $$;
create function public.staff_auth_event(target uuid,event text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.has_permission('staff.manage') or event not in ('USER_CREATED','INVITATION_SENT','PASSWORD_RESET_REQUESTED','AUTH_BAN_SYNC_FAILED') then raise exception 'Access denied'; end if;
 if not exists(select 1 from public.users where id=target) then raise exception 'Unknown staff';end if;
 if event='USER_CREATED' then update public.staff_profiles set created_by=auth.uid() where id=target and created_by is null;end if;
 if event='INVITATION_SENT' then update public.staff_profiles set invitation_sent_at=now() where id=target;end if;
 insert into public.audit_logs(user_id,action,entity_type,entity_id) values(auth.uid(),event,'staff_auth',target::text);
end $$;
-- Reset grants are single-use, short-lived and bound to the verified Auth user.
create table public.password_grants (digest text primary key,user_id uuid not null references public.users(id),expires_at timestamptz not null);
alter table public.password_grants enable row level security;
revoke all on public.password_grants from public,anon,authenticated;
grant all on public.password_grants to service_role;
create function public.consume_password_grant(proof text) returns boolean language plpgsql security definer set search_path='' as $$
declare accepted uuid;
begin
 delete from public.password_grants where digest=proof and user_id=auth.uid() and expires_at>now() and exists(select 1 from public.users where id=auth.uid() and active) returning user_id into accepted;
 return accepted is not null;
end $$;
-- Per-account email throttling is persistent across application instances. Only server may call.
create table public.auth_email_limits (digest text primary key,requested_at timestamptz not null);
alter table public.auth_email_limits enable row level security;
revoke all on public.auth_email_limits from public,anon,authenticated;
create function public.claim_auth_email(key_hash text) returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 insert into public.auth_email_limits values(key_hash,now()) on conflict(digest) do update set requested_at=now() where auth_email_limits.requested_at < now()-interval '60 seconds';
 get diagnostics n=row_count; return n=1;
end $$;
revoke all on function public.sync_staff_auth(),public.edit_staff(uuid,text,text,text,public.staff_role,boolean),public.staff_auth_event(uuid,text),public.consume_password_grant(text),public.claim_auth_email(text) from public,anon,authenticated;
grant execute on function public.edit_staff(uuid,text,text,text,public.staff_role,boolean),public.staff_auth_event(uuid,text),public.consume_password_grant(text) to authenticated;
grant execute on function public.claim_auth_email(text) to service_role;
-- Sales can work with orders they created or those assigned through the customer.
create or replace function public.can_read_order(target uuid) returns boolean language sql stable security definer set search_path='' as $$
select exists(select 1 from public.orders o join public.customers c on c.id=o.customer_id join public.users u on u.id=auth.uid() and u.active where o.id=target and
(public.has_permission('orders.read') or (o.status<>'Draft' and public.has_permission('orders.confirmed.read'))) and
(u.role<>'sales' or o.created_by=auth.uid() or c.assigned_to=auth.uid())); $$;
create or replace function public.order_is_draft(target uuid) returns boolean language sql stable security definer set search_path='' as $$
select public.has_permission('orders.write') and public.can_read_order(target) and exists(select 1 from public.orders where id=target and status='Draft'); $$;
drop policy payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated using(public.has_permission('orders.read') and public.can_read_order(order_id));
-- Preserve the working wizard implementation and put ownership authorization around it.
alter function public.save_order(uuid,jsonb,integer,boolean) rename to save_order_internal;
revoke all on function public.save_order_internal(uuid,jsonb,integer,boolean) from public,anon,authenticated;
create function public.save_order(p_id uuid,p_payload jsonb,p_expected_version integer,p_confirm boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.has_permission('orders.write') then raise exception 'Access denied';end if;
 if exists(select 1 from public.orders where id=p_id) and not public.can_read_order(p_id) then raise exception 'Access denied';end if;
 return public.save_order_internal(p_id,p_payload,p_expected_version,p_confirm);
end $$;
revoke all on function public.save_order(uuid,jsonb,integer,boolean) from public,anon,authenticated;
grant execute on function public.save_order(uuid,jsonb,integer,boolean) to authenticated;
-- Shared customer contact editing must not allow sales to grant themselves another rep’s orders.
create function public.guard_customer_assignment() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and new.assigned_to is distinct from old.assigned_to and exists(select 1 from public.users where id=auth.uid() and role='sales') then raise exception 'Only an administrator can reassign customers';end if;
 return new;
end $$;
create trigger guard_customer_assignment before update of assigned_to on public.customers for each row execute function public.guard_customer_assignment();
revoke all on function public.guard_customer_assignment() from public,anon,authenticated;
drop policy tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated using(public.has_permission('crm.read') and (order_id is null or public.can_read_order(order_id)));
drop policy tasks_insert on public.tasks;
create policy tasks_insert on public.tasks for insert to authenticated with check(public.has_permission('crm.write') and created_by=auth.uid() and (order_id is null or public.can_read_order(order_id)));
drop policy tasks_update on public.tasks;
create policy tasks_update on public.tasks for update to authenticated using(public.has_permission('crm.write') and (order_id is null or public.can_read_order(order_id))) with check(public.has_permission('crm.write') and (order_id is null or public.can_read_order(order_id)));
create function public.staff_sales_summary() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.has_permission('staff.manage') then raise exception 'Access denied';end if;
 select coalesce(jsonb_object_agg(u.id, jsonb_build_object(
 'customers',(select count(*) from public.customers c where c.assigned_to=u.id and c.status='Customer'),
 'leads',(select count(*) from public.customers c where c.assigned_to=u.id and c.status in ('Lead','Prospect')),
 'orders',(select count(*) from public.orders o join public.customers c on c.id=o.customer_id where c.assigned_to=u.id or o.created_by=u.id),
 'value',(select coalesce(sum(o.total),0) from public.orders o join public.customers c on c.id=o.customer_id where o.status<>'Draft' and (c.assigned_to=u.id or o.created_by=u.id)),
 'paid',(select coalesce(sum(o.amount_paid),0) from public.orders o join public.customers c on c.id=o.customer_id where o.status<>'Draft' and (c.assigned_to=u.id or o.created_by=u.id))
 )), '{}'::jsonb) into result from public.users u where u.role='sales';
 return result;
end $$;
revoke all on function public.staff_sales_summary() from public,anon,authenticated;
grant execute on function public.staff_sales_summary() to authenticated;
drop policy activities_read on public.activities;
create policy activities_read on public.activities for select to authenticated using(public.has_permission('crm.read') and (order_id is null or public.can_read_order(order_id)));
drop policy activities_insert on public.activities;
create policy activities_insert on public.activities for insert to authenticated with check(public.has_permission('crm.write') and user_id=auth.uid() and (order_id is null or public.can_read_order(order_id)));
commit;

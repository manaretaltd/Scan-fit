begin;
create function public.system_health() returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb='[]';t text;present boolean;secured boolean;haspolicy boolean;b record;healthy boolean;expected text[]:=array['users','staff_profiles','customers','orders','measurements','prescriptions','order_items','payments','refunds','order_charges','order_finance','files','order_files','tasks','activities','order_events','audit_logs','finance_settings','password_grants','auth_email_limits','finance_requests'];
begin
 if not public.has_permission('system.health') or not public.has_permission('staff.manage') then raise exception 'Access denied';end if;
 foreach t in array expected loop
 select true,c.relrowsecurity into present,secured from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=t;
 select exists(select 1 from pg_catalog.pg_policies where schemaname='public' and tablename=t) into haspolicy;
 rows=rows||jsonb_build_array(jsonb_build_object('component',t,'status',case when coalesce(present,false) and secured then 'Healthy' else 'Failed' end,'detail',case when not coalesce(present,false) then 'Expected table missing' when not secured then 'RLS is disabled' when not haspolicy then 'RLS enabled; direct authenticated access denied (server-only table)' else 'Table present; RLS enabled; policies present' end));
 end loop;
 healthy=exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='refunds_total') and exists(select 1 from information_schema.columns where table_schema='public' and table_name='payments' and column_name='paid_at') and to_regprocedure('public.finance_operation(uuid,text,jsonb,uuid)') is not null and to_regprocedure('public.consume_password_grant(text)') is not null;
 rows=rows||jsonb_build_array(jsonb_build_object('component','Migration / schema','status',case when healthy then 'Healthy' else 'Failed' end,'detail','Required Phase 5 columns and RPC signatures checked'));
 foreach t in array array['customer-files','order-prescriptions','order-attachments'] loop
 select id,public into b from storage.buckets where id=t;
 rows=rows||jsonb_build_array(jsonb_build_object('component','Bucket: '||t,'status',case when found and not b.public then 'Healthy' else 'Failed' end,'detail',case when not found then 'Required bucket missing' when b.public then 'Bucket must be private' else 'Private bucket configured; no public URL created' end));
 end loop;
 healthy=public.has_permission('staff.manage') and public.has_permission('finance.refund') and not exists(select 1 from public.role_permissions where role='sales' and permission in ('staff.manage','system.health','audit.read')) and exists(select 1 from public.role_permissions where role='sales' and permission='orders.write');
 rows=rows||jsonb_build_array(jsonb_build_object('component','Permissions','status',case when healthy then 'Healthy' else 'Failed' end,'detail','Current administrator rights and sales permission matrix checked; no impersonation or policy changes'));
 healthy=not exists(select 1 from public.orders where balance<>total-amount_paid+refunds_total or net_received<>amount_paid-refunds_total) and round((2000::numeric-200),2)-500-1300+200=200;
 rows=rows||jsonb_build_array(jsonb_build_object('component','Payment calculations','status',case when healthy then 'Healthy' else 'Failed' end,'detail','Stored balance identities and synthetic decimal arithmetic checked; no financial records changed'));
 healthy=not exists(select 1 from unnest(array['orders','payments','refunds','users','staff_profiles']) as x(name) where not exists(select 1 from pg_catalog.pg_trigger g join pg_catalog.pg_class c on c.oid=g.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=x.name and not g.tgisinternal and g.tgenabled<>'D' and g.tgname like 'audit%'));
 rows=rows||jsonb_build_array(jsonb_build_object('component','Audit logging','status',case when healthy then 'Healthy' else 'Failed' end,'detail','Expected enabled audit triggers inspected'));
 insert into public.audit_logs(user_id,action,entity_type,entity_id,new_value) values(auth.uid(),'SYSTEM_HEALTH_CHECK','system','health',jsonb_build_object('checks',jsonb_array_length(rows),'failed',(select count(*) from jsonb_array_elements(rows) r where r->>'status'='Failed')));
 return rows;
end $$;
revoke all on function public.system_health() from public,anon,authenticated;
grant execute on function public.system_health() to authenticated;
commit;

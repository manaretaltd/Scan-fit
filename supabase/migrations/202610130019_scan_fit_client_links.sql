begin;

alter table public.scan_fit_sessions add column capture_source text not null default 'staff' check(capture_source in ('staff','remote_client'));
create table public.scan_fit_client_links (
 id uuid primary key default gen_random_uuid(),
 session_id uuid not null unique references public.scan_fit_sessions(id),
 token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
 issued_by uuid not null references public.users(id),
 expires_at timestamptz not null,
 revoked_at timestamptz,
 submitted_at timestamptz,
 consent_at timestamptz,
 consent_version text,
 created_at timestamptz not null default now()
);
alter table public.scan_fit_client_links enable row level security;
revoke all on public.scan_fit_client_links from public,anon,authenticated;
grant all on public.scan_fit_client_links to service_role;

create function public.scan_fit_issue_client_link(actor uuid,payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare started jsonb; target uuid; expires timestamptz;
begin
 if not public.scan_fit_scope((payload->>'customer_id')::uuid,nullif(payload->>'order_id','')::uuid,actor) then raise exception 'Access denied';end if;
 expires=(payload->>'expires_at')::timestamptz;
 if expires<=now() or expires>now()+interval '7 days 1 minute' then raise exception 'Invalid link expiry';end if;
 started=public.scan_fit_operate(actor,'start',jsonb_build_object(
  'customer_id',payload->>'customer_id','order_id',coalesce(payload->>'order_id',''),
  'profile_id',payload->>'profile_id','validation_mode',false,
  'device_info',jsonb_build_object('source','remote_client','review_required',true)));
 target=(started->>'id')::uuid;
 update public.scan_fit_sessions set capture_source='remote_client' where id=target;
 insert into public.scan_fit_client_links(session_id,token_hash,issued_by,expires_at)
 values(target,payload->>'token_hash',actor,expires);
 insert into public.audit_logs(user_id,action,entity_type,entity_id,new_value)
 values(actor,'ISSUE_CLIENT_LINK','scan_fit',target::text,jsonb_build_object('session_id',target,'expires_at',expires,'source','remote_client'));
 return jsonb_build_object('session_id',target,'expires_at',expires);
end $$;

create function public.scan_fit_client_authorize(link_hash text,operation text,payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare invite public.scan_fit_client_links; s public.scan_fit_sessions; receipt jsonb;
begin
 select * into invite from public.scan_fit_client_links where token_hash=link_hash for update;
 if not found or invite.revoked_at is not null or invite.expires_at<=now() then raise exception 'Measurement link unavailable';end if;
 select * into s from public.scan_fit_sessions where id=invite.session_id for update;
 if not public.scan_fit_scope(s.customer_id,s.order_id,invite.issued_by) or s.status in ('Archived','Repeated') then raise exception 'Measurement link unavailable';end if;
 if invite.submitted_at is not null then
  if operation='status' or operation='submit' then return jsonb_build_object('state','submitted','session',jsonb_build_object('id',s.id));end if;
  raise exception 'Measurement already submitted';
 end if;
 if s.status<>'Started' then raise exception 'Measurement link unavailable';end if;
 if operation='status' then
  return jsonb_build_object('state','ready','session',to_jsonb(s),'expires_at',invite.expires_at);
 elsif operation='submit' then
  if payload->>'session_id' is distinct from s.id::text or payload->>'consent' is distinct from 'true' or payload->>'consent_version' is distinct from 'remote-capture/1' then raise exception 'Invalid submission';end if;
  receipt=public.scan_fit_operate(invite.issued_by,'review',payload);
  update public.scan_fit_client_links set submitted_at=now(),consent_at=now(),consent_version='remote-capture/1' where id=invite.id;
  insert into public.audit_logs(user_id,action,entity_type,entity_id,new_value)
  values(invite.issued_by,'REMOTE_SUBMISSION','scan_fit',s.id::text,jsonb_build_object('source','remote_client','review_required',true,'consent_version','remote-capture/1'));
  return jsonb_build_object('state','submitted','session',jsonb_build_object('id',s.id));
 else raise exception 'Invalid operation';end if;
end $$;

create function public.scan_fit_revoke_client_link(actor uuid,target uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s public.scan_fit_sessions;
begin
 select * into s from public.scan_fit_sessions where id=target;
 if not found or not public.scan_fit_scope(s.customer_id,s.order_id,actor) then raise exception 'Access denied';end if;
 update public.scan_fit_client_links set revoked_at=now() where session_id=target;
 insert into public.audit_logs(user_id,action,entity_type,entity_id,new_value)
 values(actor,'REVOKE_CLIENT_LINK','scan_fit',target::text,jsonb_build_object('revoked',true));
end $$;

revoke all on function public.scan_fit_issue_client_link(uuid,jsonb),public.scan_fit_client_authorize(text,text,jsonb),public.scan_fit_revoke_client_link(uuid,uuid) from public,anon,authenticated;
grant execute on function public.scan_fit_issue_client_link(uuid,jsonb),public.scan_fit_client_authorize(text,text,jsonb),public.scan_fit_revoke_client_link(uuid,uuid) to service_role;
commit;

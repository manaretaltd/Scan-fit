begin;

create table public.scan_fit_frame_profiles (
 id uuid primary key default gen_random_uuid(), name text not null, model text not null, version text not null,
 active boolean not null default true, definition jsonb not null, created_by uuid not null references public.users(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(model,version)
);
create table public.scan_fit_config (
 id boolean primary key default true check(id), thresholds jsonb not null, version integer not null default 1,
 updated_by uuid references public.users(id), updated_at timestamptz not null default now()
);
insert into public.scan_fit_config(id,thresholds) values(true,'{"version":1,"minMarkers":4,"burstCount":5,"minValidFrames":3,"maxYaw":3,"maxPitch":3,"maxRoll":2,"minPupilQuality":0.7,"minFrameQuality":0.5,"minOverallQuality":0.65,"minSharpness":25,"minBrightness":35,"maxBrightness":225,"maxSaturatedFraction":0.25,"maxReprojectionMm":0.6,"maxSpreadMm":0.7,"maxMidlineMm":3,"retentionDays":90,"captureMinMm":390,"captureMaxMm":410}');
create table public.scan_fit_sessions (
 id uuid primary key default gen_random_uuid(), customer_id uuid not null references public.customers(id),
 order_id uuid references public.orders(id), frame_profile_id uuid not null references public.scan_fit_frame_profiles(id),
 operator_id uuid not null references public.users(id), status text not null default 'Started' check(status in ('Started','Review','Accepted','Repeated','Archived')),
 profile_snapshot jsonb not null, config_snapshot jsonb not null, device_info jsonb not null default '{}',
 capture_target_mm integer not null default 400 check(capture_target_mm=400),
 depth_source text not null default 'none' check(depth_source in ('none','estimated','native_lidar','manual_reference')),
 estimated_distance_mm numeric check(estimated_distance_mm>0), validation_mode boolean not null default false,
 accepted_by uuid references public.users(id), accepted_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check((accepted_by is null)=(accepted_at is null))
);
create index scan_fit_customer_history on public.scan_fit_sessions(customer_id,created_at desc);
create table public.scan_fit_frames (
 id uuid primary key default gen_random_uuid(), session_id uuid not null references public.scan_fit_sessions(id),
 frame_index integer not null check(frame_index between 0 and 4), observation jsonb not null, analysis jsonb not null,
 original_path text not null unique, annotated_path text not null unique, rectified_path text not null unique,
 image_sha256 text not null, correction jsonb, created_at timestamptz not null default now(), unique(session_id,frame_index), unique(session_id,image_sha256)
);
create table public.scan_fit_results (
 id uuid primary key default gen_random_uuid(), session_id uuid not null unique references public.scan_fit_sessions(id),
 result jsonb not null, algorithm_version text not null, manually_adjusted boolean not null default false,
 accepted_by uuid references public.users(id), accepted_at timestamptz, created_at timestamptz not null default now()
);
create table public.scan_fit_adjustments (
 id uuid primary key default gen_random_uuid(), session_id uuid not null references public.scan_fit_sessions(id),
 frame_id uuid not null references public.scan_fit_frames(id), operator_id uuid not null references public.users(id),
 original_pixels jsonb not null, corrected_pixels jsonb not null, previous_correction jsonb, reason text not null check(length(reason) between 3 and 1000), created_at timestamptz not null default now()
);
create table public.scan_fit_validation (
 id uuid primary key default gen_random_uuid(), session_id uuid not null references public.scan_fit_sessions(id),
 reference jsonb not null, errors jsonb not null, operator_id uuid not null references public.users(id), created_at timestamptz not null default now()
);
alter table public.measurements add column right_pupil_height numeric(7,2), add column left_pupil_height numeric(7,2), add column scan_fit_session_id uuid references public.scan_fit_sessions(id);
create function public.scan_fit_clear_stale_provenance() returns trigger language plpgsql set search_path='' as $$
begin
 if old.scan_fit_session_id is not null and new.scan_fit_session_id is not distinct from old.scan_fit_session_id and (new.right_bd is distinct from old.right_bd or new.left_bd is distinct from old.left_bd) then
  new.scan_fit_session_id=null;
 end if;
 return new;
end $$;
create trigger scan_fit_measurement_provenance before update on public.measurements for each row execute function public.scan_fit_clear_stale_provenance();

create function public.scan_fit_scope(customer uuid,related_order uuid,actor uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.users u join public.customers c on c.id=customer
 where u.id=actor and u.active and u.role in ('administrator','sales')
 and (u.role='administrator' or c.assigned_to=actor)
 and (related_order is null or exists(select 1 from public.orders o where o.id=related_order and o.customer_id=c.id and (u.role='administrator' or o.created_by=actor or c.assigned_to=actor))));
$$;
create function public.scan_fit_session_scope(target uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.scan_fit_sessions s where s.id=target and public.scan_fit_scope(s.customer_id,s.order_id,auth.uid()));
$$;

do $$ declare t text; begin
 foreach t in array array['scan_fit_frame_profiles','scan_fit_config','scan_fit_sessions','scan_fit_frames','scan_fit_results','scan_fit_adjustments','scan_fit_validation'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
create policy scan_fit_profiles_read on public.scan_fit_frame_profiles for select to authenticated using(public.has_permission('orders.clinical'));
create policy scan_fit_config_read on public.scan_fit_config for select to authenticated using(public.has_permission('orders.clinical'));
create policy scan_fit_sessions_read on public.scan_fit_sessions for select to authenticated using(public.scan_fit_scope(customer_id,order_id,auth.uid()));
create policy scan_fit_frames_read on public.scan_fit_frames for select to authenticated using(public.scan_fit_session_scope(session_id));
create policy scan_fit_results_read on public.scan_fit_results for select to authenticated using(public.scan_fit_session_scope(session_id));
create policy scan_fit_adjustments_read on public.scan_fit_adjustments for select to authenticated using(public.scan_fit_session_scope(session_id));
create policy scan_fit_validation_read on public.scan_fit_validation for select to authenticated using(public.has_permission('staff.manage') and public.scan_fit_session_scope(session_id));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('scan-fit','scan-fit',false,10485760,array['image/jpeg','image/png']);
create policy scan_fit_storage_read on storage.objects for select to authenticated using(bucket_id='scan-fit' and exists(
 select 1 from public.scan_fit_frames f join public.scan_fit_sessions s on s.id=f.session_id
 where s.status<>'Archived' and name in(f.original_path,f.annotated_path,f.rectified_path) and public.scan_fit_scope(s.customer_id,s.order_id,auth.uid())));

-- Only the authorized application server can submit computed analysis or corrections.
-- Images and numeric outputs are never directly writable by browser JWTs.
create function public.scan_fit_operate(actor uuid,operation text,payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.scan_fit_sessions; p public.scan_fit_frame_profiles; f public.scan_fit_frames; result_value jsonb;
 target uuid; item jsonb; cfg jsonb; old_value jsonb; new_value jsonb; current_order public.orders; role_name public.staff_role;
begin
 select role into role_name from public.users where id=actor and active;
 if role_name is null or role_name not in ('administrator','sales') then raise exception 'Access denied';end if;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 if operation='profile' then
  if role_name<>'administrator' then raise exception 'Administrator only';end if;
  insert into public.scan_fit_frame_profiles(name,model,version,active,definition,created_by)
  values(payload->>'name',payload->>'model',payload->>'version',(payload->>'active')::boolean,payload,actor) returning id into target;
  new_value=jsonb_build_object('profile_id',target,'version',payload->>'version');
 elsif operation='profile_state' then
  if role_name<>'administrator' then raise exception 'Administrator only';end if;
  target=(payload->>'profile_id')::uuid;
  select jsonb_build_object('active',active) into old_value from public.scan_fit_frame_profiles where id=target for update;
  if not found then raise exception 'Frame profile not found';end if;
  update public.scan_fit_frame_profiles set active=(payload->>'active')::boolean,updated_at=now() where id=target;
  new_value=jsonb_build_object('profile_id',target,'active',(payload->>'active')::boolean);
 elsif operation='config' then
  if role_name<>'administrator' then raise exception 'Administrator only';end if;
  select thresholds into old_value from public.scan_fit_config where id=true for update;
  if (payload->>'version')::integer<>(old_value->>'version')::integer then raise exception 'Configuration changed; reload before saving';end if;
  update public.scan_fit_config set thresholds=jsonb_set(payload,'{version}',to_jsonb(version+1)),version=version+1,updated_by=actor,updated_at=now() where id=true returning thresholds into new_value;
 elsif operation='start' then
  if not public.scan_fit_scope((payload->>'customer_id')::uuid,nullif(payload->>'order_id','')::uuid,actor) then raise exception 'Access denied';end if;
  if coalesce((payload->>'validation_mode')::boolean,false) and role_name<>'administrator' then raise exception 'Validation mode is administrator only';end if;
  select * into p from public.scan_fit_frame_profiles where id=(payload->>'profile_id')::uuid and active;
  if not found then raise exception 'Choose an active calibrated frame profile';end if;
  select thresholds into cfg from public.scan_fit_config where id=true;
  insert into public.scan_fit_sessions(customer_id,order_id,frame_profile_id,operator_id,profile_snapshot,config_snapshot,device_info,validation_mode)
  values((payload->>'customer_id')::uuid,nullif(payload->>'order_id','')::uuid,p.id,actor,p.definition,cfg,coalesce(payload->'device_info','{}'),coalesce((payload->>'validation_mode')::boolean,false)) returning id into target;
  new_value=jsonb_build_object('session_id',target);
 else
  select * into s from public.scan_fit_sessions where id=(payload->>'session_id')::uuid for update;
  if not found or not public.scan_fit_scope(s.customer_id,s.order_id,actor) then raise exception 'Access denied';end if;
  target=s.id; old_value=jsonb_build_object('status',s.status);
  if operation='review' then
   if s.status<>'Started' then raise exception 'Session already captured';end if;
   if jsonb_array_length(payload->'frames')<>5 then raise exception 'A five-frame burst is required';end if;
   for item in select value from jsonb_array_elements(payload->'frames') loop
    if not ((item->>'original_path') like s.customer_id::text||'/'||s.id::text||'/%') or not ((item->>'annotated_path') like s.customer_id::text||'/'||s.id::text||'/%') or not ((item->>'rectified_path') like s.customer_id::text||'/'||s.id::text||'/%') then raise exception 'Invalid image scope';end if;
    if (select count(*) from storage.objects where bucket_id='scan-fit' and name in(item->>'original_path',item->>'annotated_path',item->>'rectified_path'))<>3 then raise exception 'Capture images were not stored';end if;
    insert into public.scan_fit_frames(session_id,frame_index,observation,analysis,original_path,annotated_path,rectified_path,image_sha256)
    values(s.id,(item->>'frame_index')::integer,item->'observation',item->'analysis',item->>'original_path',item->>'annotated_path',item->>'rectified_path',item->>'image_sha256');
   end loop;
   if payload->'result'<>'null'::jsonb then insert into public.scan_fit_results(session_id,result,algorithm_version) values(s.id,payload->'result',payload->'result'->>'algorithmVersion');end if;
   update public.scan_fit_sessions set status='Review',updated_at=now() where id=s.id;
  elsif operation='manual' then
   if s.status<>'Review' then raise exception 'Only unaccepted scans can be adjusted';end if;
   select * into f from public.scan_fit_frames where id=(payload->>'frame_id')::uuid and session_id=s.id for update;
   if not found then raise exception 'Frame not found';end if;
   insert into public.scan_fit_adjustments(session_id,frame_id,operator_id,original_pixels,corrected_pixels,previous_correction,reason)
   values(s.id,f.id,actor,f.observation->'pupils',payload->'pupils',jsonb_build_object('correction',f.correction,'annotated_path',f.annotated_path),payload->>'reason');
   update public.scan_fit_frames set correction=jsonb_build_object('right',payload->'pupils'->'right','left',payload->'pupils'->'left','reason',payload->>'reason','actor',actor,'at',now()),analysis=payload->'analysis',annotated_path=coalesce(payload->>'annotated_path',annotated_path) where id=f.id;
   delete from public.scan_fit_results where session_id=s.id and accepted_at is null;
   if payload->'result'<>'null'::jsonb then insert into public.scan_fit_results(session_id,result,algorithm_version,manually_adjusted) values(s.id,payload->'result',payload->'result'->>'algorithmVersion',true);end if;
  elsif operation='accept' then
   if s.status<>'Review' then raise exception 'Only reviewed scans can be accepted';end if;
   select result into result_value from public.scan_fit_results where session_id=s.id;
   if result_value is null or (result_value->>'validFrames')::integer<(s.config_snapshot->>'minValidFrames')::integer or (result_value->>'spreadMm')::numeric>(s.config_snapshot->>'maxSpreadMm')::numeric then raise exception 'Measurement consistency insufficient; repeat the scan';end if;
   if coalesce((result_value->>'qualityScore')::numeric,0)<coalesce((s.config_snapshot->>'minOverallQuality')::numeric,0.65) then raise exception 'Overall measurement quality is insufficient; repeat the scan';end if;
   if (result_value->'metric'->>'rightPd')::numeric not between 0.01 and 100 or (result_value->'metric'->>'leftPd')::numeric not between 0.01 and 100 then raise exception 'Invalid PD measurement';end if;
   update public.scan_fit_results set accepted_by=actor,accepted_at=now() where session_id=s.id;
   update public.scan_fit_sessions set status='Accepted',accepted_by=actor,accepted_at=now(),updated_at=now() where id=s.id;
  elsif operation='repeat' then
   if s.status not in ('Started','Review') then raise exception 'Start a new session for accepted history';end if;
   if not exists(select 1 from public.scan_fit_frame_profiles where id=s.frame_profile_id and active) then raise exception 'Frame profile is inactive; choose an active calibration for a new scan';end if;
   update public.scan_fit_sessions set status='Repeated',updated_at=now() where id=s.id;
   insert into public.scan_fit_sessions(customer_id,order_id,frame_profile_id,operator_id,profile_snapshot,config_snapshot,device_info,validation_mode)
   values(s.customer_id,s.order_id,s.frame_profile_id,actor,s.profile_snapshot,s.config_snapshot,s.device_info,s.validation_mode) returning id into target;
  elsif operation='reference' then
   if role_name<>'administrator' or not s.validation_mode then raise exception 'Administrator validation mode only';end if;
   if not exists(select 1 from public.scan_fit_results where session_id=s.id) then raise exception 'No result to compare';end if;
   insert into public.scan_fit_validation(session_id,reference,errors,operator_id) values(s.id,payload->'reference',payload->'errors',actor);
  elsif operation='archive' then
   if role_name<>'administrator' then raise exception 'Administrator only';end if;
   update public.scan_fit_sessions set status='Archived',updated_at=now() where id=s.id;
  elsif operation='apply' then
   if role_name<>'administrator' or not s.validation_mode or (payload->>'test_order_confirmed') is distinct from 'true' then raise exception 'Production ordering disabled; administrator must explicitly confirm a TEST order';end if;
   if s.status<>'Accepted' or s.order_id is null then raise exception 'An accepted scan linked to a draft order is required';end if;
   select * into current_order from public.orders where id=s.order_id for update;
   if current_order.status<>'Draft' then raise exception 'Confirmed order measurements cannot be replaced';end if;
   select to_jsonb(m) into old_value from public.measurements m where order_id=s.order_id;
   if old_value is distinct from nullif(payload->'expected_measurements','null'::jsonb) or current_order.version<>(payload->>'expected_version')::integer then raise exception 'Order measurements changed; reload before applying';end if;
   select result into result_value from public.scan_fit_results where session_id=s.id and accepted_at is not null;
   insert into public.measurements(order_id,right_bd,left_bd,right_pupil_height,left_pupil_height,scan_fit_session_id)
   values(s.order_id,round((result_value->'metric'->>'rightPd')::numeric,2),round((result_value->'metric'->>'leftPd')::numeric,2),round((result_value->'metric'->>'rightY')::numeric,2),round((result_value->'metric'->>'leftY')::numeric,2),s.id)
   on conflict(order_id) do update set right_bd=excluded.right_bd,left_bd=excluded.left_bd,right_pupil_height=excluded.right_pupil_height,left_pupil_height=excluded.left_pupil_height,scan_fit_session_id=excluded.scan_fit_session_id;
   update public.orders set version=version+1 where id=s.order_id;
   select to_jsonb(m) into new_value from public.measurements m where order_id=s.order_id;
  else raise exception 'Unknown Scan Fit operation';end if;
  if new_value is null then new_value=jsonb_build_object('session_id',target,'event',operation);end if;
 end if;
 insert into public.audit_logs(user_id,action,entity_type,entity_id,previous_value,new_value)
 values(actor,upper(operation),'scan_fit',coalesce(target::text,'thresholds'),old_value,new_value);
 if s.id is not null or operation='start' then
  if operation='start' then select * into s from public.scan_fit_sessions where id=target;end if;
  insert into public.activities(customer_id,order_id,type,description,user_id)
  values(s.customer_id,s.order_id,'Note','Scan Fit '||operation||' — /scan-fit/'||target::text,actor);
 end if;
 return coalesce(new_value,'{}')||jsonb_build_object('id',target);
end $$;
revoke all on function public.scan_fit_scope(uuid,uuid,uuid),public.scan_fit_session_scope(uuid) from public,anon;
grant execute on function public.scan_fit_scope(uuid,uuid,uuid),public.scan_fit_session_scope(uuid) to authenticated,service_role;
revoke all on function public.scan_fit_operate(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.scan_fit_clear_stale_provenance() from public,anon,authenticated;
grant execute on function public.scan_fit_operate(uuid,text,jsonb) to service_role;

commit;

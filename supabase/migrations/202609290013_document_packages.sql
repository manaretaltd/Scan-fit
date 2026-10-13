begin;
-- Manufacturer snapshots contain clinical information even when their category is operational.
create policy packs_clinical_guard on public.manufacturer_packs as restrictive for select to authenticated using(public.has_permission('orders.clinical'));

alter table public.manufacturer_packs add column version integer,add column generated_file_id uuid references public.media_files(id),add column review_fingerprint text;
with numbered as(select id,row_number() over(partition by order_id order by created_at,id) n from public.manufacturer_packs) update public.manufacturer_packs p set version=n.n from numbered n where p.id=n.id;
alter table public.manufacturer_packs alter column version set not null;
create unique index manufacturer_pack_version on public.manufacturer_packs(order_id,version);
create table public.document_packages(id uuid primary key,customer_id uuid not null references public.customers(id),order_id uuid references public.orders(id),audience text not null check(audience in ('Manufacturer','Customer')),pack_id uuid references public.manufacturer_packs(id),file_ids uuid[] not null,snapshot jsonb not null,destination text not null default '',status text not null default 'Prepared' check(status='Prepared'),prepared_by uuid not null references public.users(id),created_at timestamptz not null default now());
alter table public.document_packages enable row level security;revoke all on public.document_packages from anon,authenticated;grant select on public.document_packages to authenticated;
create policy packages_read on public.document_packages for select to authenticated using(public.media_scope(customer_id,order_id) and (audience='Customer' or public.has_permission('orders.manufacturer')) and not exists(select 1 from unnest(file_ids) f where not public.can_read_media(f)));
create trigger audit_packages after insert on public.document_packages for each row execute function public.audit_change();
create function public.media_shareable(target uuid) returns boolean language sql stable security definer set search_path='' as $$
select exists(select 1 from public.media_files f where f.id=target and f.status='Active' and f.visibility='Shareable' and public.can_read_media(f.id) and
not exists(select 1 from public.manufacturer_packs p,unnest(p.file_ids) a where p.generated_file_id=f.id and not exists(select 1 from public.media_files original join public.media_categories cat on cat.name=original.category and cat.manufacturer_allowed where original.id=a and original.status='Active' and original.visibility='Shareable' and public.can_read_media(original.id))));$$;
create function public.review_manufacturer(target uuid,selected uuid[],instructions text default '') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare o public.orders;s jsonb;f jsonb;settings public.media_settings;begin
 if not public.has_permission('orders.manufacturer') or not public.has_permission('orders.clinical') or not public.can_read_order(target) then raise exception 'Permission denied for manufacturer review';end if;
 select * into o from public.orders where id=target;if not found or o.status='Draft' then raise exception 'Confirm the order before preparing a pack';end if;
 select * into settings from public.media_settings;
 if selected is null or cardinality(selected)>settings.max_pack_files or cardinality(selected)<>(select count(distinct x) from unnest(selected) x) or length(instructions)>10000 then raise exception 'Invalid attachment selection';end if;
 if exists(select 1 from unnest(selected) a where not exists(select 1 from public.media_files f join public.media_categories c on c.name=f.category where f.id=a and c.manufacturer_allowed and f.source<>'Manufacturer Pack' and f.customer_id=o.customer_id and public.media_shareable(f.id) and (f.order_id=target or exists(select 1 from public.media_order_links l where l.order_id=target and l.file_id=f.id)))) then raise exception 'Only permitted Shareable manufacturer attachments linked to this order may be included. Finance and invoices are excluded';end if;
 if (select coalesce(sum(size_bytes),0) from public.media_files where id=any(selected))>settings.pack_limit then raise exception 'Selected files exceed the configured pack limit';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'filename',filename,'mime_type',mime_type,'size_bytes',size_bytes,'sha256',sha256,'updated_at',updated_at) order by id),'[]') into f from public.media_files where id=any(selected);
 -- Explicit manufacturing allowlist; no contact/address, payment or price fields.
 s=jsonb_build_object('order_number',o.order_number,'order_date',o.order_date,'order_version',o.version,'manufacturer_reference',o.manufacturer_reference,'expected_completion_date',o.expected_completion_date,
 'sales_representative',(select u.full_name from public.users u join public.customers c on c.assigned_to=u.id where c.id=o.customer_id),
 'customer',(select jsonb_build_object('name',first_name||' '||last_name,'practice',practice_name,'reference',customer_number) from public.customers where id=o.customer_id),
 'measurements',(select to_jsonb(m)-'order_id'||jsonb_build_object('measured_by_name',(select full_name from public.users where id=m.measured_by)) from public.measurements m where order_id=target),
 'prescription',(select to_jsonb(p)-'order_id' from public.prescriptions p where order_id=target),
 'items',(select coalesce(jsonb_agg(jsonb_build_object('sku',sku,'description',description,'kind',kind,'quantity',quantity,'configuration',configuration) order by case kind when 'Loupe' then 1 when 'Light' then 2 else 3 end,id),'[]') from public.order_items where order_id=target),'attachments',f,'instructions',instructions);
 return jsonb_build_object('snapshot',s,'fingerprint',md5(s::text));
end $$;
create function public.reserve_manufacturer(target uuid,request_id uuid,selected uuid[],instructions text,expected text) returns uuid language plpgsql security definer set search_path='' as $$
declare r jsonb;v integer;existing public.manufacturer_packs;begin
 if not public.can_read_order(target) or not public.has_permission('orders.manufacturer') or not public.has_permission('orders.clinical') then raise exception 'Permission denied';end if;
 perform 1 from public.orders where id=target for update;
 select * into existing from public.manufacturer_packs where id=request_id;
 if found then if existing.order_id<>target or existing.prepared_by<>auth.uid() then raise exception 'Request conflict';end if;return request_id;end if;
 r=public.review_manufacturer(target,selected,instructions);
 if expected is distinct from r->>'fingerprint' then raise exception 'Order or attachments changed. Refresh the review before generating';end if;
 select coalesce(max(version),0)+1 into v from public.manufacturer_packs where order_id=target;
 insert into public.manufacturer_packs(id,order_id,prepared_by,instructions,file_ids,snapshot,version,review_fingerprint) values(request_id,target,auth.uid(),instructions,selected,r->'snapshot',v,expected);
 return request_id;
end $$;
create function public.finish_manufacturer(target uuid,bytes bigint,sha text,actor uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.manufacturer_packs;o public.orders;path text;begin
 perform set_config('request.jwt.claim.sub',actor::text,true);
 select * into p from public.manufacturer_packs where id=target for update;
 if not found or p.prepared_by<>auth.uid() or not public.has_permission('orders.manufacturer') or not public.has_permission('orders.clinical') or not public.can_read_order(p.order_id) then raise exception 'Permission denied';end if;
 if p.generated_file_id is not null then return p.generated_file_id;end if;
 if p.review_fingerprint is distinct from public.review_manufacturer(p.order_id,p.file_ids,p.instructions)->>'fingerprint' then raise exception 'Order or attachments changed during generation. Generate from a refreshed review';end if;
 -- Visibility can change while rendering; never finalize an unapproved pack.
 if exists(select 1 from unnest(p.file_ids) a where not public.media_shareable(a)) then raise exception 'Attachment sharing approval changed. Review a new pack';end if;
 select * into o from public.orders where id=p.order_id;
 path=o.customer_id::text||'/'||p.id::text||'/manufacturer.pdf';
 if bytes not between 1 and 104857600 or sha !~ '^[a-f0-9]{64}$' or not exists(select 1 from storage.objects where bucket_id='crm-media' and name=path) then raise exception 'Generated PDF is not ready';end if;
 insert into public.media_files(id,customer_id,order_id,filename,original_filename,mime_type,size_bytes,category,description,storage_bucket,storage_path,sha256,visibility,status,source,uploaded_by)
 values(p.id,o.customer_id,o.id,'Easysee-EO-'||o.order_number||'-manufacturer-v'||p.version||'.pdf','Easysee-EO-'||o.order_number||'-manufacturer-v'||p.version||'.pdf','application/pdf',bytes,'Manufacturer','Manufacturer Pack v'||p.version,'crm-media',path,sha,'Shareable','Active','Manufacturer Pack',auth.uid());
 update public.manufacturer_packs set generated_file_id=p.id where id=p.id;
 perform public.media_event(p.id,'Manufacturer Order Pack generated v'||p.version,auth.uid());
 return p.id;
end $$;
create function public.prepare_document_package(target uuid,related_order uuid,customer uuid,audience text,selected uuid[]) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.manufacturer_packs;ids uuid[];snap jsonb;destination text='';existing public.document_packages;s public.media_settings;begin
 if not public.media_scope(customer,related_order) or audience not in ('Manufacturer','Customer') then raise exception 'Permission denied';end if;
 select * into s from public.media_settings;
 ids=selected;
 if audience='Manufacturer' then
 if related_order is null or not public.has_permission('orders.manufacturer') then raise exception 'Permission denied';end if;
 select * into p from public.manufacturer_packs where order_id=related_order and generated_file_id is not null order by version desc limit 1;
 if not found then raise exception 'Generate a reviewed manufacturer pack first';end if;
 ids=array(select distinct x from unnest(selected||p.file_ids||array[p.generated_file_id]) x);
 if exists(select 1 from unnest(ids) a join public.media_files f on f.id=a join public.media_categories c on c.name=f.category where not c.manufacturer_allowed) then raise exception 'Finance, invoices and unrelated categories cannot be sent to manufacturer';end if;
 destination=concat_ws(' ',nullif(s.manufacturer_name,''),nullif(s.manufacturer_email,''));
 end if;
 if ids is null or cardinality(ids)=0 or cardinality(ids)>s.max_pack_files+1 or exists(select 1 from unnest(ids) a where not exists(select 1 from public.media_files f where f.id=a and f.customer_id=customer and public.media_shareable(f.id) and (related_order is null or f.order_id=related_order or exists(select 1 from public.media_order_links l where l.file_id=f.id and l.order_id=related_order)))) then raise exception 'Choose permitted Active Shareable files for this record';end if;
 if (select sum(size_bytes) from public.media_files where id=any(ids))>104857600 then raise exception 'Package exceeds 100 MB';end if;
 select * into existing from public.document_packages where id=target;
 if found then if existing.prepared_by<>auth.uid() or existing.customer_id<>customer or existing.order_id is distinct from related_order then raise exception 'Request conflict';end if;return target;end if;
 select jsonb_agg(jsonb_build_object('id',id,'filename',filename,'sha256',sha256,'size_bytes',size_bytes) order by id) into snap from public.media_files where id=any(ids);
 insert into public.document_packages(id,customer_id,order_id,audience,pack_id,file_ids,snapshot,destination,prepared_by) values(target,customer,related_order,audience,p.id,ids,snap,destination,auth.uid());
 if related_order is not null then perform public.order_event(related_order,'Document package prepared',audience||' package prepared for manual download; no message sent',case when audience='Customer' then 'finance' else 'operational' end);end if;
 return target;
end $$;
-- Legacy manufacturer actions cannot bypass the explicit review and sharing gate.
alter function public.operate_order(uuid,text,jsonb,uuid) rename to operate_order_phase51;
revoke all on function public.operate_order_phase51(uuid,text,jsonb,uuid) from public,anon,authenticated;
create function public.operate_order(target uuid,operation text,payload jsonb,request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin if operation='manufacturer' then raise exception 'Use the reviewed Manufacturer Pack workflow';end if;return public.operate_order_phase51(target,operation,payload,request_id);end $$;
create function public.configure_media(settings jsonb) returns void language plpgsql security definer set search_path='' as $$
begin if not public.has_permission('staff.manage') then raise exception 'Permission denied';end if;
 if length(coalesce(settings->>'manufacturer_name',''))>200 or length(coalesce(settings->>'manufacturer_email',''))>254 then raise exception 'Contact too long';end if;
 update public.media_settings set manufacturer_name=coalesce(settings->>'manufacturer_name',''),manufacturer_email=coalesce(settings->>'manufacturer_email',''),image_limit=(settings->>'image_limit')::bigint,pdf_limit=(settings->>'pdf_limit')::bigint,video_limit=(settings->>'video_limit')::bigint;
end $$;
alter function public.system_health() rename to system_health_phase51;
revoke all on function public.system_health_phase51() from public,anon,authenticated;
create function public.system_health() returns jsonb language plpgsql security definer set search_path='' as $$
declare checks jsonb;t text;begin
 checks=public.system_health_phase51();
 foreach t in array array['media_files','media_order_links','media_events','document_packages','media_settings','media_categories','invoices'] loop
 checks=checks||jsonb_build_array(jsonb_build_object('component',t,'status',case when exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=t and c.relrowsecurity) then 'Healthy' else 'Failed' end,'detail','Phase 6 relation and RLS checked'));
 end loop;
 checks=checks||jsonb_build_array(jsonb_build_object('component','Secure File Storage','status',case when exists(select 1 from storage.buckets where id='crm-media' and not public) and exists(select 1 from pg_catalog.pg_policies where schemaname='storage' and tablename='objects' and policyname='media_object_read') then 'Healthy' else 'Failed' end,'detail','Private media bucket and authenticated access policy present; no public URLs generated'));
 return checks;
end $$;
revoke all on function public.media_shareable(uuid),public.review_manufacturer(uuid,uuid[],text),public.reserve_manufacturer(uuid,uuid,uuid[],text,text),public.finish_manufacturer(uuid,bigint,text,uuid),public.prepare_document_package(uuid,uuid,uuid,text,uuid[]),public.configure_media(jsonb),public.operate_order(uuid,text,jsonb,uuid),public.system_health() from public,anon,authenticated;
grant execute on function public.media_shareable(uuid),public.review_manufacturer(uuid,uuid[],text),public.reserve_manufacturer(uuid,uuid,uuid[],text,text),public.prepare_document_package(uuid,uuid,uuid,text,uuid[]),public.configure_media(jsonb),public.operate_order(uuid,text,jsonb,uuid),public.system_health() to authenticated;
grant execute on function public.finish_manufacturer(uuid,bigint,text,uuid) to service_role;
commit;

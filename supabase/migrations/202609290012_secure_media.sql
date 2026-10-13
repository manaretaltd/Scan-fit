begin;
insert into public.role_permissions values('operations','orders.manufacturer') on conflict do nothing;
create table public.media_categories(name text primary key,permission text not null,audience text not null check(audience in ('operational','clinical','finance')),manufacturer_allowed boolean not null default false,sort_order integer not null);
insert into public.media_categories values
('Customer','crm.read','operational',false,1),('Measurement','orders.clinical','clinical',true,2),('Prescription','orders.clinical','clinical',true,3),('Fitting','orders.clinical','clinical',true,4),('Manufacturer','orders.manufacturer','operational',true,5),('Finance','finance.read','finance',false,6),('Invoice','finance.read','finance',false,7),('Shipping','orders.manage','operational',false,8),('Delivery','orders.manage','operational',false,9),('Aftercare','orders.manage','operational',false,10),('Warranty','orders.manage','operational',false,11),('Product','crm.read','operational',true,12),('Other','crm.read','operational',false,13);
create table public.media_settings(id boolean primary key default true check(id),image_limit bigint not null default 20971520 check(image_limit between 1024 and 104857600),pdf_limit bigint not null default 20971520 check(pdf_limit between 1024 and 104857600),video_limit bigint not null default 104857600 check(video_limit between 1024 and 104857600),pack_limit bigint not null default 52428800 check(pack_limit between 1024 and 104857600),max_pack_files integer not null default 30 check(max_pack_files between 1 and 30),manufacturer_name text not null default '',manufacturer_email text not null default '',allowed_mimes text[] not null default array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf','video/mp4','video/quicktime']);
insert into public.media_settings default values;
create table public.media_files(
 id uuid primary key default gen_random_uuid(),customer_id uuid not null references public.customers(id),order_id uuid references public.orders(id),invoice_id uuid references public.invoices(id),payment_id uuid references public.payments(id),
 filename text not null check(length(filename) between 1 and 200),original_filename text not null check(length(original_filename) between 1 and 200),mime_type text not null,size_bytes bigint not null check(size_bytes>0),category text not null references public.media_categories(name),description text not null default '' check(length(description)<=1000),
 storage_bucket text not null,storage_path text not null,thumbnail_path text,sha256 text,
 visibility text not null default 'Internal Only' check(visibility in ('Internal Only','Shareable')),status text not null default 'Uploading' check(status in ('Uploading','Active','Archived')),
 source text not null default 'Upload' check(source in ('Upload','Customer legacy','Order legacy','Invoice','Manufacturer Pack')),
 uploaded_by uuid not null references public.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(storage_bucket,storage_path)
);
create table public.media_order_links(id uuid not null default gen_random_uuid() unique,file_id uuid not null references public.media_files(id),order_id uuid not null references public.orders(id),linked_by uuid not null references public.users(id),created_at timestamptz not null default now(),primary key(file_id,order_id));
create table public.media_events(id uuid primary key default gen_random_uuid(),file_id uuid not null references public.media_files(id),customer_id uuid not null references public.customers(id),order_id uuid references public.orders(id),action text not null,user_id uuid not null references public.users(id),created_at timestamptz not null default now());
create index media_customer_date on public.media_files(customer_id,created_at desc);
create index media_order_date on public.media_files(order_id,created_at desc);
create index media_invoice on public.media_files(invoice_id) where invoice_id is not null;
create index media_search on public.media_files using gin(to_tsvector('simple',filename||' '||description));
create index media_links_order on public.media_order_links(order_id,file_id);
create index media_events_customer on public.media_events(customer_id,created_at desc);
create function public.media_scope(customer uuid,related_order uuid default null) returns boolean language sql stable security definer set search_path='' as $$
select exists(select 1 from public.users u join public.customers c on c.id=customer where u.id=auth.uid() and u.active and public.has_permission('customers.read') and
(case when related_order is not null then exists(select 1 from public.orders o where o.id=related_order and o.customer_id=customer and public.can_read_order(o.id)) else u.role<>'sales' or c.assigned_to=u.id end)); $$;
create function public.can_read_media(target uuid) returns boolean language sql stable security definer set search_path='' as $$
select exists(select 1 from public.media_files f join public.media_categories c on c.name=f.category where f.id=target and public.has_permission(c.permission) and (f.source<>'Manufacturer Pack' or public.has_permission('orders.clinical')) and (f.status<>'Uploading' or f.uploaded_by=auth.uid()) and
(public.media_scope(f.customer_id,f.order_id) or exists(select 1 from public.media_order_links l where l.file_id=f.id and public.media_scope(f.customer_id,l.order_id)))); $$;
create function public.can_write_media(target uuid) returns boolean language sql stable security definer set search_path='' as $$
select public.can_read_media(target) and (public.has_permission('crm.write') or public.has_permission('orders.manage') or public.has_permission('finance.discount')); $$;
do $$declare t text;begin foreach t in array array['media_categories','media_settings','media_files','media_order_links','media_events'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);end loop;end $$;
create policy media_categories_read on public.media_categories for select to authenticated using(public.has_permission(permission));
create policy media_settings_read on public.media_settings for select to authenticated using(public.has_permission('customers.read'));
create policy media_read on public.media_files for select to authenticated using(public.can_read_media(id));
create policy media_links_read on public.media_order_links for select to authenticated using(public.can_read_media(file_id) and public.can_read_order(order_id));
create policy media_events_read on public.media_events for select to authenticated using(public.can_read_media(file_id));
create trigger audit_media after insert or update on public.media_files for each row execute function public.audit_change();
create trigger audit_media_links after insert or delete on public.media_order_links for each row execute function public.audit_change();
create trigger audit_media_settings after update on public.media_settings for each row execute function public.audit_change();
alter table public.order_events add column media_file_id uuid references public.media_files(id);
drop policy events_read on public.order_events;
create policy events_read on public.order_events for select to authenticated using(public.can_read_order(order_id) and (media_file_id is null or public.can_read_media(media_file_id)) and (audience='operational' or (audience='clinical' and public.has_permission('orders.clinical')) or (audience='finance' and public.has_permission('finance.read'))));
create function public.media_event(target uuid,label text,actor uuid) returns void language plpgsql security definer set search_path='' as $$
declare f public.media_files;a text;begin
 select * into f from public.media_files where id=target;select audience into a from public.media_categories where name=f.category;
 insert into public.media_events(file_id,customer_id,order_id,action,user_id) values(f.id,f.customer_id,f.order_id,label,actor);
 insert into public.order_events(order_id,kind,description,audience,user_id,media_file_id)
 select distinct o,'File: '||label,f.filename,a,actor,f.id from (select f.order_id o union select order_id from public.media_order_links where file_id=f.id) x where o is not null;
end $$;
-- Register existing objects without copying or replacing physical files. Internal is the safe migration default.
insert into public.media_files(id,customer_id,filename,original_filename,mime_type,size_bytes,category,description,storage_bucket,storage_path,status,source,uploaded_by,created_at)
select id,customer_id,filename,filename,mime_type,size_bytes,category,description,'customer-files',storage_path,'Active','Customer legacy',uploaded_by,created_at from public.files;
insert into public.media_files(id,customer_id,order_id,filename,original_filename,mime_type,size_bytes,category,storage_bucket,storage_path,status,source,uploaded_by,created_at)
select f.id,o.customer_id,f.order_id,f.filename,f.filename,f.mime_type,f.size_bytes,case f.category when 'Measurements' then 'Measurement' else f.category end,f.storage_bucket,f.storage_path,'Active','Order legacy',f.uploaded_by,f.created_at from public.order_files f join public.orders o on o.id=f.order_id;
-- Keep legacy wizard uploads integrated while retaining its required prescription table.
create function public.mirror_legacy_media() returns trigger language plpgsql security definer set search_path='' as $$
declare customer uuid;begin
 if tg_op='DELETE' then update public.media_files set status='Archived',updated_at=now() where id=old.id;perform public.media_event(old.id,'Archived',auth.uid());return old;end if;
 if tg_table_name='files' then
 insert into public.media_files(id,customer_id,filename,original_filename,mime_type,size_bytes,category,description,storage_bucket,storage_path,status,source,uploaded_by,created_at) values(new.id,new.customer_id,new.filename,new.filename,new.mime_type,new.size_bytes,new.category,new.description,'customer-files',new.storage_path,'Active','Customer legacy',new.uploaded_by,new.created_at) on conflict(id) do nothing;
 else
 select customer_id into customer from public.orders where id=new.order_id;
 insert into public.media_files(id,customer_id,order_id,filename,original_filename,mime_type,size_bytes,category,storage_bucket,storage_path,status,source,uploaded_by,created_at) values(new.id,customer,new.order_id,new.filename,new.filename,new.mime_type,new.size_bytes,case new.category when 'Measurements' then 'Measurement' else new.category end,new.storage_bucket,new.storage_path,'Active','Order legacy',new.uploaded_by,new.created_at) on conflict(id) do nothing;
 end if;
 perform public.media_event(new.id,'Uploaded',new.uploaded_by);return new;
end $$;
create trigger mirror_customer_media after insert on public.files for each row execute function public.mirror_legacy_media();
create trigger mirror_order_media after insert or delete on public.order_files for each row execute function public.mirror_legacy_media();
create function public.invoice_media() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.issued_at is not null and new.pdf_storage_path is not null and not exists(select 1 from public.media_files where invoice_id=new.id) then
 insert into public.media_files(id,customer_id,order_id,invoice_id,filename,original_filename,mime_type,size_bytes,category,storage_bucket,storage_path,sha256,status,source,uploaded_by,created_at)
 values(new.id,new.customer_id,new.order_id,new.id,new.invoice_number||'.pdf',new.invoice_number||'.pdf','application/pdf',coalesce(nullif((select metadata->>'size' from storage.objects where bucket_id='invoices' and name=new.pdf_storage_path),'')::bigint,1),'Invoice','invoices',new.pdf_storage_path,new.pdf_sha256,'Active','Invoice',new.created_by,new.issued_at);
 perform public.media_event(new.id,'Invoice PDF added',new.created_by);
 end if;return new;
end $$;
create trigger invoice_media after insert or update on public.invoices for each row execute function public.invoice_media();
insert into public.media_files(id,customer_id,order_id,invoice_id,filename,original_filename,mime_type,size_bytes,category,storage_bucket,storage_path,sha256,status,source,uploaded_by,created_at)
select id,customer_id,order_id,id,invoice_number||'.pdf',invoice_number||'.pdf','application/pdf',coalesce(nullif((select metadata->>'size' from storage.objects where bucket_id='invoices' and name=i.pdf_storage_path),'')::bigint,1),'Invoice','invoices',pdf_storage_path,pdf_sha256,'Active','Invoice',created_by,issued_at from public.invoices i where issued_at is not null;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('crm-media','crm-media',false,104857600,array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf','video/mp4','video/quicktime']);
create policy media_object_read on storage.objects for select to authenticated using(bucket_id='crm-media' and exists(select 1 from public.media_files f where f.storage_bucket=bucket_id and name in (f.storage_path,f.thumbnail_path) and f.status in ('Active','Archived') and public.can_read_media(f.id)));
-- No authenticated write/delete policies: originals are immutable; server-validated writes only.
create function public.reserve_media(target uuid,customer uuid,related_order uuid,details jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare f public.media_files;c public.media_categories;s public.media_settings;limit_bytes bigint;begin
 if not public.media_scope(customer,related_order) then raise exception 'Permission denied for this customer/order';end if;
 select * into c from public.media_categories where name=details->>'category';
 if not found or not public.has_permission(c.permission) or not(public.has_permission('crm.write') or public.has_permission('orders.manage') or public.has_permission('finance.discount')) then raise exception 'Permission denied for this category';end if;
 select * into s from public.media_settings;
 limit_bytes=case when details->>'mime_type' like 'video/%' then s.video_limit when details->>'mime_type'='application/pdf' then s.pdf_limit else s.image_limit end;
 if not(details->>'mime_type'=any(s.allowed_mimes)) or (details->>'size_bytes')::bigint not between 1 and limit_bytes or details->>'sha256' !~ '^[a-f0-9]{64}$' then raise exception 'Unsupported format or file too large';end if;
 if nullif(details->>'payment_id','') is not null and (c.name<>'Finance' or not exists(select 1 from public.payments where id=(details->>'payment_id')::uuid and customer_id=customer and order_id=related_order) or not public.has_permission('finance.read')) then raise exception 'Invalid payment association';end if;
 select * into f from public.media_files where id=target for update;
 if found then
 if f.source<>'Upload' or f.uploaded_by<>auth.uid() or f.customer_id<>customer or f.order_id is distinct from related_order or f.sha256 is distinct from details->>'sha256' or f.mime_type is distinct from details->>'mime_type' or f.size_bytes is distinct from (details->>'size_bytes')::bigint or f.filename is distinct from details->>'filename' or f.category is distinct from details->>'category' or f.visibility is distinct from coalesce(details->>'visibility','Internal Only') or f.description is distinct from coalesce(details->>'description','') or f.payment_id is distinct from nullif(details->>'payment_id','')::uuid then raise exception 'Upload request conflict';end if;
 return f.id;end if;
 insert into public.media_files(id,customer_id,order_id,payment_id,filename,original_filename,mime_type,size_bytes,category,description,storage_bucket,storage_path,sha256,visibility,uploaded_by)
 values(target,customer,related_order,nullif(details->>'payment_id','')::uuid,details->>'filename',details->>'filename',details->>'mime_type',(details->>'size_bytes')::bigint,c.name,coalesce(details->>'description',''),'crm-media',customer::text||'/'||target::text||'/original',details->>'sha256',coalesce(details->>'visibility','Internal Only'),auth.uid());return target;
end $$;
create function public.finish_media(target uuid,has_thumbnail boolean,actor uuid) returns void language plpgsql security definer set search_path='' as $$
declare f public.media_files;begin
 perform set_config('request.jwt.claim.sub',actor::text,true);
 select * into f from public.media_files where id=target for update;
 if not found or f.source<>'Upload' or f.uploaded_by<>auth.uid() or not public.can_write_media(target) then raise exception 'Permission denied';end if;
 if f.status='Active' then return;end if;
 if f.status<>'Uploading' or not exists(select 1 from storage.objects where bucket_id=f.storage_bucket and name=f.storage_path) then raise exception 'Upload is not ready';end if;
 if has_thumbnail and not exists(select 1 from storage.objects where bucket_id=f.storage_bucket and name=f.storage_path||'.jpg') then raise exception 'Thumbnail unavailable';end if;
 update public.media_files set status='Active',thumbnail_path=case when has_thumbnail then f.storage_path||'.jpg' end,updated_at=now() where id=target;
 perform public.media_event(target,'Uploaded',auth.uid());
end $$;
create function public.edit_media(target uuid,details jsonb) returns void language plpgsql security definer set search_path='' as $$
declare f public.media_files;cat text;begin
 select * into f from public.media_files where id=target for update;
 if not found or not public.can_write_media(target) or f.status='Uploading' then raise exception 'Permission denied';end if;
 cat=coalesce(details->>'category',f.category);
 if not exists(select 1 from public.media_categories where name=cat and public.has_permission(permission)) then raise exception 'Permission denied for category';end if;
 if f.source in ('Invoice','Manufacturer Pack') and (cat<>f.category or coalesce(details->>'status',f.status)<>f.status) then raise exception 'Issued historical documents cannot be recategorised or archived';end if;
 if f.invoice_id is not null or f.payment_id is not null then if cat not in ('Invoice','Finance') then raise exception 'Financial records must remain in a financial category';end if;end if;
 if coalesce(details->>'status',f.status) not in ('Active','Archived') then raise exception 'Invalid file status';end if;
 update public.media_files set category=cat,description=coalesce(details->>'description',description),visibility=coalesce(details->>'visibility',visibility),status=coalesce(details->>'status',status),updated_at=now() where id=target;
 perform public.media_event(target,case when details->>'status'='Archived' then 'Archived' else 'Metadata / visibility updated' end,auth.uid());
end $$;
create function public.link_media(target uuid,related_order uuid) returns void language plpgsql security definer set search_path='' as $$
declare f public.media_files;begin
 select * into f from public.media_files where id=target for update;
 if not found or not public.can_write_media(target) or f.status<>'Active' or not public.media_scope(f.customer_id,related_order) then raise exception 'Permission denied';end if;
 if f.invoice_id is not null or f.payment_id is not null or f.source='Manufacturer Pack' then raise exception 'Historical documents remain linked to their original order';end if;
 if f.order_id=related_order then return;end if;
 insert into public.media_order_links(file_id,order_id,linked_by,created_at) values(target,related_order,auth.uid(),now()) on conflict do nothing;
 perform public.media_event(target,'Associated with order',auth.uid());
end $$;
create function public.media_config() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('settings',(select to_jsonb(s) from public.media_settings s),'categories',(select coalesce(jsonb_agg(to_jsonb(c) order by sort_order),'[]') from public.media_categories c));$$;
create function public.search_media(filters jsonb) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;begin
 with selected as (
 select f.*,u.full_name uploader,c.first_name||' '||c.last_name customer_name,i.invoice_number,
 (select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'number',o.order_number)),'[]') from public.orders o where o.id=f.order_id or exists(select 1 from public.media_order_links l where l.file_id=f.id and l.order_id=o.id)) related_orders
 from public.media_files f join public.users u on u.id=f.uploaded_by join public.customers c on c.id=f.customer_id left join public.invoices i on i.id=f.invoice_id
 where f.status<>'Uploading' and (nullif(filters->>'customer','') is null or f.customer_id=(filters->>'customer')::uuid)
 and (nullif(filters->>'order','') is null or f.order_id=(filters->>'order')::uuid or exists(select 1 from public.media_order_links l where l.file_id=f.id and l.order_id=(filters->>'order')::uuid))
 ), filtered as (
 select * from selected f where
 (coalesce(filters->>'status','Active')='All' or f.status=coalesce(filters->>'status','Active'))
 and (nullif(filters->>'category','') is null or f.category=filters->>'category')
 and (nullif(filters->>'uploader','') is null or f.uploaded_by=(filters->>'uploader')::uuid)
 and (nullif(filters->>'type','') is null or split_part(f.mime_type,'/',1)=filters->>'type')
 and (nullif(filters->>'from','') is null or f.created_at>=(filters->>'from')::date)
 and (nullif(filters->>'to','') is null or f.created_at<(filters->>'to')::date+1)
 and (nullif(filters->>'q','') is null or concat_ws(' ',f.filename,f.description,f.category,f.customer_name,f.invoice_number,f.related_orders::text) ilike '%'||left(filters->>'q',100)||'%')
 ), page as (select * from filtered order by created_at desc,id limit 24 offset greatest(0,least(coalesce((filters->>'page')::integer,0),100000))*24)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)-'storage_bucket'-'storage_path'-'thumbnail_path'-'sha256'||jsonb_build_object('has_thumbnail',p.thumbnail_path is not null,'can_edit',public.can_write_media(p.id))) from page p),'[]'),'total',(select count(*) from filtered),'counts',coalesce((select jsonb_object_agg(category,n) from (select category,count(*) n from selected where status='Active' group by category) x),'{}')) into result;
 return result;
end $$;
create policy legacy_file_activity_guard on public.activities as restrictive for select to authenticated using(type<>'File uploaded' or public.media_scope(customer_id,null));
-- Legacy routes/storage must enforce the same category + assignment permissions.
create policy legacy_customer_media_guard on public.files as restrictive for select to authenticated using(public.can_read_media(id));
create policy legacy_order_media_guard on public.order_files as restrictive for select to authenticated using(public.can_read_media(id));
create policy legacy_storage_media_guard on storage.objects as restrictive for select to authenticated using(bucket_id not in ('customer-files','order-prescriptions','order-attachments') or exists(select 1 from public.media_files f where f.storage_bucket=bucket_id and f.storage_path=name and f.status in ('Active','Archived') and public.can_read_media(f.id)));
-- Historical physical objects cannot be removed by old wizard cleanup after becoming part of the registry.
create policy legacy_media_delete_guard on storage.objects as restrictive for delete to authenticated using(not exists(select 1 from public.media_files f where f.storage_bucket=bucket_id and f.storage_path=name));
revoke all on function public.media_scope(uuid,uuid),public.can_read_media(uuid),public.can_write_media(uuid),public.media_event(uuid,text,uuid),public.mirror_legacy_media(),public.invoice_media(),public.reserve_media(uuid,uuid,uuid,jsonb),public.finish_media(uuid,boolean,uuid),public.edit_media(uuid,jsonb),public.link_media(uuid,uuid),public.media_config(),public.search_media(jsonb) from public,anon,authenticated;
grant execute on function public.media_scope(uuid,uuid),public.can_read_media(uuid),public.can_write_media(uuid),public.reserve_media(uuid,uuid,uuid,jsonb),public.edit_media(uuid,jsonb),public.link_media(uuid,uuid),public.media_config(),public.search_media(jsonb) to authenticated;
grant execute on function public.finish_media(uuid,boolean,uuid) to service_role;
commit;

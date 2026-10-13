begin;
insert into public.role_permissions values('administrator','products.manage') on conflict do nothing;
alter table public.products add column system_code text,add column manufacturer_name text not null default '',add column manufacturer_model text not null default '',add column elevate_product_name text not null default '',add column elevate_product_family text not null default '',add column display_name text not null default '',add column description text not null default '',add column default_price numeric(12,2) check(default_price between 0 and 1000000);
-- Product audit triggers retain before/after metadata. Existing names, IDs, SKUs and snapshots are unchanged.
update public.products set system_code=sku,manufacturer_name=case when kind='Loupe' then 'Easysee' else '' end,manufacturer_model=name,display_name=name;
update public.products set manufacturer_model='ET1',elevate_product_name='ERGO',display_name='ET1 / ELEVATE ERGO™' where sku='LOUPE-ET';
update public.products set manufacturer_model='ET2 3-in-1',elevate_product_name='ADAPT',display_name='ET2 3-in-1 / ELEVATE ADAPT™' where sku='LOUPE-ET2-3IN1';
insert into public.audit_logs(user_id,action,entity_type,entity_id,new_value) values(null,'MIGRATION','products','202609300015',jsonb_build_object('reason','Add confirmed Elevate commercial aliases. Original names and historical order/invoice/pack snapshots preserved.'));
create function public.save_product(target uuid,payload jsonb) returns void language plpgsql security definer set search_path='' as $$
declare key text;v jsonb;begin
 if not public.has_permission('products.manage') then raise exception 'Access denied';end if;
 if not exists(select 1 from public.products where id=target) then raise exception 'Product not found';end if;
 if jsonb_typeof(payload)<>'object' or length(trim(coalesce(payload->>'manufacturer_model','')))=0 or length(trim(coalesce(payload->>'display_name','')))=0 or length(trim(coalesce(payload->>'sku','')))=0 then raise exception 'Model, display name and SKU are required';end if;
 foreach key in array array['manufacturer_name','manufacturer_model','elevate_product_name','elevate_product_family','display_name','sku'] loop if length(coalesce(payload->>key,''))>180 then raise exception 'Product text is too long';end if;end loop;
 if length(coalesce(payload->>'description',''))>4000 or jsonb_typeof(payload->'options')<>'object' or octet_length((payload->'options')::text)>20000 then raise exception 'Invalid product options';end if;
 for key,v in select * from jsonb_each(payload->'options') loop
 if jsonb_typeof(v)<>'array' or jsonb_array_length(v)>100 then raise exception 'Each option must be a list of at most 100 choices';end if;
 if exists(select 1 from jsonb_array_elements(v) e where jsonb_typeof(e)<>'string' or length(e#>>'{}')>100 or length(e#>>'{}')=0) then raise exception 'Invalid option choice';end if;
 end loop;
 update public.products set manufacturer_name=trim(payload->>'manufacturer_name'),manufacturer_model=trim(payload->>'manufacturer_model'),elevate_product_name=trim(payload->>'elevate_product_name'),elevate_product_family=trim(payload->>'elevate_product_family'),display_name=trim(payload->>'display_name'),description=coalesce(payload->>'description',''),sku=trim(payload->>'sku'),active=(payload->>'active')::boolean,provisional=(payload->>'provisional')::boolean,default_price=nullif(payload->>'default_price','')::numeric,default_vat_rate=(payload->>'default_vat_rate')::numeric,default_vat_applicable=(payload->>'default_vat_applicable')::boolean,options=payload->'options' where id=target;
end $$;
revoke all on function public.save_product(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_product(uuid,jsonb) to authenticated;
alter table public.order_items add column product_identity jsonb not null default '{}';
-- Only new order lines get the identity in effect at creation. Never backfill/rename historical lines.
create function public.snapshot_product_identity() returns trigger language plpgsql security definer set search_path='' as $$
declare p public.products;begin
 select * into p from public.products where id=new.product_id;
 new.product_identity=jsonb_build_object('manufacturer_name',p.manufacturer_name,'manufacturer_model',p.manufacturer_model,'original_name',p.name,'elevate_product_name',p.elevate_product_name,'elevate_product_family',p.elevate_product_family,'display_name',p.display_name);
 new.description=coalesce(nullif(p.display_name,''),p.name);
 if p.kind='Loupe' and position(p.manufacturer_model in new.description)=0 then new.description=new.description||' ('||p.manufacturer_model||')';end if;
 return new;
end $$;
create trigger product_identity_snapshot before insert on public.order_items for each row execute function public.snapshot_product_identity();
revoke all on function public.snapshot_product_identity() from public,anon,authenticated;
-- Preserve the existing review/security logic, then enrich only the explicit product identity allowlist.
alter function public.review_manufacturer(uuid,uuid[],text) rename to review_manufacturer_phase6;
revoke all on function public.review_manufacturer_phase6(uuid,uuid[],text) from public,anon,authenticated;
create function public.review_manufacturer(target uuid,selected uuid[],instructions text default '') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r jsonb;s jsonb;begin
 r=public.review_manufacturer_phase6(target,selected,instructions);s=r->'snapshot';
 s=jsonb_set(s,'{items}',(select coalesce(jsonb_agg(jsonb_build_object('sku',i.sku,'description',i.description,'kind',i.kind,'quantity',i.quantity,'configuration',i.configuration,'manufacturer_model',coalesce(nullif(i.product_identity->>'manufacturer_model',''),i.description),'manufacturer_name',coalesce(i.product_identity->>'manufacturer_name',case when i.kind='Loupe' then 'Easysee' else '' end),'commercial_name',coalesce(i.product_identity->>'elevate_product_name','')) order by case i.kind when 'Loupe' then 1 when 'Light' then 2 else 3 end,i.id),'[]') from public.order_items i where i.order_id=target));
 return jsonb_build_object('snapshot',s,'fingerprint',md5(s::text));
end $$;
revoke all on function public.review_manufacturer(uuid,uuid[],text) from public,anon,authenticated;
grant execute on function public.review_manufacturer(uuid,uuid[],text) to authenticated;
-- Use the new commercial brand only for newly generated file names. Old registered files remain intact.
create function public.brand_manufacturer_file() returns trigger language plpgsql set search_path='' as $$
begin if new.source='Manufacturer Pack' then new.filename=replace(new.filename,'Easysee-EO-','Elevate-EO-');new.original_filename=new.filename;end if;return new;end $$;
create trigger brand_manufacturer_file before insert on public.media_files for each row execute function public.brand_manufacturer_file();
revoke all on function public.brand_manufacturer_file() from public,anon,authenticated;
-- Change only the commercial setting; retain legal/tax details and all issued snapshots.
update public.company_settings set details=jsonb_set(details,'{trading_name}','"Elevate Dental Optics"'),updated_at=now() where coalesce(details->>'trading_name','') in ('','Easysee','Easysee UK');
commit;

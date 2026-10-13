begin;
-- Preserve Phase 5 wizard validation and calculations; read prescription presence from the unified registry.
create or replace function public.save_order_internal(p_id uuid,p_payload jsonb,p_expected_version integer,p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare existing public.orders; saved public.orders; m jsonb; rx jsonb; item jsonb; pay jsonb;
 product public.products; cfg jsonb; key text; net numeric; discount numeric; tax numeric; price numeric; qty integer;
 prior_lines jsonb; cid uuid; new_order boolean; line_count integer; loupe_count integer;
begin
 if not public.has_permission('orders.write') then raise exception 'Access denied'; end if;
 if p_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Invalid order'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
 select * into existing from public.orders where id=p_id for update;
 new_order=not found;
 if not new_order and existing.status<>'Draft' then
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
 perform public.validate_order_eye(coalesce(rx->'right_eye','{}'),false);
 perform public.validate_order_eye(coalesce(rx->'left_eye','{}'),false);
 if not (rx->>'required')::boolean and exists(select 1 from public.media_files f where f.category='Prescription' and f.status='Active' and (f.order_id=p_id or exists(select 1 from public.media_order_links l where l.file_id=f.id and l.order_id=p_id))) then raise exception 'Remove prescription attachments before selecting No'; end if;
 insert into public.prescriptions(order_id,required,right_eye,left_eye,prescription_date,provider,notes)
 values(p_id,(rx->>'required')::boolean,case when (rx->>'required')::boolean then rx->'right_eye' else '{}' end,
 case when (rx->>'required')::boolean then rx->'left_eye' else '{}' end,
 case when (rx->>'required')::boolean then nullif(rx->>'prescription_date','')::date end,
 case when (rx->>'required')::boolean then coalesce(rx->>'provider','') else '' end,
 case when (rx->>'required')::boolean then coalesce(rx->>'notes','') else '' end)
 on conflict(order_id) do update set required=excluded.required,right_eye=excluded.right_eye,left_eye=excluded.left_eye,prescription_date=excluded.prescription_date,provider=excluded.provider,notes=excluded.notes;
 if jsonb_typeof(p_payload->'items')<>'array' or jsonb_array_length(p_payload->'items')>50 then raise exception 'Invalid order items'; end if;
 select coalesce(jsonb_object_agg(id,to_jsonb(i)),'{}') into prior_lines from public.order_items i where order_id=p_id;
 delete from public.order_items where order_id=p_id;
 for item in select * from jsonb_array_elements(p_payload->'items') loop
 select * into product from public.products where id=(item->>'product_id')::uuid and active;
 if not found then raise exception 'Product is unavailable'; end if;
 cfg=coalesce(item->'configuration','{}');
 if jsonb_typeof(cfg)<>'object' then raise exception 'Invalid configuration'; end if;
 if product.kind='Loupe' then
 foreach key in array array['magnification','frame','frame_colour'] loop
 if coalesce(cfg->>key,'')<>'' and not coalesce((product.options->key)?(cfg->>key),false) then raise exception 'Invalid % for %',key,product.name; end if;
 if p_confirm and coalesce(cfg->>key,'')='' then raise exception 'Complete the loupe configuration'; end if;
 end loop;
 if nullif(cfg->>'working_distance','') is not null then
 if (cfg->>'working_distance')::numeric not between 350 and 550 or (cfg->>'working_distance')::numeric<>trunc((cfg->>'working_distance')::numeric) then raise exception 'Working distance must be 350–550 mm';end if;
 cfg=jsonb_set(cfg,'{working_distance}',to_jsonb((cfg->>'working_distance')::numeric));
 elsif p_confirm then raise exception 'Complete working distance';end if;
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
 if discount>0 and not public.has_permission('finance.discount') then raise exception 'Discount authorisation required';end if;
 tax=case when coalesce((item->>'vat_applicable')::boolean,true) then round((net-discount)*(item->>'vat_rate')::numeric/100,2) else 0 end;
 insert into public.order_items(id,order_id,product_id,sku,description,kind,configuration,quantity,unit_price,discount_type,discount_value,discount_reason,authorised_by,discounted_at,vat_applicable,vat_rate,subtotal,discount_amount,vat_amount,total)
 values((item->>'id')::uuid,p_id,product.id,product.sku,product.name,product.kind,cfg,qty,price,item->>'discount_type',(item->>'discount_value')::numeric,coalesce(item->>'discount_reason',''),case when discount>0 then case when (prior_lines->(item->>'id')->>'discount_type')=item->>'discount_type' and (prior_lines->(item->>'id')->>'discount_value')::numeric=(item->>'discount_value')::numeric and (prior_lines->(item->>'id')->>'discount_reason')=coalesce(item->>'discount_reason','') then (prior_lines->(item->>'id')->>'authorised_by')::uuid else auth.uid() end end,case when discount>0 then case when (prior_lines->(item->>'id')->>'discount_type')=item->>'discount_type' and (prior_lines->(item->>'id')->>'discount_value')::numeric=(item->>'discount_value')::numeric and (prior_lines->(item->>'id')->>'discount_reason')=coalesce(item->>'discount_reason','') then coalesce((prior_lines->(item->>'id')->>'discounted_at')::timestamptz,now()) else now() end end,coalesce((item->>'vat_applicable')::boolean,true),(item->>'vat_rate')::numeric,net,discount,tax,net-discount+tax);
 end loop;
 if jsonb_typeof(p_payload->'payments')<>'array' or jsonb_array_length(p_payload->'payments')>50 then raise exception 'Invalid payments'; end if;
 if exists(select 1 from public.payments p where p.order_id=p_id and p.status<>'Pending' and not exists(select 1 from jsonb_array_elements(p_payload->'payments') x where (x->>'id')::uuid=p.id)) then raise exception 'Recorded payments must be retained';end if;
 delete from public.payments p where p.order_id=p_id and p.status='Pending' and not exists(select 1 from jsonb_array_elements(p_payload->'payments') x where (x->>'id')::uuid=p.id);
 for pay in select * from jsonb_array_elements(p_payload->'payments') loop
 if not public.has_permission('orders.pay') or exists(select 1 from public.payments where id=(pay->>'id')::uuid and order_id<>p_id) then raise exception 'Payment access denied';end if;
 if (pay->>'amount')::numeric<>round((pay->>'amount')::numeric,2) then raise exception 'Payments must use whole pennies'; end if;
 insert into public.payments(id,order_id,payment_date,amount,method,reference,notes,received_by,status)
 values((pay->>'id')::uuid,p_id,(pay->>'payment_date')::date,(pay->>'amount')::numeric,pay->>'method',coalesce(pay->>'reference',''),coalesce(pay->>'notes',''),auth.uid(),'Completed')
 on conflict(id) do update set amount=excluded.amount,method=excluded.method,payment_date=excluded.payment_date,reference=excluded.reference,notes=excluded.notes,status=case when payments.status='Pending' then excluded.status else payments.status end;
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
 if (rx->>'required')::boolean and not exists(select 1 from public.media_files f join storage.objects obj on obj.bucket_id=f.storage_bucket and obj.name=f.storage_path where f.category='Prescription' and f.status='Active' and public.can_read_media(f.id) and (f.order_id=p_id or exists(select 1 from public.media_order_links l where l.file_id=f.id and l.order_id=p_id))) then raise exception 'Upload a prescription image or PDF before confirming the order'; end if;
 update public.orders set status='Order Confirmed',confirmed_at=now(),confirmed_by=auth.uid(),current_step=7 where id=p_id returning * into saved;
 insert into public.activities(customer_id,order_id,type,description,user_id) values(cid,p_id,'Order confirmed','Confirmed order EO-'||saved.order_number,auth.uid());
 end if;
 return jsonb_build_object('id',saved.id,'version',saved.version,'order_number',saved.order_number,'status',saved.status);
end $$;
commit;

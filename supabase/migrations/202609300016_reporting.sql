begin;
insert into public.role_permissions values('administrator','reports.read'),('finance','reports.read'),('sales','reports.read'),('operations','reports.read') on conflict do nothing;
create index reporting_order_date on public.orders(order_date);
create index reporting_payment_date on public.payments(payment_date);
create index reporting_refund_date on public.refunds(refund_date);
create index reporting_invoice_date on public.invoices(invoice_date) where issued_at is not null;
create function public.report_scope(target uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.has_permission('reports.read') and public.can_read_order(target);
$$;
create function public.report_data(filters jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare start_date date;end_date date;rep uuid;product uuid;role_name text;result jsonb;today date=(now() at time zone 'Europe/London')::date;
begin
 if not public.has_permission('reports.read') then raise exception 'Access denied';end if;
 select role::text into role_name from public.users where id=auth.uid() and active;
 if role_name='operations' and coalesce(filters->>'payment_status','')<>'' then raise exception 'Payment filters require financial reporting permission';end if;
 start_date=(filters->>'from')::date;end_date=(filters->>'to')::date;
 if start_date is null or end_date is null or not isfinite(start_date) or not isfinite(end_date) or start_date>end_date or end_date-start_date>3660 then raise exception 'Choose a valid report range of at most ten years';end if;
 rep=nullif(filters->>'rep','')::uuid;product=nullif(filters->>'product','')::uuid;
 with
 customers as materialized (
 select c.* from public.customers c where public.has_permission('customers.read') and (role_name<>'sales' or c.assigned_to=auth.uid()) and (rep is null or c.assigned_to=rep) and (coalesce(filters->>'lead_source','')='' or coalesce(c.lead_source,'Unattributed')=filters->>'lead_source')
 ),
 base as materialized (
 select o.*,coalesce(c.assigned_to,o.created_by) rep_id,coalesce(c.lead_source,'Unattributed') source,
 coalesce(o.order_date,(o.created_at at time zone 'Europe/London')::date) report_date,
 exists(select 1 from public.order_items i where i.order_id=o.id and i.kind='Loupe') has_loupe,
 exists(select 1 from public.order_items i join public.products p on p.id=i.product_id where i.order_id=o.id and p.system_code='LIGHT-WIRELESS') has_light
 from public.orders o join public.customers c on c.id=o.customer_id
 where public.report_scope(o.id) and (rep is null or coalesce(c.assigned_to,o.created_by)=rep)
 and (coalesce(filters->>'lead_source','')='' or coalesce(c.lead_source,'Unattributed')=filters->>'lead_source')
 and (coalesce(filters->>'status','')='' or o.status=filters->>'status')
 and (coalesce(filters->>'payment_status','')='' or o.payment_status=filters->>'payment_status')
 and ((product is null and coalesce(filters->>'family','')='' and coalesce(filters->>'model','')='') or exists(
 select 1 from public.order_items i join public.products p on p.id=i.product_id where i.order_id=o.id and (product is null or i.product_id=product)
 and (coalesce(filters->>'family','')='' or p.elevate_product_family=filters->>'family') and (coalesce(filters->>'model','')='' or p.manufacturer_model=filters->>'model')))
 ),
 cohort as materialized(select * from base where report_date between start_date and end_date),
 sold as materialized(select * from cohort where confirmed_at is not null and status not in ('Draft','Cancelled')),
 receipts as materialized(select p.*,b.rep_id from public.payments p join base b on b.id=p.order_id where p.status in ('Completed','Partially Refunded','Refunded') and p.payment_date between start_date and end_date),
 returns as materialized(select r.* from public.refunds r join base b on b.id=r.order_id where (r.refund_date at time zone 'Europe/London')::date between start_date and end_date),
 issued as materialized(select i.* from public.invoices i join base b on b.id=i.order_id where i.issued_at is not null and i.status not in ('Cancelled','Credited') and i.invoice_date between start_date and end_date),
 lines as materialized(select i.*,p.system_code,p.manufacturer_name,p.manufacturer_model,p.elevate_product_name,p.elevate_product_family,p.display_name,s.has_light,
 exists(select 1 from public.prescriptions rx where rx.order_id=s.id and rx.required) rx
 from public.order_items i join sold s on s.id=i.order_id join public.products p on p.id=i.product_id),
 customer_counts as materialized(select c.id,c.customer_number,c.assigned_to,c.status,c.lead_source,c.created_at,count(s.id) orders,coalesce(sum(s.total),0) value,coalesce(sum(greatest(s.balance,0)),0) outstanding from customers c left join sold s on s.customer_id=c.id
 where (product is null and coalesce(filters->>'family','')='' and coalesce(filters->>'model','')='' and coalesce(filters->>'status','')='' and coalesce(filters->>'payment_status','')='') or exists(select 1 from base b where b.customer_id=c.id)
 group by c.id,c.customer_number,c.assigned_to,c.status,c.lead_source,c.created_at),
 durations as (select s.id,
 (select min(h.created_at) from public.order_status_history h where h.order_id=s.id and h.to_status='Submitted to Manufacturer' and h.created_at>=s.confirmed_at) submitted,
 (select min(h.created_at) from public.order_status_history h where h.order_id=s.id and h.to_status='In Production') production,
 (select min(h.created_at) from public.order_status_history h where h.order_id=s.id and h.to_status='QC') qc,
 (select min(h.created_at) from public.order_status_history h where h.order_id=s.id and h.to_status='Customer Delivery' and h.created_at>=s.confirmed_at) delivery,s.confirmed_at from sold s)
 select jsonb_build_object(
 'scope',role_name,'from',start_date,'to',end_date,'as_of',today,
 'sales',(select jsonb_build_object('orders',count(*),'gross_order_value',coalesce(sum(subtotal),0),'discounts',coalesce(sum(discount_total),0),'net_sales',coalesce(sum(subtotal-discount_total),0),'vat',coalesce(sum(vat_total),0),'total_order_value',coalesce(sum(total),0),'outstanding',coalesce(sum(greatest(balance,0)),0),'average_order_value',coalesce(round(avg(total),2),0),'completed',count(*) filter(where status='Closed'),'active',count(*) filter(where status<>'Closed'),'deposits_received',coalesce(sum(deposit_received),0),'prescription_orders',count(*) filter(where exists(select 1 from public.prescriptions rx where rx.order_id=sold.id and rx.required)),'non_prescription_orders',count(*) filter(where not exists(select 1 from public.prescriptions rx where rx.order_id=sold.id and rx.required)),'loupe_orders',count(*) filter(where has_loupe),'light_attached_orders',count(*) filter(where has_loupe and has_light),'within_expected_window',count(*) filter(where status not in ('Customer Delivery','Fitting','Aftercare','Closed') and expected_completion_date>=today),'overdue',count(*) filter(where status not in ('Customer Delivery','Fitting','Aftercare','Closed') and expected_completion_date<today)) from sold),
 'cash',jsonb_build_object('payments_received',(select coalesce(sum(amount),0) from receipts),'refunds',(select coalesce(sum(amount),0) from returns),'net_receipts',(select coalesce(sum(amount),0) from receipts)-(select coalesce(sum(amount),0) from returns)),
 'financial',(select jsonb_build_object('invoices',count(*),'invoice_value',coalesce(sum(gross_total),0),'vat_invoiced',coalesce(sum(vat_total),0),'paid_invoices',count(*) filter(where status='Paid'),'partially_paid_invoices',count(*) filter(where status='Partially Paid'),'outstanding_invoices',count(*) filter(where amount_due>0),'invoice_balance',coalesce(sum(greatest(amount_due,0)),0),'finance_funded_orders',(select count(*) from sold s where exists(select 1 from public.order_finance f where f.order_id=s.id and f.required and f.status in ('Approved','Completed'))),'vat_collected',null) from issued),
 'customers',(select jsonb_build_object('total',count(*),'new',count(*) filter(where (created_at at time zone 'Europe/London')::date between start_date and end_date),'leads',count(*) filter(where status='Lead' and (created_at at time zone 'Europe/London')::date between start_date and end_date),'repeat_customers',count(*) filter(where orders>1),'with_outstanding',count(*) filter(where outstanding>0)) from customer_counts),
 'products',(select coalesce(jsonb_agg(to_jsonb(x) order by revenue desc),'[]') from(select product_id,manufacturer_name,manufacturer_model,elevate_product_name,elevate_product_family,display_name,kind,sum(quantity) quantity,sum(subtotal-discount_amount) revenue,round(sum(subtotal-discount_amount)/nullif(sum(quantity),0),2) average_selling_price,sum(discount_amount) discounts,count(distinct order_id) filter(where has_light and kind='Loupe') wireless_attached_orders,count(distinct order_id) filter(where rx) prescription_orders,count(distinct order_id) filter(where not rx) non_prescription_orders from lines group by product_id,manufacturer_name,manufacturer_model,elevate_product_name,elevate_product_family,display_name,kind) x),
 'wireless',(select jsonb_build_object('quantity',coalesce(sum(quantity),0),'revenue',coalesce(sum(subtotal-discount_amount),0),'average_selling_price',coalesce(round(sum(subtotal-discount_amount)/nullif(sum(quantity),0),2),0)) from lines where system_code='LIGHT-WIRELESS'),
 'representatives',(select coalesce(jsonb_agg(to_jsonb(x) order by sales_value desc),'[]') from(select u.id,u.full_name,
 (select count(*) from customer_counts c where c.assigned_to=u.id) customers,
 (select count(*) from customer_counts c where c.assigned_to=u.id and c.status='Lead' and (c.created_at at time zone 'Europe/London')::date between start_date and end_date) leads,
 (select count(*) from sold s where s.rep_id=u.id) orders,
 (select coalesce(sum(total),0) from sold s where s.rep_id=u.id) sales_value,
 (select coalesce(sum(amount),0) from receipts p where p.rep_id=u.id) payments_received,
 (select coalesce(sum(greatest(balance,0)),0) from sold s where s.rep_id=u.id) outstanding,
 (select coalesce(round(avg(total),2),0) from sold s where s.rep_id=u.id) average_order_value,
 (select coalesce(sum(discount_total),0) from sold s where s.rep_id=u.id) discounts
 from public.users u where u.id in(select rep_id from sold union select rep_id from receipts union select assigned_to from customer_counts)) x),
 'sources',(select coalesce(jsonb_agg(to_jsonb(x) order by source),'[]') from(select source,
 (select count(*) from customer_counts c where coalesce(c.lead_source,'Unattributed')=src.source) customers,
 (select count(*) from customer_counts c where coalesce(c.lead_source,'Unattributed')=src.source and c.status='Lead' and (c.created_at at time zone 'Europe/London')::date between start_date and end_date) leads,
 (select count(*) from sold s where s.source=src.source) orders,
 (select coalesce(sum(subtotal-discount_total),0) from sold s where s.source=src.source) revenue
 from(select source from sold union select coalesce(lead_source,'Unattributed') from customer_counts) src) x),
 'pipeline',(select coalesce(jsonb_agg(to_jsonb(x) order by position),'[]') from(select stage,position,count(c.id) orders,coalesce(sum(c.total),0) value from unnest(array['Draft','Awaiting Payment','Order Confirmed','Ready for Manufacturer','Submitted to Manufacturer','In Production','QC','Shipped to UK','Received in UK','Customer Delivery','Fitting','Aftercare','Closed','Cancelled']) with ordinality as stages(stage,position) left join cohort c on c.status=stage group by stage,position) x),
 'months',(select coalesce(jsonb_agg(to_jsonb(x) order by month),'[]') from(select to_char(report_date,'YYYY-MM') as month,count(*) orders,sum(subtotal-discount_total) net_sales,sum(total) order_value from sold group by 1) x),
 'durations',(select jsonb_build_object('order_to_manufacturer_days',round(avg(extract(epoch from submitted-confirmed_at)/86400),1),'manufacturing_to_qc_days',round(avg(extract(epoch from qc-production)/86400) filter(where qc>=production),1),'order_to_delivery_days',round(avg(extract(epoch from delivery-confirmed_at)/86400),1),'submission_samples',count(submitted),'production_samples',count(*) filter(where qc>=production),'delivery_samples',count(delivery)) from durations),
 'cash_records_total',(select count(*) from receipts)+(select count(*) from returns),
 'cash_records',(select coalesce(jsonb_agg(to_jsonb(x) order by transaction_date desc,id),'[]') from (
 select * from (select p.id,p.order_id,b.order_number,p.payment_date transaction_date,'Payment'::text kind,p.amount,p.method from receipts p join base b on b.id=p.order_id
 union all select r.id,r.order_id,b.order_number,(r.refund_date at time zone 'Europe/London')::date,'Refund',r.amount,'' from returns r join base b on b.id=r.order_id) cash_rows order by transaction_date desc,id limit 100 offset greatest(0,least(coalesce((filters->>'page')::integer,0),100000))*100) x),
 'records_total',(select count(*) from cohort),
 'records',(select coalesce(jsonb_agg(to_jsonb(x) order by report_date desc,id),'[]') from(select id,order_number,customer_id,report_date,status,total,balance,payment_status from cohort order by report_date desc,id limit 100 offset greatest(0,least(coalesce((filters->>'page')::integer,0),100000))*100) x),
 'invoices_total',(select count(*) from issued),
 'invoices',(select coalesce(jsonb_agg(to_jsonb(x) order by invoice_date desc,id),'[]') from(select id,invoice_number,order_id,invoice_date,status,gross_total,amount_due from issued order by invoice_date desc,id limit 100 offset greatest(0,least(coalesce((filters->>'page')::integer,0),100000))*100) x)
 ) into result;
 if role_name='operations' then return jsonb_build_object('scope',role_name,'from',start_date,'to',end_date,'as_of',today,'pipeline',result->'pipeline','durations',result->'durations','records',(select coalesce(jsonb_agg(v-'balance'-'payment_status'),'[]') from jsonb_array_elements(result->'records') v),'records_total',result->'records_total');end if;
 if not public.has_permission('finance.read') then raise exception 'Financial reporting unavailable';end if;
 return result;
end $$;
create function public.record_report_export(filters jsonb,format text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not public.has_permission('reports.read') or format not in ('csv','pdf') then raise exception 'Access denied';end if;
 insert into public.audit_logs(user_id,action,entity_type,entity_id,new_value) values(auth.uid(),'EXPORT','reports',gen_random_uuid()::text,jsonb_build_object('format',format,'filters',filters-'page','scope',(select role from public.users where id=auth.uid())));
end $$;
revoke all on function public.report_scope(uuid),public.report_data(jsonb),public.record_report_export(jsonb,text) from public,anon,authenticated;
grant execute on function public.report_scope(uuid),public.report_data(jsonb),public.record_report_export(jsonb,text) to authenticated;
commit;

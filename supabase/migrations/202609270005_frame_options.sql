begin;
-- Frame choices supplied by Easysee; existing order snapshots remain unchanged.
update public.products
set options = options || '{"frame":["Sport","Circular frame","Square frame"]}'::jsonb
where kind = 'Loupe';
commit;

begin;
-- Confirmed model names, magnifications and colours supplied by Easysee.
-- Retain product IDs and existing order item snapshots.
update public.products
set name = case when sku = 'LOUPE-ET' then 'ET 1' else name end,
    options = options || '{"magnification":["3x","4x","5x","6x"]}'::jsonb
where sku in ('LOUPE-ET','LOUPE-EL');

insert into public.products (sku,name,kind,options)
select 'LOUPE-ET2-3IN1','ET 2 3 In 1','Loupe',
       options || '{"magnification":["Adjustable (3 In 1)"]}'::jsonb
from public.products where sku='LOUPE-ET';

update public.products
set options = options || '{"frame_colour":["Silver","Black","Olive Gold","Purple/Pink","Blue"]}'::jsonb
where kind='Loupe';
-- Frames and working distances remain provisional pending manufacturer details.
commit;

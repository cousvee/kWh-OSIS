\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
create table t_res(n serial, name text, ok boolean, info text);
create table t_tok(role text primary key, token text);
create or replace function t_check(p_name text, p_ok boolean, p_info text default null) returns void language sql as
$$ insert into t_res(name, ok, info) values (p_name, coalesce(p_ok,false), p_info) $$;
create or replace function t_err(q text) returns text language plpgsql as
$$ begin execute q; return 'NO_ERROR'; exception when others then return sqlerrm; end $$;
create or replace function t_tk(r text) returns text language sql as $$ select token from t_tok where role=r $$;

-- setup: login + forced passcode change
do $$ declare r jsonb; t text; begin
 for t in select unnest(array['admin','kitchen','cashier']) loop
   r := staff_login(t,'ganti-'||t);
   perform change_passcode(r->>'token', t, 'ganti-'||t, t||'-pass-1');
   insert into t_tok values (t, r->>'token');
 end loop; end $$;
select t_check('S0 login works w/ new passcode', (staff_login('admin','admin-pass-1')->>'ok')::boolean);
select t_check('S0 old default passcode rejected', (staff_login('admin','ganti-admin')->>'ok')::boolean = false);

-- ===== CUSTOMER
create temp table pid as select name, id from products;
do $$
declare
  teh uuid := (select id from pid where name='Es Teh');
  mie uuid := (select id from pid where name='Mie Goreng');
  jeruk uuid := (select id from pid where name='Es Jeruk');
  r jsonb; r2 jsonb;
begin
  r := create_customer_order('key-aaaaaaaa1','Kichiro','8.1', jsonb_build_array(
        jsonb_build_object('product_id',teh,'quantity',2), jsonb_build_object('product_id',mie,'quantity',1)));
  perform t_check('C1/2 first queue = 001', r->'order'->>'queue_number'='001', r->'order'->>'queue_number');
  perform t_check('C5/6 server total 2xTeh+Mie = 20000', (r->'order'->>'total_amount')::int=20000, r->'order'->>'total_amount');
  perform t_check('C ticket has no staff fields', not (r->'order' ? 'paid_by_role') and not (r->'order' ? 'event_id'));
  r2 := create_customer_order('key-aaaaaaaa2','Sari','7.2', jsonb_build_array(jsonb_build_object('product_id',jeruk,'quantity',3)));
  perform t_check('C3/4 second queue = 002', r2->'order'->>'queue_number'='002');
  perform t_check('C total 3xJeruk = 18000', (r2->'order'->>'total_amount')::int=18000);
  -- idempotency replay
  r2 := create_customer_order('key-aaaaaaaa1','Beda','9.9', jsonb_build_array(jsonb_build_object('product_id',jeruk,'quantity',1)));
  perform t_check('C9 same key returns original order', r2->'order'->>'queue_number'='001' and (r2->>'replayed')::boolean and r2->'order'->>'customer_name'='Kichiro');
  perform t_check('C9 no duplicate row', (select count(*) from orders)=2);
  perform t_check('C9 queue counter not burned by replay', (select current_queue_seq from events where status='active')=2);
  -- invalid inputs
  perform t_check('C10 empty cart rejected', t_err($q$select create_customer_order('key-bbbbbbbb1','A','1','[]'::jsonb)$q$)='EMPTY_CART');
  perform t_check('C10 null items rejected', t_err($q$select create_customer_order('key-bbbbbbbb2','A','1',null)$q$)='EMPTY_CART');
  perform t_check('C11 empty name', t_err(format($q$select create_customer_order('key-bbbbbbbb3','  ','1','[{"product_id":"%s","quantity":1}]'::jsonb)$q$,teh))='INVALID_CUSTOMER_NAME');
  perform t_check('C11 empty class', t_err(format($q$select create_customer_order('key-bbbbbbbb4','A','','[{"product_id":"%s","quantity":1}]'::jsonb)$q$,teh))='INVALID_CUSTOMER_CLASS');
  perform t_check('C11 qty 0', t_err(format($q$select create_customer_order('key-bbbbbbbb5','A','1','[{"product_id":"%s","quantity":0}]'::jsonb)$q$,teh))='INVALID_QUANTITY');
  perform t_check('C11 qty negative', t_err(format($q$select create_customer_order('key-bbbbbbbb6','A','1','[{"product_id":"%s","quantity":-3}]'::jsonb)$q$,teh))='INVALID_QUANTITY');
  perform t_check('C11 qty text', t_err(format($q$select create_customer_order('key-bbbbbbbb7','A','1','[{"product_id":"%s","quantity":"abc"}]'::jsonb)$q$,teh))='INVALID_QUANTITY');
  perform t_check('C11 qty fraction', t_err(format($q$select create_customer_order('key-bbbbbbbb8','A','1','[{"product_id":"%s","quantity":1.5}]'::jsonb)$q$,teh))='INVALID_QUANTITY');
  perform t_check('C11 bad product id', t_err($q$select create_customer_order('key-bbbbbbbb9','A','1','[{"product_id":"nope","quantity":1}]'::jsonb)$q$)='INVALID_ITEMS');
  perform t_check('C11 unknown product', t_err($q$select create_customer_order('key-bbbbbbbc1','A','1','[{"product_id":"11111111-1111-1111-1111-111111111111","quantity":1}]'::jsonb)$q$)='PRODUCT_NOT_FOUND');
  perform t_check('C11 merged qty >99', t_err(format($q$select create_customer_order('key-bbbbbbbc2','A','1','[{"product_id":"%s","quantity":60},{"product_id":"%s","quantity":60}]'::jsonb)$q$,teh,teh))='INVALID_QUANTITY');
  perform t_check('C failed attempts burned no queue numbers', (select current_queue_seq from events where status='active')=2);
  -- client-supplied price/total ignored
  r := create_customer_order('key-cccccccc1','Hack','1', jsonb_build_array(jsonb_build_object('product_id',teh,'quantity',1,'price',1,'total_amount',1)));
  perform t_check('C6 client price ignored (still 5000)', (r->'order'->>'total_amount')::int=5000);
  perform t_check('C duplicate lines merged', (select count(*) from order_items where order_id=(r->'order'->>'id')::uuid)=1);
  -- sold out
  perform admin_save_product(t_tk('admin'), jeruk, 'Es Jeruk','minuman',6000,false);
  perform t_check('C7/8 sold-out rejected by server', t_err(format($q$select create_customer_order('key-dddddddd1','A','1','[{"product_id":"%s","quantity":1}]'::jsonb)$q$,jeruk))='PRODUCT_UNAVAILABLE');
  perform t_check('C sold-out in menu flagged', (select (m->>'available')::boolean from jsonb_array_elements(get_menu()) m where m->>'name'='Es Jeruk')=false);
  perform admin_save_product(t_tk('admin'), jeruk, 'Es Jeruk','minuman',6000,true);
end $$;

-- ===== KITCHEN
do $$
declare
  o1 uuid := (select id from orders where queue_number='001');
  o2 uuid := (select id from orders where queue_number='002');
  o3 uuid := (select id from orders where queue_number='003');
  k text := t_tk('kitchen'); r jsonb; s jsonb;
begin
  perform t_check('K12 new order waiting', (select production_status from orders where id=o1)='waiting');
  perform t_check('K list shows 3 active, no payment info', jsonb_array_length(list_kitchen_orders(k))=3 and not (list_kitchen_orders(k)->0 ? 'total_amount'));
  s := get_production_summary(k);
  perform t_check('K18 summary aggregates', (select (x->>'quantity')::int from jsonb_array_elements(s->'items') x where x->>'product_name'='Es Teh')=3
     and (select (x->>'quantity')::int from jsonb_array_elements(s->'items') x where x->>'product_name'='Es Jeruk')=3 and (select (x->>'quantity')::int from jsonb_array_elements(s->'items') x where x->>'product_name'='Mie Goreng')=1, s::text);
  perform t_check('K skip step rejected', t_err(format($q$select update_production_status('%s','%s','ready')$q$,k,o1))='INVALID_TRANSITION');
  perform t_check('K backwards rejected', t_err(format($q$select update_production_status('%s','%s','waiting')$q$,k,o1))='INVALID_STATUS');
  r := update_production_status(k,o1,'processing');
  perform t_check('K13 waiting->processing', r->'order'->>'production_status'='processing' and (r->>'changed')::boolean);
  r := update_production_status(k,o1,'processing');
  perform t_check('K double-click safe', not (r->>'changed')::boolean);
  r := update_production_status(k,o1,'ready');
  perform t_check('K14 processing->ready', r->'order'->>'production_status'='ready');
  s := get_production_summary(k);
  perform t_check('K ready still in summary', (select (x->>'quantity')::int from jsonb_array_elements(s->'items') x where x->>'product_name'='Mie Goreng')=1);
  r := update_production_status(k,o1,'completed');
  perform t_check('K15 ready->completed', r->'order'->>'production_status'='completed');
  s := get_production_summary(k);
  perform t_check('K16 completed leaves summary', (select count(*) from jsonb_array_elements(s->'items') x where x->>'product_name'='Mie Goreng')=0
     and (select (x->>'quantity')::int from jsonb_array_elements(s->'items') x where x->>'product_name'='Es Teh')=1, s::text);
  perform t_check('K completed leaves kitchen list', jsonb_array_length(list_kitchen_orders(k))=2);
  -- cancel
  perform t_check('X cancel needs reason', t_err(format($q$select cancel_order('%s','%s',' ')$q$,k,o2))='REASON_REQUIRED');
  r := cancel_order(k,o2,'Pelanggan batal');
  perform t_check('X cancel ok & keeps data', r->'order'->>'production_status'='cancelled' and (r->'order'->>'total_amount')::int=18000 and r->'order'->>'queue_number'='002' and r->'order'->>'cancelled_by_role'='kitchen' and jsonb_array_length(r->'order'->'items')=1);
  s := get_production_summary(k);
  perform t_check('K17 cancelled leaves summary', (select count(*) from jsonb_array_elements(s->'items') x where x->>'product_name'='Es Jeruk')=0, s::text);
  perform t_check('K cancelled leaves kitchen list', jsonb_array_length(list_kitchen_orders(k))=1);
  perform t_check('K cancelled cannot progress', t_err(format($q$select update_production_status('%s','%s','processing')$q$,k,o2))='ORDER_CANCELLED');
  perform t_check('X cancel twice is idempotent', not (cancel_order(k,o2,'lagi')->>'changed')::boolean);
  perform t_check('X total unchanged in DB', (select total_amount from orders where id=o2)=18000);
  perform t_check('X direct total rewrite blocked', t_err(format($q$update orders set total_amount=0 where id='%s'$q$,o2))='IMMUTABLE_RECORD');
  perform t_check('X kitchen cannot cancel completed', t_err(format($q$select cancel_order('%s','%s','salah')$q$,k,o1))='FORBIDDEN');
end $$;

-- ===== CASHIER
do $$
declare
  o1 uuid := (select id from orders where queue_number='001');
  o2 uuid := (select id from orders where queue_number='002');
  o3 uuid := (select id from orders where queue_number='003');
  c text := t_tk('cashier'); k text := t_tk('kitchen'); a text := t_tk('admin'); r jsonb;
begin
  perform t_check('P19 search by queue "1"', jsonb_array_length(list_cashier_orders(c,'1','all'))>=1 and (list_cashier_orders(c,'001')->0->>'queue_number')='001');
  perform t_check('P19 search by name', (list_cashier_orders(c,'kichiro')->0->>'customer_name')='Kichiro');
  perform t_check('P19 search by class', (list_cashier_orders(c,'8.1')->0->>'customer_class')='8.1');
  perform t_check('P search w/ % is literal', jsonb_array_length(list_cashier_orders(c,'%'))=0);
  perform t_check('P cancelled hidden from cashier list', (select count(*) from jsonb_array_elements(list_cashier_orders(c)) x where x->>'queue_number'='002')=0);
  perform t_check('P22 kitchen cannot mark paid', t_err(format($q$select mark_order_paid('%s','%s')$q$,k,o1))='FORBIDDEN');
  perform t_check('P23 anon (no token) cannot mark paid', t_err(format($q$select mark_order_paid(null,'%s')$q$,o1))='SESSION_INVALID');
  perform t_check('P cancelled cannot be paid', t_err(format($q$select mark_order_paid('%s','%s')$q$,c,o2))='ORDER_CANCELLED');
  r := mark_order_paid(c,o1);
  perform t_check('P20 mark paid', r->'order'->>'payment_status'='paid' and (r->>'changed')::boolean and r->'order'->>'paid_by_role'='cashier');
  r := mark_order_paid(c,o1);
  perform t_check('P21 double click: no 2nd record', not (r->>'changed')::boolean and (select count(*) from payment_records where order_id=o1)=1);
  perform t_check('P filter lunas', (select count(*) from jsonb_array_elements(list_cashier_orders(c,null,'paid')) x)=1);
  perform t_check('P filter belum lunas', (select count(*) from jsonb_array_elements(list_cashier_orders(c,null,'unpaid')) x)=1);
  perform t_check('P paid order cannot be cancelled', t_err(format($q$select cancel_order('%s','%s','x salah')$q$,a,o1))='ORDER_PAID_REVERSE_FIRST');
  perform t_check('A35 cashier cannot reverse', t_err(format($q$select reverse_order_payment('%s','%s','catatan')$q$,c,o1))='FORBIDDEN');
  perform t_check('A35 cashier cannot see finance', t_err(format($q$select get_financial_report('%s')$q$,c))='FORBIDDEN');
  perform t_check('A35 cashier cannot edit product', t_err(format($q$select admin_save_product('%s',null,'X','snack',1,true)$q$,c))='FORBIDDEN');
  perform t_check('A35 cashier cannot start/close event', t_err(format($q$select close_current_event('%s',true)$q$,c))='FORBIDDEN');
  perform t_check('A34 kitchen cannot read cashier list', t_err(format($q$select list_cashier_orders('%s')$q$,k))='FORBIDDEN');
  perform t_check('A34 cashier cannot change production', t_err(format($q$select update_production_status('%s','%s','processing')$q$,c,o1))='FORBIDDEN');
  perform t_check('A34 cashier cannot read kitchen list', t_err(format($q$select list_kitchen_orders('%s')$q$,c))='FORBIDDEN');
  perform t_check('A33 garbage token', t_err($q$select list_kitchen_orders('abcdefghijklmnopqrstuvwxyz0123456789abcdef')$q$)='SESSION_INVALID');
  perform t_check('A33 null token', t_err($q$select list_kitchen_orders(null)$q$)='SESSION_INVALID');
  -- cashier cancels order 3 (unpaid, waiting)
end $$;

-- ===== ADMIN: finance, reversal
do $$
declare
  o1 uuid := (select id from orders where queue_number='001');
  a text := t_tk('admin'); c text := t_tk('cashier'); r jsonb; f jsonb;
begin
  f := get_financial_report(a);
  perform t_check('F reconciled: paid 20000 / debt 5000 / rev 25000', (f->'reconciliation'->>'reconciled')::boolean and (f->'totals'->>'paid_total')::int=20000
    and (f->'totals'->>'debt_total')::int=5000 and (f->'totals'->>'active_revenue')::int=25000, (f->'totals')::text);
  perform t_check('F27 cancelled excluded from revenue, listed separately', (f->'totals'->>'cancelled_orders')::int=1 and (f->'totals'->>'cancelled_value')::int=18000 and jsonb_array_length(f->'cancelled')=1);
  perform t_check('F items sold = 4 (3 Teh + 1... ) ', (f->'totals'->>'items_sold')::int=4, f->'totals'->>'items_sold');
  perform t_check('R reversal requires note', t_err(format($q$select reverse_order_payment('%s','%s','')$q$,a,o1))='NOTE_REQUIRED');
  r := reverse_order_payment(a,o1,'Salah input nominal');
  perform t_check('R24 reversal -> unpaid', r->'order'->>'payment_status'='unpaid' and r->'order'->>'paid_at' is null);
  perform t_check('R25 original payment row preserved + reversal row added', (select count(*) from payment_records where order_id=o1 and record_type='payment')=1 and (select count(*) from payment_records where order_id=o1 and record_type='reversal')=1);
  perform t_check('R ledger immutable (update)', t_err($q$update payment_records set amount=1$q$)='IMMUTABLE_RECORD');
  perform t_check('R ledger immutable (delete)', t_err($q$delete from payment_records$q$)='IMMUTABLE_RECORD');
  perform t_check('R reverse unpaid rejected', t_err(format($q$select reverse_order_payment('%s','%s','catatan')$q$,a,o1))='ORDER_NOT_PAID');
  f := get_financial_report(a);
  perform t_check('R26 still reconciled after reversal', (f->'reconciliation'->>'reconciled')::boolean and (f->'totals'->>'paid_total')::int=0 and (f->'totals'->>'debt_total')::int=25000, (f->'totals')::text);
  perform mark_order_paid(c,o1);  -- pay again after reversal
  perform t_check('R pay again after reversal ok (3 ledger rows)', (select count(*) from payment_records where order_id=o1)=3);
  f := get_financial_report(a);
  perform t_check('R reconciled after re-pay', (f->'reconciliation'->>'reconciled')::boolean and (f->'totals'->>'paid_total')::int=20000);
  -- tamper to prove ADA SELISIH detection (superuser bypass of triggers)
  alter table payment_records disable trigger payment_records_immutable;
  delete from payment_records where order_id=o1 and record_type='reversal';
  alter table payment_records enable trigger payment_records_immutable;
  f := get_financial_report(a);
  perform t_check('F detects ledger tampering (not reconciled, issue listed)', not (f->'reconciliation'->>'reconciled')::boolean and jsonb_array_length(f->'reconciliation'->'issues')=1, (f->'reconciliation')::text);
end $$;
select ok, count(*) from t_res group by ok;
select n||' FAIL '||name||' :: '||coalesce(info,'') from t_res where not ok order by n;

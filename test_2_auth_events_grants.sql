\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
-- ===== SESSIONS / AUTH
do $$
declare a text := t_tk('admin'); k text := t_tk('kitchen'); r jsonb; tok text;
begin
  perform t_check('A validate session', staff_validate(a)->>'role'='admin');
  -- expiry
  update osis_sessions set expires_at = now() - interval '1 minute' where role='kitchen';
  perform t_check('A expired session rejected', t_err(format($q$select list_kitchen_orders('%s')$q$,k))='SESSION_EXPIRED');
  r := staff_login('kitchen','kitchen-pass-1'); tok := r->>'token';
  perform t_check('A relogin works, 12h expiry', (r->>'expires_at')::timestamptz > now()+interval '11 hours 59 minutes' and (r->>'expires_at')::timestamptz <= now()+interval '12 hours');
  perform t_check('A token not stored in plaintext', (select count(*) from osis_sessions where session_token_hash = tok)=0 and (select count(*) from osis_sessions where session_token_hash = encode(extensions.digest(tok,'sha256'),'hex'))=1);
  perform staff_logout(tok);
  perform t_check('A logout invalidates', t_err(format($q$select list_kitchen_orders('%s')$q$,tok))='SESSION_INVALID');
  perform t_check('A passcode stored as bcrypt', (select passcode_hash like '$2a$%' or passcode_hash like '$2b$%' from osis_auth where role='admin'));
  -- passcode change rules
  r := staff_login('kitchen','kitchen-pass-1'); tok := r->>'token';
  perform t_check('A kitchen cannot change admin passcode', t_err(format($q$select change_passcode('%s','admin','x','newpass-123')$q$,tok))='FORBIDDEN');
  perform t_check('A self-change needs correct current', t_err(format($q$select change_passcode('%s','kitchen','salah','newpass-123')$q$,tok))='INVALID_CURRENT_PASSCODE');
  perform t_check('A short passcode rejected', t_err(format($q$select change_passcode('%s','kitchen','kitchen-pass-1','123')$q$,tok))='PASSCODE_INVALID');
  perform change_passcode(a,'kitchen',null,'kitchen-pass-2');   -- admin reset
  perform t_check('A admin reset revokes kitchen sessions', t_err(format($q$select list_kitchen_orders('%s')$q$,tok))='SESSION_INVALID');
  perform t_check('A admin reset: new passcode works', (staff_login('kitchen','kitchen-pass-2')->>'ok')::boolean);
  perform t_check('A admin own session survives', staff_validate(a)->>'role'='admin');
  -- throttle
  for i in 1..8 loop perform staff_login('cashier','wrong'); end loop;
  perform t_check('A throttle after 8 fails', staff_login('cashier','cashier-pass-1')->>'error'='TOO_MANY_ATTEMPTS');
  delete from osis_login_attempts;
  perform t_check('A login ok after throttle cleared', (staff_login('cashier','cashier-pass-1')->>'ok')::boolean);
  perform t_check('A invalid role rejected', staff_login('god','x')->>'error'='INVALID_CREDENTIALS');
end $$;

-- ===== EVENTS
do $$
declare
  a text := t_tk('admin'); k text := (staff_login('kitchen','kitchen-pass-2'))->>'token';
  c text := (staff_login('cashier','cashier-pass-1'))->>'token';
  teh uuid := (select id from products where name='Es Teh');
  ev1 uuid := (select id from events where status='active');
  r jsonb; ev2 jsonb; hist jsonb; o uuid; before_rev jsonb;
begin
  -- new order 003 exists in waiting from earlier test
  perform t_check('E setup: 1 order still waiting', (select count(*) from orders where production_status='waiting')=1);
  perform t_check('E32 close blocked while orders active', t_err(format($q$select close_current_event('%s')$q$,a))='ORDERS_STILL_ACTIVE');
  perform t_check('E start while active rejected', t_err(format($q$select start_new_event('%s','Baru')$q$,a))='EVENT_ALREADY_ACTIVE');
  perform t_check('E cashier cannot close', t_err(format($q$select close_current_event('%s',true)$q$,c))='FORBIDDEN');
  before_rev := get_financial_report(a)->'totals';
  r := close_current_event(a, true);
  perform t_check('E32 force close works, reports forced count', r->>'status'='completed' and (r->>'forced_open_orders')::int=1);
  perform t_check('E no active event -> customer error', t_err(format($q$select create_customer_order('key-eeeeeeee1','A','1','[{"product_id":"%s","quantity":1}]'::jsonb)$q$,teh))='NO_ACTIVE_EVENT');
  perform t_check('E get_active_event null when none', get_active_event() is null);
  perform t_check('E staff mutations blocked on closed event', t_err(format($q$select mark_order_paid('%s','%s')$q$,c,(select id from orders where queue_number='003' and event_id=ev1)))='EVENT_CLOSED');
  perform t_check('E kitchen list empty when no event', list_kitchen_orders(k)='[]'::jsonb);
  ev2 := start_new_event(a, 'Pentas Seni 2026');
  perform t_check('E30 new event active', ev2->>'status'='active' and get_active_event()->>'name'='Pentas Seni 2026');
  r := create_customer_order('key-ffffffff1','Dina','9.1', jsonb_build_array(jsonb_build_object('product_id',teh,'quantity',1)));
  perform t_check('E30 queue resets to 001', r->'order'->>'queue_number'='001', r->'order'->>'queue_number');
  r := create_customer_order('key-ffffffff2','Eka','9.2', jsonb_build_array(jsonb_build_object('product_id',teh,'quantity',1)));
  perform t_check('E queue 002 in new event', r->'order'->>'queue_number'='002');
  perform t_check('E31 old event orders intact', (select count(*) from orders where event_id=ev1)=3 and (select current_queue_seq from events where id=ev1)=3);
  perform t_check('E31 old event totals unchanged', get_financial_report(a, ev1)->'totals' = before_rev);
  perform t_check('E31 kitchen only sees new event orders', jsonb_array_length(list_kitchen_orders(k))=2);
  hist := list_events(a);
  perform t_check('E17 history lists both events', jsonb_array_length(hist)=2 and hist->0->'event'->>'name'='Pentas Seni 2026', hist::text);
  perform t_check('E duplicate queue seq impossible (constraint)', t_err(format($q$insert into orders(event_id,queue_number,queue_seq,customer_name,customer_class,total_amount) values ('%s','002',2,'x','y',0)$q$,(ev2->>'id')::uuid)) like '%orders_event_queue_unique%');
  perform t_check('E two active events impossible (constraint)', t_err($q$insert into events(name,status) values ('dup','active')$q$) like '%events_one_active%');
  perform t_check('E events cannot be deleted', t_err($q$delete from events$q$)='IMMUTABLE_RECORD');
  perform t_check('E archive completed event', archive_event(a, ev1)->>'status'='archived');
  perform t_check('E archive active event rejected', t_err(format($q$select archive_event('%s','%s')$q$,a,(ev2->>'id')::uuid))='EVENT_NOT_ARCHIVABLE');
  -- price change must not alter history
  perform admin_save_product(a,(select id from products where name='Es Teh'),'Es Teh Manis','minuman',8000,true);
  perform t_check('M28 snapshot keeps old name+price', (select product_name_snapshot||':'||unit_price_snapshot from order_items where order_id=(select id from orders where event_id=ev1 and queue_number='001') and product_name_snapshot like 'Es Teh%')='Es Teh:5000');
  r := create_customer_order('key-ffffffff3','Fani','9.3', jsonb_build_array(jsonb_build_object('product_id',teh,'quantity',2)));
  perform t_check('M28 new order uses new price 16000', (r->'order'->>'total_amount')::int=16000);
  perform t_check('M add product', admin_save_product(a,null,'Bakso','makanan',9000,true)->>'name'='Bakso');
  perform t_check('M invalid product rejected', t_err(format($q$select admin_save_product('%s',null,'','makanan',9000,true)$q$,a))='INVALID_PRODUCT');
  perform t_check('M negative price rejected', t_err(format($q$select admin_save_product('%s',null,'Z','makanan',-1,true)$q$,a))='INVALID_PRODUCT');
  perform t_check('M bad category rejected', t_err(format($q$select admin_save_product('%s',null,'Z','alien',100,true)$q$,a))='INVALID_PRODUCT');
end $$;

-- ===== ROLE-LEVEL ACCESS (what the browser's anon key can do)
create or replace function t_as_anon(q text) returns text language plpgsql as $$
begin set local role anon; execute q; reset role; return 'NO_ERROR';
exception when others then reset role; return sqlerrm; end $$;
select t_check('G36 anon cannot SELECT orders', t_as_anon('select * from orders') like 'permission denied%', t_as_anon('select * from orders'));
select t_check('G anon cannot SELECT payment_records', t_as_anon('select * from payment_records') like 'permission denied%');
select t_check('G anon cannot SELECT osis_auth', t_as_anon('select * from osis_auth') like 'permission denied%');
select t_check('G anon cannot SELECT osis_sessions', t_as_anon('select * from osis_sessions') like 'permission denied%');
select t_check('G anon cannot UPDATE products', t_as_anon('update products set price=1') like 'permission denied%');
select t_check('G anon cannot INSERT orders', t_as_anon($q$insert into orders(event_id,queue_number,queue_seq,customer_name,customer_class,total_amount) select id,'999',999,'x','y',0 from events limit 1$q$) like 'permission denied%');
select t_check('G anon cannot call _auth', t_as_anon($q$select _auth('x',array['admin'])$q$) like 'permission denied%');
select t_check('G anon cannot call _event_report', t_as_anon($q$select _event_report(gen_random_uuid())$q$) like 'permission denied%');
select t_check('G anon CAN call get_menu', t_as_anon('select get_menu()')='NO_ERROR');
select t_check('G anon CAN call get_active_event', t_as_anon('select get_active_event()')='NO_ERROR');
select t_check('G anon staff RPC w/o session -> SESSION_INVALID', t_as_anon($q$select mark_order_paid('zzzz',gen_random_uuid())$q$)='SESSION_INVALID');
select t_check('G anon CAN create order', t_as_anon(format($q$select create_customer_order('key-anon00001','Anon','1','[{"product_id":"%s","quantity":1}]'::jsonb)$q$,(select id from products where name like 'Es Teh%')))='NO_ERROR');
select t_check('G RLS enabled on all tables', (select bool_and(relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relkind='r' and relname !~ '^t_'));

select ok, count(*) from t_res group by ok;
select n||' FAIL '||name||' :: '||coalesce(info,'') from t_res where not ok order by n;

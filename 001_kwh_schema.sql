-- =====================================================================
-- KWh Queue & POS  —  Migration 001  (Phase 1: database, auth, RPCs)
-- Run once in a NEW Supabase project: SQL Editor -> paste -> Run.
--
-- Design rules:
--   * RLS is ON for every table and there are NO policies, and table
--     privileges are revoked from anon/authenticated. The browser can
--     therefore never read or write tables directly.
--   * Everything goes through SECURITY DEFINER functions (RPCs).
--   * Staff RPCs take a session token (p_token) and verify it server-side
--     on every call. Customer RPCs are public but validated.
--   * Errors are raised as short codes (message = e.g. 'NO_ACTIVE_EVENT');
--     the frontend maps these to Indonesian messages.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------

create table public.events (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (char_length(btrim(name)) between 1 and 100),
  status            text not null default 'active'
                      check (status in ('active','completed','archived')),
  current_queue_seq integer not null default 0 check (current_queue_seq >= 0),
  created_at        timestamptz not null default now(),
  ended_at          timestamptz
);
-- Only ONE active event at any time.
create unique index events_one_active on public.events ((true)) where status = 'active';

create table public.products (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  category   text not null check (category in ('makanan','minuman','snack','lainnya')),
  price      integer not null check (price >= 0),          -- integer Rupiah
  available  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.events(id),
  idempotency_key   text unique,
  queue_number      text not null,
  queue_seq         integer not null,
  customer_name     text not null,
  customer_class    text not null,
  order_type        text not null default 'walk-in' check (order_type in ('walk-in','pre-order')),
  total_amount      integer not null check (total_amount >= 0),
  payment_status    text not null default 'unpaid' check (payment_status in ('unpaid','paid')),
  production_status text not null default 'waiting'
                      check (production_status in ('waiting','processing','ready','completed','cancelled')),
  created_at        timestamptz not null default now(),
  paid_at           timestamptz,
  paid_by_role      text check (paid_by_role in ('cashier','admin')),
  cancelled_at      timestamptz,
  cancelled_by_role text check (cancelled_by_role in ('kitchen','cashier','admin')),
  cancel_reason     text,
  constraint orders_event_queue_unique unique (event_id, queue_seq),
  constraint orders_paid_consistent
    check (payment_status <> 'paid' or (paid_at is not null and paid_by_role is not null)),
  constraint orders_cancel_consistent
    check (production_status <> 'cancelled'
           or (cancelled_at is not null and cancelled_by_role is not null and cancel_reason is not null))
);
create index orders_event_prod_idx on public.orders (event_id, production_status);
create index orders_event_pay_idx  on public.orders (event_id, payment_status);

create table public.order_items (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references public.orders(id),
  product_id            uuid references public.products(id),
  product_name_snapshot text not null,
  unit_price_snapshot   integer not null check (unit_price_snapshot >= 0),
  quantity              integer not null check (quantity > 0),
  subtotal              integer not null check (subtotal >= 0),
  constraint order_items_subtotal_ok check (subtotal = unit_price_snapshot * quantity)
);
create index order_items_order_idx on public.order_items (order_id);

-- Immutable audit ledger. A reversal is a NEW row; amounts are positive,
-- record_type says which direction. Net paid = payments - reversals.
create table public.payment_records (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders(id),
  record_type      text not null check (record_type in ('payment','reversal')),
  amount           integer not null check (amount >= 0),
  recorded_by_role text not null check (recorded_by_role in ('cashier','admin')),
  note             text,
  created_at       timestamptz not null default now()
);
create index payment_records_order_idx on public.payment_records (order_id);

create table public.osis_auth (
  role          text primary key check (role in ('cashier','kitchen','admin')),
  passcode_hash text not null,                       -- bcrypt
  must_change   boolean not null default true,       -- forces change of seeded passcodes
  updated_at    timestamptz not null default now()
);

create table public.osis_sessions (
  id                 uuid primary key default gen_random_uuid(),
  role               text not null check (role in ('cashier','kitchen','admin')),
  session_token_hash text not null unique,           -- sha256 of the token; token itself is never stored
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now()
);
create index osis_sessions_expires_idx on public.osis_sessions (expires_at);

create table public.osis_login_attempts (            -- failed logins only (throttling)
  id           bigint generated always as identity primary key,
  role         text not null,
  attempted_at timestamptz not null default now()
);
create index osis_login_attempts_idx on public.osis_login_attempts (role, attempted_at);

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY: on, with no policies  =>  clients see nothing.
-- ---------------------------------------------------------------------
alter table public.events              enable row level security;
alter table public.products            enable row level security;
alter table public.orders              enable row level security;
alter table public.order_items         enable row level security;
alter table public.payment_records     enable row level security;
alter table public.osis_auth           enable row level security;
alter table public.osis_sessions       enable row level security;
alter table public.osis_login_attempts enable row level security;

-- ---------------------------------------------------------------------
-- INTEGRITY TRIGGERS
-- ---------------------------------------------------------------------
create or replace function public._block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE_RECORD' using errcode = 'P0001';
end $$;

create trigger payment_records_immutable before update or delete on public.payment_records
  for each row execute function public._block_mutation();
create trigger order_items_immutable before update or delete on public.order_items
  for each row execute function public._block_mutation();
create trigger orders_no_delete before delete on public.orders
  for each row execute function public._block_mutation();
create trigger events_no_delete before delete on public.events
  for each row execute function public._block_mutation();

-- Identity/amount columns of an order can never change after creation
-- (so cancelling can never zero out or rewrite the original total).
create or replace function public._orders_protect() returns trigger
language plpgsql as $$
begin
  if new.id              is distinct from old.id
  or new.event_id        is distinct from old.event_id
  or new.queue_number    is distinct from old.queue_number
  or new.queue_seq       is distinct from old.queue_seq
  or new.customer_name   is distinct from old.customer_name
  or new.customer_class  is distinct from old.customer_class
  or new.total_amount    is distinct from old.total_amount
  or new.idempotency_key is distinct from old.idempotency_key
  or new.created_at      is distinct from old.created_at then
    raise exception 'IMMUTABLE_RECORD' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger orders_protect before update on public.orders
  for each row execute function public._orders_protect();

-- ---------------------------------------------------------------------
-- INTERNAL HELPERS (not callable by clients)
-- ---------------------------------------------------------------------

-- Validates a staff session token and (optionally) the role. Returns the role.
create or replace function public._auth(
  p_token text, p_roles text[], p_allow_must_change boolean default false)
returns text
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_role text; v_exp timestamptz; v_must boolean;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'SESSION_INVALID' using errcode = 'P0001';
  end if;
  select s.role, s.expires_at into v_role, v_exp
    from public.osis_sessions s
   where s.session_token_hash = encode(digest(p_token, 'sha256'), 'hex');
  if v_role is null then
    raise exception 'SESSION_INVALID' using errcode = 'P0001';
  end if;
  if v_exp <= now() then
    raise exception 'SESSION_EXPIRED' using errcode = 'P0001';
  end if;
  select a.must_change into v_must from public.osis_auth a where a.role = v_role;
  if coalesce(v_must, false) and not p_allow_must_change then
    raise exception 'PASSCODE_CHANGE_REQUIRED' using errcode = 'P0001';
  end if;
  if not (v_role = any (p_roles)) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  return v_role;
end $$;

create or replace function public._order_json(o public.orders) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', o.id, 'event_id', o.event_id,
    'queue_number', o.queue_number, 'queue_seq', o.queue_seq,
    'customer_name', o.customer_name, 'customer_class', o.customer_class,
    'order_type', o.order_type, 'total_amount', o.total_amount,
    'payment_status', o.payment_status, 'production_status', o.production_status,
    'created_at', o.created_at, 'paid_at', o.paid_at, 'paid_by_role', o.paid_by_role,
    'cancelled_at', o.cancelled_at, 'cancelled_by_role', o.cancelled_by_role,
    'cancel_reason', o.cancel_reason,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_name', i.product_name_snapshot, 'unit_price', i.unit_price_snapshot,
               'quantity', i.quantity, 'subtotal', i.subtotal)
             order by i.product_name_snapshot)
        from public.order_items i where i.order_id = o.id), '[]'::jsonb));
$$;

-- What a customer is allowed to see of an order.
create or replace function public._customer_view(o public.orders) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select public._order_json(o)
         - 'event_id' - 'paid_by_role' - 'paid_at'
         - 'cancelled_by_role' - 'cancel_reason' - 'cancelled_at';
$$;

create or replace function public._order_result(p_changed boolean, o public.orders) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('changed', p_changed, 'order', public._order_json(o));
$$;

create or replace function public._require_active_event(p_event_id uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.events where id = p_event_id and status = 'active') then
    raise exception 'EVENT_CLOSED' using errcode = 'P0001';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- STAFF AUTH RPCs
-- ---------------------------------------------------------------------

-- Returns {ok:false,error} for bad credentials (so the failed attempt is
-- persisted for throttling); never raises for credential problems.
create or replace function public.staff_login(p_role text, p_passcode text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_hash text; v_must boolean; v_fail int; v_token text; v_exp timestamptz;
begin
  if p_role is null or p_role not in ('cashier','kitchen','admin') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_CREDENTIALS');
  end if;

  select count(*) into v_fail from public.osis_login_attempts
   where role = p_role and attempted_at > now() - interval '10 minutes';
  if v_fail >= 8 then
    return jsonb_build_object('ok', false, 'error', 'TOO_MANY_ATTEMPTS');
  end if;

  select passcode_hash, must_change into v_hash, v_must from public.osis_auth where role = p_role;
  if v_hash is null or crypt(coalesce(p_passcode, ''), v_hash) <> v_hash then
    insert into public.osis_login_attempts(role) values (p_role);
    return jsonb_build_object('ok', false, 'error', 'INVALID_CREDENTIALS');
  end if;

  delete from public.osis_login_attempts where role = p_role;
  delete from public.osis_sessions where expires_at <= now();

  v_token := encode(gen_random_bytes(32), 'hex');
  v_exp   := now() + interval '12 hours';
  insert into public.osis_sessions(role, session_token_hash, expires_at)
  values (p_role, encode(digest(v_token, 'sha256'), 'hex'), v_exp);

  return jsonb_build_object('ok', true, 'token', v_token, 'role', p_role,
                            'expires_at', v_exp, 'must_change', v_must);
end $$;

create or replace function public.staff_logout(p_token text) returns boolean
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if p_token is not null then
    delete from public.osis_sessions
     where session_token_hash = encode(digest(p_token, 'sha256'), 'hex');
  end if;
  return true;
end $$;

create or replace function public.staff_validate(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; v_exp timestamptz; v_must boolean;
begin
  v_role := public._auth(p_token, array['cashier','kitchen','admin'], true);
  select expires_at into v_exp from public.osis_sessions
   where session_token_hash = encode(digest(p_token, 'sha256'), 'hex');
  select must_change into v_must from public.osis_auth where role = v_role;
  return jsonb_build_object('role', v_role, 'expires_at', v_exp, 'must_change', v_must);
end $$;

-- Self-change requires the current passcode. Admin may reset any role's
-- passcode without it. Other sessions of the changed role are revoked.
create or replace function public.change_passcode(
  p_token text, p_target_role text, p_current text, p_new text) returns boolean
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_role text; v_hash text; v_self text;
begin
  v_role := public._auth(p_token, array['cashier','kitchen','admin'], true);
  if p_target_role is null or p_target_role not in ('cashier','kitchen','admin') then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001';
  end if;
  if v_role <> 'admin' and p_target_role <> v_role then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;
  if p_new is null or char_length(p_new) < 6 or char_length(p_new) > 72 then
    raise exception 'PASSCODE_INVALID' using errcode = 'P0001';
  end if;

  if p_target_role = v_role then
    select passcode_hash into v_hash from public.osis_auth where role = v_role;
    if crypt(coalesce(p_current, ''), v_hash) <> v_hash then
      raise exception 'INVALID_CURRENT_PASSCODE' using errcode = 'P0001';
    end if;
    if p_new = p_current then
      raise exception 'PASSCODE_SAME' using errcode = 'P0001';
    end if;
  end if;

  update public.osis_auth
     set passcode_hash = crypt(p_new, gen_salt('bf', 10)), must_change = false, updated_at = now()
   where role = p_target_role;

  v_self := encode(digest(p_token, 'sha256'), 'hex');
  delete from public.osis_sessions
   where role = p_target_role and session_token_hash <> v_self;
  return true;
end $$;

-- ---------------------------------------------------------------------
-- PUBLIC READ RPCs
-- ---------------------------------------------------------------------

create or replace function public.get_active_event() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', e.id, 'name', e.name, 'status', e.status)
    from public.events e where e.status = 'active';
$$;

create or replace function public.get_menu() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'name', p.name, 'category', p.category,
           'price', p.price, 'available', p.available)
         order by case p.category when 'makanan' then 1 when 'minuman' then 2
                                  when 'snack' then 3 else 4 end, p.name), '[]'::jsonb)
    from public.products p;
$$;

-- ---------------------------------------------------------------------
-- CUSTOMER ORDER CREATION  (server is authoritative for everything)
-- ---------------------------------------------------------------------
create or replace function public.create_customer_order(
  p_idempotency_key text, p_customer_name text, p_customer_class text, p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_key   text := btrim(coalesce(p_idempotency_key, ''));
  v_name  text := btrim(coalesce(p_customer_name, ''));
  v_class text := btrim(coalesce(p_customer_class, ''));
  v_event public.events;
  v_order public.orders;
  v_seq   int;
  v_total bigint := 0;
  v_cnt   int := 0;
  v_expected int;
  e jsonb;
  r record;
begin
  if char_length(v_key) < 8 or char_length(v_key) > 100 then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001';
  end if;

  -- 1. Idempotency: same key => return the original order.
  select * into v_order from public.orders where idempotency_key = v_key;
  if found then
    return jsonb_build_object('replayed', true,
      'event_name', (select name from public.events where id = v_order.event_id),
      'order', public._customer_view(v_order));
  end if;

  -- Input validation (before taking any lock).
  if char_length(v_name) < 1 or char_length(v_name) > 60 then
    raise exception 'INVALID_CUSTOMER_NAME' using errcode = 'P0001';
  end if;
  if char_length(v_class) < 1 or char_length(v_class) > 20 then
    raise exception 'INVALID_CUSTOMER_CLASS' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'INVALID_ITEMS' using errcode = 'P0001';
  end if;
  for e in select x from jsonb_array_elements(p_items) x loop
    if jsonb_typeof(e) <> 'object' then
      raise exception 'INVALID_ITEMS' using errcode = 'P0001';
    end if;
    if coalesce(e->>'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'INVALID_ITEMS' using errcode = 'P0001';
    end if;
    if coalesce(e->>'quantity', '') !~ '^[0-9]{1,3}$' then
      raise exception 'INVALID_QUANTITY' using errcode = 'P0001';
    end if;
    if (e->>'quantity')::int < 1 or (e->>'quantity')::int > 99 then
      raise exception 'INVALID_QUANTITY' using errcode = 'P0001';
    end if;
  end loop;

  -- 2. Active event, locked: serialises queue-number allocation.
  select * into v_event from public.events where status = 'active' for update;
  if not found then
    raise exception 'NO_ACTIVE_EVENT' using errcode = 'P0001';
  end if;

  -- Re-check idempotency now that we hold the lock (closes the concurrent-retry race).
  select * into v_order from public.orders where idempotency_key = v_key;
  if found then
    return jsonb_build_object('replayed', true, 'event_name', v_event.name,
                              'order', public._customer_view(v_order));
  end if;

  -- 3. Validate products and price them from the database.
  select count(*) into v_expected from (
    select 1 from jsonb_array_elements(p_items) x group by (x->>'product_id')::uuid) s;

  for r in
    select p.id, p.name, p.price, p.available, a.qty
      from (select (x->>'product_id')::uuid as pid, sum((x->>'quantity')::int) as qty
              from jsonb_array_elements(p_items) x group by 1) a
      join public.products p on p.id = a.pid
       for share of p
  loop
    v_cnt := v_cnt + 1;
    if not r.available then
      raise exception 'PRODUCT_UNAVAILABLE' using errcode = 'P0001', detail = r.name;
    end if;
    if r.qty > 99 then
      raise exception 'INVALID_QUANTITY' using errcode = 'P0001';
    end if;
    v_total := v_total + r.qty::bigint * r.price;
  end loop;
  if v_cnt <> v_expected then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_total > 2000000000 then
    raise exception 'INVALID_ITEMS' using errcode = 'P0001';
  end if;

  -- 4. Allocate queue number atomically, create order + snapshot items.
  update public.events set current_queue_seq = current_queue_seq + 1
   where id = v_event.id returning current_queue_seq into v_seq;

  insert into public.orders(event_id, idempotency_key, queue_number, queue_seq,
                            customer_name, customer_class, total_amount)
  values (v_event.id, v_key, lpad(v_seq::text, 3, '0'), v_seq, v_name, v_class, v_total::int)
  returning * into v_order;

  insert into public.order_items(order_id, product_id, product_name_snapshot,
                                 unit_price_snapshot, quantity, subtotal)
  select v_order.id, p.id, p.name, p.price, a.qty, a.qty * p.price
    from (select (x->>'product_id')::uuid as pid, sum((x->>'quantity')::int)::int as qty
            from jsonb_array_elements(p_items) x group by 1) a
    join public.products p on p.id = a.pid;

  return jsonb_build_object('replayed', false, 'event_name', v_event.name,
                            'order', public._customer_view(v_order));
end $$;

-- ---------------------------------------------------------------------
-- KITCHEN
-- ---------------------------------------------------------------------

create or replace function public.list_kitchen_orders(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text;
begin
  v_role := public._auth(p_token, array['kitchen','admin']);
  return coalesce((
    select jsonb_agg(public._order_json(o)
                     - 'payment_status' - 'total_amount' - 'paid_at' - 'paid_by_role'
                     order by o.queue_seq)
      from public.orders o
      join public.events e on e.id = o.event_id and e.status = 'active'
     where o.production_status in ('waiting','processing','ready')), '[]'::jsonb);
end $$;

create or replace function public.update_production_status(
  p_token text, p_order_id uuid, p_new_status text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; o public.orders;
begin
  v_role := public._auth(p_token, array['kitchen','admin']);
  if p_new_status is null or p_new_status not in ('processing','ready','completed') then
    raise exception 'INVALID_STATUS' using errcode = 'P0001';
  end if;

  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001'; end if;
  perform public._require_active_event(o.event_id);

  if o.production_status = 'cancelled' then
    raise exception 'ORDER_CANCELLED' using errcode = 'P0001';
  end if;
  if o.production_status = p_new_status then
    return public._order_result(false, o);              -- double-click safe
  end if;
  if not ((o.production_status = 'waiting'    and p_new_status = 'processing')
       or (o.production_status = 'processing' and p_new_status = 'ready')
       or (o.production_status = 'ready'      and p_new_status = 'completed')) then
    raise exception 'INVALID_TRANSITION' using errcode = 'P0001';
  end if;

  update public.orders set production_status = p_new_status where id = o.id returning * into o;
  return public._order_result(true, o);
end $$;

create or replace function public.get_production_summary(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text;
begin
  v_role := public._auth(p_token, array['kitchen','admin']);
  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('product_name', t.name, 'quantity', t.qty)
                       order by t.qty desc, t.name)
        from (select i.product_name_snapshot as name, sum(i.quantity)::int as qty
                from public.order_items i
                join public.orders o on o.id = i.order_id
                join public.events e on e.id = o.event_id and e.status = 'active'
               where o.production_status in ('waiting','processing','ready')
               group by i.product_name_snapshot) t), '[]'::jsonb),
    'order_count', (select count(*) from public.orders o
                      join public.events e on e.id = o.event_id and e.status = 'active'
                     where o.production_status in ('waiting','processing','ready')));
end $$;

-- ---------------------------------------------------------------------
-- CANCELLATION
--   kitchen: waiting/processing only | cashier: waiting/processing/ready
--   admin: anything not already cancelled. A PAID order must be reversed first.
-- ---------------------------------------------------------------------
create or replace function public.cancel_order(
  p_token text, p_order_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; o public.orders; v_reason text := btrim(coalesce(p_reason, ''));
begin
  v_role := public._auth(p_token, array['kitchen','cashier','admin']);
  if char_length(v_reason) < 3 or char_length(v_reason) > 200 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;

  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001'; end if;
  if o.production_status = 'cancelled' then
    return public._order_result(false, o);
  end if;
  if v_role <> 'admin' then
    perform public._require_active_event(o.event_id);
  end if;
  if o.payment_status = 'paid' then
    raise exception 'ORDER_PAID_REVERSE_FIRST' using errcode = 'P0001';
  end if;
  if (v_role = 'kitchen' and o.production_status not in ('waiting','processing'))
  or (v_role = 'cashier' and o.production_status not in ('waiting','processing','ready')) then
    raise exception 'FORBIDDEN' using errcode = 'P0001';
  end if;

  update public.orders
     set production_status = 'cancelled', cancelled_at = now(),
         cancelled_by_role = v_role, cancel_reason = v_reason
   where id = o.id returning * into o;
  return public._order_result(true, o);
end $$;

-- ---------------------------------------------------------------------
-- CASHIER
-- ---------------------------------------------------------------------

create or replace function public.list_cashier_orders(
  p_token text, p_search text default null, p_filter text default 'all') returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; v_q text := lower(btrim(coalesce(p_search, '')));
begin
  v_role := public._auth(p_token, array['cashier','admin']);
  if p_filter is null or p_filter not in ('all','unpaid','paid') then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(public._order_json(o) order by o.queue_seq desc)
      from (select o2.* from public.orders o2
              join public.events e on e.id = o2.event_id and e.status = 'active'
             where o2.production_status <> 'cancelled'
               and (p_filter = 'all' or o2.payment_status = p_filter)
               and (v_q = ''
                    or position(v_q in lower(o2.customer_name))  > 0
                    or position(v_q in lower(o2.customer_class)) > 0
                    or position(v_q in o2.queue_number) > 0
                    or (case when v_q ~ '^[0-9]{1,6}$' then o2.queue_seq = v_q::int else false end))
             order by o2.queue_seq desc
             limit 200) o), '[]'::jsonb);
end $$;

create or replace function public.mark_order_paid(p_token text, p_order_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; o public.orders;
begin
  v_role := public._auth(p_token, array['cashier','admin']);
  select * into o from public.orders where id = p_order_id for update;   -- row lock
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001'; end if;
  perform public._require_active_event(o.event_id);
  if o.production_status = 'cancelled' then
    raise exception 'ORDER_CANCELLED' using errcode = 'P0001';
  end if;
  if o.payment_status = 'paid' then
    return public._order_result(false, o);              -- already paid: do nothing
  end if;

  insert into public.payment_records(order_id, record_type, amount, recorded_by_role)
  values (o.id, 'payment', o.total_amount, v_role);
  update public.orders
     set payment_status = 'paid', paid_at = now(), paid_by_role = v_role
   where id = o.id returning * into o;
  return public._order_result(true, o);
end $$;

-- ADMIN ONLY. Adds a 'reversal' ledger row; never touches the original payment row.
create or replace function public.reverse_order_payment(
  p_token text, p_order_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; o public.orders; v_note text := btrim(coalesce(p_note, ''));
begin
  v_role := public._auth(p_token, array['admin']);
  if char_length(v_note) < 3 or char_length(v_note) > 300 then
    raise exception 'NOTE_REQUIRED' using errcode = 'P0001';
  end if;
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001'; end if;
  if o.payment_status <> 'paid' then
    raise exception 'ORDER_NOT_PAID' using errcode = 'P0001';
  end if;

  insert into public.payment_records(order_id, record_type, amount, recorded_by_role, note)
  values (o.id, 'reversal', o.total_amount, v_role, v_note);
  update public.orders
     set payment_status = 'unpaid', paid_at = null, paid_by_role = null
   where id = o.id returning * into o;
  return public._order_result(true, o);
end $$;

-- ---------------------------------------------------------------------
-- FINANCIAL REPORT (per event) — revenue comes from ORDERS, then is
-- cross-checked against order_items and the payment ledger (net of reversals).
-- ---------------------------------------------------------------------
create or replace function public._event_report(p_event_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  ev public.events; t record; v_items_sold int; v_items_total bigint; v_ledger_live bigint;
  v_issues jsonb; v_products jsonb; v_cancelled jsonb; v_reconciled boolean;
begin
  select * into ev from public.events where id = p_event_id;
  if not found then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0001'; end if;

  select
    count(*) filter (where production_status <> 'cancelled')                                   as active_orders,
    coalesce(sum(total_amount) filter (where production_status <> 'cancelled'), 0)             as active_revenue,
    coalesce(sum(total_amount) filter (where production_status <> 'cancelled' and payment_status = 'paid'), 0)   as paid_total,
    coalesce(sum(total_amount) filter (where production_status <> 'cancelled' and payment_status = 'unpaid'), 0) as debt_total,
    count(*) filter (where production_status <> 'cancelled' and payment_status = 'paid')       as orders_paid,
    count(*) filter (where production_status <> 'cancelled' and payment_status = 'unpaid')     as orders_unpaid,
    count(*) filter (where production_status = 'cancelled')                                    as cancelled_orders,
    coalesce(sum(total_amount) filter (where production_status = 'cancelled'), 0)             as cancelled_value
  into t from public.orders where event_id = p_event_id;

  select coalesce(sum(i.quantity), 0), coalesce(sum(i.subtotal), 0)
    into v_items_sold, v_items_total
    from public.order_items i join public.orders o on o.id = i.order_id
   where o.event_id = p_event_id and o.production_status <> 'cancelled';

  select coalesce(sum(case when pr.record_type = 'payment' then pr.amount else -pr.amount end), 0)
    into v_ledger_live
    from public.payment_records pr join public.orders o on o.id = pr.order_id
   where o.event_id = p_event_id and o.production_status <> 'cancelled';

  select jsonb_agg(to_jsonb(x) order by x.queue_number) into v_issues from (
    select q.queue_number, q.production_status, q.payment_status, q.total_amount, q.items_sum, q.ledger_net,
           case when q.items_sum <> q.total_amount then 'ITEMS_TOTAL_MISMATCH'
                else 'LEDGER_MISMATCH' end as issue
      from (select o.queue_number, o.queue_seq, o.production_status, o.payment_status, o.total_amount,
                   coalesce((select sum(subtotal) from public.order_items where order_id = o.id), 0) as items_sum,
                   coalesce((select sum(case when record_type = 'payment' then amount else -amount end)
                               from public.payment_records where order_id = o.id), 0) as ledger_net
              from public.orders o where o.event_id = p_event_id) q
     where q.items_sum <> q.total_amount
        or q.ledger_net <> case when q.payment_status = 'paid' then q.total_amount else 0 end
     order by q.queue_seq limit 50) x;

  select jsonb_agg(jsonb_build_object('product_name', p.name, 'quantity', p.qty, 'revenue', p.rev)
                   order by p.qty desc, p.name) into v_products
    from (select i.product_name_snapshot as name, sum(i.quantity)::int as qty, sum(i.subtotal)::bigint as rev
            from public.order_items i join public.orders o on o.id = i.order_id
           where o.event_id = p_event_id and o.production_status <> 'cancelled'
           group by i.product_name_snapshot) p;

  select jsonb_agg(jsonb_build_object(
           'queue_number', o.queue_number, 'customer_name', o.customer_name,
           'customer_class', o.customer_class, 'total_amount', o.total_amount,
           'cancel_reason', o.cancel_reason, 'cancelled_at', o.cancelled_at,
           'cancelled_by_role', o.cancelled_by_role) order by o.queue_seq) into v_cancelled
    from public.orders o where o.event_id = p_event_id and o.production_status = 'cancelled';

  v_reconciled := (t.active_revenue = t.paid_total + t.debt_total)
                  and v_issues is null
                  and v_items_total = t.active_revenue
                  and v_ledger_live = t.paid_total;

  return jsonb_build_object(
    'event', jsonb_build_object('id', ev.id, 'name', ev.name, 'status', ev.status,
               'created_at', ev.created_at, 'ended_at', ev.ended_at,
               'orders_issued', ev.current_queue_seq),
    'totals', jsonb_build_object(
      'active_orders', t.active_orders, 'active_revenue', t.active_revenue,
      'paid_total', t.paid_total, 'debt_total', t.debt_total,
      'orders_paid', t.orders_paid, 'orders_unpaid', t.orders_unpaid,
      'cancelled_orders', t.cancelled_orders, 'cancelled_value', t.cancelled_value,
      'items_sold', v_items_sold),
    'products', coalesce(v_products, '[]'::jsonb),
    'cancelled', coalesce(v_cancelled, '[]'::jsonb),
    'reconciliation', jsonb_build_object(
      'reconciled', v_reconciled,
      'active_revenue', t.active_revenue,
      'paid_plus_debt', t.paid_total + t.debt_total,
      'difference', t.active_revenue - (t.paid_total + t.debt_total),
      'items_total', v_items_total,
      'ledger_net_paid', v_ledger_live,
      'issues', coalesce(v_issues, '[]'::jsonb)));
end $$;

create or replace function public.get_financial_report(p_token text, p_event_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; v_id uuid;
begin
  v_role := public._auth(p_token, array['admin']);
  v_id := coalesce(p_event_id, (select id from public.events where status = 'active'));
  if v_id is null then raise exception 'NO_ACTIVE_EVENT' using errcode = 'P0001'; end if;
  return public._event_report(v_id);
end $$;

-- Event history (newest first) with headline numbers per event.
create or replace function public.list_events(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text;
begin
  v_role := public._auth(p_token, array['admin']);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'event', r->'event', 'totals', r->'totals',
             'reconciled', r->'reconciliation'->'reconciled') order by e.created_at desc)
      from public.events e, lateral (select public._event_report(e.id) as r) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- PRODUCT MANAGEMENT (admin). Historical snapshots are never touched.
-- ---------------------------------------------------------------------
create or replace function public.admin_save_product(
  p_token text, p_id uuid, p_name text, p_category text, p_price integer, p_available boolean)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; v_name text := btrim(coalesce(p_name, '')); p public.products;
begin
  v_role := public._auth(p_token, array['admin']);
  if char_length(v_name) < 1 or char_length(v_name) > 80
     or p_category is null or p_category not in ('makanan','minuman','snack','lainnya')
     or p_price is null or p_price < 0 or p_price > 10000000
     or p_available is null then
    raise exception 'INVALID_PRODUCT' using errcode = 'P0001';
  end if;

  if p_id is null then
    insert into public.products(name, category, price, available)
    values (v_name, p_category, p_price, p_available) returning * into p;
  else
    update public.products
       set name = v_name, category = p_category, price = p_price,
           available = p_available, updated_at = now()
     where id = p_id returning * into p;
    if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0001'; end if;
  end if;
  return jsonb_build_object('id', p.id, 'name', p.name, 'category', p.category,
                            'price', p.price, 'available', p.available);
end $$;

-- ---------------------------------------------------------------------
-- EVENT MANAGEMENT (admin)
-- ---------------------------------------------------------------------
create or replace function public.start_new_event(p_token text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; v_name text := btrim(coalesce(p_name, '')); ev public.events;
begin
  v_role := public._auth(p_token, array['admin']);
  if char_length(v_name) < 1 or char_length(v_name) > 100 then
    raise exception 'INVALID_EVENT_NAME' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.events where status = 'active') then
    raise exception 'EVENT_ALREADY_ACTIVE' using errcode = 'P0001';
  end if;
  begin
    insert into public.events(name, status, current_queue_seq)
    values (v_name, 'active', 0) returning * into ev;
  exception when unique_violation then
    raise exception 'EVENT_ALREADY_ACTIVE' using errcode = 'P0001';
  end;
  return jsonb_build_object('id', ev.id, 'name', ev.name, 'status', ev.status);
end $$;

create or replace function public.close_current_event(p_token text, p_force boolean default false)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; ev public.events; v_open int;
begin
  v_role := public._auth(p_token, array['admin']);
  select * into ev from public.events where status = 'active' for update;
  if not found then raise exception 'NO_ACTIVE_EVENT' using errcode = 'P0001'; end if;

  select count(*) into v_open from public.orders
   where event_id = ev.id and production_status in ('waiting','processing','ready');
  if v_open > 0 and not coalesce(p_force, false) then
    raise exception 'ORDERS_STILL_ACTIVE' using errcode = 'P0001', detail = v_open::text;
  end if;

  update public.events set status = 'completed', ended_at = now()
   where id = ev.id returning * into ev;
  return jsonb_build_object('id', ev.id, 'name', ev.name, 'status', ev.status,
                            'ended_at', ev.ended_at, 'forced_open_orders', v_open);
end $$;

create or replace function public.archive_event(p_token text, p_event_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; ev public.events;
begin
  v_role := public._auth(p_token, array['admin']);
  update public.events set status = 'archived'
   where id = p_event_id and status = 'completed' returning * into ev;
  if not found then raise exception 'EVENT_NOT_ARCHIVABLE' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', ev.id, 'name', ev.name, 'status', ev.status);
end $$;

-- ---------------------------------------------------------------------
-- PRIVILEGES: clients get EXECUTE on the public RPCs only.
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.get_active_event(),
  public.get_menu(),
  public.create_customer_order(text, text, text, jsonb),
  public.staff_login(text, text),
  public.staff_logout(text),
  public.staff_validate(text),
  public.change_passcode(text, text, text, text),
  public.list_kitchen_orders(text),
  public.update_production_status(text, uuid, text),
  public.get_production_summary(text),
  public.cancel_order(text, uuid, text),
  public.list_cashier_orders(text, text, text),
  public.mark_order_paid(text, uuid),
  public.reverse_order_payment(text, uuid, text),
  public.get_financial_report(text, uuid),
  public.list_events(text),
  public.admin_save_product(text, uuid, text, text, integer, boolean),
  public.start_new_event(text, text),
  public.close_current_event(text, boolean),
  public.archive_event(text, uuid)
to anon, authenticated;

-- ---------------------------------------------------------------------
-- SEED DATA
-- Temporary passcodes below are FORCED to be changed at first login
-- (every other RPC is blocked until then). Change them immediately.
-- ---------------------------------------------------------------------
insert into public.osis_auth(role, passcode_hash, must_change) values
  ('kitchen', extensions.crypt('ganti-kitchen', extensions.gen_salt('bf', 10)), true),
  ('cashier', extensions.crypt('ganti-cashier', extensions.gen_salt('bf', 10)), true),
  ('admin',   extensions.crypt('ganti-admin',   extensions.gen_salt('bf', 10)), true);

insert into public.events(name, status) values ('Hari Batik & Bulan Bahasa 2026', 'active');

insert into public.products(name, category, price) values
  ('Es Teh',      'minuman',  5000),
  ('Es Jeruk',    'minuman',  6000),
  ('Mie Goreng',  'makanan', 10000),
  ('Nasi Goreng', 'makanan', 12000),
  ('Risoles',     'snack',    3000);

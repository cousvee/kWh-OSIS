-- =====================================================================
-- KWh Queue & POS  —  Migration 002  (extras approved after Phase 4)
-- Run ONCE in the Supabase SQL Editor, AFTER 001_kwh_schema.sql.
--
--   * Pause ordering (Admin)                 -> events.accepting_orders
--   * Spam protection on public checkout     -> rate limit + open-order cap
--   * Kitchen can mark a product HABIS / ADA -> set_product_availability
--   * Live ticket status for customers       -> get_ticket_status
--   * Public pickup board (TV screen)        -> get_pickup_board
-- =====================================================================

-- ---------------------------------------------------------------------
-- Pause switch
-- ---------------------------------------------------------------------
alter table public.events
  add column if not exists accepting_orders boolean not null default true;

create or replace function public.get_active_event() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', e.id, 'name', e.name, 'status', e.status,
                            'accepting_orders', e.accepting_orders)
    from public.events e where e.status = 'active';
$$;

create or replace function public.set_accepting_orders(p_token text, p_accepting boolean)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; ev public.events;
begin
  v_role := public._auth(p_token, array['admin']);
  if p_accepting is null then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001';
  end if;
  update public.events set accepting_orders = p_accepting
   where status = 'active' returning * into ev;
  if not found then raise exception 'NO_ACTIVE_EVENT' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', ev.id, 'name', ev.name, 'status', ev.status,
                            'accepting_orders', ev.accepting_orders);
end $$;

-- ---------------------------------------------------------------------
-- Spam protection
--   * per network address (hashed): max 30 orders / 2 min, 200 / hour.
--     Venue wifi shares one address, so the limits are deliberately generous.
--     If the address cannot be determined, this check is skipped.
--   * per same name + class: max 8 open (unpaid, not finished) orders.
--   * Admin's "pause ordering" is the emergency brake.
-- ---------------------------------------------------------------------
create table if not exists public.order_rate_limits (
  id         bigint generated always as identity primary key,
  ip_hash    text not null,
  created_at timestamptz not null default now()
);
create index if not exists order_rate_limits_idx on public.order_rate_limits (ip_hash, created_at);
alter table public.order_rate_limits enable row level security;
revoke all on public.order_rate_limits from anon, authenticated;

create or replace function public._client_ip() returns text
language plpgsql stable set search_path = public, pg_temp as $$
declare h json; ip text;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    return null;
  end;
  if h is null then return null; end if;
  ip := coalesce(nullif(btrim(h->>'cf-connecting-ip'), ''),
                 nullif(btrim(split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1)), ''),
                 nullif(btrim(h->>'x-real-ip'), ''));
  return ip;
end $$;

-- Same as 001 plus: ORDERS_PAUSED, TOO_MANY_OPEN_ORDERS, RATE_LIMITED.
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
  v_ip    text;
  v_hash  text;
  e jsonb;
  r record;
begin
  if char_length(v_key) < 8 or char_length(v_key) > 100 then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001';
  end if;

  -- Idempotency: same key => original order (replays never count against limits).
  select * into v_order from public.orders where idempotency_key = v_key;
  if found then
    return jsonb_build_object('replayed', true,
      'event_name', (select name from public.events where id = v_order.event_id),
      'order', public._customer_view(v_order));
  end if;

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

  select * into v_event from public.events where status = 'active' for update;
  if not found then
    raise exception 'NO_ACTIVE_EVENT' using errcode = 'P0001';
  end if;

  select * into v_order from public.orders where idempotency_key = v_key;
  if found then
    return jsonb_build_object('replayed', true, 'event_name', v_event.name,
                              'order', public._customer_view(v_order));
  end if;

  if not v_event.accepting_orders then
    raise exception 'ORDERS_PAUSED' using errcode = 'P0001';
  end if;

  -- Open-order cap per identical name + class.
  if (select count(*) from public.orders o
       where o.event_id = v_event.id
         and lower(o.customer_name) = lower(v_name)
         and lower(o.customer_class) = lower(v_class)
         and o.payment_status = 'unpaid'
         and o.production_status not in ('cancelled', 'completed')) >= 8 then
    raise exception 'TOO_MANY_OPEN_ORDERS' using errcode = 'P0001';
  end if;

  -- Rate limit per network address.
  v_ip := public._client_ip();
  if v_ip is not null then
    v_hash := encode(digest(v_ip, 'sha256'), 'hex');
    delete from public.order_rate_limits where created_at < now() - interval '1 hour';
    if (select count(*) from public.order_rate_limits
         where ip_hash = v_hash and created_at > now() - interval '2 minutes') >= 30
    or (select count(*) from public.order_rate_limits
         where ip_hash = v_hash) >= 200 then
      raise exception 'RATE_LIMITED' using errcode = 'P0001';
    end if;
    insert into public.order_rate_limits(ip_hash) values (v_hash);
  end if;

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
-- Kitchen (and admin) can flip a product HABIS / ADA. Nothing else about
-- the product (name, price, category) can be changed from here.
-- Existing orders containing the product are NOT touched.
-- ---------------------------------------------------------------------
create or replace function public.set_product_availability(
  p_token text, p_product_id uuid, p_available boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; p public.products;
begin
  v_role := public._auth(p_token, array['kitchen','admin']);
  if p_available is null or p_product_id is null then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001';
  end if;
  update public.products set available = p_available, updated_at = now()
   where id = p_product_id returning * into p;
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', p.id, 'name', p.name, 'category', p.category,
                            'price', p.price, 'available', p.available);
end $$;

-- ---------------------------------------------------------------------
-- Live ticket: the order's secret id (only the ticket holder has it) returns
-- ONLY its statuses. No names, classes or prices are exposed.
-- ---------------------------------------------------------------------
create or replace function public.get_ticket_status(p_order_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('queue_number', o.queue_number,
                            'payment_status', o.payment_status,
                            'production_status', o.production_status)
    from public.orders o where o.id = p_order_id;
$$;

-- Public pickup board: queue NUMBERS only.
create or replace function public.get_pickup_board() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'event_name', e.name,
    'preparing', coalesce((select jsonb_agg(o.queue_number order by o.queue_seq)
                             from public.orders o
                            where o.event_id = e.id
                              and o.production_status in ('waiting','processing')), '[]'::jsonb),
    'ready', coalesce((select jsonb_agg(o.queue_number order by o.queue_seq)
                         from public.orders o
                        where o.event_id = e.id
                          and o.production_status = 'ready'), '[]'::jsonb))
    from public.events e where e.status = 'active';
$$;

-- ---------------------------------------------------------------------
-- Privileges for the new functions
-- ---------------------------------------------------------------------
revoke execute on function public._client_ip() from public, anon, authenticated;
revoke execute on function
  public.set_accepting_orders(text, boolean),
  public.set_product_availability(text, uuid, boolean),
  public.get_ticket_status(uuid),
  public.get_pickup_board()
from public, anon, authenticated;

grant execute on function
  public.get_active_event(),
  public.create_customer_order(text, text, text, jsonb),
  public.set_accepting_orders(text, boolean),
  public.set_product_availability(text, uuid, boolean),
  public.get_ticket_status(uuid),
  public.get_pickup_board()
to anon, authenticated;

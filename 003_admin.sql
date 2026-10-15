-- =====================================================================
-- KWh Queue & POS  —  Migration 003  (Admin panel: modal, report, events)
-- Run ONCE in the Supabase SQL Editor, AFTER 001 and 002.
--
--   * expenses          "modal": money a worker spent upfront (to be reimbursed)
--   * cash_counts       actual cash counted at the end of an event
--   * get_event_full_report   everything the sales report / CSV needs
--   * list_event_orders       all orders of an event (admin lookup, export)
--   * rename_event
--
-- Profit = money already PAID by customers - total modal (voided entries
-- excluded). Reimbursing a worker only marks the entry; it never changes profit.
-- Times in reports are grouped in WIB (Asia/Jakarta).
-- =====================================================================

-- ---------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------
create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references public.events(id),
  worker_name  text not null check (char_length(btrim(worker_name)) between 1 and 60),
  item         text not null check (char_length(btrim(item)) between 1 and 120),
  category     text not null check (category in ('bahan','kemasan','transport','peralatan','lainnya')),
  amount       integer not null check (amount > 0),
  receipt_no   text check (receipt_no is null or char_length(receipt_no) <= 40),
  spent_on     date not null,
  reimbursed   boolean not null default false,
  reimbursed_at timestamptz,
  voided       boolean not null default false,   -- never deleted: voided entries stay visible for audit
  void_reason  text,
  voided_at    timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint expenses_void_consistent
    check (not voided or (void_reason is not null and voided_at is not null))
);
create index if not exists expenses_event_idx on public.expenses (event_id);
alter table public.expenses enable row level security;
revoke all on public.expenses from anon, authenticated;
drop trigger if exists expenses_no_delete on public.expenses;
create trigger expenses_no_delete before delete on public.expenses
  for each row execute function public._block_mutation();

create table if not exists public.cash_counts (
  event_id       uuid primary key references public.events(id),
  counted_amount integer not null check (counted_amount >= 0),
  note           text,
  counted_at     timestamptz not null default now()
);
alter table public.cash_counts enable row level security;
revoke all on public.cash_counts from anon, authenticated;

-- ---------------------------------------------------------------------
-- HELPERS (internal)
-- ---------------------------------------------------------------------
create or replace function public._resolve_event(p_event_id uuid) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid;
begin
  if p_event_id is null then
    select id into v from public.events where status = 'active';
    if v is null then raise exception 'NO_ACTIVE_EVENT' using errcode = 'P0001'; end if;
    return v;
  end if;
  select id into v from public.events where id = p_event_id;
  if v is null then raise exception 'EVENT_NOT_FOUND' using errcode = 'P0001'; end if;
  return v;
end $$;

create or replace function public._expense_json(e public.expenses) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', e.id, 'event_id', e.event_id, 'worker_name', e.worker_name, 'item', e.item,
    'category', e.category, 'amount', e.amount, 'receipt_no', e.receipt_no,
    'spent_on', e.spent_on, 'reimbursed', e.reimbursed, 'reimbursed_at', e.reimbursed_at,
    'voided', e.voided, 'void_reason', e.void_reason, 'created_at', e.created_at);
$$;

-- ---------------------------------------------------------------------
-- EVENT NAME
-- ---------------------------------------------------------------------
create or replace function public.rename_event(p_token text, p_event_id uuid, p_name text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; v_name text := btrim(coalesce(p_name, '')); ev public.events;
begin
  v_role := public._auth(p_token, array['admin']);
  if char_length(v_name) < 1 or char_length(v_name) > 100 then
    raise exception 'INVALID_EVENT_NAME' using errcode = 'P0001';
  end if;
  update public.events set name = v_name
   where id = public._resolve_event(p_event_id) returning * into ev;
  return jsonb_build_object('id', ev.id, 'name', ev.name, 'status', ev.status);
end $$;

-- ---------------------------------------------------------------------
-- MODAL (expenses)
-- ---------------------------------------------------------------------
create or replace function public.list_expenses(p_token text, p_event_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; v_ev uuid;
begin
  v_role := public._auth(p_token, array['admin']);
  v_ev := public._resolve_event(p_event_id);
  return coalesce((
    select jsonb_agg(public._expense_json(e) order by e.spent_on desc, e.created_at desc)
      from public.expenses e where e.event_id = v_ev), '[]'::jsonb);
end $$;

create or replace function public.save_expense(
  p_token text, p_id uuid, p_event_id uuid, p_worker_name text, p_item text,
  p_category text, p_amount integer, p_receipt_no text, p_spent_on date)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_role text; v_ev uuid; e public.expenses;
  v_worker text := btrim(coalesce(p_worker_name, ''));
  v_item   text := btrim(coalesce(p_item, ''));
  v_nota   text := nullif(btrim(coalesce(p_receipt_no, '')), '');
begin
  v_role := public._auth(p_token, array['admin']);
  if char_length(v_worker) < 1 or char_length(v_worker) > 60
     or char_length(v_item) < 1 or char_length(v_item) > 120
     or p_category is null or p_category not in ('bahan','kemasan','transport','peralatan','lainnya')
     or p_amount is null or p_amount < 1 or p_amount > 1000000000
     or (v_nota is not null and char_length(v_nota) > 40)
     or p_spent_on is null then
    raise exception 'INVALID_EXPENSE' using errcode = 'P0001';
  end if;

  if p_id is null then
    v_ev := public._resolve_event(p_event_id);
    if (select status from public.events where id = v_ev) = 'archived' then
      raise exception 'EVENT_ARCHIVED' using errcode = 'P0001';
    end if;
    insert into public.expenses(event_id, worker_name, item, category, amount, receipt_no, spent_on)
    values (v_ev, v_worker, v_item, p_category, p_amount, v_nota, p_spent_on)
    returning * into e;
  else
    select * into e from public.expenses where id = p_id for update;
    if not found then raise exception 'EXPENSE_NOT_FOUND' using errcode = 'P0001'; end if;
    if e.voided then raise exception 'EXPENSE_VOIDED' using errcode = 'P0001'; end if;
    update public.expenses
       set worker_name = v_worker, item = v_item, category = p_category, amount = p_amount,
           receipt_no = v_nota, spent_on = p_spent_on, updated_at = now()
     where id = p_id returning * into e;
  end if;
  return public._expense_json(e);
end $$;

create or replace function public.set_expense_reimbursed(p_token text, p_id uuid, p_reimbursed boolean)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; e public.expenses;
begin
  v_role := public._auth(p_token, array['admin']);
  if p_reimbursed is null then raise exception 'INVALID_REQUEST' using errcode = 'P0001'; end if;
  select * into e from public.expenses where id = p_id for update;
  if not found then raise exception 'EXPENSE_NOT_FOUND' using errcode = 'P0001'; end if;
  if e.voided then raise exception 'EXPENSE_VOIDED' using errcode = 'P0001'; end if;
  update public.expenses
     set reimbursed = p_reimbursed,
         reimbursed_at = case when p_reimbursed then coalesce(reimbursed_at, now()) else null end,
         updated_at = now()
   where id = p_id returning * into e;
  return public._expense_json(e);
end $$;

create or replace function public.void_expense(p_token text, p_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; e public.expenses; v_reason text := btrim(coalesce(p_reason, ''));
begin
  v_role := public._auth(p_token, array['admin']);
  if char_length(v_reason) < 3 or char_length(v_reason) > 200 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  select * into e from public.expenses where id = p_id for update;
  if not found then raise exception 'EXPENSE_NOT_FOUND' using errcode = 'P0001'; end if;
  if e.voided then return public._expense_json(e); end if;
  update public.expenses
     set voided = true, void_reason = v_reason, voided_at = now(), updated_at = now()
   where id = p_id returning * into e;
  return public._expense_json(e);
end $$;

-- ---------------------------------------------------------------------
-- CASH COUNT
-- ---------------------------------------------------------------------
create or replace function public.set_cash_count(
  p_token text, p_event_id uuid, p_amount integer, p_note text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; v_ev uuid; c public.cash_counts;
begin
  v_role := public._auth(p_token, array['admin']);
  if p_amount is null or p_amount < 0 or p_amount > 2000000000 then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001';
  end if;
  v_ev := public._resolve_event(p_event_id);
  insert into public.cash_counts(event_id, counted_amount, note, counted_at)
  values (v_ev, p_amount, nullif(btrim(coalesce(p_note, '')), ''), now())
  on conflict (event_id) do update
     set counted_amount = excluded.counted_amount, note = excluded.note, counted_at = now()
  returning * into c;
  return jsonb_build_object('event_id', c.event_id, 'counted_amount', c.counted_amount,
                            'note', c.note, 'counted_at', c.counted_at);
end $$;

-- ---------------------------------------------------------------------
-- ORDER LOOKUP FOR ADMIN (any event, includes cancelled)
-- ---------------------------------------------------------------------
create or replace function public.list_event_orders(
  p_token text, p_event_id uuid default null, p_search text default null, p_filter text default 'all')
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_role text; v_ev uuid; v_q text := lower(btrim(coalesce(p_search, '')));
begin
  v_role := public._auth(p_token, array['admin']);
  if p_filter is null or p_filter not in ('all','unpaid','paid','cancelled') then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001';
  end if;
  v_ev := public._resolve_event(p_event_id);
  return coalesce((
    select jsonb_agg(public._order_json(o) order by o.queue_seq desc)
      from (select o2.* from public.orders o2
             where o2.event_id = v_ev
               and (p_filter = 'all'
                    or (p_filter = 'cancelled' and o2.production_status = 'cancelled')
                    or (p_filter = 'paid'   and o2.production_status <> 'cancelled' and o2.payment_status = 'paid')
                    or (p_filter = 'unpaid' and o2.production_status <> 'cancelled' and o2.payment_status = 'unpaid'))
               and (v_q = ''
                    or position(v_q in lower(o2.customer_name))  > 0
                    or position(v_q in lower(o2.customer_class)) > 0
                    or position(v_q in o2.queue_number) > 0
                    or (case when v_q ~ '^[0-9]{1,6}$' then o2.queue_seq = v_q::int else false end))
             order by o2.queue_seq desc
             limit 500) o), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- FULL REPORT  (sections A-I of the sales report)
-- ---------------------------------------------------------------------
create or replace function public.get_event_full_report(p_token text, p_event_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_role text; v_ev uuid; base jsonb;
  v_revenue bigint; v_paid bigint; v_orders int;
  v_modal bigint; v_reimb bigint; v_voided int; v_entries int;
  v_by_cat jsonb; v_by_hour jsonb; v_reasons jsonb; v_reversals jsonb; v_workers jsonb;
  v_first timestamptz; v_last timestamptz; v_cash public.cash_counts;
begin
  v_role := public._auth(p_token, array['admin']);
  v_ev := public._resolve_event(p_event_id);
  base := public._event_report(v_ev);

  v_revenue := (base->'totals'->>'active_revenue')::bigint;
  v_paid    := (base->'totals'->>'paid_total')::bigint;
  v_orders  := (base->'totals'->>'active_orders')::int;

  select coalesce(sum(amount) filter (where not voided), 0),
         coalesce(sum(amount) filter (where not voided and reimbursed), 0),
         count(*) filter (where voided),
         count(*) filter (where not voided)
    into v_modal, v_reimb, v_voided, v_entries
    from public.expenses where event_id = v_ev;

  select jsonb_agg(jsonb_build_object('category', c.cat, 'items', c.items, 'revenue', c.rev)
                   order by c.rev desc, c.cat) into v_by_cat
    from (select coalesce(p.category, 'lainnya') as cat,
                 sum(i.quantity)::int as items, sum(i.subtotal)::bigint as rev
            from public.order_items i
            join public.orders o on o.id = i.order_id
            left join public.products p on p.id = i.product_id
           where o.event_id = v_ev and o.production_status <> 'cancelled'
           group by 1) c;

  select jsonb_agg(jsonb_build_object('hour', h.hr, 'orders', h.n, 'revenue', h.rev) order by h.hr) into v_by_hour
    from (select to_char(date_trunc('hour', o.created_at at time zone 'Asia/Jakarta'), 'YYYY-MM-DD HH24:00') as hr,
                 count(*)::int as n, sum(o.total_amount)::bigint as rev
            from public.orders o
           where o.event_id = v_ev and o.production_status <> 'cancelled'
           group by 1) h;

  select jsonb_agg(jsonb_build_object('reason', r.reason, 'count', r.n) order by r.n desc, r.reason) into v_reasons
    from (select o.cancel_reason as reason, count(*)::int as n
            from public.orders o
           where o.event_id = v_ev and o.production_status = 'cancelled'
           group by 1) r;

  select jsonb_agg(jsonb_build_object('queue_number', o.queue_number, 'amount', pr.amount,
                                      'note', pr.note, 'recorded_by_role', pr.recorded_by_role,
                                      'created_at', pr.created_at) order by pr.created_at)
    into v_reversals
    from public.payment_records pr join public.orders o on o.id = pr.order_id
   where o.event_id = v_ev and pr.record_type = 'reversal';

  select jsonb_agg(jsonb_build_object('worker_name', w.worker, 'total', w.total,
                                      'reimbursed', w.reimb, 'remaining', w.total - w.reimb)
                   order by w.worker) into v_workers
    from (select e.worker_name as worker, sum(e.amount)::bigint as total,
                 coalesce(sum(e.amount) filter (where e.reimbursed), 0)::bigint as reimb
            from public.expenses e
           where e.event_id = v_ev and not e.voided
           group by e.worker_name) w;

  select min(created_at), max(created_at) into v_first, v_last
    from public.orders where event_id = v_ev and production_status <> 'cancelled';

  select * into v_cash from public.cash_counts where event_id = v_ev;

  return base || jsonb_build_object(
    'by_category', coalesce(v_by_cat, '[]'::jsonb),
    'by_hour', coalesce(v_by_hour, '[]'::jsonb),
    'cancel_reasons', coalesce(v_reasons, '[]'::jsonb),
    'reversals', coalesce(v_reversals, '[]'::jsonb),
    'expenses', jsonb_build_object(
        'total_modal', v_modal, 'reimbursed_total', v_reimb, 'remaining_total', v_modal - v_reimb,
        'voided_count', v_voided, 'entries_count', v_entries,
        'by_worker', coalesce(v_workers, '[]'::jsonb)),
    'profit', jsonb_build_object(
        'net', v_paid - v_modal,
        'margin_pct', case when v_paid > 0 then round((v_paid - v_modal)::numeric * 100 / v_paid) else null end,
        'paid_pct', case when v_revenue > 0 then round(v_paid::numeric * 100 / v_revenue) else null end,
        'avg_order', case when v_orders > 0 then round(v_revenue::numeric / v_orders) else 0 end),
    'period', jsonb_build_object('first_order_at', v_first, 'last_order_at', v_last),
    'cash', case when v_cash.event_id is null then null else jsonb_build_object(
        'counted_amount', v_cash.counted_amount, 'system_amount', v_paid,
        'difference', v_cash.counted_amount - v_paid,
        'note', v_cash.note, 'counted_at', v_cash.counted_at) end
  );
end $$;

-- ---------------------------------------------------------------------
-- PRIVILEGES
-- ---------------------------------------------------------------------
revoke execute on function
  public._resolve_event(uuid), public._expense_json(public.expenses)
from public, anon, authenticated;

revoke execute on function
  public.rename_event(text, uuid, text),
  public.list_expenses(text, uuid),
  public.save_expense(text, uuid, uuid, text, text, text, integer, text, date),
  public.set_expense_reimbursed(text, uuid, boolean),
  public.void_expense(text, uuid, text),
  public.set_cash_count(text, uuid, integer, text),
  public.list_event_orders(text, uuid, text, text),
  public.get_event_full_report(text, uuid)
from public, anon, authenticated;

grant execute on function
  public.rename_event(text, uuid, text),
  public.list_expenses(text, uuid),
  public.save_expense(text, uuid, uuid, text, text, text, integer, text, date),
  public.set_expense_reimbursed(text, uuid, boolean),
  public.void_expense(text, uuid, text),
  public.set_cash_count(text, uuid, integer, text),
  public.list_event_orders(text, uuid, text, text),
  public.get_event_full_report(text, uuid)
to anon, authenticated;

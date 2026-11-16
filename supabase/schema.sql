-- FieldSync schema: tables, Row Level Security, the single write function
-- (sync_push), the read function (sync_pull) and the Storage bucket policies.
-- Safe to run repeatedly: `npm run schema` applies it on every verify run.

-- ---------------------------------------------------------------- tables

create table if not exists public.regions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null
);

create table if not exists public.region_members (
  region_id uuid not null references public.regions (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  role      text not null default 'editor' check (role in ('editor', 'viewer', 'lead')),
  primary key (region_id, user_id)
);

create table if not exists public.records (
  id          uuid primary key,                -- made on the device
  region_id   uuid not null references public.regions (id),
  type        text not null check (type in ('soil', 'water', 'wildlife')),
  seq         integer not null,                -- label number, e.g. SOIL-014
  fields      jsonb not null default '{}'::jsonb,
  field_meta  jsonb not null default '{}'::jsonb, -- per field: version, user, device, time of last write
  version     integer not null default 1,
  updated_at  timestamptz not null default clock_timestamp(),
  deleted     boolean not null default false,
  observed_at timestamptz,
  created_by  uuid,
  updated_by  uuid,
  updated_device text,
  created_at  timestamptz not null default clock_timestamp(),
  unique (region_id, type, seq)
);
create index if not exists records_region_updated on public.records (region_id, updated_at);

create table if not exists public.media (
  id           uuid primary key,               -- made on the device
  record_id    uuid not null references public.records (id),
  region_id    uuid not null references public.regions (id),
  storage_path text not null,
  mime_type    text not null default 'image/jpeg',
  size_bytes   integer,
  position     integer,
  deleted      boolean not null default false,
  created_by   uuid,
  created_at   timestamptz not null default clock_timestamp(),
  updated_at   timestamptz not null default clock_timestamp()
);
create index if not exists media_region_updated on public.media (region_id, updated_at);

create table if not exists public.gps_logs (
  id         uuid primary key,                 -- made on the device
  region_id  uuid not null references public.regions (id),
  record_id  uuid references public.records (id),
  kind       text not null check (kind in ('point', 'track')),
  name       text,
  seq        integer,
  points     jsonb not null default '[]'::jsonb,
  started_at timestamptz,
  ended_at   timestamptz,
  distance_m double precision,
  deleted    boolean not null default false,
  version    integer not null default 1,
  created_by uuid,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists gps_logs_region_updated on public.gps_logs (region_id, updated_at);

create table if not exists public.conflict_log (
  id          uuid primary key default gen_random_uuid(),
  record_id   uuid not null references public.records (id),
  region_id   uuid not null references public.regions (id),
  kind        text not null check (kind in ('same_field', 'edit_vs_delete')),
  field       text not null,
  lost_value  jsonb,
  lost_by     uuid,
  lost_device text,
  kept_value  jsonb,
  kept_by     uuid,
  kept_device text,
  at          timestamptz not null default clock_timestamp(),
  resolved    boolean not null default false,
  resolved_by uuid,
  updated_at  timestamptz not null default clock_timestamp()
);
create index if not exists conflict_region_updated on public.conflict_log (region_id, updated_at);

-- Ledger of pushed operations. A retried op id returns the stored result
-- instead of being applied twice.
create table if not exists public.applied_ops (
  op_id   uuid primary key,
  user_id uuid not null,
  result  jsonb not null,
  at      timestamptz not null default clock_timestamp()
);

create table if not exists public.devices (
  device_id    text primary key,
  user_id      uuid not null,
  last_sync_at timestamptz not null default clock_timestamp(),
  last_status  text not null default 'ok'
);

-- ------------------------------------------------------ helper functions

create or replace function public.is_member(p_region uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.region_members m
                 where m.region_id = p_region and m.user_id = auth.uid());
$$;

create or replace function public.can_edit(p_region uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.region_members m
                 where m.region_id = p_region and m.user_id = auth.uid()
                   and m.role in ('editor', 'lead'));
$$;

create or replace function public.shares_region(p_user uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_user = auth.uid() or exists (
    select 1 from public.region_members mine
    join public.region_members theirs on theirs.region_id = mine.region_id
    where mine.user_id = auth.uid() and theirs.user_id = p_user);
$$;

create or replace function public.try_uuid(p_text text)
returns uuid language plpgsql immutable as $$
begin
  return p_text::uuid;
exception when others then
  return null;
end $$;

-- Readings are numbers and pH is on the pH scale. The form checks this too,
-- but the form is not the only program that can call sync_push.
create or replace function public.check_record_fields(p_changed jsonb)
returns void language plpgsql immutable as $$
declare
  v_key text;
  v_val jsonb;
begin
  for v_key, v_val in select * from jsonb_each(coalesce(p_changed, '{}'::jsonb)) loop
    if v_key in ('ph', 'moisture', 'temperature', 'depth', 'turbidity', 'oxygen', 'count') then
      if jsonb_typeof(v_val) not in ('number', 'null') then
        raise exception '% must be a number', v_key using errcode = '22023';
      end if;
      if v_key = 'ph' and jsonb_typeof(v_val) = 'number'
         and ((v_val #>> '{}')::numeric < 0 or (v_val #>> '{}')::numeric > 14) then
        raise exception 'pH must be between 0 and 14' using errcode = '22023';
      end if;
    end if;
  end loop;
end $$;

-- --------------------------------------------------- Row Level Security
-- Clients can only read, and only regions listed for them in region_members.
-- There are no insert/update/delete policies: every write goes through
-- sync_push below.

alter table public.regions        enable row level security;
alter table public.profiles       enable row level security;
alter table public.region_members enable row level security;
alter table public.records        enable row level security;
alter table public.media          enable row level security;
alter table public.gps_logs       enable row level security;
alter table public.conflict_log   enable row level security;
alter table public.applied_ops    enable row level security;
alter table public.devices        enable row level security;

revoke all on public.regions, public.profiles, public.region_members, public.records,
  public.media, public.gps_logs, public.conflict_log, public.applied_ops, public.devices
  from anon, authenticated;
grant select on public.regions, public.profiles, public.region_members, public.records,
  public.media, public.gps_logs, public.conflict_log, public.devices
  to authenticated;

drop policy if exists regions_read on public.regions;
create policy regions_read on public.regions for select to authenticated
  using (public.is_member(id));

drop policy if exists members_read on public.region_members;
create policy members_read on public.region_members for select to authenticated
  using (public.is_member(region_id));

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (public.shares_region(user_id));

drop policy if exists records_read on public.records;
create policy records_read on public.records for select to authenticated
  using (public.is_member(region_id));

drop policy if exists media_read on public.media;
create policy media_read on public.media for select to authenticated
  using (public.is_member(region_id));

drop policy if exists gps_logs_read on public.gps_logs;
create policy gps_logs_read on public.gps_logs for select to authenticated
  using (public.is_member(region_id));

drop policy if exists conflict_log_read on public.conflict_log;
create policy conflict_log_read on public.conflict_log for select to authenticated
  using (public.is_member(region_id));

drop policy if exists devices_read on public.devices;
create policy devices_read on public.devices for select to authenticated
  using (public.shares_region(user_id));

-- ------------------------------------------------- sync_push: all writes
-- The only way a client can change data. Takes a list of outbox operations
-- and answers each one with applied or rejected.
--
-- Merge rules for records (one place, as the PRD requires):
--   * different fields edited on two devices  -> both kept
--   * same field edited on two devices        -> the edit this function
--     receives later wins (server time, never device time); the value it
--     replaces goes to conflict_log
--   * edit against a deleted record           -> the delete wins; the edit
--     goes to conflict_log so it can be restored
--   * delete of a record that another device edited after the version the
--     deleting device last saw                -> the delete wins; the edited
--     values go to conflict_log so they can be restored
--   * every op id is applied at most once      -> retries cannot duplicate
--
-- Nothing the client sends is trusted to say who it is or where a row lives:
--   * the user is auth.uid(); the role comes from region_members
--   * the region of a row that already exists is read from that row
--   * a device id belongs to the user who used it first; a push that names
--     the device id of another user is rejected

create or replace function public.sync_push(p_device_id text, p_ops jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid      uuid := auth.uid();
  v_op       jsonb;
  v_res      jsonb;
  v_results  jsonb := '[]'::jsonb;
  v_op_id    uuid;
  v_table    text;
  v_kind     text;
  v_id       uuid;
  v_region   uuid;
  v_role     text;
  v_rname    text;
  v_changed  jsonb;
  v_base     integer;
  v_rec      public.records%rowtype;
  v_gps      public.gps_logs%rowtype;
  v_med      public.media%rowtype;
  v_grec     uuid;
  v_owner    uuid;
  v_dev_ok   boolean := false;
  v_dev_why  text := 'a device id is required';
  v_con      public.conflict_log%rowtype;
  v_fields   jsonb;
  v_meta     jsonb;
  v_fm       jsonb;
  v_cur      jsonb;
  v_key      text;
  v_val      jsonb;
  v_seq      integer;
  v_type     text;
  v_new_ver  integer;
  v_touched  boolean;
  v_conflicts integer;
  v_now      timestamptz;
  v_path     text;
  v_rejected boolean := false;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  -- Device rule: the id is registered to the first user who pushes with it.
  -- "Same device" in the merge below is only believed for the registered owner.
  if p_device_id is not null and length(p_device_id) between 1 and 100 then
    insert into public.devices (device_id, user_id) values (p_device_id, v_uid)
      on conflict (device_id) do nothing;
    select d.user_id into v_owner from public.devices d where d.device_id = p_device_id;
    v_dev_ok := v_owner is not distinct from v_uid;
    v_dev_why := 'this device id is registered to another user';
  end if;

  for v_op in select * from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) loop
    if not v_dev_ok then
      v_results := v_results || jsonb_build_array(jsonb_build_object('status', 'rejected',
        'op_id', v_op->>'op_id', 'table', v_op->>'table', 'row_id', v_op->>'row_id',
        'reason', v_dev_why, 'code', '42501'));
      continue;
    end if;
    v_op_id := public.try_uuid(v_op->>'op_id');

    -- Idempotency: an op that was already applied answers with its first result.
    select a.result into v_res from public.applied_ops a
      where a.op_id = v_op_id and a.user_id = v_uid;
    if found then
      v_results := v_results || jsonb_build_array(v_res || jsonb_build_object('duplicate', true));
      continue;
    end if;

    begin
      v_table := v_op->>'table';
      v_kind  := coalesce(v_op->>'kind', 'upsert');
      v_id    := public.try_uuid(v_op->>'row_id');
      v_now   := clock_timestamp();
      v_conflicts := 0;
      v_changed := coalesce(v_op->'changed', '{}'::jsonb);
      if v_op_id is null or v_id is null then
        raise exception 'bad operation ids' using errcode = '22023';
      end if;

      -- Find the region this op touches.
      v_region := null;
      if v_table = 'records' then
        select * into v_rec from public.records r where r.id = v_id for update;
        if found then v_region := v_rec.region_id;
        else v_region := public.try_uuid(v_op->>'region_id'); end if;
      elsif v_table = 'media' then
        -- A photo that is already on the server decides its own record and
        -- region. The record id in the op is only used for a new photo.
        select * into v_med from public.media m where m.id = v_id for update;
        if found then
          select * into v_rec from public.records r where r.id = v_med.record_id;
        else
          select * into v_rec from public.records r where r.id = public.try_uuid(v_op->>'record_id');
        end if;
        if not found then
          raise exception 'the record for this photo is not on the server' using errcode = '23503';
        end if;
        v_region := coalesce(v_med.region_id, v_rec.region_id);
      elsif v_table = 'gps_logs' then
        select * into v_gps from public.gps_logs g where g.id = v_id for update;
        if found then v_region := v_gps.region_id;
        else v_region := public.try_uuid(v_op->>'region_id'); end if;
      elsif v_table = 'conflict_log' then
        select * into v_con from public.conflict_log c where c.id = v_id for update;
        if not found then
          raise exception 'unknown conflict entry' using errcode = '23503';
        end if;
        v_region := v_con.region_id;
      else
        raise exception 'unknown table %', v_table using errcode = '22023';
      end if;

      -- Region rule: the caller must be listed for the region with edit rights.
      select m.role, g.name into v_role, v_rname
        from public.region_members m join public.regions g on g.id = m.region_id
        where m.region_id = v_region and m.user_id = v_uid;
      if v_role is null then
        raise exception 'you are not assigned to this region' using errcode = '42501';
      elsif v_role = 'viewer' then
        raise exception '% is view only', v_rname using errcode = '42501';
      end if;

      -- ------------------------------------------------------- records
      if v_table = 'records' then
        if v_kind in ('upsert', 'restore') then
          perform public.check_record_fields(v_changed);
        end if;
        select * into v_rec from public.records r where r.id = v_id for update;

        if not found then
          if v_kind = 'upsert' then
            v_type := v_op->>'type';
            if v_type is null or v_type not in ('soil', 'water', 'wildlife') then
              raise exception 'unknown record type' using errcode = '22023';
            end if;
            -- Label number: keep the device's proposal when free, else next free.
            perform pg_advisory_xact_lock(hashtext(v_region::text || v_type));
            v_seq := nullif(v_op->>'seq', '')::integer;
            if v_seq is null or v_seq < 1 or exists (
                 select 1 from public.records r
                 where r.region_id = v_region and r.type = v_type and r.seq = v_seq) then
              select coalesce(max(r.seq), 0) + 1 into v_seq from public.records r
                where r.region_id = v_region and r.type = v_type;
            end if;
            v_meta := '{}'::jsonb;
            for v_key in select jsonb_object_keys(v_changed) loop
              v_meta := v_meta || jsonb_build_object(v_key,
                jsonb_build_object('v', 1, 'by', v_uid, 'dev', p_device_id, 'at', v_now));
            end loop;
            insert into public.records (id, region_id, type, seq, fields, field_meta, version,
                updated_at, deleted, observed_at, created_by, updated_by, updated_device, created_at)
              values (v_id, v_region, v_type, v_seq, v_changed, v_meta, 1, v_now, false,
                coalesce(nullif(v_op->>'observed_at', '')::timestamptz, v_now),
                v_uid, v_uid, p_device_id, v_now);
          end if;
          -- delete / restore of a record the server never saw: nothing to do.

        elsif v_kind = 'delete' then
          if not v_rec.deleted then
            -- The delete wins. Values another device wrote after the version this
            -- device last saw would vanish with it, so they are kept in the log.
            v_base := coalesce(nullif(v_op->>'base_version', '')::integer, 0);
            for v_key, v_fm in select * from jsonb_each(v_rec.field_meta) loop
              if (v_fm->>'v')::integer > v_base
                 and ((v_fm->>'dev') is distinct from p_device_id
                      or (v_fm->>'by') is distinct from v_uid::text) then
                insert into public.conflict_log (record_id, region_id, kind, field, lost_value, lost_by,
                    lost_device, kept_value, kept_by, kept_device, at, updated_at)
                  values (v_id, v_region, 'edit_vs_delete', v_key, v_rec.fields->v_key,
                    public.try_uuid(v_fm->>'by'), v_fm->>'dev', null, v_uid, p_device_id, v_now, v_now);
                v_conflicts := v_conflicts + 1;
              end if;
            end loop;
            update public.records set deleted = true, version = version + 1, updated_at = v_now,
              updated_by = v_uid, updated_device = p_device_id where id = v_id;
          end if;

        elsif v_kind = 'restore' then
          if v_rec.deleted then
            v_fields := v_rec.fields; v_meta := v_rec.field_meta; v_new_ver := v_rec.version + 1;
            for v_key, v_val in select * from jsonb_each(v_changed) loop
              v_fields := jsonb_set(v_fields, array[v_key], v_val, true);
              v_meta := jsonb_set(v_meta, array[v_key],
                jsonb_build_object('v', v_new_ver, 'by', v_uid, 'dev', p_device_id, 'at', v_now), true);
            end loop;
            update public.records set deleted = false, fields = v_fields, field_meta = v_meta,
              version = v_new_ver, updated_at = v_now, updated_by = v_uid,
              updated_device = p_device_id where id = v_id;
          end if;
          update public.conflict_log set resolved = true, resolved_by = v_uid, updated_at = v_now
            where record_id = v_id and kind = 'edit_vs_delete' and not resolved;

        elsif v_rec.deleted then
          -- Edit against a deleted record: the delete wins, the edit is kept in the log.
          for v_key, v_val in select * from jsonb_each(v_changed) loop
            insert into public.conflict_log (record_id, region_id, kind, field, lost_value, lost_by,
                lost_device, kept_value, kept_by, kept_device, at, updated_at)
              values (v_id, v_region, 'edit_vs_delete', v_key, v_val, v_uid, p_device_id,
                null, v_rec.updated_by, v_rec.updated_device, v_now, v_now);
            v_conflicts := v_conflicts + 1;
          end loop;

        else
          -- Per-field merge.
          v_base := coalesce(nullif(v_op->>'base_version', '')::integer, 0);
          v_fields := v_rec.fields; v_meta := v_rec.field_meta;
          v_new_ver := v_rec.version + 1; v_touched := false;
          for v_key, v_val in select * from jsonb_each(v_changed) loop
            v_cur := coalesce(v_fields->v_key, 'null'::jsonb);
            v_fm := v_meta->v_key;
            if v_cur is distinct from v_val then
              -- Another device wrote this field after the version this device
              -- last saw: same-field conflict. This (later) edit wins.
              if v_fm is not null and (v_fm->>'v')::integer > v_base
                 and ((v_fm->>'dev') is distinct from p_device_id
                      or (v_fm->>'by') is distinct from v_uid::text) then
                insert into public.conflict_log (record_id, region_id, kind, field, lost_value,
                    lost_by, lost_device, kept_value, kept_by, kept_device, at, updated_at)
                  values (v_id, v_region, 'same_field', v_key, v_cur,
                    public.try_uuid(v_fm->>'by'), v_fm->>'dev', v_val, v_uid, p_device_id, v_now, v_now);
                v_conflicts := v_conflicts + 1;
              end if;
              v_fields := jsonb_set(v_fields, array[v_key], v_val, true);
              v_meta := jsonb_set(v_meta, array[v_key],
                jsonb_build_object('v', v_new_ver, 'by', v_uid, 'dev', p_device_id, 'at', v_now), true);
              v_touched := true;
            end if;
          end loop;
          if v_touched then
            update public.records set fields = v_fields, field_meta = v_meta, version = v_new_ver,
              updated_at = v_now, updated_by = v_uid, updated_device = p_device_id where id = v_id;
          end if;
        end if;

        select * into v_rec from public.records r where r.id = v_id;
        v_res := jsonb_build_object('status', 'applied', 'table', 'records', 'row_id', v_id,
          'conflicts', v_conflicts,
          'record', case when v_rec.id is null then null else jsonb_build_object(
            'id', v_rec.id, 'region_id', v_rec.region_id, 'type', v_rec.type, 'seq', v_rec.seq,
            'fields', v_rec.fields, 'version', v_rec.version, 'updated_at', v_rec.updated_at,
            'deleted', v_rec.deleted, 'observed_at', v_rec.observed_at,
            'created_by', v_rec.created_by, 'updated_by', v_rec.updated_by) end);

      -- --------------------------------------------------------- media
      elsif v_table = 'media' then
        if v_kind = 'delete' then
          update public.media set deleted = true, updated_at = v_now
            where id = v_id and region_id = v_region;
        else
          v_path := v_op->>'storage_path';
          if v_path is null or v_path <> v_region::text || '/' || v_rec.id::text || '/' || v_id::text || '.jpg' then
            raise exception 'bad photo path' using errcode = '22023';
          end if;
          insert into public.media (id, record_id, region_id, storage_path, mime_type, size_bytes,
              position, created_by, created_at, updated_at)
            values (v_id, v_rec.id, v_region, v_path, coalesce(v_op->>'mime_type', 'image/jpeg'),
              nullif(v_op->>'size_bytes', '')::integer, nullif(v_op->>'position', '')::integer,
              v_uid, v_now, v_now)
            on conflict (id) do nothing;
        end if;
        v_res := jsonb_build_object('status', 'applied', 'table', 'media', 'row_id', v_id);

      -- ------------------------------------------------------ gps_logs
      elsif v_table = 'gps_logs' then
        if v_kind = 'delete' then
          update public.gps_logs set deleted = true, version = version + 1, updated_at = v_now
            where id = v_id;
          v_seq := v_gps.seq;
        elsif v_gps.id is not null then
          update public.gps_logs set points = coalesce(v_op->'points', points),
            name = coalesce(v_op->>'name', name),
            ended_at = coalesce(nullif(v_op->>'ended_at', '')::timestamptz, ended_at),
            distance_m = coalesce(nullif(v_op->>'distance_m', '')::double precision, distance_m),
            version = version + 1, updated_at = v_now where id = v_id;
          v_seq := v_gps.seq;
        else
          v_seq := null;
          if coalesce(v_op->>'gps_kind', 'point') = 'track' then
            perform pg_advisory_xact_lock(hashtext(v_region::text || 'track'));
            v_seq := nullif(v_op->>'seq', '')::integer;
            if v_seq is null or v_seq < 1 or exists (
                 select 1 from public.gps_logs g
                 where g.region_id = v_region and g.kind = 'track' and g.seq = v_seq) then
              select coalesce(max(g.seq), 0) + 1 into v_seq from public.gps_logs g
                where g.region_id = v_region and g.kind = 'track';
            end if;
          end if;
          -- A GPS row may only point at a record of its own region.
          v_grec := public.try_uuid(v_op->>'record_id');
          if v_grec is not null and not exists (
               select 1 from public.records r where r.id = v_grec and r.region_id = v_region) then
            raise exception 'the record for this GPS point is not in this region' using errcode = '23503';
          end if;
          insert into public.gps_logs (id, region_id, record_id, kind, name, seq, points,
              started_at, ended_at, distance_m, created_by, updated_at)
            values (v_id, v_region, v_grec,
              coalesce(v_op->>'gps_kind', 'point'), v_op->>'name', v_seq,
              coalesce(v_op->'points', '[]'::jsonb),
              nullif(v_op->>'started_at', '')::timestamptz,
              nullif(v_op->>'ended_at', '')::timestamptz,
              nullif(v_op->>'distance_m', '')::double precision, v_uid, v_now);
        end if;
        v_res := jsonb_build_object('status', 'applied', 'table', 'gps_logs', 'row_id', v_id, 'seq', v_seq);

      -- -------------------------------------------------- conflict_log
      else
        update public.conflict_log set resolved = true, resolved_by = v_uid, updated_at = v_now
          where id = v_id;
        v_res := jsonb_build_object('status', 'applied', 'table', 'conflict_log', 'row_id', v_id);
      end if;

      v_res := v_res || jsonb_build_object('op_id', v_op_id);
      insert into public.applied_ops (op_id, user_id, result) values (v_op_id, v_uid, v_res)
        on conflict (op_id) do nothing;

    exception
      -- A rule said no. Answer "rejected" for this op only; nothing was written
      -- for it (the block above is rolled back). Unexpected errors are not
      -- caught: they fail the whole call and the client simply retries later.
      when insufficient_privilege or foreign_key_violation or check_violation
        or not_null_violation or invalid_parameter_value or invalid_text_representation
        or raise_exception then
        v_res := jsonb_build_object('status', 'rejected', 'op_id', v_op->>'op_id',
          'table', v_op->>'table', 'row_id', v_op->>'row_id', 'reason', sqlerrm, 'code', sqlstate);
        v_rejected := true;
    end;

    v_results := v_results || jsonb_build_array(v_res);
  end loop;

  -- Only the owner's push updates the device row; the owner never changes.
  if v_dev_ok then
    update public.devices set last_sync_at = clock_timestamp(),
        last_status = case when v_rejected then 'rejected' else 'ok' end
      where device_id = p_device_id and user_id = v_uid;
  end if;

  return jsonb_build_object('server_time', clock_timestamp(), 'results', v_results);
end $$;

-- -------------------------------------------------- sync_pull: all reads
-- Runs with the caller's rights, so Row Level Security decides what it sees.
-- Returns only rows changed since p_since (null = first pull).

create or replace function public.sync_pull(p_since timestamptz)
returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'server_time', clock_timestamp(),
    'user_id', auth.uid(),
    'regions', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'name', g.name,
        'role', (select m.role from public.region_members m
                 where m.region_id = g.id and m.user_id = auth.uid()),
        'members', (select count(*) from public.region_members m
                    where m.region_id = g.id and m.role <> 'lead')) order by g.name)
      from public.regions g), '[]'::jsonb),
    'profiles', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', p.user_id, 'display_name', p.display_name))
      from public.profiles p), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(jsonb_build_object(
        'device_id', d.device_id, 'user_id', d.user_id,
        'last_sync_at', d.last_sync_at, 'last_status', d.last_status) order by d.last_sync_at desc)
      from public.devices d), '[]'::jsonb),
    'records', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'region_id', r.region_id, 'type', r.type, 'seq', r.seq, 'fields', r.fields,
        'version', r.version, 'updated_at', r.updated_at, 'deleted', r.deleted,
        'observed_at', r.observed_at, 'created_by', r.created_by, 'updated_by', r.updated_by))
      from public.records r
      where (p_since is null and (not r.deleted or exists (
               select 1 from public.conflict_log c where c.record_id = r.id and not c.resolved)))
         or r.updated_at > p_since), '[]'::jsonb),
    'media', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'record_id', m.record_id, 'region_id', m.region_id,
        'storage_path', m.storage_path, 'mime_type', m.mime_type, 'size_bytes', m.size_bytes,
        'position', m.position, 'deleted', m.deleted))
      from public.media m
      where (p_since is null and not m.deleted) or m.updated_at > p_since), '[]'::jsonb),
    'gps_logs', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'region_id', g.region_id, 'record_id', g.record_id, 'kind', g.kind,
        'name', g.name, 'seq', g.seq, 'points', g.points, 'started_at', g.started_at,
        'ended_at', g.ended_at, 'distance_m', g.distance_m, 'deleted', g.deleted))
      from public.gps_logs g
      where (p_since is null and not g.deleted) or g.updated_at > p_since), '[]'::jsonb),
    'conflicts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'record_id', c.record_id, 'region_id', c.region_id, 'kind', c.kind,
        'field', c.field, 'lost_value', c.lost_value, 'lost_by', c.lost_by,
        'lost_device', c.lost_device, 'kept_value', c.kept_value, 'kept_by', c.kept_by,
        'kept_device', c.kept_device, 'at', c.at, 'resolved', c.resolved))
      from public.conflict_log c
      where p_since is null or c.updated_at > p_since), '[]'::jsonb)
  );
$$;

revoke all on function public.check_record_fields(jsonb) from public, anon;
revoke all on function public.sync_push(text, jsonb) from public, anon;
revoke all on function public.sync_pull(timestamptz) from public, anon;
grant execute on function public.sync_push(text, jsonb) to authenticated;
grant execute on function public.sync_pull(timestamptz) to authenticated;

-- --------------------------------------------------------------- Storage
-- Private bucket. Object names are <region id>/<record id>/<photo id>.jpg,
-- so the first folder decides who may read or write.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('photos', 'photos', false, 5242880, array['image/jpeg'])
  on conflict (id) do update set public = false, file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg'];

drop policy if exists fieldsync_photos_read on storage.objects;
create policy fieldsync_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member(public.try_uuid((storage.foldername(name))[1])));

drop policy if exists fieldsync_photos_insert on storage.objects;
create policy fieldsync_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.can_edit(public.try_uuid((storage.foldername(name))[1])));

drop policy if exists fieldsync_photos_update on storage.objects;
create policy fieldsync_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'photos' and public.can_edit(public.try_uuid((storage.foldername(name))[1])))
  with check (bucket_id = 'photos' and public.can_edit(public.try_uuid((storage.foldername(name))[1])));

notify pgrst, 'reload schema';

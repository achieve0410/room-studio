update public.profiles
set display_name = left(display_name, 120)
where char_length(display_name) > 120;

alter table public.profiles
  add constraint profiles_display_name_length_check
  check (display_name is null or char_length(display_name) <= 120);

alter table public.projects
  drop constraint projects_schema_version_check,
  add constraint projects_schema_version_check check (schema_version = 1),
  add constraint projects_layout_json_shape_check check (
    jsonb_typeof(layout_json) = 'object'
    and coalesce(jsonb_typeof(layout_json -> 'zones'), '') = 'array'
    and coalesce(jsonb_typeof(layout_json -> 'items'), '') = 'array'
    and coalesce(jsonb_typeof(layout_json -> 'structures'), '') = 'array'
    and coalesce(jsonb_typeof(layout_json -> 'wallHeight'), '') = 'number'
  ),
  add constraint projects_layout_json_size_check
  check (octet_length(layout_json::text) <= 1048576);

alter table public.projects
  add constraint projects_id_owner_key unique (id, owner_id);

alter table public.project_versions
  drop constraint project_versions_project_id_fkey,
  add constraint project_versions_project_owner_fkey
    foreign key (project_id, owner_id)
    references public.projects(id, owner_id)
    on delete cascade,
  drop constraint project_versions_schema_version_check,
  add constraint project_versions_schema_version_check check (schema_version = 1),
  add constraint project_versions_layout_json_shape_check check (
    jsonb_typeof(layout_json) = 'object'
    and coalesce(jsonb_typeof(layout_json -> 'zones'), '') = 'array'
    and coalesce(jsonb_typeof(layout_json -> 'items'), '') = 'array'
    and coalesce(jsonb_typeof(layout_json -> 'structures'), '') = 'array'
    and coalesce(jsonb_typeof(layout_json -> 'wallHeight'), '') = 'number'
  ),
  add constraint project_versions_layout_json_size_check
  check (octet_length(layout_json::text) <= 1048576);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    pg_catalog.left(coalesce(new.raw_user_meta_data ->> 'full_name', pg_catalog.split_part(new.email, '@', 1)), 120)
  );
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public;
revoke all on function public.handle_new_user() from public;

revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

revoke insert, update, delete on public.projects from authenticated;
revoke insert, update, delete on public.project_versions from authenticated;

drop policy if exists "Users can create their own projects" on public.projects;
drop policy if exists "Users can update their own projects" on public.projects;
drop policy if exists "Users can delete their own projects" on public.projects;
drop policy if exists "Users can create their own project versions" on public.project_versions;

create or replace function public.save_project(
  p_project_id uuid,
  p_name text,
  p_layout_json jsonb,
  p_schema_version integer,
  p_expected_revision bigint,
  p_create_version boolean default false
)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  max_projects_per_user constant integer := 100;
  max_versions_per_project constant integer := 100;
  saved_project public.projects;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if p_project_id is null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_user_id::text, 0));

    if (select count(*) from public.projects where owner_id = current_user_id) >= max_projects_per_user then
      raise exception 'PROJECT_LIMIT_REACHED' using errcode = '54000';
    end if;

    insert into public.projects (owner_id, name, layout_json, schema_version)
    values (current_user_id, p_name, p_layout_json, p_schema_version)
    returning * into saved_project;
  else
    update public.projects
    set name = p_name,
        layout_json = p_layout_json,
        schema_version = p_schema_version,
        revision = revision + 1
    where id = p_project_id
      and owner_id = current_user_id
      and revision = p_expected_revision
    returning * into saved_project;

    if saved_project.id is null then
      raise exception 'PROJECT_CONFLICT' using errcode = '40001';
    end if;
  end if;

  if coalesce(p_create_version, false) then
    insert into public.project_versions (project_id, owner_id, layout_json, schema_version)
    values (saved_project.id, current_user_id, p_layout_json, p_schema_version);

    delete from public.project_versions
    where id in (
      select id
      from public.project_versions
      where project_id = saved_project.id
      order by created_at desc, id desc
      offset max_versions_per_project
    );
  end if;

  return saved_project;
end;
$$;
revoke all on function public.save_project(uuid, text, jsonb, integer, bigint, boolean) from public;
grant execute on function public.save_project(uuid, text, jsonb, integer, bigint, boolean) to authenticated;
